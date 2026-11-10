// Runtime.evaluate expressions for a page's media, from chrome-extension/lib/media.js (images omitted: Pipeline saves audio/video only).

// Runtime.evaluate expression: collect the resolved sources of every media
// element. currentSrc is what the browser actually chose to play.
export const MEDIA_SOURCE_EXPRESSION = `(() => {
  const urls = new Set();
  for (const el of document.querySelectorAll('video, audio')) {
    if (el.currentSrc) urls.add(el.currentSrc);
    if (el.src) urls.add(el.src);
    for (const s of el.querySelectorAll('source')) {
      if (s.src) urls.add(s.src);
    }
  }
  return [...urls];
})()`;

// Runtime.evaluate expression: does this page present a video the user has not
// played? X/Twitter, Instagram and similar build the <video> element only on
// the first play, so at capture time there is no media element and no manifest
// request to find — only the poster and the player chrome. When this is true we
// hand the page URL to the backend so yt-dlp can reconstruct the clip.
export const VIDEO_INDICATOR_EXPRESSION = `(() => {
  if (document.querySelector('video, audio')) return false;
  const selectors = [
    'meta[property="og:video"]',
    'meta[property="og:video:url"]',
    'meta[name="twitter:player"]',
    '[data-testid="videoPlayer"]',
    '[data-testid="videoComponent"]',
    '[data-testid="playButton"]',
    '[aria-label="Play"]',
    '[role="button"][aria-label*="Play" i]'
  ];
  if (selectors.some((selector) => document.querySelector(selector))) return true;
  // X serves the poster frame of a tweet video from video.twimg.com even before
  // the player is built, so its presence means "there is a clip here".
  return [...document.querySelectorAll('img')].some((el) =>
    (el.currentSrc || el.src || '').includes('video.twimg.com')
  );
})()`;

const STREAMING_SUFFIXES = ['.m3u8', '.mpd'];
const STREAMING_MIME_HINTS = ['mpegurl', 'dash+xml'];

function pathname(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return '';
  }
}

export function isStreamingUrl(url, mimeType = '') {
  const path = pathname(url);
  const mime = (mimeType || '').toLowerCase();
  return (
    STREAMING_SUFFIXES.some((suffix) => path.endsWith(suffix)) ||
    STREAMING_MIME_HINTS.some((hint) => mime.includes(hint))
  );
}

// Runtime.evaluate expression: collect the full-resolution source of every
// content image. Page furniture (avatars, icons, spacers, tracking pixels) is
// excluded by rendered size here and by isRelevantImageUrl below.
export const IMAGE_SOURCE_EXPRESSION = `(() => {
  const urls = new Set();
  const add = (value) => {
    if (typeof value !== 'string' || !value) return;
    try {
      const resolved = new URL(value, location.href).href;
      if (/^https?:/i.test(resolved)) urls.add(resolved);
    } catch { /* an unresolvable candidate is simply skipped */ }
  };
  // A responsive image lists several resolutions; archive the largest.
  const widest = (srcset) => {
    let best = null;
    let bestWidth = -1;
    for (const candidate of srcset.split(',')) {
      const [url, descriptor] = candidate.trim().split(/\\s+/);
      if (!url) continue;
      const width = descriptor && descriptor.endsWith('w') ? parseInt(descriptor, 10) : 0;
      if (width >= bestWidth) { bestWidth = width; best = url; }
    }
    return best;
  };
  for (const el of document.querySelectorAll('img')) {
    const width = el.naturalWidth || el.width || 0;
    const height = el.naturalHeight || el.height || 0;
    if (width < 200 && height < 200) continue;
    if (el.srcset) add(widest(el.srcset));
    add(el.currentSrc);
    add(el.src);
  }
  // A poster frame is the only still we get for a clip we cannot fetch.
  for (const el of document.querySelectorAll('video[poster]')) add(el.poster);
  for (const el of document.querySelectorAll(
    'meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"]'
  )) add(el.content);
  return [...urls];
})()`;

// Recurring page furniture that is never the evidence itself.
const IRRELEVANT_IMAGE_PATTERNS = [
  'twimg.com/profile_images',
  'twimg.com/default_profile_images',
  'cdninstagram.com/rsrc.php/',
  'telegram.org/img/emoji/',
  'static.licdn.com',
  'emoji.redditmedia.com',
  'favicon'
];
const IRRELEVANT_IMAGE_SUFFIXES = ['.svg', '.ico'];

// X serves a downscaled image by default (name=small/medium). The original is
// always available under name=orig, so upgrade before archiving.
export function bestQualityImageUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('twimg.com')) return url;
    if (!parsed.searchParams.has('name')) return url;
    parsed.searchParams.set('name', 'orig');
    return parsed.toString();
  } catch {
    return url;
  }
}

export function isRelevantImageUrl(url) {
  if (typeof url !== 'string' || !/^https?:/i.test(url)) return false;
  const withoutQuery = url.split('?')[0].toLowerCase();
  if (IRRELEVANT_IMAGE_SUFFIXES.some((suffix) => withoutQuery.endsWith(suffix))) return false;
  return !IRRELEVANT_IMAGE_PATTERNS.some((pattern) => withoutQuery.includes(pattern));
}

// Subtitle/caption tracks the page declares on its media elements.
export const TRACK_SOURCE_EXPRESSION = `(() => [...document.querySelectorAll('video track[src], audio track[src]')]
  .filter((t) => /^(subtitles|captions)$/i.test(t.kind || 'subtitles'))
  .map((t) => ({ url: t.src, label: t.label || '', lang: t.srclang || '' })))()`;

// Marks pages that ask for DRM (EME): installed in every capture tab so a failed media grab can say "DRM" explicitly.
export const EME_MARK = `(() => {
  const ask = navigator.requestMediaKeySystemAccess;
  if (ask) navigator.requestMediaKeySystemAccess = function (...args) { window.__pipelineEme = args[0]; return ask.apply(this, args); };
})()`;
