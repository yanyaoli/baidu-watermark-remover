import { generateBaiduToken } from './token';
import type { BaiduQueryResponse } from '../types';

/**
 * 百度 AIGC 图片去水印 API 封装
 */

const BAIDU_BASE = 'https://image.baidu.com';
const UPLOAD_URL = `${BAIDU_BASE}/aigc/pic_upload`;
const CREATE_TASK_URL = `${BAIDU_BASE}/aigc/pccreate`;
const QUERY_TASK_URL = `${BAIDU_BASE}/aigc/pcquery`;

const SCENE = 'pic_edit';
const QUERY_TEXT = 'bdaitpzs百度AI图片助手bdaitpzs';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 单张图片上限 10MB

/** 模拟浏览器请求头 */
function baiduHeaders(): Record<string, string> {
	return {
		accept: '*/*',
		'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
		'cache-control': 'no-cache',
		pragma: 'no-cache',
		'sec-ch-ua': '"Microsoft Edge";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
		'sec-ch-ua-mobile': '?0',
		'sec-ch-ua-platform': '"Windows"',
		'sec-fetch-dest': 'empty',
		'sec-fetch-mode': 'cors',
		'sec-fetch-site': 'same-origin',
		referer: 'https://image.baidu.com/search/index?showMask=1&fr=csaitab&tn=baiduimage&toolType=1&word=bdaitpzs%E7%99%BE%E5%BA%A6AI%E5%9B%BE%E7%89%87%E5%8A%A9%E6%89%8Bbdaitpzs',
		'x-requested-with': 'XMLHttpRequest'
	};
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
	const response = await fetch(url, {
		...init,
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!response.ok) {
		throw new Error(`百度接口请求失败: HTTP ${response.status}`);
	}
	return response;
}

/** ArrayBuffer → base64（分块避免 String.fromCharCode 爆栈） */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

/** 去掉 data:image/...;base64, 前缀 */
export function stripBase64Prefix(input: string): string {
	return input.includes('base64,') ? input.split('base64,')[1]! : input;
}

/** 下载图片直链并转为纯 base64 */
export async function urlToBase64(imageUrl: string): Promise<string> {
	let response: Response;
	try {
		response = await fetchWithTimeout(imageUrl, { headers: { accept: 'image/*,*/*' } }, 30000);
	} catch (err) {
		throw new Error(`图片下载失败: ${err instanceof Error ? err.message : String(err)}`);
	}
	const buffer = await response.arrayBuffer();
	if (buffer.byteLength > MAX_IMAGE_BYTES) {
		throw new Error(`图片文件过大 (${(buffer.byteLength / 1024 / 1024).toFixed(2)}MB)，请选择小于10MB的图片`);
	}
	return arrayBufferToBase64(buffer);
}

/** 上传图片到百度，返回托管 URL */
export async function uploadImage(base64Image: string): Promise<string> {
	const timestamp = Date.now();
	const token = generateBaiduToken(base64Image, timestamp);

	const body = new URLSearchParams();
	body.append('token', token);
	body.append('scene', SCENE);
	body.append('picInfo', base64Image);
	body.append('timestamp', timestamp.toString());
	body.append('pageFr', '');

	const response = await fetchWithTimeout(
		UPLOAD_URL,
		{
			method: 'POST',
			headers: {
				...baiduHeaders(),
				'content-type': 'application/x-www-form-urlencoded;charset=UTF-8'
			},
			body: body.toString()
		},
		30000
	);

	const data = (await response.json()) as {
		status?: number;
		message?: string;
		data?: { url?: string };
	};
	if (data.status === 0 && data.data?.url) {
		return data.data.url;
	}
	throw new Error('图片上传失败: ' + (data.message || '未知错误'));
}

/** 创建去水印任务；有遮罩 type=2（手动涂抹），无遮罩 type=1（自动检测） */
export async function createTask(imageUrl: string, maskData: string | null): Promise<{ taskId: string }> {
	const body = new URLSearchParams();
	body.append('query', QUERY_TEXT);
	body.append('picInfo', '');
	body.append('picInfo2', maskData ?? '');
	body.append('type', maskData ? '2' : '1');
	body.append('text', '');
	body.append('ext_ratio', '');
	body.append('expand_zoom', '');
	body.append('original_url', imageUrl);
	body.append('thumb_url', imageUrl);
	body.append('front_display', '0');
	body.append('create_level', '0');
	body.append('image_source', '1');
	body.append('style', '');
	body.append('queryFeature', '');
	body.append('imageFeature', '');
	body.append('channel', 'edit');
	body.append('page_fr', 'csaitab');
	body.append('search_id', '');
	body.append('applid', '11081733447198592405');
	body.append('querycate83', '3');
	body.append('sa', '');
	body.append('pic_fr', '0');

	const response = await fetchWithTimeout(
		CREATE_TASK_URL,
		{
			method: 'POST',
			headers: {
				...baiduHeaders(),
				'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'
			},
			body: body.toString()
		},
		30000
	);

	const data = (await response.json()) as {
		status?: number;
		pcEditTaskid?: string;
	};
	if (data.status === 0 && data.pcEditTaskid) {
		return { taskId: data.pcEditTaskid };
	}
	// 创建失败统一引导用户涂抹
	throw new Error('未找到水印，请进行涂抹');
}

/** 查询百度任务状态 */
export async function queryTask(taskId: string): Promise<BaiduQueryResponse> {
	const url = `${QUERY_TASK_URL}?taskId=${encodeURIComponent(taskId)}&query=${encodeURIComponent(QUERY_TEXT)}&image_source=1&type=1`;

	const response = await fetchWithTimeout(url, { headers: baiduHeaders() }, 10000);
	return (await response.json()) as BaiduQueryResponse;
}
