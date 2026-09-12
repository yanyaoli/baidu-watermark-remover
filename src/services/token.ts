import { md5Hex } from './md5';

/**
 * 百度 AIGC 接口 token 生成
 * token = MD5( MD5(input) + scene + timestamp + isSkAnti ).slice(0, 5)
 */
export function generateBaiduToken(input: string, timestamp: number): string {
	const scene = 'pic_edit';
	const isSkAnti = '';
	const firstHash = md5Hex(input);
	const combined = firstHash + scene + timestamp.toString() + isSkAnti;
	return md5Hex(combined).slice(0, 5);
}
