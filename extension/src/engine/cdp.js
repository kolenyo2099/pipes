// A capture tab driven over the Chrome DevTools Protocol (chrome.debugger):
// the in-browser stand-in for the desktop engine's Playwright page. It runs in
// the user's own Chrome, so it carries their sessions and residential IP.

import { recordNetworkEvent } from './har.js';
import { sleep } from './util.js';

const tabs = new Map();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  chrome.debugger.onEvent.addListener((source, method, params) => tabs.get(source.tabId)?.dispatch(method, params));
  chrome.debugger.onDetach.addListener((source, reason) => {
    const tab = tabs.get(source.tabId);
    if (tab) tab.detached = reason;
  });
}

export class TimeoutError extends Error {}

/** One unfocused window per job holds its capture tabs. */
export async function openCaptureWindow() {
  const window = await chrome.windows.create({ url: 'about:blank', focused: false, width: 1480, height: 1000, type: 'normal' });
  return window.id;
}

export async function closeWindow(windowId) {
  if (windowId == null) return;
  try { await chrome.windows.remove(windowId); } catch { /* already closed */ }
}

export class CaptureTab {
  static async open({ windowId, active = true, url = 'about:blank' } = {}) {
    listen();
    const created = await chrome.tabs.create({ ...(windowId != null ? { windowId } : {}), url, active });
    return CaptureTab.attach(created.id, { ownsTab: true });
  }

  static async attach(tabId, { ownsTab = false } = {}) {
    listen();
    const tab = new CaptureTab(tabId, ownsTab);
    await chrome.debugger.attach({ tabId }, '1.3');
    tabs.set(tabId, tab);
    await tab.send('Page.enable');
    await tab.send('Network.enable', { maxTotalBufferSize: 100_000_000, maxResourceBufferSize: 20_000_000, maxPostDataSize: 2_000_000 });
    await tab.send('Runtime.enable');
    return tab;
  }

  constructor(tabId, ownsTab) {
    this.tabId = tabId;
    this.ownsTab = ownsTab;
    this.waiters = new Set();
    this.network = { requests: {} };
    this.inflight = new Set();
    this.lastNetworkActivity = Date.now();
    this.mainFrameId = null;
    this.mainResponse = null;
    this.flags = {};
    this.detached = null;
    this.downloadStarted = false;
  }

  send(method, params = {}) {
    if (this.detached) return Promise.reject(new Error(`Chrome debugger detached: ${this.detached}`));
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params);
  }

  dispatch(method, params) {
    if (method.startsWith('Network.')) {
      recordNetworkEvent(this.network, method, params);
      if (method === 'Network.requestWillBeSent') this.inflight.add(params.requestId);
      if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') this.inflight.delete(params.requestId);
      this.lastNetworkActivity = Date.now();
      if (method === 'Network.responseReceived' && params.type === 'Document' && (!this.mainFrameId || params.frameId === this.mainFrameId)) {
        this.mainResponse = params.response;
      }
    }
    if (method === 'Page.frameNavigated' && !params.frame.parentId) this.mainFrameId = params.frame.id;
    if (method === 'Page.domContentEventFired') this.flags.domContent = true;
    if (method === 'Page.loadEventFired') this.flags.load = true;
    if (method === 'Page.downloadWillBegin') this.downloadStarted = true;
    for (const waiter of [...this.waiters]) {
      if (waiter.method === method && waiter.accept(params)) {
        this.waiters.delete(waiter);
        waiter.resolve(params);
      }
    }
  }

  waitFor(method, timeoutMs, accept = () => true) {
    return new Promise((resolve, reject) => {
      const waiter = { method, accept, resolve };
      this.waiters.add(waiter);
      setTimeout(() => {
        if (this.waiters.delete(waiter)) reject(new TimeoutError(`Timeout ${timeoutMs}ms exceeded waiting for ${method}`));
      }, timeoutMs);
    });
  }

  /** Waits for a page flag that may already be set. */
  async waitForFlag(flag, event, timeoutMs) {
    if (this.flags[flag]) return;
    await this.waitFor(event, timeoutMs);
  }

  resetDocumentState() {
    this.flags = {};
    this.mainResponse = null;
    this.network = { requests: {} };
    this.inflight.clear();
  }

  /**
   * Navigate and wait for DOMContentLoaded, or for any of `settleOn`
   * ([event, accept] pairs), e.g. the response turning out to be a file.
   * Returns { errorText }, { timeout } or {}.
   */
  async navigate(url, timeoutMs, { settleOn = [] } = {}) {
    this.resetDocumentState();
    const signals = [['Page.domContentEventFired', () => true], ...settleOn].map(([method, accept]) => this.waitFor(method, timeoutMs, accept));
    signals.forEach((signal) => signal.catch(() => {}));
    const result = await this.send('Page.navigate', { url });
    if (result.frameId) this.mainFrameId = result.frameId;
    if (result.errorText) return { errorText: result.errorText };
    try {
      await Promise.race(signals);
      return {};
    } catch (error) {
      return { timeout: error.message };
    }
  }

  async reload(timeoutMs) {
    this.resetDocumentState();
    const domReady = this.waitFor('Page.domContentEventFired', timeoutMs);
    domReady.catch(() => {});
    await this.send('Page.reload', { ignoreCache: false });
    await domReady;
  }

  /** No request in flight for `quietMs`, or give up after `timeoutMs`. */
  async networkIdle(timeoutMs, quietMs = 500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.inflight.size && Date.now() - this.lastNetworkActivity >= quietMs) return true;
      await sleep(100);
    }
    throw new TimeoutError(`Timeout ${timeoutMs}ms exceeded waiting for network idle`);
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'page script failed');
    }
    return result.result?.value;
  }

  /** Call a self-contained function in the page with JSON arguments. */
  call(fn, ...args) {
    return this.evaluate(`(${fn})(...${JSON.stringify(args)})`);
  }

  async close() {
    tabs.delete(this.tabId);
    try { await chrome.debugger.detach({ tabId: this.tabId }); } catch { /* already detached */ }
    if (this.ownsTab) {
      try { await chrome.tabs.remove(this.tabId); } catch { /* already closed */ }
    }
  }
}

export function base64ToBlob(data, type) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}
