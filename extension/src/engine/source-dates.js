// Source-reported dates from saved HTML. Never fetch or infer a capture date.
const KINDS = {
  "datepublished": "published",
  "dateposted": "published",
  "publishdate": "published",
  "publisheddate": "published",
  "publication_date": "published",
  "publicationdate": "published",
  "article:published_time": "published",
  "article_published_time": "published",
  "og:article:published_time": "published",
  "article:published": "published",
  "og:pubdate": "published",
  "pubdate": "published",
  "citation_publication_date": "published",
  "originalpublicationdate": "published",
  "sailthru.date": "published",
  "rnews:datepublished": "published",
  "nastooh:publishdate": "published",
  "cxenseparse:publishtime": "published",
  "dc.date.issued": "published",
  "dcterms.issued": "published",
  "govpl:site_published": "published",
  "datemodified": "updated",
  "modified_date": "updated",
  "last_updated_date": "updated",
  "last-modified": "updated",
  "article:modified_time": "updated",
  "article_modified_time": "updated",
  "og:article:modified_time": "updated",
  "article:modified": "updated",
  "article:updated_time": "updated",
  "og:updated_time": "updated",
  "dcterms.modified": "updated",
  "datecreated": "created",
  "created_date": "created",
  "dcterms.created": "created",
  "ssc:create_time": "created",
  "uploaddate": "uploaded",
  "date": "unknown",
  "dc.date": "unknown",
  "dcterms.date": "unknown",
  "timestamp": "unknown",
  "ssc:paper_date": "unknown",
  "lastdate": "unknown",
  "parsely-pub-date": "published",
  "date_published": "published",
  "publish_date": "published",
  "published_date": "published",
  "published_time": "published",
  "publish-date": "published",
  "published-date": "published",
  "article:post_date": "published",
  "article:published_date": "published",
  "article:publicationdate": "published",
  "og:datepublished": "published",
  "og:publish_date": "published",
  "og:published_time": "published",
  "og:article:published": "published",
  "shareaholic:article_published_time": "published",
  "cxenseparse:recs:publishtime": "published",
  "dc.date.publication": "published",
  "dcsext.articlefirstpublished": "published",
  "twt-published-at": "published",
  "date_created": "created",
  "article.created": "created",
  "content_create_date": "created",
  "dc.created": "created",
  "dc.date.created": "created",
  "dc:created": "created",
  "lastmod": "updated",
  "lastmodified": "updated",
  "article:modified_date": "updated",
  "article:modifiedtime": "updated",
  "dateupdate": "updated",
  "dc.date.modified": "updated"
};
const MONTH_ALIASES = ["januar jänner januari janvier ocak", "februar feber februari février şubat", "mär märz maret mart mars", "avril nisan", "mai mei mayıs", "juni juin haziran", "juli juillet temmuz", "agustus ağustos aout août", "septembre eylül", "oktober octobre ekim", "kasım novembre", "dez dezember desember décembre aralık"];

const RESEARCH_REVISION = 'bellingcat/uniform-timezone@bfbe860541a9931b37716903284ee46645568078';

function unwrapWayback(url) {
  try {
    if (new URL(url).hostname !== 'web.archive.org') return [url, null];
    const match = /\/web\/(\d{14})(?:[a-z]+_)?\/(https?:\/\/.+)$/.exec(url);
    if (!match) return [url, null];
    const n = match[1];
    const raw = `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 8)}T${n.slice(8, 10)}:${n.slice(10, 12)}:${n.slice(12, 14)}Z`;
    const parsed = normalizeDate(raw);
    return parsed.normalized ? [match[2], parsed.normalized] : [url, null];
  } catch { return [url, null]; }
}

export function platformIdentity(url) {
  try {
    const [original] = unwrapWayback(url);
    const parsed = new URL(original), host = parsed.hostname, path = decodeURIComponent(parsed.pathname);
    const domain = (d) => host === d || host.endsWith(`.${d}`);
    const candidates = [
      [domain('linkedin.com'), 'linkedin', /(?:\/posts\/[^/]*-activity-|\/feed\/update\/urn:li:activity:)(\d{19})(?:\D|$)/],
      [['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host), 'x', /\/[^/]+\/status\/(\d{15,20})(?:\/|$)/],
      [domain('tiktok.com'), 'tiktok', /\/@[^/]+\/video\/(\d{18,20})(?:\/|$)/],
      [['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'].includes(host), 'discord', /\/channels\/(?:@me|\d+)\/\d+\/(\d{17,20})(?:\/|$)/],
      [domain('instagram.com'), 'instagram', /\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)(?:\/|$)/],
      [['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net'].includes(host), 'threads', /\/@[^/]+\/post\/([A-Za-z0-9_-]+)(?:\/|$)/],
      [domain('reddit.com'), 'reddit', /\/comments\/([a-z0-9]+)(?:\/|$)/],
      [host === 'bsky.app', 'bluesky', /\/profile\/[^/]+\/post\/([A-Za-z0-9]+)(?:\/|$)/]
    ];
    for (const [accepted, platform, regex] of candidates) {
      const match = accepted && regex.exec(path);
      if (match) return [platform, match[1]];
    }
    for (const [accepted, platform] of candidates) if (accepted) return [platform, null];
  } catch { /* not a recognized permalink */ }
  return [null, null];
}

export function urlDateObservations(url) {
  const [original, snapshot] = unwrapWayback(url);
  const observations = [];
  if (snapshot) observations.push({ kind: 'archive_snapshot', raw: url, source: 'wayback_url', locator: 'capture.final_url', scope: 'archive', ...normalizeDate(snapshot), basis: 'archive_locator', entity_url: original, method: 'wayback_14_digit_utc' });
  const [platform, identity] = platformIdentity(original);
  if (!identity) return observations;
  const observation = idDateObservation(platform, identity, original);
  if (observation) observations.push(observation);
  return observations;
}

export function idDateObservation(platform, identity, entityUrl = null) {
  if (['linkedin', 'x', 'discord', 'tiktok'].includes(platform) &&
      (typeof identity !== 'string' || !/^\d{15,20}$/.test(identity) || BigInt(identity) <= 0n || BigInt(identity) >= 2n ** 64n)) return null;
  try {
    let microseconds, method, precision = 'datetime';
    if (platform === 'linkedin') {
      const id = BigInt(identity);
      if (id.toString(2).length !== 63) return null;
      microseconds = (id >> 22n) * 1000n;
      method = 'linkedin_activity_unix_ms_shift22';
    } else if (platform === 'x' || platform === 'discord') {
      microseconds = ((BigInt(identity) >> 22n) + (platform === 'x' ? 1288834974657n : 1420070400000n)) * 1000n;
      method = `${platform}_snowflake_epoch_ms_shift22`;
    } else if (platform === 'tiktok') {
      microseconds = (BigInt(identity) >> 32n) * 1000000n;
      method = 'tiktok_video_unix_seconds_shift32'; precision = 'second';
    } else if (platform === 'bluesky' && /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(identity)) {
      let value = 0n;
      for (const char of identity) value = value * 32n + BigInt('234567abcdefghijklmnopqrstuvwxyz'.indexOf(char));
      microseconds = value >> 10n;
      method = 'atproto_tid_base32_unix_microseconds_shift10'; precision = 'microsecond';
    } else return null;
    const date = new Date(Number(microseconds / 1000n));
    if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < { linkedin: 2006, x: 2010, discord: 2015, tiktok: 2016, bluesky: 2022 }[platform] || date.getUTCFullYear() > 2100) return null;
    let normalized = date.toISOString();
    if (precision === 'microsecond') normalized = normalized.slice(0, -1) + String(microseconds % 1000n).padStart(3, '0') + 'Z';
    return { kind: 'created', raw: identity, source: 'platform_id', locator: 'capture.final_url', scope: 'page', normalized,
      precision, timezone: 'explicit', parse_status: 'derived', basis: 'id_derived', platform, method, entity_url: entityUrl,
      caveat: 'Encoded ID creation time, not an independently verified publication date.' + (platform === 'bluesky' ? ' TIDs are user-controlled.' : platform === 'linkedin' ? ' Activity can represent a repost.' : '') };
  } catch { /* malformed or unsupported ID */ }
  return null;
}

function platformTimeScope(node, url, isRelated) {
  const target = platformIdentity(url);
  isRelated ||= Boolean(node.closest('shreddit-comment, shreddit-profile-comment'));
  for (let parent = node; parent; parent = parent.parentElement) {
    const link = parent.tagName === 'A' ? parent.getAttribute('href') : parent.getAttribute('permalink') || parent.getAttribute('data-permalink');
    if (link) {
      let entity;
      try { entity = new URL(link, url).href; } catch { continue; }
      const identity = platformIdentity(entity);
      if (identity[0] && identity[0] === target[0]) {
        let comment = /comment/i.test(parent.className || '');
        if (identity[0] === 'reddit') comment ||= new URL(entity).pathname.split('/comments/').pop().replace(/^\/+|\/+$/g, '').split('/').length > 2;
        if (['instagram', 'threads'].includes(identity[0])) comment ||= /\/(c|comment)\//.test(new URL(entity).pathname);
        return [identity[1] === target[1] && !isRelated && !comment ? 'page' : 'related', entity];
      }
    }
    if (target[0] === 'discord' && parent.tagName === 'LI') {
      const match = /^chat-messages-(\d+)-(\d+)$/.exec(parent.id);
      if (match) {
        const guild = new URL(url).pathname.split('/channels/').pop().split('/')[0];
        return [match[2] === target[1] && !isRelated ? 'page' : !target[1] ? 'message' : 'related', `https://discord.com/channels/${guild}/${match[1]}/${match[2]}`];
      }
    }
  }
  return [isRelated ? 'related' : 'unresolved', null];
}

export function normalizeDate(raw) {
  raw = String(raw).trim();
  const iso = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;
  if (!iso.test(raw)) {
    const tooltip = /^(.+?)\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(raw);
    if (tooltip) {
      const base = normalizeDate(tooltip[1].replace(/[, ]+$/, ''));
      let hour = +tooltip[2];
      const minute = +tooltip[3], second = +(tooltip[4] || 0), ampm = (tooltip[5] || '').toUpperCase();
      if (base.precision === 'date' && minute < 60 && second < 60 && (ampm ? hour >= 1 && hour <= 12 : hour < 24)) {
        if (ampm) hour = hour % 12 + (ampm === 'PM' ? 12 : 0);
        return { normalized: `${base.normalized}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`, precision: 'datetime', timezone: null, parse_status: 'parsed' };
      }
    }
    const names = ['january jan enero', 'february feb febrero', 'march mar marzo', 'april apr abril', 'may mayo', 'june jun junio', 'july jul julio', 'august aug agosto', 'september sep septiembre', 'october oct octubre', 'november nov noviembre', 'december dec diciembre'];
    const fold = (s) => s.replaceAll('ı', 'i').replaceAll('İ', 'i').toLowerCase();
    const clean = fold(raw).replace(/\bde\b|[,\.]/g, ' ').replace(/(?<=\d)(st|nd|rd|th)\b/g, '');
    const match = /^\s*(?:(\d{1,2})\s+([\p{L}]+)|([\p{L}]+)\s+(\d{1,2}))\s+(\d{4})\s*$/u.exec(clean);
    const month = match && names.findIndex((n, i) => fold(n + ' ' + MONTH_ALIASES[i]).split(' ').includes(match[2] || match[3])) + 1;
    if (month) return normalizeDate(`${match[5]}-${String(month).padStart(2, '0')}-${String(match[1] || match[4]).padStart(2, '0')}`);
    return { normalized: null, parse_status: 'unparsed' };
  }
  const day = raw.slice(0, 10);
  const dayDate = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(dayDate.getTime()) || dayDate.toISOString().slice(0, 10) !== day) return { normalized: null, parse_status: 'invalid' };
  if (raw.length === 10) return { normalized: day, precision: 'date', timezone: null, parse_status: 'parsed' };
  const clock = /[Tt ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (+clock[1] > 23 || +clock[2] > 59 || +(clock[3] || 0) > 59) return { normalized: null, parse_status: 'invalid' };
  const explicit = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const date = new Date(raw.replace(' ', 'T') + (explicit ? '' : 'Z'));
  if (!Number.isFinite(date.getTime())) return { normalized: null, parse_status: 'invalid' };
  let normalized = explicit ? date.toISOString() : raw.replace(' ', 'T');
  const fraction = /\.(\d{4,})/.exec(raw);
  if (explicit && fraction) normalized = normalized.replace(/\.\d{3}Z$/, '.' + fraction[1].slice(0, 6) + 'Z');
  return { normalized, precision: 'datetime', timezone: explicit ? 'explicit' : null, parse_status: 'parsed' };
}

export function summarizeDates(observations, errors = []) {
  const selected = {}, disagreements = {};
  for (const kind of ['published', 'created', 'updated', 'uploaded']) {
    const values = [...new Set(observations.filter((o) => o.kind === kind && o.scope === 'page' && o.normalized && o.basis !== 'id_derived').map((o) => o.normalized))].sort();
    if (values.length === 1) selected[kind] = values[0];
    else if (values.length > 1) disagreements[kind] = values;
  }
  const reported_relative = {};
  for (const o of observations) {
    if (o.scope === 'page' && o.precision === 'relative') reported_relative[o.kind] = [...new Set([...(reported_relative[o.kind] || []), o.raw])].sort();
  }
  return { schema_version: 1, extractor_version: '1.3', research_revision: RESEARCH_REVISION, basis: 'source_reported_and_derived', selected, disagreements, reported_relative,
    derived: observations.filter((o) => o.basis === 'id_derived' && o.scope === 'page'),
    other_dates: observations.filter((o) => o.scope === 'page' && o.normalized && o.kind === 'listed_in_ats'), observations, errors };
}

const relativeDatePattern = /\b\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b|\bhace\s+\d+\s+(?:segundos?|minutos?|horas?|d[ií]as?|semanas?|mes(?:es)?|a[nñ]os?)\b|\b\d+\s*(?:s|m|h|d|w|mo|yr)\b/i;
const isLinkedIn = (url) => {
  try { return /(^|\.)linkedin\.com$/.test(new URL(url).hostname); } catch { return false; }
};
export function linkedInJobId(url) {
  try {
    if (!isLinkedIn(url)) return null;
    return /^\/jobs\/view\/(?:[^/]*-)?(\d+)\/?$/.exec(new URL(url).pathname)?.[1] || null;
  } catch { return null; }
}
function linkedInScope(node, url, text, isRelated) {
  const target = linkedInJobId(url);
  const ancestors = [];
  for (let parent = node; parent; parent = parent.parentElement) ancestors.push(parent);
  if (target) {
    for (const n of ancestors) {
      const urn = /^urn:li:(?:fsd_)?jobPosting:(\d+)$/.exec(n.getAttribute('data-entity-urn') || '');
      if (urn) return urn[1] === target ? 'page' : 'related';
    }
    const anchor = node.closest('a[href]');
    if (anchor) {
      const link = new URL(anchor.getAttribute('href'), url).href;
      const parsed = new URL(link);
      let jobId = linkedInJobId(link);
      const ids = parsed.searchParams.getAll('currentJobId');
      if (parsed.pathname.replace(/\/$/, '') === '/jobs/search-results' && ids.length === 1 && /^\d+$/.test(ids[0])) jobId = ids[0];
      if (jobId && isLinkedIn(link)) return jobId === target && !isRelated ? 'page' : 'related';
    }
    const header = ancestors.some((n) => (n.getAttribute('data-sdui-screen') || '').includes('jobs.JobDetails'));
    const legacy = ancestors.some((n) => /job-details-jobs-unified-top-card|topcard__flavor--metadata/.test(n.className));
    if (!isRelated && ((header && text.includes('·') && /\b(applicants?|solicitantes?|candidatos?)\b/i.test(text)) || legacy)) return 'page';
  }
  if (!ancestors.some((n) => /update-components-actor__sub-description|feed-shared-actor__sub-description/.test(n.className))) return isRelated ? 'related' : 'unresolved';
  const targetActivity = /activity[-:](\d+)/.exec(url);
  for (const n of ancestors) {
    const activity = /urn:li:activity:(\d+)/.exec(['data-urn', 'data-id', 'data-entity-urn'].map((key) => n.getAttribute(key) || '').join(' '));
    if (activity) return targetActivity && activity[1] === targetActivity[1] && !isRelated ? 'page' : 'related';
  }
  return isRelated ? 'related' : 'unresolved';
}

const sameUrl = (a, b) => {
  try {
    if (linkedInJobId(a) && linkedInJobId(a) === linkedInJobId(b)) return true;
    // Desktop parity: Python urlsplit compares the raw text (lowercased netloc, path without trailing slashes, raw query).
    // WHATWG URL would also equate %-encoded and raw-Unicode paths, which desktop deliberately does not.
    const split = (u) => { const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/i.exec(u); return m ? [m[1].toLowerCase(), m[2].replace(/\/+$/, ''), m[3] || ''] : null; };
    const x = split(a), y = split(b);
    return Boolean(x && y && x[0] === y[0] && x[1] === y[1] && x[2] === y[2]);
  } catch { return false; }
};
const labelKind = (label) => /^(updat|modif|actualiz)/i.test(label) ? 'updated' : /^(creat|cread)/i.test(label) ? 'created' : 'published';
const labelPattern = /\b(published|posted|updated|modified|created|publicad[oa]|actualizad[oa]|cread[oa])\b/i;
const datePattern = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}[/.]\d{1,2}[/.]\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:de\s+)?(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+(?:de\s+)?\d{4}/i;

export function extractDatesFull(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const observations = urlDateObservations(url), errors = [];
  [url] = unwrapWayback(url);
  const [pagePlatform, targetId] = platformIdentity(url);
  let truncated = false;
  const add = (raw, kind, source, locator, scope, extra = {}) => {
    if (typeof raw !== 'string' && typeof raw !== 'number') return;
    raw = String(raw).trim();
    if (!raw || raw.length > 500) return;
    if (observations.length >= 2000) { truncated = true; return; }
    observations.push({ kind, raw, source, locator, scope, ...normalizeDate(raw), ...extra });
  };
  const related = (node) => {
    for (let parent = node; parent; parent = parent.parentElement) {
      const context = `${parent.className || ''} ${parent.id || ''} ${parent.getAttribute('role') || ''} ${parent.getAttribute('itemtype') || ''}`;
      if (['ASIDE', 'FOOTER', 'NAV'].includes(parent.tagName) || /(?:^|[\s_/-])(comment\w*|related\w*|recommend\w*|sidebar|footer|navigation)(?:$|[\s_/-])/i.test(context)) return true;
    }
    return false;
  };
  const nodes = [...doc.querySelectorAll('meta, [itemprop], [property], time, faceplate-timeago, faceplate-date, a[href], a[data-tooltip], script[type="application/ld+json"], script[type="application/json"], p, span, div, li, small')];
  const addEpoch = (value, kind, source, locator, seconds, extra) => {
    if (!['string', 'number'].includes(typeof value) || !(seconds ? /^\d{10}$/ : /^\d{13}$/).test(String(value))) return;
    const date = new Date(Number(value) * (seconds ? 1000 : 1));
    if (date.getUTCFullYear() >= 2000 && date.getUTCFullYear() <= 2100) add(String(value), kind, source, locator, 'page', { ...normalizeDate(date.toISOString()), timestamp_unit: seconds ? 'seconds' : 'milliseconds', ...extra });
  };
  function walk(data, locator, path, source, isRelated = false, depth = 0) {
    if (depth > 40 || !data || typeof data !== 'object') return;
    if (Array.isArray(data)) { data.forEach((v, i) => walk(v, locator, `${path}[${i}]`, source, isRelated, depth + 1)); return; }
    const types = [data['@type'] || ''].flat().map((t) => String(t).split('/').pop());
    let entityUrl = data.url || data['@id'] || data.mainEntityOfPage;
    if (entityUrl && typeof entityUrl === 'object') entityUrl = entityUrl['@id'] || entityUrl.url;
    const foreign = isRelated || types.some((t) => ['Comment', 'Review', 'ListItem'].includes(t)) || (typeof entityUrl === 'string' && entityUrl.startsWith('http') && url && !sameUrl(entityUrl, url));
    const scope = foreign ? 'related' : typeof entityUrl === 'string' && sameUrl(entityUrl, url) ? 'page' : 'unresolved';
    for (const [key, value] of Object.entries(data)) {
      const kind = KINDS[key.split('/').pop().toLowerCase()];
      if (kind && (source !== 'embedded_json' || kind !== 'unknown')) add(value, kind, source, `${locator}:${path}.${key}`, scope, { entity_type: types, entity_url: typeof entityUrl === 'string' ? entityUrl : null });
      walk(value, locator, `${path}.${key}`, source, foreign || ['comment', 'comments', 'itemlistelement', 'relatedlink'].includes(key.toLowerCase()), depth + 1);
    }
    const platform = pagePlatform;
    if (platform === 'instagram' && targetId && data.code === targetId && !isRelated) addEpoch(data.taken_at, 'published', source, `${locator}:${path}.taken_at`, true, { field: 'taken_at', entity_id: targetId });
    if (platform === 'linkedin') {
      const identity = ['id', 'entityUrn', 'urn', 'url', '@id'].map((k) => data[k] || '').join(' ');
      const matches = [...identity.matchAll(/(?:activity:|activity-)(\d{19})/g)].map((m) => m[1]);
      if (matches.length && new Set(matches).size === 1 && matches[0] === targetId && !isRelated) {
        for (const [field, kind] of [['createdAt', 'created'], ['publishedAt', 'published'], ['lastModifiedAt', 'updated']]) addEpoch(data[field], kind, source, `${locator}:${path}.${field}`, false, { field, entity_id: targetId });
      }
    }
    const job = linkedInJobId(url);
    if (job && !isRelated) {
      const identity = ['entityUrn', 'jobPostingUrn', 'urn', 'url'].map((k) => data[k] || '').join(' ');
      const match = /(?:urn:li:(?:fsd_)?jobPosting:|\/jobs\/view\/)(\d+)/.exec(identity);
      if (match && match[1] === job) addEpoch(data.listedAt, 'listed_in_ats', source, `${locator}:${path}.listedAt`, false, { field: 'listedAt', entity_id: job });
    }
    if (platform === 'bluesky' && !isRelated) {
      const match = typeof data.uri === 'string' && /^at:\/\/([^/]+)\/app.bsky.feed.post\/([^/]+)$/.exec(data.uri);
      const targetRepo = decodeURIComponent(new URL(url).pathname).split('/profile/').pop().split('/')[0];
      const authorMatches = match && data.author?.did === match[1] && data.author?.handle?.toLowerCase() === targetRepo.toLowerCase();
      if (match && match[2] === targetId && (match[1] === targetRepo || authorMatches) && data.record?.$type === 'app.bsky.feed.post') add(data.record.createdAt, 'created', source, `${locator}:${path}.record.createdAt`, 'page', { field: 'createdAt', entity_url: data.uri });
    }
  }
  for (const [index, node] of nodes.entries()) {
    const attr = (name) => node.getAttribute(name) || '';
    const locator = `document.querySelectorAll(date-elements)[${index}]`;
    let scope = related(node) ? 'related' : 'unresolved';
    const tag = node.tagName.toLowerCase();
    const platform = pagePlatform;
    if (tag === 'a' && attr('href') && platform) {
      try {
        const entityUrl = new URL(attr('href'), url).href;
        const [linkedPlatform, identity] = platformIdentity(entityUrl);
        const linked = linkedPlatform === platform && identity && idDateObservation(linkedPlatform, identity, entityUrl);
        if (linked && identity !== targetId) {
          if (observations.length < 2000) observations.push({ ...linked, source: 'platform_link_id', locator: locator + '@href', scope: 'linked_item' });
          else truncated = true;
        }
      } catch { /* malformed permalink */ }
    }
    if (platform === 'linkedin') {
      const comment = /^urn:li:fsd_comment:\((\d{19}),urn:li:activity:(\d{19})\)$/.exec(attr('data-id'));
      const originalComment = /^urn:li:comment:\(activity:(\d{19}),(\d{19})\)$/.exec(attr('data-id'));
      const commentId = originalComment ? originalComment[2] : comment && comment[1];
      const parentId = originalComment ? originalComment[1] : comment && comment[2];
      const decoded = commentId && idDateObservation('linkedin', commentId);
      if (decoded && observations.length < 2000) observations.push({ ...decoded, kind: 'commented', source: 'linkedin_comment_id', scope: 'comment', locator: locator + '@data-id', method: 'linkedin_comment_unix_ms_shift22', raw_urn: attr('data-id'), parent_activity_id: parentId, caveat: 'Timestamp encoded in the comment ID, not a verified event date.' });
      if (!commentId) {
        const feed = /urn:li:activity:(\d{19})(?:\D|$)/.exec(attr('data-id'));
        const value = feed && feed[1] !== targetId && idDateObservation('linkedin', feed[1]);
        if (value && observations.length < 2000) observations.push({ ...value, source: 'linkedin_feed_id', scope: 'feed_item', locator: locator + '@data-id', raw_urn: attr('data-id') });
      }
    }
    if (platform === 'tiktok' && tag === 'div') {
      const video = /^xgwrapper-0-(\d{18,20})$/.exec(attr('id'));
      const value = video && video[1] !== targetId && idDateObservation('tiktok', video[1]);
      if (value && observations.length < 2000) observations.push({ ...value, source: 'tiktok_dom_id', scope: 'feed_item', locator: locator + '@id' });
    }
    if (platform === 'reddit' && ['faceplate-timeago', 'faceplate-date'].includes(tag) && attr('ts')) {
      const [entityScope, entityUrl] = platformTimeScope(node, url, scope === 'related');
      add(attr('ts'), 'published', 'reddit_time', locator + '@ts', entityScope, { entity_url: entityUrl });
    }
    if (platform === 'bluesky' && attr('data-tooltip').includes(' at ')) {
      const [entityScope, entityUrl] = platformTimeScope(node, url, scope === 'related');
      add(attr('data-tooltip'), 'published', 'bluesky_tooltip', locator + '@data-tooltip', entityScope, { entity_url: entityUrl });
    }
    if (isLinkedIn(url) && ['p', 'span', 'time'].includes(tag)) {
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      const match = text.length <= 250 && relativeDatePattern.exec(text);
      if (match) {
        const entityScope = linkedInScope(node, url, text, scope === 'related');
        if (entityScope !== 'unresolved') add(match[0], /\breposted\b/i.test(text) ? 'reposted' : 'published', 'linkedin_relative', locator, entityScope,
          { normalized: null, precision: 'relative', timezone: null, parse_status: 'relative', excerpt: text, entity_url: entityScope === 'page' ? url : null });
      }
    }
    if (tag === 'script') {
      try { walk(JSON.parse(node.textContent), locator, '$', attr('type') === 'application/ld+json' ? 'json_ld' : 'embedded_json', scope === 'related'); }
      catch { if (attr('type') === 'application/ld+json') errors.push({ locator, error: 'malformed JSON-LD' }); }
      continue;
    }
    const field = attr('property') || attr('name') || attr('itemprop') || attr('http-equiv');
    const kind = KINDS[field.toLowerCase()];
    if (tag === 'meta' && kind) add(attr('content'), kind, 'meta', locator, scope === 'related' ? scope : 'page', { field });
    if (tag !== 'meta' && kind) add(attr('content') || attr('datetime') || node.textContent, kind, 'structured_html', locator, scope, { field });
    if (tag === 'time') {
      let entityUrl = null;
      const text = node.textContent.trim();
      const label = labelPattern.exec(`${text} ${attr('class')} ${attr('aria-label')}`);
      let timeKind = kind || (node.hasAttribute('pubdate') ? 'published' : label ? labelKind(label[0]) : 'unknown');
      if (/header(date|time)/i.test(attr('class'))) scope = 'site_clock';
      if (platform === 'linkedin' && /(?:job-search-card|main-job-card)__listdate/.test(attr('class'))) {
        scope = linkedInScope(node, url, text, scope === 'related'); timeKind = 'published';
        entityUrl = scope === 'page' ? url : null;
      }
      if (['instagram', 'threads', 'reddit', 'bluesky'].includes(platform) || (platform === 'discord' && attr('id').startsWith('message-timestamp'))) {
        [scope, entityUrl] = platformTimeScope(node, url, scope === 'related'); timeKind = 'published';
      }
      try {
        if (/^(www\.)?(x|twitter)\.com$/.test(new URL(url).host)) {
          const anchor = node.closest('a[href]');
          const linkId = anchor && /\/status\/(\d+)\/?$/.exec(new URL(anchor.getAttribute('href'), url).pathname);
          const targetId = /\/status\/(\d+)/.exec(new URL(url).pathname);
          if (linkId) { scope = targetId && linkId[1] === targetId[1] ? 'page' : 'related'; timeKind = 'published'; }
        }
      } catch { /* unknown scope */ }
      add(attr('datetime') || attr('title') || text, timeKind, 'time', locator, scope, { excerpt: text.slice(0, 200), entity_url: entityUrl });
    }
    if (['p', 'span', 'div', 'li', 'small'].includes(tag) && !node.closest('script, style')) {
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (text.length > 250) continue;
      const label = labelPattern.exec(text);
      const rest = label && text.slice(label.index + label[0].length);
      const match = rest && datePattern.exec(rest);
      if (match && match.index < 45) add(match[0], labelKind(label[0]), 'labeled_text', locator, scope, { excerpt: text });
    }
  }
  if (truncated) errors.push({ error: 'date observations limited to 2000' });
  return summarizeDates(observations, errors);
}

export function sourceDateReport(data) {
  if (!data) return [];
  return ['Source-reported dates', '---------------------', 'These are source claims, not verified dates or capture timestamps.',
    ...Object.entries(data.selected).map(([kind, value]) => `${kind}: ${value}`),
    ...Object.entries(data.reported_relative || {}).map(([kind, values]) => `${kind} (source-relative label): ${values.join(', ')}`),
    ...(data.other_dates || []).map((o) => `Initial ATS listing (source claim): ${o.normalized}`),
    ...(data.derived || []).flatMap((o) => [`${o.platform} ID-derived creation time: ${o.normalized}`, `  Method: ${o.method}. ${o.caveat}`]),
    ...data.observations.filter((o) => o.kind === 'archive_snapshot').map((o) => `Wayback snapshot: ${o.normalized}`),
    ...[...new Set(data.observations.filter((o) => o.capture_context === 'supplemental_public_lookup').map((o) => `Supplemental public date lookup: ${o.observed_at} — ${o.source_url}`))],
    ...(!Object.keys(data.selected).length ? ['No unambiguous absolute page date selected.'] : []),
    `Date observations retained in manifest: ${data.observations.length}`,
    ...Object.entries(data.disagreements).map(([kind, values]) => `Differing ${kind} values: ${values.join(', ')}`),
    ...data.errors.map((e) => `Extraction issue: ${e.error}`), ''];
}

// Captured/lookup times are deliberately not inputs: only saved HTML can
// supply a posting date. Each observation binds to the stored file's digest.
export async function sourceDatesFromArtifacts(entries, url, lookup = null) {
  const observations = [], errors = [];
  const html = entries.filter((e) => /\.(html?|xhtml)$/i.test(e.filename));
  if (!html.length) observations.push(...urlDateObservations(url));
  for (const entry of html) {
    const artifact = entry.stored_as || entry.path;
    if (entry.blob.size > 20 * 1024 * 1024) {
      errors.push({ artifact, error: 'HTML exceeds 20 MiB extraction limit' });
      continue;
    }
    try {
      const dates = extractDatesFull(await entry.blob.text(), url);
      const context = Object.fromEntries(['source_url', 'observed_at', 'capture_context'].filter((k) => entry[k]).map((k) => [k, entry[k]]));
      observations.push(...dates.observations.map((o) => ({ ...o, artifact, artifact_sha256: entry.sha256, media_id: entry.media_id, ...context })));
      errors.push(...dates.errors.map((e) => ({ ...e, artifact })));
    } catch (error) { errors.push({ artifact, error: error.name }); }
  }
  if (lookup && lookup.status !== 'matched') errors.push({ source: 'linkedin_public_job_search',
    error: `LinkedIn posting date lookup: ${lookup.status}${lookup.http_status ? ` (HTTP ${lookup.http_status})` : ''}` });
  return summarizeDates(observations, errors);
}

// ---------------------------------------------------------------------------
// Extension-side additions (the code above is HRC chrome-app/src/engine/source-dates.js).
// Needs DOMParser, so run it in an extension page or offscreen document, not the service worker.

/** Contract wrapper. Pure. published_at / updated_at are the single unambiguous page-scope values (date-only
 * strings stay date-only), `method` is the source that reported published_at (json_ld, meta, time, ...). */
export function extractSourceDates({ html, url }) {
  let summary;
  try { summary = extractDatesFull(String(html || ''), url || ''); } catch (error) {
    return { published_at: null, updated_at: null, method: null, candidates: [], summary: null, error: error?.message || String(error) };
  }
  const published_at = summary.selected.published || null;
  const updated_at = summary.selected.updated || null;
  const from = summary.observations.find((o) => o.kind === 'published' && o.scope === 'page' && o.normalized === published_at);
  const candidates = summary.observations
    .filter((o) => o.scope === 'page' && (o.normalized || o.precision === 'relative'))
    .map((o) => ({ kind: o.kind, value: o.normalized, raw: o.raw, source: o.source, precision: o.precision, basis: o.basis || 'source_reported' }));
  return { published_at, updated_at, method: published_at ? from?.source || null : null, candidates, summary };
}

// ── LinkedIn public job-card lookup (chrome-app/linkedin-job-dates.js plus desktop's fixes) ──
// Only used when the saved page carries no absolute date. Unauthenticated, no cookies, no redirects.

export const RATE_LIMIT_WAITS = [5, 15];
const MAX_LOOKUP_BYTES = 2 * 1024 * 1024;

export function jobSearchRequest(html, url) {
  const jobId = linkedInJobId(url);
  if (!jobId) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let title = (doc.querySelector('meta[property="og:title"]')?.content || doc.title).split('|')[0].trim();
  if (title.includes(' hiring ')) title = title.split(' hiring ', 2)[1].replace(/\s+in\s+[^,]+(?:,.*)?$/, '');
  title = title.replace(/\s+/g, ' ').trim();
  if (title.length < 5 || title.length > 200 || ['linkedin', 'sign in', 'linkedin login, sign in'].includes(title.toLowerCase())) return null;
  return { job_id: jobId, request_url: 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?' + new URLSearchParams({ keywords: title, start: '0' }) };
}

async function readCapped(response, deadline) {
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_LOOKUP_BYTES || Date.now() > deadline) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return new Blob(chunks, { type: 'text/html' });
}

/** → null when not a LinkedIn job, a date is already known, or no usable title; else { record, blob|null }.
 * record.status: matched | no_matching_date | rate_limited | http_error | unexpected_content_type | response_limit | request_failed. */
export async function lookupLinkedInJobDate({ html, url, fetchImpl = globalThis.fetch, sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!linkedInJobId(url) || extractDatesFull(html, url).selected.published) return null;
  const request = jobSearchRequest(html, url);
  if (!request) return null;
  const record = { ...request, observed_at: new Date().toISOString(), method: 'linkedin_public_search_card' };
  try {
    let response;
    for (const wait of [0, ...RATE_LIMIT_WAITS]) {
      if (wait) {
        // desktop: honour Retry-After, never less than our own step and at most 30 s
        const asked = Number.parseInt(response.headers.get('Retry-After'), 10);
        const seconds = Math.min(Math.max(Number.isFinite(asked) ? asked : wait, wait), 30);
        (record.rate_limited_attempts ||= []).push(record.observed_at);
        await sleepImpl(seconds * 1000);
        record.observed_at = new Date().toISOString();
      }
      response = await fetchImpl(request.request_url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Accept: 'text/html' } });
      record.http_status = response.status;
      if (response.status !== 429 && response.status !== 999) break;
    }
    if (response.status === 429 || response.status === 999) record.status = 'rate_limited';
    else if (response.status !== 200) record.status = 'http_error';
    else if (!response.headers.get('Content-Type')?.toLowerCase().includes('text/html')) record.status = 'unexpected_content_type';
    else {
      const blob = await readCapped(response, Date.now() + 15000);
      if (!blob) record.status = 'response_limit';
      else {
        record.status = extractDatesFull(await blob.text(), url).selected.published ? 'matched' : 'no_matching_date';
        return { record, blob };
      }
    }
  } catch (error) { record.status = 'request_failed'; record.error = error?.name || 'Error'; }
  return { record, blob: null };
}
