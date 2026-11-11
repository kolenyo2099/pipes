// Pipeline — capture (service worker side, classic script loaded by importScripts)
// Context menus "Save link/page to team sheet" + the PDF title prompt.
// Delivery is pipelineEnqueue() from outbox.js.
(function () {
  const isPdfUrl = (url = '') => {
    try { return new URL(url).pathname.toLowerCase().endsWith('.pdf'); }
    catch { return /\.pdf(?:[?#]|$)/i.test(url); }
  };

  const IMG = /\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)$/i;
  const isImageUrl = (url = '') => {
    try { return IMG.test(new URL(url).pathname); }
    catch { return /\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#]|$)/i.test(url); }
  };

  function embeddedPdfUrl(url = '') {
    try { return new URL(url).searchParams.get('src') || ''; } catch { return ''; }
  }

  function getPdfUrl(info = {}, tab = {}) {
    const candidates = [tab.url, info.pageUrl, info.frameUrl].filter(Boolean);
    for (const c of candidates) { const e = embeddedPdfUrl(c); if (e) return e; }
    for (const c of candidates) if (isPdfUrl(c)) return c;
    return /\.pdf\b/i.test(tab.title || '') ? (tab.url || info.pageUrl || '') : '';
  }

  function filenameOf(url = '') {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '').trim();
    } catch {
      return decodeURIComponent(url.split(/[?#]/)[0].split('/').filter(Boolean).pop() || '').trim();
    }
  }

  function pdfFallbackTitle(tab, pdfUrl = '') {
    const title = (tab.title || '').replace(/\s*[-–]\s*.*PDF.*$/i, '').trim();
    if (title && !/^about:blank$/i.test(title)) return title;
    return filenameOf(pdfUrl || tab.url || '').replace(/\.pdf$/i, '').trim();
  }

  const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

  // Drop blank placeholders; the outbox fills savedBy.
  function makeCapture(sourceType, fields) {
    const capture = { sourceType, timestamp: new Date().toISOString() };
    for (const [k, v] of Object.entries(fields)) if (v) capture[k] = v;
    return capture;
  }

  async function toast(tabId, msg, ok) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (msg, ok) => {
          const id = '__pipeline_bg_toast__';
          document.getElementById(id)?.remove();
          const el = document.createElement('div');
          el.id = id;
          el.textContent = msg;
          Object.assign(el.style, {
            position: 'fixed', bottom: '20px', right: '20px', zIndex: '2147483647',
            padding: '10px 16px', borderRadius: '6px',
            background: ok ? '#276749' : '#c53030', color: '#fff', fontSize: '14px',
            fontFamily: 'system-ui, sans-serif', boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
            pointerEvents: 'none'
          });
          document.body.appendChild(el);
          setTimeout(() => el.remove(), 3000);
        },
        args: [msg, ok]
      });
    } catch { /* restricted page: the outbox badge still shows the queue */ }
  }

  // `manual`: also remember this tab for the Archive view's "Capture that tab now" (the engine runs in the app page,
  // which has the DOM APIs, blob URLs and downloads it needs; a service worker cannot do the capture itself).
  async function save({ capture, tabId, manual }) {
    const reply = await pipelineEnqueue({ kind: 'capture', capture });
    if (reply?.ok && manual) {
      const { pipelineManualTabs = [] } = await chrome.storage.session.get('pipelineManualTabs');
      await chrome.storage.session.set({ pipelineManualTabs: [...pipelineManualTabs.filter((e) => e.tabId !== tabId), { tabId, url: capture.url, title: capture.title || '' }] });
    }
    await toast(
      tabId,
      reply?.ok
        ? (manual ? `✅ Saved. Open Pipeline → Archive and press "Capture that tab now": "${(capture.title || capture.url).slice(0, 40)}"`
                  : `✅ Saved to team queue: "${(capture.title || capture.url).slice(0, 60)}"`)
        : `❌ ${reply?.error || 'Save failed.'}`,
      !!reply?.ok
    );
  }

  async function promptForPdfTitleAndSave({ defaultTitle, pendingSave }) {
    const requestId = crypto.randomUUID();
    const promptUrl = chrome.runtime.getURL(
      `capture/pdf-title.html?requestId=${encodeURIComponent(requestId)}&title=${encodeURIComponent(defaultTitle || '')}`
    );
    await chrome.storage.session.set({ [`pdfSave:${requestId}`]: pendingSave });
    try {
      const win = await chrome.windows.create({ url: promptUrl, type: 'popup', width: 420, height: 220, focused: true });
      await chrome.storage.session.set({ [`pdfSaveWindow:${requestId}`]: win?.id });
    } catch {
      await chrome.storage.session.remove(`pdfSave:${requestId}`);
      await toast(pendingSave.tabId, '❌ Could not open the title prompt.', false);
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'pipeline:pdf-title' || !message.requestId) return;
    (async () => {
      const pendingKey = `pdfSave:${message.requestId}`;
      const windowKey = `pdfSaveWindow:${message.requestId}`;
      const data = await chrome.storage.session.get([pendingKey, windowKey]);
      const pendingSave = data[pendingKey];
      const windowId = data[windowKey];
      await chrome.storage.session.remove([pendingKey, windowKey]);
      if (typeof windowId === 'number') chrome.windows.remove(windowId).catch(() => {});

      const title = typeof message.title === 'string' ? message.title.trim() : '';
      if (!pendingSave || !title) return; // cancelled
      pendingSave.capture.title = title;
      await save(pendingSave);
    })();
  });

  // Prompt window closed without a response: drop its pending save.
  chrome.windows.onRemoved.addListener(async (windowId) => {
    const all = await chrome.storage.session.get(null);
    const stale = [];
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('pdfSaveWindow:') && v === windowId) {
        stale.push(k, `pdfSave:${k.slice('pdfSaveWindow:'.length)}`);
      }
    }
    if (stale.length) await chrome.storage.session.remove(stale);
  });

  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: 'pipeline-save-link', title: 'Save link to team sheet', contexts: ['link'] });
      chrome.contextMenus.create({ id: 'pipeline-save-page', title: 'Save page to team sheet', contexts: ['all'] });
      chrome.contextMenus.create({ id: 'pipeline-archive-page', title: 'Archive this page to team sheet', contexts: ['all'] });
    });
  });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab) return;
    let capture, pdf = false;

    if (info.menuItemId === 'pipeline-save-link') {
      // Link text recorded by context-tracker.js
      let linkText = '';
      try {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => window.__pipelineContext?.linkText ?? ''
        });
        linkText = r?.result ?? '';
      } catch { /* restricted page */ }

      const url = info.linkUrl;
      pdf = isPdfUrl(url);
      capture = makeCapture(pdf ? 'pdf' : 'link', { title: linkText, url, domain: hostOf(url) });
      if (pdf) {
        return promptForPdfTitleAndSave({
          defaultTitle: pdfFallbackTitle(tab, url),
          pendingSave: { capture, tabId: tab.id }
        });
      }
    } else if (info.menuItemId === 'pipeline-save-page' || info.menuItemId === 'pipeline-archive-page') {
      let meta = {};
      try {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const m = (n) => document.querySelector(`meta[name="${n}"]`)?.content ||
                             document.querySelector(`meta[property="${n}"]`)?.content || '';
            return {
              metaDescription: m('description'),
              ogTitle:         m('og:title'),
              ogDescription:   m('og:description'),
              ogType:          m('og:type'),
              author:          m('author') || m('article:author'),
              publishDate:     m('article:published_time') || m('date') || m('pubdate'),
              canonicalUrl:    document.querySelector('link[rel="canonical"]')?.href || '',
              language:        document.documentElement.lang || ''
            };
          }
        });
        meta = r?.result || {};
      } catch { /* restricted page */ }

      // The saved thing is the open page, so its text goes along (page-text.js; empty on restricted pages).
      let text = '';
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture/page-text.js'] });
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => pipelinePageText() });
        text = r?.result || '';
      } catch { /* restricted page */ }

      const pdfUrl = getPdfUrl(info, tab);
      const url = pdfUrl || (info.srcUrl && isImageUrl(info.srcUrl) ? info.srcUrl : tab.url || '');
      const image = !pdfUrl && isImageUrl(url);
      capture = makeCapture(pdfUrl ? 'pdf' : image ? 'image' : 'page', {
        title: image ? filenameOf(url) : (tab.title || ''),
        url, domain: hostOf(url), ...meta, ...(!pdfUrl && !image && { text })
      });
      if (pdfUrl) {
        return promptForPdfTitleAndSave({
          defaultTitle: pdfFallbackTitle(tab, url),
          pendingSave: { capture, tabId: tab.id }
        });
      }
    } else {
      return;
    }

    await save({ capture, tabId: tab.id, manual: info.menuItemId === 'pipeline-archive-page' });
  });
})();
