// DASH: read the MPD the player used, pick the best video and audio
// representation, and join init + media segments byte for byte. Video and audio
// stay separate files. Merging them would need a remux (ffmpeg/mp4box), and the
// separate tracks are exactly what the server sent.
// Needs DOMParser, so it runs in capture.html, not the service worker.

const kids = (el, name) => [...(el?.children ?? [])].filter((child) => child.localName === name);
const kid = (el, name) => kids(el, name)[0] ?? null;

export function parseDuration(iso) {
  const match = /^P(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(iso ?? '');
  if (!match) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((v) => Number(v ?? 0));
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

export function fillTemplate(template, vars) {
  return template.replace(/\$\$|\$(RepresentationID|Number|Time|Bandwidth)(?:%0(\d+)d)?\$/g, (match, name, width) => {
    if (match === '$$') return '$';
    const value = String(vars[name]);
    return width ? value.padStart(Number(width), '0') : value;
  });
}

function parseRange(spec) {
  if (!spec) return null;
  const [start, end] = spec.split('-').map(Number);
  return { offset: start, length: end - start + 1 };
}

function baseOf(el, parentBase) {
  const base = kid(el, 'BaseURL')?.textContent.trim();
  return base ? new URL(base, parentBase).href : parentBase;
}

function kindOf(set, rep) {
  const type = set.getAttribute('contentType') || set.getAttribute('mimeType') || rep?.getAttribute('mimeType') || '';
  if (type.startsWith('video')) return 'video';
  if (type.startsWith('audio')) return 'audio';
  return null; // subtitles, thumbnails
}

function segmentsFor(rep, set, period, repBase, periodDuration) {
  const vars = { RepresentationID: rep.getAttribute('id'), Bandwidth: rep.getAttribute('bandwidth') };
  // SegmentTemplate/SegmentList attributes inherit Period → AdaptationSet → Representation.
  const templates = [rep, set, period].map((el) => kid(el, 'SegmentTemplate')).filter(Boolean);
  if (templates.length) {
    const attr = (name) => templates.map((t) => t.getAttribute(name)).find((v) => v != null) ?? null;
    const media = attr('media');
    const initTemplate = attr('initialization');
    const timescale = Number(attr('timescale') || 1);
    const offset = Number(attr('presentationTimeOffset') || 0);
    let number = Number(attr('startNumber') ?? 1);
    const segment = (time) => ({ url: new URL(fillTemplate(media, { ...vars, Number: number++, Time: time }), repBase).href, range: null });
    const init = initTemplate ? { url: new URL(fillTemplate(initTemplate, vars), repBase).href, range: null } : null;
    const segments = [];
    const timeline = templates.map((t) => kid(t, 'SegmentTimeline')).find(Boolean);
    if (timeline) {
      const entries = kids(timeline, 'S');
      let time = 0;
      entries.forEach((s, index) => {
        if (s.hasAttribute('t')) time = Number(s.getAttribute('t'));
        const duration = Number(s.getAttribute('d'));
        let repeat = Number(s.getAttribute('r') || 0);
        if (repeat < 0) {
          // r=-1: repeat until the next S@t, or the end of the period.
          const nextStart = entries[index + 1]?.getAttribute('t');
          const end = nextStart != null ? Number(nextStart) : offset + (periodDuration ?? 0) * timescale;
          repeat = Math.max(0, Math.ceil((end - time) / duration) - 1);
        }
        for (let k = 0; k <= repeat; k += 1) {
          segments.push(segment(time));
          time += duration;
        }
      });
    } else {
      const duration = Number(attr('duration'));
      if (!duration || periodDuration == null) throw new Error('segment count unknown (a live stream without a timeline)');
      const count = Math.ceil((periodDuration * timescale) / duration);
      for (let k = 0; k < count; k += 1) segments.push(segment(offset + k * duration));
    }
    return { init, segments };
  }
  const list = [rep, set, period].map((el) => kid(el, 'SegmentList')).find(Boolean);
  if (list) {
    const initEl = kid(list, 'Initialization');
    const init = initEl
      ? { url: new URL(initEl.getAttribute('sourceURL') ?? '', repBase).href, range: parseRange(initEl.getAttribute('range')) }
      : null;
    const segments = kids(list, 'SegmentURL').map((s) => ({
      url: new URL(s.getAttribute('media') ?? '', repBase).href,
      range: parseRange(s.getAttribute('mediaRange'))
    }));
    return { init, segments };
  }
  // SegmentBase or a bare BaseURL: the representation is one file.
  return { init: null, segments: [{ url: repBase, range: null }] };
}

const bandwidth = (rep) => Number(rep.getAttribute('bandwidth')) || 0;

export function parseMpd(xml, mpdUrl) {
  const mpd = new DOMParser().parseFromString(xml, 'application/xml').documentElement;
  if (mpd?.localName !== 'MPD') throw new Error('not a DASH manifest');
  const total = parseDuration(mpd.getAttribute('mediaPresentationDuration'));
  const mpdBase = baseOf(mpd, mpdUrl);
  const periods = kids(mpd, 'Period');
  const tracks = {};
  let drm = false;
  periods.forEach((period, index) => {
    const start = parseDuration(period.getAttribute('start')) ?? 0;
    const nextStart = parseDuration(periods[index + 1]?.getAttribute('start'));
    const periodDuration =
      parseDuration(period.getAttribute('duration')) ?? (nextStart ?? total ?? NaN) - start;
    const periodBase = baseOf(period, mpdBase);
    const best = {};
    for (const set of kids(period, 'AdaptationSet')) {
      const reps = kids(set, 'Representation');
      const kind = kindOf(set, reps[0]);
      if (!kind || !reps.length) continue;
      if (kid(set, 'ContentProtection') || reps.some((r) => kid(r, 'ContentProtection'))) {
        drm = true;
        continue;
      }
      const rep = reps.reduce((a, b) => (bandwidth(b) > bandwidth(a) ? b : a));
      if (!best[kind] || bandwidth(rep) > bandwidth(best[kind].rep)) best[kind] = { rep, set };
    }
    for (const [kind, { rep, set }] of Object.entries(best)) {
      const repBase = baseOf(rep, baseOf(set, periodBase));
      const piece = segmentsFor(rep, set, period, repBase, Number.isNaN(periodDuration) ? null : periodDuration);
      tracks[kind] ??= {
        kind,
        mimeType: rep.getAttribute('mimeType') || set.getAttribute('mimeType') || '',
        bandwidth: bandwidth(rep),
        width: Number(rep.getAttribute('width') || set.getAttribute('width')) || null,
        height: Number(rep.getAttribute('height') || set.getAttribute('height')) || null,
        pieces: []
      };
      tracks[kind].pieces.push(piece);
    }
  });
  return { live: mpd.getAttribute('type') === 'dynamic', drm, tracks: Object.values(tracks) };
}

// Each period starts with its own init segment. ponytail: multi-period
// streams (ad breaks) are joined in order; split them if a player needs it.
export function trackItems(track) {
  return track.pieces.flatMap((piece) => (piece.init ? [piece.init, ...piece.segments] : piece.segments));
}

export function dashExtension(track) {
  const webm = track.mimeType.includes('webm');
  if (track.kind === 'audio') return webm ? '.webm' : '.m4a';
  return webm ? '.webm' : '.mp4';
}
