/**
 * Vercel Serverless 入口
 * 静态资源由 vercel.json rewrites 映射到 /public 下的文件。
 */
import { handle } from 'hono/vercel';
import { createApp } from '../src/app';

const app = createApp();

export const GET = handle(app);
export const POST = handle(app);
export const OPTIONS = handle(app);
