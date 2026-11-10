// Which of the URLs a page loaded can be saved whole, and what to call the files.

const PROGRESSIVE_PATH = /\.(mp4|m4v|m4a|mov|webm|mp3|aac|ogg|oga|ogv|opus|wav|flac)$/;
// Byte-range fragments of a bigger stream (Instagram's bytestart/byteend,
// YouTube's range/rn): fetching one URL gives a partial file.
const FRAGMENT_PARAMS = ['bytestart', 'byteend', 'range', 'rn', 'rbuf'];
// YouTube serves only fragments and SABR requests; its media comes from recording.
const RECORD_ONLY_HOSTS = ['googlevideo.com'];

function parse(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

// 'hls' | 'dash' | 'progressive' | null
export function classifyUrl(url, { fromMediaElement = false } = {}) {
  const parsed = parse(url);
  if (!parsed) return null;
  const host = parsed.hostname;
  if (RECORD_ONLY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  const path = parsed.pathname.toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  if (FRAGMENT_PARAMS.some((p) => parsed.searchParams.has(p))) return null;
  // A <video src> is a file even without an extension; a bare network entry is not.
  if (fromMediaElement || PROGRESSIVE_PATH.test(path)) return 'progressive';
  return null;
}

// frames: results of probePage() from every frame of the tab.
export function classifyProbe(frames) {
  const found = { progressive: new Set(), hls: new Set(), dash: new Set() };
  for (const frame of frames) {
    for (const url of frame?.mediaSources ?? []) {
      const kind = classifyUrl(url, { fromMediaElement: true });
      if (kind) found[kind].add(url);
    }
    for (const url of frame?.resources ?? []) {
      const kind = classifyUrl(url);
      if (kind) found[kind].add(url);
    }
  }
  return { progressive: [...found.progressive], hls: [...found.hls], dash: [...found.dash] };
}

const EXTENSION_BY_MIME = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/ogg': '.ogv',
  'video/mp2t': '.ts',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/wav': '.wav',
  'audio/webm': '.webm',
  'audio/flac': '.flac',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif'
};

export function baseMime(contentType) {
  return (contentType || '').split(';')[0].trim().toLowerCase();
}

export function extensionFor(contentType, fallback = '.bin') {
  return EXTENSION_BY_MIME[baseMime(contentType)] ?? fallback;
}

export function isSavableType(contentType) {
  const mime = baseMime(contentType);
  return mime.startsWith('video/') || mime.startsWith('audio/') || mime.startsWith('image/');
}

export function base64ToBytes(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
