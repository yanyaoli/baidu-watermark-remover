import type { Context } from 'hono';

export interface RateLimitOptions {
	/** 窗口内允许的最大请求数 */
	limit: number;
	/** 窗口时长（毫秒） */
	windowMs: number;
}

export interface RateLimitState {
	allowed: boolean;
	limit: number;
	remaining: number;
	/** 配额重置时间（epoch ms），超限时为最早一条记录滑出窗口的时间 */
	resetAt: number;
	/** 超限时建议等待秒数 */
	retryAfterSeconds: number;
}

/**
 * 内存滑动窗口限速存储。
 * 按 IP 记录提交时间戳；单实例内生效（Workers 单 isolate / Vercel 单实例）。
 * 多副本部署时各实例独立计数，如需全局精确限速可接入外部存储（Upstash/KV/DO）。
 */
class SlidingWindowStore {
	private hits = new Map<string, number[]>();
	private readonly maxKeys = 10000;

	prune(ip: string, now: number, windowMs: number): number[] {
		const list = this.hits.get(ip);
		if (!list) return [];
		const valid = list.filter((t) => now - t < windowMs);
		if (valid.length !== list.length) {
			if (valid.length === 0) this.hits.delete(ip);
			else this.hits.set(ip, valid);
		}
		return valid;
	}

	consume(ip: string, count: number, windowMs: number): void {
		// 防止 Map 无限增长
		if (this.hits.size >= this.maxKeys && !this.hits.has(ip)) {
			const oldestKey = this.hits.keys().next().value;
			if (oldestKey !== undefined) this.hits.delete(oldestKey);
		}
		const list = this.hits.get(ip) ?? [];
		const now = Date.now();
		for (let i = 0; i < count; i++) list.push(now);
		this.hits.set(ip, list);
	}
}

const store = new SlidingWindowStore();

export function getClientIp(c: Context): string {
	const cfIp = c.req.header('cf-connecting-ip');
	if (cfIp) return cfIp;
	const forwarded = c.req.header('x-forwarded-for');
	if (forwarded) return forwarded.split(',')[0]!.trim();
	const realIp = c.req.header('x-real-ip');
	if (realIp) return realIp;
	return 'unknown';
}

export function checkRateLimit(ip: string, count: number, opts: RateLimitOptions): RateLimitState {
	const now = Date.now();
	const list = store.prune(ip, now, opts.windowMs);
	const remaining = Math.max(0, opts.limit - list.length);

	if (list.length + count > opts.limit) {
		const oldest = list[0] ?? now;
		const resetAt = oldest + opts.windowMs;
		return {
			allowed: false,
			limit: opts.limit,
			remaining,
			resetAt,
			retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
		};
	}

	return {
		allowed: true,
		limit: opts.limit,
		remaining: Math.max(0, remaining - count),
		resetAt: now + opts.windowMs,
		retryAfterSeconds: 0,
	};
}

export function consumeRateLimit(ip: string, count: number, opts: RateLimitOptions): void {
	store.consume(ip, count, opts.windowMs);
}

export function rateLimitHeaders(state: RateLimitState): Record<string, string> {
	return {
		'x-ratelimit-limit': String(state.limit),
		'x-ratelimit-remaining': String(state.remaining),
		'x-ratelimit-reset': String(Math.ceil(state.resetAt / 1000)),
	};
}
