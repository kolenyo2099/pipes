// Functions injected into the captured page with chrome.scripting.executeScript.
// Each is serialized on its own, so none may reference anything outside itself.

export function probePage() {
  const mediaSources = [];
  for (const el of document.querySelectorAll('video, audio')) {
    for (const src of [el.currentSrc, el.src, ...[...el.querySelectorAll('source')].map((s) => s.src)]) {
      if (src) mediaSources.push(src);
    }
  }
  return {
    url: location.href,
    title: document.title,
    mediaSources,
    resources: performance.getEntriesByType('resource').map((entry) => entry.name)
  };
}

// Same-origin from inside instagram.com, so the request carries the page's own
// session and headers exactly as Instagram's web app sends it.
export async function instagramInfoInPage(mediaId) {
  const response = await fetch(`/api/v1/media/${mediaId}/info/`, {
    credentials: 'include',
    headers: { 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest' }
  });
  if (!response.ok) return { error: `Instagram answered HTTP ${response.status}` };
  try {
    return await response.json();
  } catch {
    return { error: 'Instagram did not return media info (log in to Instagram in this browser)' };
  }
}

export function largestVideoInPage() {
  let best = null;
  for (const video of document.querySelectorAll('video')) {
    const area = video.clientWidth * video.clientHeight;
    if (!best || area > best.area) best = { area, ready: video.readyState > 0 };
  }
  return best;
}

// Play the main video from the start, muted, so the recorder sees every
// segment. YouTube's player is first asked for its best quality so the recording
// is not whatever the adaptive logic picked for a small tab. Nothing recorded
// so far is dropped: the player may already have buffered the whole clip and
// will not append it again, and a quality switch starts a separate file anyway.
// A short YouTube video can finish while the page evidence is being captured, and the player then autoplays
// something else. Reports whether that happened and how long the requested video is (from the page's own data,
// which describes the video the address asked for), so its recording can be told apart from the others.
export function requestedVideoInPage(wanted) {
  const details = window.ytInitialPlayerResponse?.videoDetails;
  const current = document.getElementById('movie_player')?.getVideoData?.().video_id;
  return { moved: Boolean(wanted && current && current !== wanted), length: details?.videoId === wanted ? Number(details.lengthSeconds) || null : null };
}

export function startPlaybackInPage(rate) {
  const videos = [...document.querySelectorAll('video')];
  if (!videos.length) return null;
  const video = videos.reduce((a, b) => (b.clientWidth * b.clientHeight > a.clientWidth * a.clientHeight ? b : a));
  let quality = null;
  const player = document.getElementById('movie_player');
  if (player?.getAvailableQualityLevels) {
    // The best quality up to 1080p: recording plays at many times normal speed, and above 1080p the browser cannot
    // decode fast enough to keep the player fetching, so the recording stalls and comes out partial.
    const levels = player.getAvailableQualityLevels().filter((q) => q !== 'auto');
    quality = levels.find((q) => !/^(highres|hd2880|hd2160|hd1440)$/.test(q)) ?? levels[0] ?? null;
    if (quality) player.setPlaybackQualityRange(quality, quality);
  }
  // Chrome pauses unmuted playback without a user gesture, and YouTube
  // restores its own volume setting, so mute through its API too.
  player?.mute?.();
  video.muted = true;
  video.loop = false;
  // Setting currentTime fires a seek even when it is already 0, and some
  // players (dash.js) answer a seek by flushing and re-appending their buffer.
  if (video.currentTime > 0) video.currentTime = 0;
  video.playbackRate = rate;
  video.play().catch(() => {});
  // At 16x a short clip ends between two polls, and YouTube then autoplays the next video into the same
  // buffers. Pause the instant the requested video ends; runs of other videos are dropped afterwards by length.
  video.addEventListener('ended', () => { window.__hrcEnded = true; video.pause(); }, { once: true });
  window.__hrcVideo = video;
  window.__hrcRate = rate;
  return { quality, duration: video.duration, usesMse: video.src.startsWith('blob:') };
}

export function pollPlaybackInPage() {
  const video = window.__hrcVideo;
  if (!video) return null;
  // Players reset the rate or pause on their own (buffering, "are you still
  // watching"); keep pushing until the end.
  if (!video.ended && !window.__hrcEnded) {
    if (!video.muted) video.muted = true;
    if (video.playbackRate !== window.__hrcRate) video.playbackRate = window.__hrcRate;
    if (video.paused) video.play().catch(() => {});
  }
  const buffered = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
  return { paused: video.paused, rate: video.playbackRate, ready: video.readyState, time: video.currentTime, buffered, duration: video.duration, ended: video.ended || Boolean(window.__hrcEnded), bytes: window.__hrcMse?.totalBytes() ?? 0 };
}

export function pauseInPage() {
  window.__hrcVideo?.pause();
}

export function recordingSummaryInPage() {
  return window.__hrcMse?.summary() ?? null;
}

export function readRecordingInPage(buffer, run, from) {
  return window.__hrcMse.read(buffer, run, from);
}

export function drainRecordingInPage(buffer, run) {
  return window.__hrcMse.drain(buffer, run);
}

export function stopRecordingInPage() {
  window.__hrcMse?.stop();
}
