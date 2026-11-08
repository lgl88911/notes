// ===== 媒体：采集、压缩、时长/波形提取 =====

export const LIMITS = {
  imageMaxEdge: 1600,
  imageQuality: 0.82,
  maxFileBytes: 25 * 1024 * 1024, // 单文件 25MB，避免撑爆仓库
  audioMaxSeconds: 60 * 10,
};

/* ---------------- 图片 ---------------- */

export async function compressImage(file) {
  const bmp = await loadBitmap(file);
  const { width, height } = bmp;
  const maxEdge = LIMITS.imageMaxEdge;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();

  const blob = await canvasToBlob(canvas, 'image/webp', LIMITS.imageQuality);
  if (!blob) {
    const jpeg = await canvasToBlob(canvas, 'image/jpeg', 0.86);
    return { blob: jpeg, mime: 'image/jpeg', w, h };
  }
  return { blob, mime: blob.type || 'image/webp', w, h };
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    if (canvas.toBlob) canvas.toBlob((b) => resolve(b), type, quality);
    else resolve(null);
  });
}

async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      try { return await createImageBitmap(file); } catch { /* fall through */ }
    }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
    img.src = url;
  });
}

/* ---------------- 视频 ---------------- */

export async function inspectVideo(file) {
  const info = { dur: 0, w: 0, h: 0 };
  const url = URL.createObjectURL(file);
  try {
    await new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.playsInline = true;
      v.onloadedmetadata = () => {
        info.dur = Number.isFinite(v.duration) ? v.duration : 0;
        info.w = v.videoWidth || 0;
        info.h = v.videoHeight || 0;
        resolve();
      };
      v.onerror = () => resolve();
      setTimeout(resolve, 4000);
      v.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
  return info;
}

/* ---------------- 音频录制 ---------------- */

const AUDIO_MIMES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
];

export function pickAudioMime() {
  if (!window.MediaRecorder) return '';
  for (const m of AUDIO_MIMES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export function createRecorder() {
  let stream = null;
  let rec = null;
  let chunks = [];
  let audioCtx = null;
  let analyser = null;
  let raf = 0;
  let levels = [];
  let startedAt = 0;
  let wakeLock = null;

  const state = { recording: false, level: 0, seconds: 0, mime: '' };

  async function start() {
    if (state.recording) return;
    state.mime = pickAudioMime();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    chunks = [];
    levels = [];
    rec = new MediaRecorder(stream, state.mime ? { mimeType: state.mime, audioBitsPerSecond: 96000 } : undefined);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.start(250);
    startedAt = performance.now();
    state.recording = true;

    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { audioCtx = null; }
    if (audioCtx) {
      const src = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!state.recording) return;
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = Math.abs(buf[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        state.level = Math.min(1, peak * 1.7);
        levels.push(Math.round(state.level * 100));
        state.seconds = (performance.now() - startedAt) / 1000;
        if (state.seconds >= LIMITS.audioMaxSeconds) stop();
        raf = requestAnimationFrame(tick);
      };
      tick();
    }

    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch { /* ignore */ }
  }

  function teardown() {
    cancelAnimationFrame(raf);
    raf = 0;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    analyser = null;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    state.recording = false;
    state.level = 0;
  }

  function stop() {
    return new Promise((resolve) => {
      if (!rec || rec.state === 'inactive') { teardown(); resolve(null); return; }
      rec.onstop = async () => {
        const dur = (performance.now() - startedAt) / 1000;
        const type = rec.mimeType || state.mime || 'audio/webm';
        const blob = new Blob(chunks, { type });
        const wave = downsample(levels, 48);
        teardown();
        resolve({ blob, mime: type, dur, wave });
      };
      try { rec.stop(); } catch { teardown(); resolve(null); }
    });
  }

  function cancel() {
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
    teardown();
  }

  return { state, start, stop, cancel };
}

export function downsample(arr, n) {
  if (!arr.length) return new Array(n).fill(0);
  const out = [];
  const block = arr.length / n;
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i * block);
    const e = Math.max(s + 1, Math.floor((i + 1) * block));
    let sum = 0;
    for (let j = s; j < e && j < arr.length; j++) sum += arr[j];
    out.push(Math.round(sum / (e - s)));
  }
  return out;
}

/** 播放时用的 object URL 缓存 */
const urlCache = new Map();
export function objectUrl(key, blob) {
  if (urlCache.has(key)) return urlCache.get(key);
  const u = URL.createObjectURL(blob);
  urlCache.set(key, u);
  return u;
}
export function revokeUrl(key) {
  if (urlCache.has(key)) {
    URL.revokeObjectURL(urlCache.get(key));
    urlCache.delete(key);
  }
}
