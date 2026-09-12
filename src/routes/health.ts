import { Hono } from 'hono';
import { checkRateLimit, getClientIp, rateLimitHeaders } from '../services/rateLimit';

export const healthRoutes = new Hono();

/**
 * GET /api/v1/health — 健康检查 + 当前 IP 限速余量
 */
healthRoutes.get('/health', (c) => {
	const opts = {
		limit: Number(process.env.RATE_LIMIT_MAX ?? 10),
		windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000)
	};
	const rate = checkRateLimit(getClientIp(c), 0, opts);

	return c.json(
		{
			success: true,
			data: {
				status: 'ok',
				timestamp: new Date().toISOString(),
				rateLimit: {
					limit: rate.limit,
					remaining: rate.remaining,
					resetAt: new Date(rate.resetAt).toISOString(),
					windowMs: opts.windowMs
				}
			}
		},
		200,
		rateLimitHeaders(rate)
	);
});
