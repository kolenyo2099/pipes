// Page layer: port of engine/src/auto_archiver/modules/browser_capture.
// Same adaptive policy (JS off first, JS on for known hosts or an unrendered
// static capture), same paint wait and reloads, same artifacts and metadata —
// driven over CDP in a tab of the user's own Chrome instead of Playwright.

import { buildHar } from './har.js';
import {
  assessBrowserCapture,
  blankReasonFromFraction,
  clippedRenderReason,
  javascriptRetryReason,
  pageDomSignals,
  requiresJavascript
} from './quality.js';
import { hostOf, sleep } from './util.js';
import { base64ToBlob, CaptureTab, TimeoutError } from './cdp.js';
import { dominantColourFraction } from './render.js';

export class DownloadNavigation extends Error {}

const PAINT_BUDGET_MS = 6000;
const PAINT_RELOADS = 3;
// Tall pages beyond this are cut rather than failing the GPU readback.
const MAX_SCREENSHOT_HEIGHT = 30_000;

const PAGE_EXTENT_SCRIPT = `(() => {
  const doc = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  let content = 0;
  for (const el of document.querySelectorAll('body, body > *, main, [role="main"], .home, #content')) {
    const style = getComputedStyle(el);
    if (style.position === 'fixed' || style.position === 'absolute') continue;
    content = Math.max(content, el.scrollHeight);
  }
  return { document: doc, content, viewport: window.innerHeight };
})()`;

// Scroll-reveal pages hide sections until they enter the viewport; a full-page
// screenshot or PDF never scrolls, so walk the page once before capturing.
const SCROLL_THROUGH_SCRIPT = `(async () => {
  const step = Math.max(200, Math.floor(innerHeight * 0.8));
  const deadline = Date.now() + 15000;
  for (let y = 0; y < document.documentElement.scrollHeight && Date.now() < deadline; y += step) {
    scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 150));
  }
  scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 500));
})()`;

// The tallest vertical stretch of the page with nothing drawn in it: no text,
// image, video or canvas. Virtualized feeds (X, Facebook, Reddit) keep only
// the cells near the scroll position and leave spacers for the rest.
const CONTENT_GAP_SCRIPT = `(() => {
  const spans = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.currentNode; el; el = walker.nextNode()) {
    const drawn = el.matches('img, video, canvas, svg, iframe, picture') ||
      [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!drawn) continue;
    const r = el.getBoundingClientRect();
    if (r.width >= 1 && r.height >= 1) spans.push([r.top + scrollY, r.bottom + scrollY]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let gap = 0;
  for (const [top, bottom] of spans) {
    gap = Math.max(gap, top - covered);
    covered = Math.max(covered, bottom);
  }
  const height = document.documentElement.scrollHeight;
  return { height, gap: Math.max(gap, height - covered), viewport: innerHeight };
})()`;

// The same page-text function the save buttons use (public/capture/page-text.js), evaluated in the captured page.
let pageTextCode
const pageTextSource = async () => (pageTextCode ??= await (await fetch(chrome.runtime.getURL('capture/page-text.js'))).text())

const settleTimeout = (config) => Math.max(2000, Math.min(Number(config.timeout_ms), 8000));

async function pageExtent(tab) {
  try {
    return await tab.evaluate(PAGE_EXTENT_SCRIPT);
  } catch {
    return null;
  }
}

async function viewportScreenshot(tab) {
  const { data } = await tab.send('Page.captureScreenshot', { format: 'png' });
  return base64ToBlob(data, 'image/png');
}

export async function blankRenderReason(blob) {
  return blankReasonFromFraction(await dominantColourFraction(blob));
}

async function settleUntilPainted(tab) {
  const deadline = Date.now() + PAINT_BUDGET_MS;
  for (;;) {
    try {
      const unusable = (await blankRenderReason(await viewportScreenshot(tab))) || clippedRenderReason(await pageExtent(tab));
      if (!unusable) return true;
    } catch {
      return true; // a probe must never fail the capture
    }
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

async function waitUntilPainted(tab, config, log) {
  for (let attempt = 0; attempt <= PAINT_RELOADS; attempt += 1) {
    if (await settleUntilPainted(tab)) {
      if (attempt) log({ level: 'info', message: `Page painted after ${attempt} reload(s)` });
      return;
    }
    if (attempt === PAINT_RELOADS) break;
    log({ level: 'info', message: `Page loaded but painted nothing; reloading (${attempt + 1}/${PAINT_RELOADS})` });
    try {
      await tab.reload(config.timeout_ms);
    } catch {
      return;
    }
    await tab.waitForFlag('load', 'Page.loadEventFired', settleTimeout(config)).catch(() => {});
  }
  log({ level: 'info', message: 'Page still renders nothing after every reload; capturing it as it stands' });
}

function isDocumentResponse(response) {
  const mime = (response?.mimeType || '').toLowerCase();
  return mime === 'application/pdf' || (mime.startsWith('application/') && !mime.includes('xml') && !mime.includes('json') && !mime.includes('javascript'));
}

async function fullPageScreenshot(tab) {
  const metrics = await tab.send('Page.getLayoutMetrics');
  const size = metrics.cssContentSize || metrics.contentSize;
  const clip = {
    x: 0,
    y: 0,
    width: Math.max(1, Math.ceil(size.width)),
    height: Math.max(1, Math.min(Math.ceil(size.height), MAX_SCREENSHOT_HEIGHT)),
    scale: 1
  };
  const { data } = await tab.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
  return base64ToBlob(data, 'image/png');
}

async function hideNoscript(tab) {
  await tab.send('DOM.enable');
  await tab.send('CSS.enable');
  const { frameTree } = await tab.send('Page.getFrameTree');
  const { styleSheetId } = await tab.send('CSS.createStyleSheet', { frameId: frameTree.frame.id });
  await tab.send('CSS.setStyleSheetText', { styleSheetId, text: 'noscript { display: none !important; }' });
}

const viewportMetrics = (config, height) => ({
  width: config.viewport_width,
  height,
  deviceScaleFactor: 1,
  mobile: false
});

/**
 * A virtualized list renders only what fits the viewport, so make the viewport
 * as tall as the page: the site then renders every cell, and the screenshot,
 * PDF, DOM and media harvest all see them. Kept only if it filled the gap, so
 * an ordinary page with empty space keeps its normal viewport (and its 100vh
 * sections their normal size). Returns the height used, or null.
 */
async function expandVirtualizedList(tab, config, log) {
  const before = await tab.evaluate(CONTENT_GAP_SCRIPT);
  if (!before || before.gap < 2 * before.viewport) return null;
  let height = before.height;
  let after = before;
  for (let round = 0; round < 3; round += 1) {
    height = Math.min(height, MAX_SCREENSHOT_HEIGHT);
    await tab.send('Emulation.setDeviceMetricsOverride', viewportMetrics(config, height));
    await sleep(1000);
    await tab.networkIdle(settleTimeout(config)).catch(() => {});
    after = await tab.evaluate(CONTENT_GAP_SCRIPT);
    // A feed that loads more as it grows: follow it, up to the screenshot limit.
    if (after.height <= height || height === MAX_SCREENSHOT_HEIGHT) break;
    height = after.height;
  }
  if (after.gap >= before.gap / 2) {
    await tab.send('Emulation.setDeviceMetricsOverride', viewportMetrics(config, config.viewport_height));
    return null;
  }
  log({ level: 'info', message: `Page renders only what is on screen; captured with a ${height}px viewport to render all of it` });
  return height;
}

async function optional(label, produce, log) {
  try {
    return await produce();
  } catch (error) {
    log({ level: 'warning', message: `${label} unavailable (${error.message})` });
    return null;
  }
}

async function captureOnce(url, { javascriptEnabled, config, windowId, log }) {
  const tab = await CaptureTab.open({ windowId });
  try {
    await tab.send('Emulation.setDeviceMetricsOverride', viewportMetrics(config, config.viewport_height));
    await tab.send('Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    // Static captures run without scripts: cheaper, deterministic, and they
    // never execute third-party code.
    if (!javascriptEnabled) await tab.send('Emulation.setScriptExecutionDisabled', { value: true });

    // A PDF opens in Chrome's viewer and never fires DOMContentLoaded here.
    const navigation = await tab.navigate(url, config.timeout_ms, {
      settleOn: [
        ['Network.responseReceived', (p) => p.type === 'Document' && isDocumentResponse(p.response)],
        ['Page.downloadWillBegin', () => true]
      ]
    });
    if (tab.downloadStarted || isDocumentResponse(tab.mainResponse)) throw new DownloadNavigation(url);
    // An error status with an empty body is still a response: capture Chrome's
    // page for it and let verification flag the status, as Playwright's goto does.
    if (navigation.errorText && !(navigation.errorText === 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' && tab.mainResponse)) {
      throw new Error(`Navigation failed: ${navigation.errorText}`);
    }
    const navigationError = navigation.timeout ?? null;
    let expandedViewport = null;

    // Static captures wait for load too (HRC desktop does; the Chrome build did not).
    await tab.waitForFlag('load', 'Page.loadEventFired', settleTimeout(config)).catch(() => {});
    if (javascriptEnabled) {
      // ponytail: HRC desktop also probes for text hidden by entrance animations (hidden_content) and enlarges
      // the viewport for apps whose main panel scrolls inside a one-screen document (_expand_scroll_container);
      // port both from engine/browser_capture.py when Gmail-style pages or animated landing pages matter.
      await tab.networkIdle(settleTimeout(config)).catch(() => {});
      await waitUntilPainted(tab, config, log);
      await tab.evaluate(SCROLL_THROUGH_SCRIPT).catch(() => {});
      expandedViewport = await optional('Virtualized list expansion', () => expandVirtualizedList(tab, config, log), log);
    }

    const page = await tab.evaluate(`(() => ({
      final_url: location.href,
      title: document.title,
      user_agent: navigator.userAgent,
      navigation_timing: performance.getEntriesByType('navigation')[0]?.toJSON?.() || {},
      dom: (document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '') + document.documentElement.outerHTML
    }))()`);
    const extent = await pageExtent(tab);
    const text = await tab.evaluate(`(${await pageTextSource()})()`).catch(() => '');
    // Freeze the page before rendering artifacts: ad loops and live feeds can
    // peg print-to-PDF indefinitely.
    await tab.send('Emulation.setScriptExecutionDisabled', { value: true });
    const mhtml = await optional('MHTML snapshot', async () => {
      const { data } = await tab.send('Page.captureSnapshot', { format: 'mhtml' });
      return new Blob([data], { type: 'multipart/related' });
    }, log);
    // Disabling scripts makes Chrome render <noscript>, whose content was parsed
    // as raw text. Hide it for the renders only; this adds a <style>, so it runs
    // after the MHTML snapshot.
    if (javascriptEnabled) await optional('Hiding <noscript>', () => hideNoscript(tab), log);

    const screenshot = await fullPageScreenshot(tab).catch(async () => viewportScreenshot(tab));
    const preview = await optional('Preview thumbnail', async () => {
      const clip = { x: 0, y: 0, width: config.viewport_width, height: config.viewport_height, scale: 1 };
      const { data } = await tab.send('Page.captureScreenshot', { format: 'jpeg', quality: 60, clip });
      return base64ToBlob(data, 'image/jpeg');
    }, () => {});
    const pdf = await optional('Page PDF', async () => {
      const { data } = await tab.send('Page.printToPDF', { printBackground: true });
      return base64ToBlob(data, 'application/pdf');
    }, log);

    return {
      tab,
      status_code: tab.mainResponse?.status ?? null,
      final_url: page.final_url,
      title: page.title,
      user_agent: page.user_agent,
      navigation_timing: page.navigation_timing,
      navigation_error: navigationError,
      rendered_dom: page.dom,
      javascript_enabled: javascriptEnabled,
      text,
      page_extent: extent,
      expanded_viewport: expandedViewport,
      artifacts: { screenshot, preview, pdf, mhtml }
    };
  } catch (error) {
    await tab.close();
    throw error;
  }
}

function authenticationDiagnostics(url, cookies) {
  const host = hostOf(url);
  const site = cookies.filter((c) => {
    const domain = String(c.domain || '').replace(/^\./, '');
    return host === domain || host.endsWith(`.${domain}`);
  });
  const active = site.filter((c) => !c.expirationDate || c.expirationDate * 1000 > Date.now());
  const names = new Set(active.map((c) => c.name));
  const facebook = host === 'facebook.com' || host.endsWith('.facebook.com');
  return {
    // The extension always captures with the browser's own session; nothing
    // was configured, so nothing was "expected".
    authentication_expected: false,
    cookie_count: cookies.length,
    site_cookie_count: site.length,
    expired_site_cookie_count: site.length - active.length,
    session_cookie_present: facebook ? names.has('c_user') && names.has('xs') : host.endsWith('linkedin.com') ? names.has('li_at') : active.length > 0
  };
}

/**
 * Returns `{ result, tab }` — the tab stays open for the media layer — or
 * throws DownloadNavigation when the URL is a file rather than a page.
 */
export async function browserCapture(url, { config, windowId, log }) {
  let javascriptEnabled = requiresJavascript(url);
  let capture = await captureOnce(url, { javascriptEnabled, config, windowId, log });

  const unusableRender = async (candidate) =>
    (await blankRenderReason(candidate.artifacts.screenshot)) || clippedRenderReason(candidate.page_extent);
  let blankRender = await unusableRender(capture);
  let adaptiveRetry = false;
  let retryReason = null;
  if (!javascriptEnabled) {
    retryReason = javascriptRetryReason(capture.rendered_dom) || blankRender;
    if (retryReason) {
      log({ level: 'info', message: `Static capture looks unrendered (${retryReason}); retrying with JavaScript: ${url}` });
      try {
        const retry = await captureOnce(url, { javascriptEnabled: true, config, windowId, log });
        await capture.tab.close();
        capture = retry;
        javascriptEnabled = true;
        adaptiveRetry = true;
        blankRender = await unusableRender(capture);
      } catch (error) {
        if (error instanceof DownloadNavigation) throw error;
        log({ level: 'warning', message: `JavaScript retry failed (${error.message}); keeping the static capture` });
      }
    }
  }

  // Pipeline does not ask for the cookies permission: diagnostics fall back to "no cookie info".
  const cookies = (await Promise.resolve(chrome.cookies?.getAll({ url })).catch(() => [])) ?? [];
  const authentication = authenticationDiagnostics(url, cookies);
  const domSignals = pageDomSignals(capture.rendered_dom);
  const browserVersion = /Chrome\/([\d.]+)/.exec(capture.user_agent)?.[1] ?? null;
  const metadata = {
    url,
    final_url: capture.final_url,
    status_code: capture.status_code,
    browser_version: browserVersion,
    browser_engine: 'chrome-extension-debugger',
    viewport: { width: config.viewport_width, height: config.viewport_height },
    user_agent: capture.user_agent,
    navigation_timing: capture.navigation_timing,
    title: capture.title,
    javascript_enabled: javascriptEnabled,
    javascript_adaptive_retry: adaptiveRetry,
    authentication,
    dom_signals: domSignals
  };
  if (capture.expanded_viewport) metadata.expanded_viewport_height = capture.expanded_viewport;
  if (capture.navigation_error) metadata.navigation_error = capture.navigation_error;
  if (retryReason) metadata.javascript_retry_reason = retryReason;
  if (blankRender) metadata.blank_render = blankRender;
  const assessment = assessBrowserCapture({
    url,
    finalUrl: capture.final_url,
    statusCode: capture.status_code,
    title: capture.title,
    domSignals,
    navigationError: capture.navigation_error,
    authenticationExpected: authentication.authentication_expected,
    authenticationCookiePresent: authentication.session_cookie_present,
    blankRender
  });
  metadata.capture_quality = assessment.quality;
  metadata.capture_issues = assessment.issues;
  if (assessment.issues.length) metadata.capture_issue_summary = assessment.issues.map((i) => i.message).join('; ');

  const har = buildHar(capture.tab.network, {
    title: capture.title,
    url: capture.final_url,
    startedDateTime: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version
  });
  const { screenshot, preview, pdf, mhtml } = capture.artifacts;
  const json = (value) => new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  // Same file set and names HRC writes (screenshot.png, page.pdf, snapshot.mhtml, network.har, dom.html, preview.jpg).
  // ponytail: embedded video/audio and page images are not downloaded; HRC's media layer is not ported.
  const files = [
    { id: 'screenshot', name: 'screenshot.png', blob: screenshot },
    pdf && { id: 'page_pdf', name: 'page.pdf', blob: pdf },
    mhtml && { id: 'mhtml_snapshot', name: 'snapshot.mhtml', blob: mhtml },
    { id: 'network_har', name: 'network.har', blob: json(har) },
    { id: 'rendered_dom', name: 'dom.html', blob: new Blob([capture.rendered_dom], { type: 'text/html' }) },
    preview && { id: 'preview', name: 'preview.jpg', blob: preview }
  ].filter(Boolean);
  metadata.capture_artifacts = files.map((f) => f.name);
  return { result: { status: 'browser_capture: success', metadata, files, text: capture.text }, tab: capture.tab };
}

export { TimeoutError };
