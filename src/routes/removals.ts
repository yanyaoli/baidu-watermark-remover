import { Hono } from 'hono';
import { createTask, queryTask, stripBase64Prefix, uploadImage, urlToBase64, MAX_IMAGE_BYTES } from '../services/baidu';
import { checkRateLimit, consumeRateLimit, getClientIp, rateLimitHeaders } from '../services/rateLimit';
import type { RemovalRequest, RemovalStatus, SubmitResult } from '../types';

/** 限速配置：默认每 IP 每分钟 10 张，可通过环境变量覆盖 */
function rateLimitOptions() {
	return {
		limit: Number(process.env.RATE_LIMIT_MAX ?? 10),
		windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000)
	};
}

export const removalsRoutes = new Hono();

/**
 * POST /api/v1/removals — 提交单张去水印任务
 * 逐张提交（而非批量数组）：Vercel 请求体上限 4.5MB，批量 base64 必然超限；
 * 前端并行逐张提交，服务端内上传/建任务依然瞬时完成。
 */
removalsRoutes.post('/removals', async (c) => {
	const opts = rateLimitOptions();
	const ip = getClientIp(c);

	let body: RemovalRequest;
	try {
		body = (await c.req.json()) as RemovalRequest;
	} catch {
		return c.json({ success: false, message: '请求体必须是 JSON' }, 400);
	}

	const rate = checkRateLimit(ip, 1, opts);
	if (!rate.allowed) {
		return c.json(
			{
				success: false,
				message: `提交过于频繁，每分钟最多 ${opts.limit} 张，请 ${rate.retryAfterSeconds} 秒后重试`,
				code: 'RATE_LIMITED'
			},
			429,
			{ ...rateLimitHeaders(rate), 'retry-after': String(rate.retryAfterSeconds) }
		);
	}

	if (!body.imageUrl && !body.base64) {
		return c.json({ success: false, message: '请提供 imageUrl 或 base64' }, 400);
	}
	if (body.mask && !body.mask.startsWith('data:image/')) {
		return c.json({ success: false, message: 'mask 必须是 data:image/... 格式' }, 400);
	}

	let base64Image: string;
	try {
		if (body.imageUrl) {
			if (!/^https?:\/\//i.test(body.imageUrl)) {
				return c.json({ success: false, message: 'imageUrl 必须是 http(s) 链接' }, 400);
			}
			base64Image = await urlToBase64(body.imageUrl);
		} else {
			base64Image = stripBase64Prefix(body.base64!);
			const bytes = Math.floor((base64Image.length * 3) / 4);
			if (bytes > MAX_IMAGE_BYTES) {
				return c.json({ success: false, message: `图片数据过大 (${(bytes / 1024 / 1024).toFixed(2)}MB)，请选择小于10MB的图片` }, 413);
			}
		}
	} catch (err) {
		return c.json({ success: false, message: err instanceof Error ? err.message : '图片获取失败' }, 400);
	}

	// 消耗 1 个配额
	consumeRateLimit(ip, 1, opts);

	try {
		const uploadedImage = await uploadImage(base64Image);

		try {
			const task = await createTask(uploadedImage, body.mask ?? null);
			const result: SubmitResult = {
				id: body.id,
				status: 'processing',
				taskId: task.taskId,
				uploadedImage
			};
			c.header('x-ratelimit-remaining', String(rate.remaining));
			return c.json({ success: true, message: '任务已创建', data: result });
		} catch (err) {
			const message = err instanceof Error ? err.message : '创建任务失败';
			if (message.includes('涂抹')) {
				// 自动检测未发现水印：返回 need_paint，前端打开涂抹编辑器后带遮罩重新提交
				const result: SubmitResult = {
					id: body.id,
					status: 'need_paint',
					uploadedImage,
					message: '未找到水印，请涂抹后重试'
				};
				c.header('x-ratelimit-remaining', String(rate.remaining));
				return c.json({ success: true, message: result.message, data: result });
			}
			throw err;
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : '上传失败';
		return c.json({ success: false, message }, 502);
	}
});

/**
 * GET /api/v1/removals/:taskId — 无状态轮询百度任务结果
 */
removalsRoutes.get('/removals/:taskId', async (c) => {
	const taskId = c.req.param('taskId');
	try {
		const raw = await queryTask(taskId);
		const status: RemovalStatus = {
			status: 'processing',
			progress: typeof raw.progress === 'number' ? raw.progress : 0
		};
		if (raw.isGenerate && raw.picArr && raw.picArr.length > 0 && raw.picArr[0]?.url) {
			status.status = 'done';
			status.progress = 100;
			status.resultUrl = raw.picArr[0].url;
		} else if (raw.failMsg) {
			status.status = 'error';
			status.message = raw.failMsg;
		}
		return c.json({ success: true, data: status });
	} catch (err) {
		return c.json({ success: false, message: err instanceof Error ? err.message : '查询失败' }, 502);
	}
});
