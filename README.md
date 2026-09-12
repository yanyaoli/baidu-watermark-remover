# 图片去水印

百度 AI 图片助手驱动的图片去水印工具

## 快速开始

```bash
npm install
npm run dev
```

生产运行：`npm run build && npm start`。

## 部署

```bash
npx vercel --prod        # Vercel
npm run build && npx wrangler deploy   # Cloudflare Workers
npm run build && npm start             # 本地
```

## API

统一响应格式 `{ success, message?, data? }`；

| 方法 | 路径                       | 说明                                                                                                                            |
| ---- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| POST | `/api/v1/removals`         | 提交单张任务：`{ id?, imageUrl? / base64?, mask? }`，返回 `{ taskId, uploadedImage }`；未检测到水印时返回 `need_paint` 引导涂抹 |
| GET  | `/api/v1/removals/:taskId` | 轮询结果：`{ status, progress, resultUrl? }`                                                                                    |
| GET  | `/api/v1/health`           | 健康检查 + 当前 IP 限速余量                                                                                                     |

```bash
curl -X POST http://localhost:3000/api/v1/removals \
  -H "Content-Type: application/json" \
  -d '{"imageUrl":"https://example.com/photo.jpg"}'
```

## 配置

| 环境变量               | 默认    | 说明                   |
| ---------------------- | ------- | ---------------------- |
| `PORT`                 | `3000`  | 本地服务端口           |
| `RATE_LIMIT_MAX`       | `10`    | 每 IP 每窗口最大提交数 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 限速窗口时长（毫秒）   |
