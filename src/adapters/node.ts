/**
 * 本地 / Node 服务器入口
 * - npm run dev （NODE_ENV=development）：内嵌 Vite 中间件，前端实时热更新，单终端即可
 * - npm start   （NODE_ENV=production） ：托管 public/ 构建产物
 */
import { getRequestListener, serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApp } from '../app';

const isDev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);

if (isDev) {
	// 开发模式：Vite 直接服务 frontend/ 源码（HMR），未命中的路径走 API
	const { createServer: createViteServer } = await import('vite');
	const vite = await createViteServer({ server: { middlewareMode: true } });
	const apiListener = getRequestListener(createApp().fetch);

	import('node:http').then(({ createServer }) => {
		createServer((req, res) => {
			// API 路径直接交给 Hono，避免被 Vite 的 SPA fallback 拦截
			if (req.url?.startsWith('/api/')) {
				apiListener(req, res);
				return;
			}
			vite.middlewares(req, res, () => apiListener(req, res));
		}).listen(port, () => {
			console.log(`开发模式（前端热更新 + API）: http://localhost:${port}`);
		});
	});
} else {
	const app = new Hono();
	app.route('/', createApp());
	app.use('*', serveStatic({ root: './public' }));

	serve({ fetch: app.fetch, port }, (info) => {
		console.log(`去水印服务已启动: http://localhost:${info.port}`);
	});
}
