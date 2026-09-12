import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { removalsRoutes } from './routes/removals';
import { healthRoutes } from './routes/health';

/**
 * Hono 应用主体
 */

// Vercel Serverless 请求体硬上限 4.5MB，这里放宽到 6MB 交给平台层裁决
const MAX_BODY_BYTES = 6 * 1024 * 1024;

export function createApp() {
	const app = new Hono();

	app.use('/api/*', cors());

	app.use(
		'/api/*',
		bodyLimit({
			maxSize: MAX_BODY_BYTES,
			onError: (c) => c.json({ success: false, message: '请求体过大，请确保单张图片不超过10MB' }, 413),
		}),
	);

	app.route('/api/v1', removalsRoutes);
	app.route('/api/v1', healthRoutes);

	app.notFound((c) => c.json({ success: false, message: '接口不存在' }, 404));

	app.onError((err, c) => {
		console.error('未处理异常:', err);
		return c.json(
			{
				success: false,
				message: err instanceof Error ? err.message : '服务器内部错误',
			},
			500,
		);
	});

	return app;
}
