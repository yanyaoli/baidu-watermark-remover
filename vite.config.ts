import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// 前端源码在 frontend/，构建产物输出到 public/（服务端三平台统一托管该目录）
// 开发模式由 src/adapters/node.ts 内嵌 Vite 中间件（与 API 同端口同进程），无需代理
export default defineConfig({
	root: 'frontend',
	plugins: [tailwindcss()],
	build: {
		outDir: '../public',
		emptyOutDir: true,
	},
});
