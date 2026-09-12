/**
 * 图片去水印
 */
import './style.css';
import { siGithub, siGooglephotos } from 'simple-icons';

const API_BASE = '/api/v1';
const MAX_IMAGES = 10;
const MAX_SEND_BYTES = 3.2 * 1024 * 1024; // base64 后 ~4.3MB，低于 Vercel 4.5MB 请求体上限
const POLL_INTERVAL = 2000;
const SUBMIT_CONCURRENCY = 2;

type ImageStatus = 'idle' | 'queued' | 'submitting' | 'processing' | 'need_paint' | 'done' | 'error';

interface AppImage {
	id: string;
	name: string;
	kind: 'file' | 'url';
	/** file 类型为 Blob/File，url 类型为直链 */
	source: Blob | string;
	previewUrl: string;
	width: number;
	height: number;
	mask: string | null;
	status: ImageStatus;
	progress: number;
	taskId: string | null;
	uploadedImage?: string;
	resultUrl: string | null;
	message: string;
}

interface SubmitResultData {
	id?: string;
	status: 'processing' | 'need_paint';
	taskId?: string;
	uploadedImage?: string;
	message?: string;
}

interface RemovalStatusData {
	status: 'processing' | 'done' | 'error';
	progress: number;
	resultUrl?: string;
	message?: string;
}

interface Stroke {
	points: Array<{ x: number; y: number }>;
	size: number;
}

interface EditorState {
	img: AppImage;
	el: HTMLImageElement;
	strokes: Stroke[];
	drawing: boolean;
	current: Stroke | null;
	/** 显示坐标 → 原图坐标 的缩放系数 */
	scale: number;
	onPointerUp: () => void;
}

const STATUS_META: Record<ImageStatus, { label: string; chip: string }> = {
	idle: { label: '待处理', chip: '' },
	queued: { label: '排队中', chip: '' },
	submitting: { label: '提交中', chip: 'chip-processing' },
	processing: { label: '处理中', chip: 'chip-processing' },
	need_paint: { label: '需涂抹', chip: 'chip-warn' },
	done: { label: '已完成', chip: 'chip-done' },
	error: { label: '失败', chip: 'chip-error' }
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const images: AppImage[] = [];
let running = false;
let editor: EditorState | null = null;
let toastTimer: number | undefined;

/* ============ 工具 ============ */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const genId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

const escapeHtml = (str: string) => String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(new Error('读取图片失败'));
		reader.readAsDataURL(blob);
	});
}

function toast(message: string, type: '' | 'err' = '') {
	const stack = $('toastStack');
	const el = document.createElement('div');
	el.className = `anim-toast-in pointer-events-auto flex max-w-[min(480px,90vw)] items-center gap-2 rounded-xs border border-line-strong bg-[#1d1d1d] px-4 py-2 text-[13px] shadow-[0_8px_32px_rgba(0,0,0,0.45)]`;
	const icon = type === 'err' ? 'i-alert' : 'i-check';
	const iconColor = type === 'err' ? 'text-err' : 'text-ink-2';
	el.innerHTML = `<svg class="icon !h-[15px] !w-[15px] ${iconColor}"><use href="#${icon}"/></svg><span>${escapeHtml(message)}</span>`;
	stack.appendChild(el);
	window.clearTimeout(toastTimer);
	toastTimer = window.setTimeout(() => {
		el.classList.replace('anim-toast-in', 'anim-toast-out');
		setTimeout(() => el.remove(), 300);
	}, 3200);
}

/* ============ 图片收集 ============ */

function bindUpload() {
	const dropzone = $('dropzone');
	const fileInput = $<HTMLInputElement>('fileInput');
	dropzone.addEventListener('click', () => fileInput.click());
	dropzone.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') fileInput.click();
	});
	dropzone.addEventListener('dragover', (e) => {
		e.preventDefault();
		dropzone.classList.add('border-[#6e6e6e]', 'bg-panel-2');
	});
	dropzone.addEventListener('dragleave', () => dropzone.classList.remove('border-[#6e6e6e]', 'bg-panel-2'));
	dropzone.addEventListener('drop', (e) => {
		e.preventDefault();
		dropzone.classList.remove('border-[#6e6e6e]', 'bg-panel-2');
		if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
	});
	fileInput.addEventListener('change', () => {
		if (fileInput.files?.length) addFiles(fileInput.files);
		fileInput.value = '';
	});
}

function bindUrlInput() {
	const input = $<HTMLInputElement>('urlInput');
	input.addEventListener('keydown', (e) => {
		if (e.key !== 'Enter') return;
		e.preventDefault();
		const raw = input.value.trim();
		if (!raw) return;
		const urls = raw.split(/[\s,，]+/).filter(Boolean);
		input.value = '';
		addUrls(urls);
	});
}

function bindPaste() {
	document.addEventListener('paste', (e) => {
		const items = e.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		for (const item of Array.from(items)) {
			if (item.type.startsWith('image/')) {
				const file = item.getAsFile();
				if (file) files.push(file);
			}
		}
		if (files.length) {
			e.preventDefault();
			addFiles(files);
		}
	});
}

function addFiles(fileList: FileList | File[]) {
	const files = Array.from(fileList).filter((f) => {
		if (!f.type.startsWith('image/')) {
			toast(`「${f.name}」不是图片文件`, 'err');
			return false;
		}
		if (f.size > 10 * 1024 * 1024) {
			toast(`「${f.name}」超过 10MB 限制`, 'err');
			return false;
		}
		return true;
	});
	if (!files.length) return;
	if (images.length + files.length > MAX_IMAGES) {
		toast(`一次最多处理 ${MAX_IMAGES} 张图片`, 'err');
		return;
	}
	files.forEach((file) => enqueuePrepare(file));
}

function addUrls(urls: string[]) {
	let added = 0;
	for (const url of urls) {
		if (!/^https?:\/\//i.test(url)) {
			toast(`链接无效：${url.slice(0, 60)}`, 'err');
			continue;
		}
		if (images.length + added >= MAX_IMAGES) {
			toast(`一次最多处理 ${MAX_IMAGES} 张图片`, 'err');
			break;
		}
		images.push({
			id: genId(),
			name: decodeURIComponent(url.split('/').pop() || 'image').slice(0, 40) || 'image',
			kind: 'url',
			source: url,
			previewUrl: url,
			width: 0,
			height: 0,
			mask: null,
			status: 'idle',
			progress: 0,
			taskId: null,
			resultUrl: null,
			message: ''
		});
		added++;
	}
	if (added) renderGallery();
}

/** 文件图片：超限（或 GIF）则压缩为 JPEG（长边≤2560 → 质量降档），保证请求体在平台限制内 */
async function enqueuePrepare(file: File) {
	const item: AppImage = {
		id: genId(),
		name: file.name,
		kind: 'file',
		source: file,
		previewUrl: URL.createObjectURL(file),
		width: 0,
		height: 0,
		mask: null,
		status: 'idle',
		progress: 0,
		taskId: null,
		resultUrl: null,
		message: ''
	};
	images.push(item);
	renderGallery();

	try {
		const bitmap = await createImageBitmap(file);
		let blob: Blob = file;
		let width = bitmap.width;
		let height = bitmap.height;

		if (file.size > MAX_SEND_BYTES || file.type === 'image/gif') {
			const compressed = await compressBitmap(bitmap);
			blob = compressed.blob;
			width = compressed.width;
			height = compressed.height;
		}
		bitmap.close?.();

		item.source = blob;
		item.width = width;
		item.height = height;
		if (blob !== file) {
			URL.revokeObjectURL(item.previewUrl);
			item.previewUrl = URL.createObjectURL(blob);
			item.name = item.name.replace(/\.\w+$/, '') + '.jpg';
		}
	} catch {
		// 解码失败仍保留原文件，交给服务端报错
	}
	renderGallery();
}

async function compressBitmap(bitmap: ImageBitmap): Promise<{ blob: Blob; width: number; height: number }> {
	const MAX_EDGE = 2560;
	let scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
	const qualities = [0.9, 0.78, 0.65, 0.5];

	const rasterize = async (q: number): Promise<{ blob: Blob; width: number; height: number }> => {
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', q));
		return { blob: blob!, width, height };
	};

	for (const q of qualities) {
		for (let pass = 0; pass < 3; pass++) {
			const out = await rasterize(q);
			if (out.blob.size <= MAX_SEND_BYTES) return out;
			scale *= 0.85;
		}
	}
	return rasterize(0.5);
}

function removeImage(id: string) {
	const img = images.find((i) => i.id === id);
	if (img && img.kind === 'file') URL.revokeObjectURL(img.previewUrl);
	images.splice(images.indexOf(img!), 1);
	renderGallery();
	renderProgressList();
	renderResults();
}

function clearAll() {
	images.forEach((i) => i.kind === 'file' && URL.revokeObjectURL(i.previewUrl));
	images.length = 0;
	$('progressSection').hidden = true;
	$('resultSection').hidden = true;
	renderGallery();
}

/* ============ 渲染 ============ */

function renderGallery() {
	const section = $('gallerySection');
	const gallery = $('gallery');
	section.hidden = images.length === 0;
	$('imageCount').textContent = String(images.length);
	updateActionbar();

	gallery.innerHTML = '';
	for (const img of images) {
		const card = document.createElement('div');
		card.className = 'relative aspect-[4/3] overflow-hidden rounded-xs border border-line bg-panel transition-colors hover:border-line-strong';

		const el = document.createElement('img');
		el.src = img.previewUrl;
		el.alt = img.name;
		el.loading = 'lazy';
		el.className = 'block h-full w-full bg-[#101010] object-cover';
		card.appendChild(el);

		const name = document.createElement('span');
		name.className = 'text-shadow-thumb pointer-events-none absolute inset-x-2 top-2 truncate text-[11px] text-white/85';
		name.textContent = img.name;
		card.appendChild(name);

		if (img.mask) {
			const badge = document.createElement('span');
			badge.className = 'absolute left-2 top-2 flex items-center gap-1 rounded-xs border border-line-strong bg-[#0e0e0e]/80 px-2 py-0.5 text-[11px] backdrop-blur-sm';
			badge.innerHTML = '<svg class="icon icon-xs"><use href="#i-brush"/></svg>已涂抹';
			card.appendChild(badge);
		}

		const actions = document.createElement('div');
		actions.className = 'absolute inset-x-0 bottom-0 flex justify-end gap-1.5 bg-gradient-to-t from-black/75 to-transparent p-2 pt-6 opacity-0 transition-opacity duration-200 group-hover:opacity-100';
		actions.style.opacity = '';
		card.addEventListener('mouseenter', () => (actions.style.opacity = '1'));
		card.addEventListener('mouseleave', () => (actions.style.opacity = '0'));
		actions.innerHTML = `
      <button type="button" class="icon-btn" title="涂抹遮罩" data-act="paint">
        <svg class="icon icon-sm"><use href="#i-brush"/></svg>
      </button>
      <button type="button" class="icon-btn icon-btn-danger" title="移除" data-act="remove">
        <svg class="icon icon-sm"><use href="#i-trash"/></svg>
      </button>
    `;
		actions.querySelector('[data-act="paint"]')!.addEventListener('click', (e) => {
			e.stopPropagation();
			openEditor(img.id);
		});
		actions.querySelector('[data-act="remove"]')!.addEventListener('click', (e) => {
			e.stopPropagation();
			removeImage(img.id);
		});
		card.appendChild(actions);
		gallery.appendChild(card);
	}
}

function renderProgressCard(img: AppImage): HTMLElement {
	const meta = STATUS_META[img.status];
	const actions: string[] = [];
	if (img.status === 'need_paint') {
		actions.push(`<button type="button" class="btn btn-ghost btn-sm" data-act="paint">涂抹</button>`);
	}
	if (img.status === 'error' || img.status === 'need_paint') {
		actions.push(`<button type="button" class="btn btn-ghost btn-sm" data-act="retry">重试</button>`);
	}

	const card = document.createElement('div');
	card.className = 'card grid grid-cols-[64px_1fr_auto] items-center gap-3.5 py-2.5 pl-2.5 pr-3.5';
	card.id = `pc-${img.id}`;
	if (img.status === 'done' || img.status === 'error') {
		card.classList.add(img.status);
	}
	card.innerHTML = `
    <img class="block h-12 w-16 rounded-xs border border-line bg-[#101010] object-cover" src="${img.previewUrl}" alt="" />
    <div class="min-w-0">
      <div class="mb-1.5 flex items-center gap-2">
        <span class="min-w-0 flex-1 truncate text-[13px]">${escapeHtml(img.name)}</span>
        <span class="chip ${meta.chip}">${meta.label}</span>
      </div>
      <div class="h-[3px] overflow-hidden rounded-xs bg-[#242424]">
        <div class="progress-fill h-full rounded-xs transition-[width] duration-500" style="width:${img.progress}%"></div>
      </div>
      <div class="min-h-[17px] truncate text-[11.5px] text-ink-3">${escapeHtml(img.message || '')}</div>
    </div>
    <div class="flex gap-1.5">${actions.join('')}</div>
  `;
	const fill = card.querySelector<HTMLElement>('.progress-fill')!;
	if (img.status === 'done') fill.classList.add('bg-ok');
	else if (img.status === 'error') fill.classList.add('bg-err');
	else fill.classList.add('bg-gradient-to-r', 'from-[#7a7a7a]', 'to-[#e8e8e8]');

	const paintBtn = card.querySelector('[data-act="paint"]');
	paintBtn?.addEventListener('click', () => openEditor(img.id));
	const retryBtn = card.querySelector('[data-act="retry"]');
	retryBtn?.addEventListener('click', () => processImages([img]));
	return card;
}

function renderProgressList() {
	const section = $('progressSection');
	const list = $('progressList');
	const processed = images.filter((i) => i.status !== 'idle');
	section.hidden = processed.length === 0;
	list.innerHTML = '';
	processed.forEach((img) => list.appendChild(renderProgressCard(img)));
}

function patchProgressCard(img: AppImage) {
	const card = document.getElementById(`pc-${img.id}`);
	if (!card) {
		renderProgressList();
	} else {
		card.replaceWith(renderProgressCard(img));
	}
	updateActionbar();
}

function renderResults() {
	const section = $('resultSection');
	const list = $('resultList');
	const doneImages = images.filter((i) => i.status === 'done' && i.resultUrl);
	section.hidden = doneImages.length === 0;
	list.innerHTML = '';

	for (const img of doneImages) {
		const idx = images.indexOf(img) + 1;
		const card = document.createElement('div');
		card.className = 'card rounded-xs p-3.5';
		card.innerHTML = `
      <div class="flex items-center justify-between gap-2.5">
        <span class="min-w-0 flex-1 truncate text-[13px]">${escapeHtml(img.name)}</span>
        <button type="button" class="btn btn-ghost btn-sm" data-act="dl">
          <svg class="icon icon-sm"><use href="#i-download"/></svg>下载结果
        </button>
      </div>
      <div class="mt-2.5 grid grid-cols-2 gap-2.5 max-md:grid-cols-1">
        <div class="min-w-0">
          <p class="mx-0.5 mb-1.5 flex items-center gap-1.5 text-[11.5px] text-ink-3">原图</p>
          <img class="block w-full rounded-xs border border-line bg-[#101010]" src="${img.previewUrl}" alt="原图" loading="lazy" />
        </div>
        <div class="min-w-0">
          <p class="mx-0.5 mb-1.5 flex items-center gap-1.5 text-[11.5px] text-ink-3">
            <svg class="icon icon-sm"><use href="#i-check"/></svg>去水印后
          </p>
          <img class="block w-full rounded-xs border border-line bg-[#101010]" src="${img.resultUrl}" alt="去水印结果" loading="lazy" />
        </div>
      </div>
    `;
		card.querySelector('[data-act="dl"]')!.addEventListener('click', async () => {
			const url = img.resultUrl!;
			const base = img.name.replace(/\.[^.]+$/, '') || 'image';
			const ext = img.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? 'jpg';
			const name = `${base}_nowatermark.${ext}`;
			try {
				const res = await fetch(url, { mode: 'cors' });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const blob = await res.blob();
				const objUrl = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = objUrl;
				a.download = name;
				a.click();
				setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
			} catch {
				const a = document.createElement('a');
				a.href = url;
				a.target = '_blank';
				a.rel = 'noopener';
				a.click();
			}
		});
		list.appendChild(card);
	}
	if (doneImages.length) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updateActionbar() {
	const pending = images.filter((i) => i.status === 'idle' || i.status === 'need_paint');
	$('actionbar').hidden = images.length === 0;
	$('actionbarSpacer').hidden = images.length === 0;
	$('actionbarInfo').textContent = running ? `处理中… ${images.filter((i) => i.status === 'done').length}/${images.length} 完成` : `已选择 ${images.length} 张`;
	$<HTMLButtonElement>('processBtn').disabled = running || pending.length === 0;
}

/* ============ 遮罩编辑器 ============ */

function loadImageForEditor(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const el = new Image();
		el.crossOrigin = 'anonymous';
		el.onload = () => resolve(el);
		el.onerror = () => {
			// 跨域失败降级为普通加载（画布会被污染，但遮罩导出只用笔划、不读像素）
			const plain = new Image();
			plain.onload = () => resolve(plain);
			plain.onerror = () => reject(new Error('图片加载失败，无法进入涂抹模式'));
			plain.src = src;
		};
		el.src = src;
	});
}

async function openEditor(imageId: string) {
	const img = images.find((i) => i.id === imageId);
	if (!img) return;

	let el: HTMLImageElement;
	try {
		el = await loadImageForEditor(img.previewUrl);
	} catch (err) {
		toast((err as Error).message, 'err');
		return;
	}

	editor = {
		img,
		el,
		strokes: [],
		drawing: false,
		current: null,
		scale: 1,
		onPointerUp: () => strokeFinish()
	};

	const modal = $('maskModal');
	modal.classList.remove('hidden');
	modal.classList.add('flex');

	const canvas = $<HTMLCanvasElement>('maskCanvas');
	const wrap = $('maskCanvasWrap');
	const maxW = Math.min(wrap.clientWidth - 32, 860);
	const maxH = window.innerHeight * 0.58;
	const fit = Math.min(maxW / el.naturalWidth, maxH / el.naturalHeight, 1);
	canvas.width = Math.round(el.naturalWidth * fit);
	canvas.height = Math.round(el.naturalHeight * fit);
	editor.scale = 1 / fit; // 显示坐标 → 原图坐标

	canvas.onpointerdown = (e) => strokeStart(e);
	canvas.onpointermove = (e) => strokeMove(e);
	window.addEventListener('pointerup', editor.onPointerUp);

	redrawCanvas();
}

function closeEditor() {
	const modal = $('maskModal');
	modal.classList.add('hidden');
	modal.classList.remove('flex');
	if (editor) window.removeEventListener('pointerup', editor.onPointerUp);
	const canvas = $<HTMLCanvasElement>('maskCanvas');
	canvas.width = 1;
	canvas.height = 1;
	canvas.onpointerdown = canvas.onpointermove = null;
	editor = null;
}

function strokeCoords(e: PointerEvent) {
	const canvas = $<HTMLCanvasElement>('maskCanvas');
	const rect = canvas.getBoundingClientRect();
	return {
		x: ((e.clientX - rect.left) * canvas.width) / rect.width,
		y: ((e.clientY - rect.top) * canvas.height) / rect.height
	};
}

function strokeStart(e: PointerEvent) {
	e.preventDefault();
	if (!editor) return;
	editor.drawing = true;
	const p = strokeCoords(e);
	const size = Number($<HTMLInputElement>('maskBrushSize').value);
	editor.current = { points: [p], size };
	paintSegment($<HTMLCanvasElement>('maskCanvas').getContext('2d')!, null, p, size);
}

function strokeMove(e: PointerEvent) {
	if (!editor?.drawing) return;
	e.preventDefault();
	const p = strokeCoords(e);
	const cur = editor.current!;
	const last = cur.points[cur.points.length - 1]!;
	cur.points.push(p);
	paintSegment($<HTMLCanvasElement>('maskCanvas').getContext('2d')!, last, p, cur.size);
}

function strokeFinish() {
	if (!editor?.drawing) return;
	editor.drawing = false;
	if (editor.current) {
		editor.strokes.push(editor.current);
		editor.current = null;
	}
}

function paintSegment(ctx: CanvasRenderingContext2D, from: { x: number; y: number } | null, to: { x: number; y: number }, size: number) {
	ctx.strokeStyle = ctx.fillStyle = '#ffffff';
	ctx.lineWidth = size;
	ctx.lineCap = ctx.lineJoin = 'round';
	if (!from) {
		ctx.beginPath();
		ctx.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
		ctx.fill();
		return;
	}
	ctx.beginPath();
	ctx.moveTo(from.x, from.y);
	ctx.lineTo(to.x, to.y);
	ctx.stroke();
}

function redrawCanvas() {
	const canvas = $<HTMLCanvasElement>('maskCanvas');
	const ctx = canvas.getContext('2d')!;
	const { el, strokes, current } = editor!;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	try {
		ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
	} catch {
		/* 跨域污染不影响笔划绘制 */
	}
	for (const s of strokes) replayStroke(ctx, s);
	if (current) replayStroke(ctx, current);
}

function replayStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
	const pts = stroke.points;
	if (pts.length === 1) {
		paintSegment(ctx, null, pts[0]!, stroke.size);
	} else {
		for (let i = 1; i < pts.length; i++) {
			paintSegment(ctx, pts[i - 1]!, pts[i]!, stroke.size);
		}
	}
}

function undoStroke() {
	if (!editor) return;
	editor.strokes.pop();
	redrawCanvas();
}

function clearStrokes() {
	if (!editor) return;
	editor.strokes = [];
	redrawCanvas();
}

/** 按原图全分辨率重放笔划，导出白笔划透明底 PNG dataURL */
function saveMask() {
	if (!editor) return;
	strokeFinish();
	const { img, el, strokes, scale } = editor;

	const off = document.createElement('canvas');
	off.width = el.naturalWidth;
	off.height = el.naturalHeight;
	const octx = off.getContext('2d')!;
	octx.imageSmoothingEnabled = true;

	for (const s of strokes) {
		replayStroke(octx, {
			size: s.size * scale,
			points: s.points.map((p) => ({ x: p.x * scale, y: p.y * scale }))
		});
	}

	img.mask = off.toDataURL('image/png');
	closeEditor();
	renderGallery();
}

/* ============ 处理流程 ============ */

async function processImages(targets: AppImage[]) {
	if (!targets.length || running) return;
	running = true;
	targets.forEach((img) => {
		img.status = 'queued';
		img.progress = 0;
		img.message = '';
		img.resultUrl = null;
	});
	renderProgressList();
	updateActionbar();

	let cursor = 0;
	const worker = async () => {
		while (cursor < targets.length) {
			const img = targets[cursor++]!;
			await processOne(img);
		}
	};
	await Promise.all(Array.from({ length: Math.min(SUBMIT_CONCURRENCY, targets.length) }, worker));

	running = false;
	renderResults();
	renderProgressList();
	updateActionbar();
}

async function processOne(img: AppImage) {
	img.status = 'submitting';
	img.message = '正在上传图片…';
	patchProgressCard(img);

	try {
		const payload: Record<string, unknown> = { id: img.id };
		if (img.kind === 'url') {
			payload.imageUrl = img.source;
		} else {
			payload.base64 = await blobToDataUrl(img.source as Blob);
		}
		if (img.mask) payload.mask = img.mask;

		let data: SubmitResultData | null = null;
		for (let attempt = 0; attempt < 4; attempt++) {
			const res = await fetch(`${API_BASE}/removals`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});

			if (res.status === 429) {
				const wait = (parseInt(res.headers.get('retry-after') || '5', 10) || 5) + 0.5;
				img.status = 'queued';
				img.message = `触发限速，${Math.ceil(wait)} 秒后重试…`;
				patchProgressCard(img);
				toast(`提交过于频繁，${Math.ceil(wait)} 秒后自动重试`, 'err');
				await sleep(wait * 1000);
				img.status = 'submitting';
				patchProgressCard(img);
				continue;
			}

			const json = await res.json().catch(() => ({}) as Record<string, unknown>);
			if (!res.ok || !json.success) {
				throw new Error((json.message as string) || `HTTP ${res.status}`);
			}
			data = json.data as SubmitResultData;
			break;
		}

		if (!data) throw new Error('提交失败，请稍后重试');

		if (data.status === 'need_paint') {
			img.status = 'need_paint';
			img.progress = 0;
			img.message = data.message || '未找到水印，请涂抹后重试';
			img.taskId = null;
			img.uploadedImage = data.uploadedImage;
			patchProgressCard(img);
			return;
		}

		img.taskId = data.taskId!;
		img.status = 'processing';
		img.progress = 10;
		img.message = '任务已创建，等待处理…';
		patchProgressCard(img);
		await pollTask(img);
	} catch (err) {
		img.status = 'error';
		img.message = (err as Error).message || '处理失败';
		patchProgressCard(img);
	}
}

async function pollTask(img: AppImage) {
	for (let attempt = 0; attempt < 150; attempt++) {
		await sleep(POLL_INTERVAL);
		try {
			const res = await fetch(`${API_BASE}/removals/${encodeURIComponent(img.taskId!)}`);
			if (!res.ok) continue;
			const json = await res.json();
			if (!json.success) continue;
			const s = json.data as RemovalStatusData;

			img.progress = Math.max(img.progress, Math.min(99, s.progress ?? img.progress));
			if (s.status === 'done' && s.resultUrl) {
				img.status = 'done';
				img.progress = 100;
				img.resultUrl = s.resultUrl;
				img.message = '';
				patchProgressCard(img);
				return;
			}
			if (s.status === 'error') {
				throw new Error(s.message || '百度处理失败');
			}
			img.message = `AI 处理中 ${s.progress ?? 0}%`;
			patchProgressCard(img);
		} catch (err) {
			img.status = 'error';
			img.message = (err as Error).message || '查询任务失败';
			patchProgressCard(img);
			return;
		}
	}
	img.status = 'error';
	img.message = '任务处理超时';
	patchProgressCard(img);
}

/* ============ 初始化 ============ */

function bindMaskEditor() {
	$('maskCloseBtn').addEventListener('click', closeEditor);
	$('maskUndoBtn').addEventListener('click', undoStroke);
	$('maskClearBtn').addEventListener('click', clearStrokes);
	$('maskSaveBtn').addEventListener('click', saveMask);
	const slider = $<HTMLInputElement>('maskBrushSize');
	slider.addEventListener('input', () => {
		$('maskBrushValue').textContent = slider.value;
	});
	$('maskModal').addEventListener('click', (e) => {
		if (e.target === $('maskModal')) closeEditor();
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !$('maskModal').classList.contains('hidden')) closeEditor();
	});
}

function bindActionbar() {
	$('processBtn').addEventListener('click', () => {
		const pending = images.filter((i) => i.status === 'idle' || i.status === 'need_paint');
		processImages(pending);
	});
	$('clearBtn').addEventListener('click', clearAll);
}

document.addEventListener('DOMContentLoaded', () => {
	const svgNS = 'http://www.w3.org/2000/svg';

	const logoSvg = document.getElementById('logoIcon');
	if (logoSvg) {
		const logoPath = document.createElementNS(svgNS, 'path');
		logoPath.setAttribute('d', siGooglephotos.path);
		logoPath.setAttribute('fill', 'url(#logo-grad)');
		logoSvg.querySelector('path')?.remove();
		logoSvg.appendChild(logoPath);
	}

	const githubPath = document.createElementNS(svgNS, 'path');
	githubPath.setAttribute('d', siGithub.path);
	document.getElementById('i-github')?.replaceChildren(githubPath);
	bindUpload();
	bindUrlInput();
	bindPaste();
	bindActionbar();
	bindMaskEditor();
});
