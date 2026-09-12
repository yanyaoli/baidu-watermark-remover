const S = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10,
	15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// K[i] = floor(abs(sin(i + 1)) * 2^32)，RFC 1321 常量表
const K = new Int32Array(64);
for (let i = 0; i < 64; i++) {
	K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
}

const HEX = '0123456789abcdef';

function utf8Bytes(input: string): Uint8Array {
	return new TextEncoder().encode(input);
}

function toHexLE(word: number): string {
	let out = '';
	for (let i = 0; i < 4; i++) {
		const byte = (word >>> (i * 8)) & 0xff;
		out += HEX[(byte >>> 4) & 0xf] + HEX[byte & 0xf];
	}
	return out;
}

export function md5Hex(input: string | Uint8Array): string {
	const msg = typeof input === 'string' ? utf8Bytes(input) : input;
	const len = msg.length;

	// 填充：消息 + 0x80 + 0x00...，末尾 8 字节为比特长度（小端）
	const paddedLen = (((len + 8) >> 6) + 1) << 6;
	const padded = new Uint8Array(paddedLen);
	padded.set(msg);
	padded[len] = 0x80;

	const view = new DataView(padded.buffer);
	const bitLen = len * 8;
	view.setUint32(paddedLen - 8, bitLen >>> 0, true);
	view.setUint32(paddedLen - 4, Math.floor(bitLen / 4294967296), true);

	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;

	const M = new Int32Array(16);

	for (let chunk = 0; chunk < paddedLen; chunk += 64) {
		for (let j = 0; j < 16; j++) {
			M[j] = view.getInt32(chunk + j * 4, true);
		}

		let A = a0;
		let B = b0;
		let C = c0;
		let D = d0;

		for (let i = 0; i < 64; i++) {
			let F: number;
			let g: number;
			if (i < 16) {
				F = (B & C) | (~B & D);
				g = i;
			} else if (i < 32) {
				F = (D & B) | (~D & C);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				F = B ^ C ^ D;
				g = (3 * i + 5) % 16;
			} else {
				F = C ^ (B | ~D);
				g = (7 * i) % 16;
			}
			F = (F + A + K[i]! + M[g]!) | 0;
			A = D;
			D = C;
			C = B;
			const s = S[i]!;
			B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
		}

		a0 = (a0 + A) | 0;
		b0 = (b0 + B) | 0;
		c0 = (c0 + C) | 0;
		d0 = (d0 + D) | 0;
	}

	return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
}
