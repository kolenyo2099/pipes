// Layer 4: the few sites worth a dedicated extractor, because their players
// only build a <video> on first play, so a page nobody played shows nothing.
// Each one reads the site's own media list rather than reverse-engineering the
// player. YouTube has no extractor here: its URLs are signed and throttled per
// session, so it is recorded instead (see startPlaybackInPage in page.js).

export function tweetId(url) {
  return /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:i\/web|[^/]+)\/status(?:es)?\/(\d+)/.exec(url)?.[1] ?? null;
}

// The token X's own embed widget sends to the syndication endpoint (as in
// vercel/react-tweet). Public tweets only; protected or age-restricted ones come
// back as a tombstone and fall through to recording.
export function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

export function syndicationUrl(id) {
  return `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndicationToken(id)}&lang=en`;
}

export function xMedia(tweet) {
  const found = [];
  for (const media of tweet?.mediaDetails ?? []) {
    if (media.type === 'photo') {
      found.push({ kind: 'image', url: `${media.media_url_https}?name=orig` });
      continue;
    }
    const best = (media.video_info?.variants ?? [])
      .filter((v) => v.content_type === 'video/mp4')
      .reduce((a, b) => (!a || (b.bitrate ?? 0) > (a.bitrate ?? 0) ? b : a), null);
    if (best) found.push({ kind: 'video', url: best.url });
  }
  return found;
}

const IG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function instagramShortcode(url) {
  return /^https?:\/\/(?:www\.)?instagram\.com\/(?:[^/]+\/)?(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? null;
}

// A shortcode is the media id in base64url. Private posts append 28 characters.
export function instagramMediaId(shortcode) {
  const code = shortcode.length > 28 ? shortcode.slice(0, -28) : shortcode;
  let id = 0n;
  for (const char of code) id = id * 64n + BigInt(IG_ALPHABET.indexOf(char));
  return id.toString();
}

const largest = (list) =>
  (list ?? []).reduce((a, b) => (!a || b.width * b.height > a.width * a.height ? b : a), null);

export function instagramMedia(info) {
  const item = info?.items?.[0];
  if (!item) return [];
  return (item.carousel_media ?? [item])
    .map((node) => {
      const video = largest(node.video_versions);
      if (video) return { kind: 'video', url: video.url };
      const image = largest(node.image_versions2?.candidates);
      return image ? { kind: 'image', url: image.url } : null;
    })
    .filter(Boolean);
}

export function isYouTube(url) {
  return /^https?:\/\/((www|m|music)\.)?youtube(-nocookie)?\.com\/|^https?:\/\/youtu\.be\//.test(url);
}
