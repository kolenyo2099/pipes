// HLS: fetch the playlist the player used and join its segments byte for byte.
// The result is what the server sent (MPEG-TS or fMP4), not a re-encode, so each
// segment can still be checked against the source. AES-128 is decrypted with
// WebCrypto; SAMPLE-AES and DRM key systems are refused.

import { downloadItems, fetchBytes } from './net.js';

export function parseAttributes(list) {
  const attrs = {};
  for (const [, key, value] of list.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    attrs[key] = value.startsWith('"') ? value.slice(1, -1) : value;
  }
  return attrs;
}

const lines = (text) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const after = (line, tag) => line.slice(tag.length);

export function isMasterPlaylist(text) {
  return text.includes('#EXT-X-STREAM-INF');
}

export function parseMaster(text, baseUrl) {
  const all = lines(text);
  const variants = [];
  const renditions = [];
  all.forEach((line, index) => {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributes(after(line, '#EXT-X-STREAM-INF:'));
      const uri = all.slice(index + 1).find((next) => !next.startsWith('#'));
      if (!uri) return;
      variants.push({
        url: new URL(uri, baseUrl).href,
        bandwidth: Number(attrs.BANDWIDTH) || 0,
        resolution: attrs.RESOLUTION ?? null,
        audioGroup: attrs.AUDIO ?? null
      });
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(after(line, '#EXT-X-MEDIA:'));
      // A rendition without a URI is muxed into the variant stream itself.
      if (attrs.TYPE !== 'AUDIO' || !attrs.URI) return;
      renditions.push({
        url: new URL(attrs.URI, baseUrl).href,
        group: attrs['GROUP-ID'],
        isDefault: attrs.DEFAULT === 'YES',
        name: attrs.NAME ?? null
      });
    }
  });
  return { variants, renditions };
}

// Highest bandwidth wins. When its audio is a separate rendition (X does this),
// that rendition has to be fetched too or the video is silent.
export function pickVariant({ variants, renditions }) {
  const video = variants.reduce((best, v) => (v.bandwidth > best.bandwidth ? v : best));
  const group = renditions.filter((r) => r.group === video.audioGroup);
  return { video, audio: group.find((r) => r.isDefault) ?? group[0] ?? null };
}

function hexBytes(hex) {
  const clean = hex.replace(/^0x/i, '').padStart(32, '0');
  return Uint8Array.from(clean.match(/../g), (pair) => parseInt(pair, 16));
}

// RFC 8216 §5.2: without an explicit IV, the IV is the media sequence number.
export function sequenceIv(sequence) {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setBigUint64(8, BigInt(sequence));
  return iv;
}

function byteRange(spec, defaultOffset) {
  const [length, offset] = spec.split('@').map(Number);
  return { length, offset: offset ?? defaultOffset };
}

export function parseMedia(text, baseUrl) {
  let sequence = 0;
  let key = null;
  let map = null;
  let pendingRange = null;
  let unsupported = null;
  let ended = false;
  const lastEnd = new Map(); // a BYTERANGE without @offset continues the previous one
  const segments = [];
  for (const line of lines(text)) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      sequence = Number(after(line, '#EXT-X-MEDIA-SEQUENCE:')) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(after(line, '#EXT-X-KEY:'));
      if (attrs.METHOD === 'NONE') key = null;
      else if (attrs.METHOD === 'AES-128' && (!attrs.KEYFORMAT || attrs.KEYFORMAT === 'identity')) {
        key = { url: new URL(attrs.URI, baseUrl).href, iv: attrs.IV ? hexBytes(attrs.IV) : null };
      } else {
        unsupported = attrs.KEYFORMAT ? `${attrs.METHOD} (${attrs.KEYFORMAT})` : attrs.METHOD;
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(after(line, '#EXT-X-MAP:'));
      map = { url: new URL(attrs.URI, baseUrl).href, range: attrs.BYTERANGE ? byteRange(attrs.BYTERANGE, 0) : null };
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = after(line, '#EXT-X-BYTERANGE:');
    } else if (line === '#EXT-X-ENDLIST') {
      ended = true;
    } else if (!line.startsWith('#')) {
      const url = new URL(line, baseUrl).href;
      let range = null;
      if (pendingRange) {
        range = byteRange(pendingRange, lastEnd.get(url) ?? 0);
        lastEnd.set(url, range.offset + range.length);
        pendingRange = null;
      }
      segments.push({ url, range, key, map, sequence });
      sequence += 1;
    }
  }
  return { segments, live: !ended, unsupported };
}

// fMP4 needs its init section ahead of the first segment and again wherever
// it changes (after a discontinuity). MPEG-TS carries no init section.
export function playlistItems(playlist) {
  const items = [];
  let currentMap = null;
  for (const segment of playlist.segments) {
    if (segment.map && segment.map !== currentMap) {
      items.push({ url: segment.map.url, range: segment.map.range, key: null });
      currentMap = segment.map;
    }
    items.push(segment);
  }
  return items;
}

export function hlsExtension(playlist, kind) {
  if (playlist.segments.some((s) => s.map)) return kind === 'audio' ? '.m4a' : '.mp4';
  const path = new URL(playlist.segments[0].url).pathname.toLowerCase();
  return ['.aac', '.mp3', '.ac3', '.ec3'].find((ext) => path.endsWith(ext)) ?? '.ts';
}

export async function downloadPlaylist(playlist, { onProgress } = {}) {
  if (playlist.unsupported) throw new Error(`encrypted with ${playlist.unsupported}; only AES-128 can be decrypted`);
  if (!playlist.segments.length) throw new Error('the playlist lists no segments');
  const keys = new Map();
  const keyFor = (key) => {
    if (!keys.has(key.url)) {
      keys.set(key.url, fetchBytes(key.url).then((raw) => crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt'])));
    }
    return keys.get(key.url);
  };
  return downloadItems(playlistItems(playlist), {
    onProgress,
    transform: async (item, bytes) => {
      if (!item.key) return bytes;
      const iv = item.key.iv ?? sequenceIv(item.sequence);
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, await keyFor(item.key), bytes));
    }
  });
}

// From a fetched playlist to the tracks to save: a master playlist resolves to
// its best variant (plus a separate audio rendition when it has one).
export async function resolveTracks({ text, url }, fetchText) {
  if (!isMasterPlaylist(text)) return [{ kind: 'stream', url, playlist: parseMedia(text, url) }];
  const { video, audio } = pickVariant(parseMaster(text, url));
  const tracks = [];
  for (const [kind, entry] of [['video', video], ['audio', audio]]) {
    if (!entry) continue;
    const media = await fetchText(entry.url);
    tracks.push({ kind, url: media.url, resolution: entry.resolution, playlist: parseMedia(media.text, media.url) });
  }
  return tracks;
}

// URLs a master playlist points at: the page also requested these directly,
// and saving them again separately would duplicate the master's tracks.
export function referencedPlaylists({ text, url }) {
  if (!isMasterPlaylist(text)) return [];
  const { variants, renditions } = parseMaster(text, url);
  return [...variants, ...renditions].map((entry) => entry.url);
}
