// One verdict function over the *stored* item shape, ported from
// engine/src/auto_archiver/utils/capture_quality.py and verification.py.
// Capture and the later audit call the same verifyArchive().

import { hostOf } from './util.js';

const ERROR_TITLES = [
  'technical difficulties', 'access denied', 'attention required', 'error 403',
  'page not found', 'service unavailable', 'just a moment', 'client challenge', 'request could not be satisfied'
];
const FACEBOOK_LOGIN_TITLES = ['log into facebook', 'facebook – log in or sign up', 'facebook - log in or sign up'];
const FACEBOOK_UNAVAILABLE_TEXT = [
  "this content isn't available right now",
  'this content isn’t available right now',
  'you must log in to continue'
];

export function pageDomSignals(renderedDom) {
  const dom = (renderedDom || '').toLowerCase();
  return {
    login_form_present: dom.includes('id="login_form"'),
    unavailable_notice: FACEBOOK_UNAVAILABLE_TEXT.find((marker) => dom.includes(marker)) ?? null
  };
}

export function isCompoundUrl(url) {
  const lowered = url.toLowerCase();
  return url.includes(' | ') || url.includes('\n') || url.includes('\r') ||
    (lowered.split('http://').length - 1) + (lowered.split('https://').length - 1) > 1;
}

const matchesHost = (host, names) => names.includes(host) || names.some((name) => host.endsWith(`.${name}`));

export function requiresJavascript(url) {
  return matchesHost(hostOf(url), ['facebook.com', 'm.facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'youtube.com', 'youtu.be', 'tiktok.com', 'vimeo.com']);
}

const JS_NOTICE_MARKERS = [
  'enable javascript', 'enable js to', 'javascript is disabled', 'javascript is not available',
  'javascript is required', 'requires javascript', 'needs javascript', 'turn on javascript',
  'please enable javascript', 'you need to enable javascript', "doesn't work properly without javascript",
  "won't work properly without javascript", 'this app requires javascript'
];
const SPA_SHELL_MARKERS = ["something went wrong, but don't fret", 'something went wrong, but don’t fret'];
const SPA_ROOT_MARKERS = ['id="root"', "id='root'", 'id="__next"', 'id="__nuxt"', 'id="app"', 'id="react-root"', 'data-reactroot', 'ng-version='];
const MIN_VISIBLE_TEXT = 200;

export function visibleTextLength(dom) {
  if (!dom) return 0;
  const withoutHidden = dom.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  return withoutHidden.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
}

export function javascriptRetryReason(dom) {
  const lowered = (dom || '').toLowerCase();
  for (const marker of JS_NOTICE_MARKERS) if (lowered.includes(marker)) return `page reports it needs JavaScript ('${marker}')`;
  for (const marker of SPA_SHELL_MARKERS) if (lowered.includes(marker)) return `served an unrendered app shell ('${marker}')`;
  const length = visibleTextLength(dom);
  if (length < MIN_VISIBLE_TEXT && SPA_ROOT_MARKERS.some((m) => lowered.includes(m))) {
    return `single-page-app root rendered only ${length} visible characters`;
  }
  return null;
}

const CLIPPED_CONTENT_RATIO = 1.5;

/**
 * Detect substantial laid-out text hidden by reveal/animation CSS (capture_quality.hidden_content_reason).
 * A small hidden control is normal. At least 200 hidden characters and more hidden than visible text needs a
 * scripted retry, or review if scripts still cannot reveal it.
 */
export function hiddenContentReason(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const { hidden, visible } = metrics;
  if (typeof hidden !== 'number' || typeof visible !== 'number') return null;
  if (hidden >= 200 && visible >= 0 && hidden > visible) {
    return `page has ${hidden.toFixed(0)} hidden text characters but only ${visible.toFixed(0)} visible characters`;
  }
  return null;
}

export function clippedRenderReason(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const { document: doc, content } = metrics;
  if (typeof doc !== 'number' || typeof content !== 'number' || doc <= 0 || content <= 0) return null;
  if (content < doc * CLIPPED_CONTENT_RATIO) return null;
  return `page content is ${content.toFixed(0)}px tall but only ${doc.toFixed(0)}px was reachable`;
}

const BLANK_RENDER_THRESHOLD = 0.999;

export function blankReasonFromFraction(fraction) {
  if (fraction == null || fraction < BLANK_RENDER_THRESHOLD) return null;
  return `screenshot is a single flat colour across ${(fraction * 100).toFixed(2)}% of sampled pixels`;
}

const SOCIAL_HOSTS = ['facebook.com', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com', 'youtube.com', 'youtu.be', 'vimeo.com', 't.me', 'telegram.me'];

export const expectsMediaDownload = (url) => matchesHost(hostOf(url), SOCIAL_HOSTS);

const NO_MEDIA_PRESENT_MARKERS = [
  'no video could be found in this tweet', "there's no video in this tweet", 'there is no video in this tweet',
  'no video could be found in this post', 'there is no video in this post', 'no media found', 'no video formats found'
];
export const isNoMediaPresent = (message) => NO_MEDIA_PRESENT_MARKERS.some((m) => (message || '').toLowerCase().includes(m));

const issue = (code, message) => ({ code, message });
const dedupe = (issues) => {
  const seen = new Set();
  return issues.filter((i) => {
    const key = `${i.code}\u0000${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export function assessBrowserCapture({
  url, finalUrl, statusCode, title, domSignals, navigationError,
  authenticationExpected = false, authenticationCookiePresent = false, blankRender = null, statusRecorded = true
}) {
  const issues = [];
  const normalizedTitle = (title || '').trim().toLowerCase();
  const signals = domSignals || {};
  const host = hostOf(url);
  const final = (finalUrl || '').toLowerCase();
  if (isCompoundUrl(url)) issues.push(issue('compound_url', 'Input contains more than one URL'));
  if (statusCode == null) {
    if (statusRecorded) issues.push(issue('http_status_unknown', 'No HTTP response status was available'));
  } else if (statusCode >= 400) {
    issues.push(issue(`http_${statusCode}`, `Server returned HTTP ${statusCode}`));
  }
  if (navigationError) issues.push(issue('navigation_error', `Browser navigation was incomplete: ${navigationError}`));
  if (ERROR_TITLES.some((m) => normalizedTitle.includes(m))) issues.push(issue('error_page', `Captured page title indicates an error: ${title}`));
  if (blankRender) issues.push(issue('blank_render', `Page rendered no visible content: ${blankRender}`));
  const hiddenReason = hiddenContentReason(signals.text_visibility);
  if (hiddenReason) issues.push(issue('hidden_content', hiddenReason));
  if (host === 'facebook.com' || host.endsWith('.facebook.com')) {
    const loginWall = FACEBOOK_LOGIN_TITLES.some((m) => normalizedTitle.includes(m)) ||
      final.includes('/login') || final.includes('/checkpoint') || Boolean(signals.login_form_present);
    if (authenticationExpected && !authenticationCookiePresent) {
      issues.push(issue('facebook_session_cookie_missing', 'Saved cookies do not contain a Facebook session'));
    }
    if (loginWall) {
      issues.push(issue(authenticationCookiePresent ? 'facebook_authentication_rejected' : 'facebook_login_required',
        'Facebook returned a login or checkpoint page'));
    }
    if (signals.unavailable_notice) {
      issues.push(issue('facebook_content_unavailable', 'Facebook reported that the requested content is unavailable'));
    }
  }
  const unique = dedupe(issues);
  return { quality: unique.length ? 'needs_review' : 'verified', issues: unique };
}

// ── verification.py ──────────────────────────────────────────────────────────

export const PAGE_EVIDENCE_IDS = ['screenshot', 'page_pdf', 'rendered_dom', 'source_document'];
const PAGE_DIAGNOSTIC_KEYS = ['final_url', 'status_code', 'navigation_error', 'javascript_enabled'];
const DERIVED_CODES = new Set([
  'result_metadata_incomplete', 'compound_url', 'page_not_captured', 'media_extraction_failed',
  'embedded_media_not_captured', 'legacy_social_capture_unverified', 'blank_render', 'navigation_error',
  'error_page', 'hidden_content', 'http_status_unknown', 'facebook_session_cookie_missing', 'facebook_login_required',
  'facebook_authentication_rejected', 'facebook_content_unavailable'
]);
const isDerived = (code) => DERIVED_CODES.has(code) || code.startsWith('http_');

const AV_SUFFIX = /\.(mp4|m4v|mov|mkv|webm|ogv|ts|mp3|m4a|aac|ogg|oga|opus|wav|flac|weba)$/i;

/** Every media dict, including thumbnails and timestamp files nested in properties. */
export function allMedia(value) {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      if ('filename' in node && 'properties' in node) found.push(node);
      Object.values(node).forEach(walk);
    }
  };
  walk(value);
  return found;
}

const mediaEntries = (result) => (Array.isArray(result.media) ? result.media.filter((m) => m && typeof m === 'object') : []);
const mediaId = (media) => String(media?.properties?.id || '');
const isAudioOrVideo = (media) => {
  const mimetype = media._mimetype || '';
  if (mimetype) return mimetype.startsWith('audio') || mimetype.startsWith('video');
  return AV_SUFFIX.test(String(media.filename || media._key || ''));
};

export const hasPageEvidence = (result) => mediaEntries(result).some((m) => PAGE_EVIDENCE_IDS.includes(mediaId(m)));

const storedIssues = (metadata) =>
  (Array.isArray(metadata.capture_issues) ? metadata.capture_issues : []).filter((i) => i && i.code && i.message);

export function verifyArchive(result, { url }) {
  const metadata = result.metadata && typeof result.metadata === 'object' ? result.metadata : {};
  const media = mediaEntries(result);
  const issues = storedIssues(metadata)
    .filter((i) => !isDerived(String(i.code)))
    .map((i) => issue(String(i.code), String(i.message)));

  if (!result.status) issues.push(issue('result_metadata_incomplete', 'Stored result does not identify a successful extractor'));
  if (isCompoundUrl(url)) issues.push(issue('compound_url', 'Input contains more than one URL'));
  if (!hasPageEvidence(result)) issues.push(issue('page_not_captured', 'No screenshot, PDF, or document was captured for this URL'));

  if (PAGE_DIAGNOSTIC_KEYS.some((key) => key in metadata)) {
    const authentication = metadata.authentication && typeof metadata.authentication === 'object' ? metadata.authentication : {};
    const assessment = assessBrowserCapture({
      url,
      finalUrl: String(metadata.final_url || url),
      statusCode: Number.isInteger(metadata.status_code) ? metadata.status_code : null,
      title: String(metadata.title || ''),
      domSignals: metadata.dom_signals && typeof metadata.dom_signals === 'object' ? metadata.dom_signals : null,
      navigationError: metadata.navigation_error ? String(metadata.navigation_error) : null,
      authenticationExpected: Boolean(authentication.authentication_expected),
      authenticationCookiePresent: Boolean(authentication.session_cookie_present),
      blankRender: metadata.blank_render,
      statusRecorded: 'status_code' in metadata
    });
    issues.push(...assessment.issues);
  }

  if (!('blank_render' in metadata) && !('blank_render_scan' in metadata)) {
    issues.push(...storedIssues(metadata).filter((i) => i.code === 'blank_render').map((i) => issue(i.code, i.message)));
  }

  issues.push(...mediaIssues(metadata, media, url));

  if (expectsMediaDownload(url) && hasPageEvidence(result) && !('javascript_enabled' in metadata) && !('manual_capture' in metadata)) {
    issues.push(issue('legacy_social_capture_unverified', 'Legacy social capture lacks authentication and media-download diagnostics'));
  }
  return dedupe(issues);
}

function mediaIssues(metadata, media, url) {
  const issues = [];
  const layers = metadata.capture_layers;
  if (Array.isArray(layers)) {
    const failures = layers.filter((l) => l && l.role === 'media' && l.error && !isNoMediaPresent(String(l.error)));
    if (expectsMediaDownload(url) && failures.length) {
      issues.push(issue('media_extraction_failed', 'Page evidence was captured, but media extraction failed for this social/video URL'));
    }
  } else {
    issues.push(...storedIssues(metadata).filter((i) => i.code === 'media_extraction_failed').map((i) => issue(i.code, i.message)));
  }
  // The extension runs its media layer only on pages that play media, so any recorded failure is a real one.
  if (metadata.media_extraction_error && !isNoMediaPresent(String(metadata.media_extraction_error))) {
    issues.push(issue('media_extraction_failed', `Page evidence was captured, but its audio/video could not be saved: ${metadata.media_extraction_error}`));
  }
  if (Array.isArray(metadata.page_media_sources) && metadata.page_media_sources.length && !media.some(isAudioOrVideo)) {
    issues.push(issue('embedded_media_not_captured', 'The page contains embedded video/audio that was not saved'));
  }
  return issues;
}

export function mediaExtractionError(metadata) {
  const layers = Array.isArray(metadata.capture_layers) ? metadata.capture_layers : [];
  for (const layer of layers) {
    if (layer?.role === 'media' && layer.error && !isNoMediaPresent(String(layer.error))) return String(layer.error);
  }
  return null;
}

/** Apply a verdict to metadata in place, the way _archive() and the audit both do. */
export function applyVerdict(metadata, issues) {
  metadata.capture_quality = issues.length ? 'needs_review' : 'verified';
  metadata.capture_issues = issues;
  if (issues.length) metadata.capture_issue_summary = issues.map((i) => i.message).join('; ');
  else delete metadata.capture_issue_summary;
}
