/** 统一响应包裹 */
export interface ApiResponse<T = unknown> {
	success: boolean;
	message?: string;
	data?: T;
}

/** POST /api/v1/removals 请求体 */
export interface RemovalRequest {
	/** 客户端本地 id，原样回传用于关联 */
	id?: string;
	/** 图片直链（与 base64 二选一） */
	imageUrl?: string;
	/** 图片 base64，可带 data:image/...;base64, 前缀 */
	base64?: string;
	/** 与原图同尺寸的遮罩 data URL（黑底白涂抹区 PNG），可选 */
	mask?: string;
}

/** 提交结果 */
export interface SubmitResult {
	id?: string;
	status: 'processing' | 'need_paint';
	taskId?: string;
	/** 百度侧上传后的图片地址 */
	uploadedImage?: string;
	message?: string;
}

/** GET /api/v1/removals/:taskId 结果 */
export interface RemovalStatus {
	status: 'processing' | 'done' | 'error';
	progress: number;
	resultUrl?: string;
	message?: string;
}

/** 百度 pcquery 原始返回（部分字段） */
export interface BaiduQueryResponse {
	isGenerate?: boolean;
	progress?: number;
	picArr?: Array<{ url?: string }>;
	failMsg?: string;
	[key: string]: unknown;
}
