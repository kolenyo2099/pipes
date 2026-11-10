// Pipeline — capture content script
// Injects save buttons on Google results, X/Twitter, YouTube and Facebook.
// Every save is handed to the service-worker outbox via 'pipeline:save'.

function extensionContextAlive() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

let toastEl = null;
function showToast(message, type = 'info') {
  if (toastEl) toastEl.remove();
  toastEl = document.createElement('div');
  toastEl.className = `sts-toast sts-toast-${type}`;
  toastEl.textContent = message;
  document.body.appendChild(toastEl);
  setTimeout(() => { if (toastEl) toastEl.remove(); }, 4000);
}

function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

// Drop blank placeholders, stamp the time.
function buildCapture(sourceType, fields) {
  const capture = { sourceType, timestamp: new Date().toISOString() };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== '' && v !== undefined && v !== null) capture[k] = v;
  }
  return capture;
}

// Returns the outbox reply: { ok, queued } | { ok:false, error }
async function sendCapture(capture, key) {
  if (!extensionContextAlive()) {
    return { ok: false, error: 'Extension was reloaded — please refresh this page.' };
  }
  try {
    const item = { kind: 'capture', capture };
    if (key) item.key = key;
    return (await chrome.runtime.sendMessage({ type: 'pipeline:save', item }))
      || { ok: false, error: 'No response from extension.' };
  } catch {
    return { ok: false, error: 'Could not reach the extension. Try reloading the page.' };
  }
}

// Shared click flow for single-item buttons (tweet / video / post).
async function saveWithButton(btn, capture, okMessage) {
  btn.disabled = true;
  btn.textContent = '⏳';
  const reply = await sendCapture(capture);
  if (reply.ok) {
    btn.textContent = '✅';
    showToast(`✅ ${okMessage}`, 'success');
  } else {
    btn.disabled = false;
    btn.textContent = '❌';
    showToast(`❌ ${reply.error || 'Could not save.'}`, 'error');
    setTimeout(() => { btn.textContent = '💾'; }, 3000);
  }
}

// ── Google Search ─────────────────────────────────────────────────────────────

let lastUrl = location.href;

// Keys already handed to the outbox for the current query.
const savedGoogleUrls = new Set();
function savedKey(href) { return `${getCurrentQuery()}|${href}`; }

function getCurrentQuery() {
  return new URLSearchParams(window.location.search).get('q') || '';
}

// Walk the SERP in document order and return one entry per organic result.
// The selectors overlap (a div.g can sit inside a div[data-hveid]), so nested
// matches resolve to the same <h3> — that element is used as the identity key.
function collectGoogleResults() {
  const seen = new Set();
  const results = [];

  document.querySelectorAll('div.g, div[data-hveid]').forEach(result => {
    const titleEl = result.querySelector('h3');
    const linkEl  = result.querySelector('a[href]');
    if (!titleEl || !linkEl || seen.has(titleEl)) return;

    // Skip Google's own widgets (Scholar block, image/news carousels, "people
    // also ask"). They carry an <h3> and pass as results, but their heading is a
    // section label rather than a page title, and counting them shifts the rank
    // of every organic result below.
    const href = linkEl.href;
    if (!href) return;

    let url;
    try { url = new URL(href); } catch { return; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    if (/(^|\.)google(\.[a-z]{2,3})+$/i.test(url.hostname)) return;

    seen.add(titleEl);
    results.push({
      titleEl,
      href,
      snippetEl: result.querySelector('.VwiC3b, [data-sncf="1"], [data-sncf="2"]'),
      position: results.length + 1
    });
  });

  return results;
}

function buildGoogleCapture(entry) {
  return buildCapture('google', {
    query:   getCurrentQuery(),
    title:   entry.titleEl.textContent.trim(),
    url:     entry.href,
    snippet: entry.snippetEl ? entry.snippetEl.textContent.trim() : '',
    domain:  (() => { try { return new URL(entry.href).hostname; } catch { return ''; } })(),
    position: String(entry.position),
  });
}

function addSaveButtons() {
  collectGoogleResults().forEach(entry => {
    const { titleEl, href } = entry;
    if (titleEl.parentElement.querySelector('.sts-save-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'sts-save-btn';
    btn.textContent = '💾';
    btn.title = 'Save to team sheet';

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      btn.disabled = true;
      btn.textContent = '⏳';
      const capture = buildGoogleCapture(entry);
      const key = savedKey(href);
      const reply = await sendCapture(capture, key);

      if (reply.ok) {
        savedGoogleUrls.add(key);
        btn.textContent = '✅';
        showToast(reply.queued
          ? `✅ Saved to team queue: "${capture.title.slice(0, 60)}"`
          : 'Already saved.', reply.queued ? 'success' : 'info');
        updateSaveAllBar();
      } else {
        btn.disabled = false;
        btn.textContent = '❌';
        showToast(`❌ ${reply.error || 'Could not save.'}`, 'error');
        setTimeout(() => { btn.textContent = '💾'; }, 3000);
      }
    });

    titleEl.parentElement.insertBefore(btn, titleEl.nextSibling);
  });
}

// ── Google Search — save all results ──────────────────────────────────────────

let saveAllRunning = false;

async function saveAllResults(btn) {
  if (saveAllRunning) return;

  const pending = collectGoogleResults().filter(e => !savedGoogleUrls.has(savedKey(e.href)));
  if (pending.length === 0) {
    showToast('Nothing new to save on this page.', 'info');
    return;
  }

  saveAllRunning = true;
  btn.disabled = true;
  btn.textContent = `📤 Queuing ${pending.length}…`;

  const replies = await Promise.all(pending.map(entry => {
    const key = savedKey(entry.href);
    return sendCapture(buildGoogleCapture(entry), key).then(reply => ({ entry, key, reply }));
  }));

  saveAllRunning = false;
  btn.disabled = false;

  let queued = 0, duplicate = 0, failed = 0, firstError = '';
  for (const { entry, key, reply } of replies) {
    const rowBtn = entry.titleEl.parentElement.querySelector('.sts-save-btn');
    if (reply.ok) {
      savedGoogleUrls.add(key);
      if (reply.queued) queued++; else duplicate++;
      if (rowBtn) { rowBtn.disabled = true; rowBtn.textContent = '✅'; }
    } else {
      failed++;
      firstError = firstError || reply.error || '';
    }
  }

  if (failed) {
    showToast(`❌ ${firstError || 'Could not save.'}${queued ? ` (${queued} queued)` : ''}`, 'error');
  } else {
    showToast(
      duplicate > 0
        ? `📤 Queued ${queued} for the team sheet (${duplicate} already saved).`
        : `📤 Queued ${queued} result${queued === 1 ? '' : 's'} — saving in the background.`,
      'success'
    );
  }
  updateSaveAllBar();
}

function updateSaveAllBar() {
  const btn = document.querySelector('.sts-save-all-btn');
  if (!btn || saveAllRunning) return;

  const pending = collectGoogleResults().filter(e => !savedGoogleUrls.has(savedKey(e.href))).length;
  const label = pending > 0
    ? `💾 Save all ${pending} result${pending === 1 ? '' : 's'}`
    : '✅ All results saved';

  // Only write when the label actually changes — assigning textContent replaces
  // the text node, which would retrigger the MutationObserver that called us
  if (btn.textContent !== label) btn.textContent = label;
  btn.disabled = pending === 0;
}

function addSaveAllBar() {
  if (!getCurrentQuery()) return;
  if (document.querySelector('.sts-save-all-bar')) { updateSaveAllBar(); return; }
  if (collectGoogleResults().length === 0) return;

  // Google re-skins the SERP often; fall back through progressively broader anchors
  const anchor = document.querySelector('#rso') || document.querySelector('#search');
  const parent = anchor ? anchor.parentElement : document.querySelector('#center_col');
  if (!parent) return;

  const bar = document.createElement('div');
  bar.className = 'sts-save-all-bar';

  const btn = document.createElement('button');
  btn.className = 'sts-save-all-btn';
  btn.title = 'Save every result on this page to the team sheet';
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    saveAllResults(btn);
  });

  bar.appendChild(btn);
  parent.insertBefore(bar, anchor || parent.firstChild);
  updateSaveAllBar();
}

function initGoogle() {
  const refresh = () => { addSaveButtons(); addSaveAllBar(); };
  // Debounced: Google mutates the SERP constantly, and each pass re-scans the
  // whole result list
  const debouncedRefresh = debounce(refresh, 150);

  refresh();

  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // New query or results page — previous saves no longer apply
      savedGoogleUrls.clear();
      setTimeout(refresh, 500);
    } else {
      debouncedRefresh();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ── X.com / Twitter ───────────────────────────────────────────────────────────

function extractTweetData(article) {
  // Permalink — the <a> wrapping the <time> element is the most reliable anchor
  const permalinkAnchor = article.querySelector('a[href*="/status/"] time')
    ?.closest('a[href*="/status/"]');
  const tweetPath = permalinkAnchor?.getAttribute('href') || '';
  const tweetId   = tweetPath.split('/status/')[1]?.split(/[/?#]/)[0] || '';
  const tweetUrl  = tweetId ? `https://${location.hostname}${tweetPath}` : location.href;

  // Tweet body
  const tweetText = article.querySelector('[data-testid="tweetText"]')?.innerText || '';

  // Author — User-Name block, first role="link" anchor = profile link
  const userBlock   = article.querySelector('[data-testid="User-Name"]');
  const profileLink = userBlock?.querySelector('a[role="link"]');
  const rawHandle   = profileLink?.getAttribute('href')?.replace(/^\//, '')?.split('/')[0] || '';
  const authorUsername = rawHandle ? `@${rawHandle}` : '';
  // Display name: nested span>span inside the profile link
  const authorName =
    profileLink?.querySelector('span > span')?.innerText ||
    profileLink?.querySelector('span')?.innerText || '';

  // Datetime from <time datetime="ISO string">
  const tweetDate = article.querySelector('time')?.getAttribute('datetime') || '';

  return { tweetId, tweetUrl, tweetText, authorName, authorUsername, tweetDate };
}

function addTweetSaveButtons() {
  document.querySelectorAll('article[data-testid="tweet"]').forEach(article => {
    if (article.querySelector('.sts-tweet-btn')) return;

    // Action bar = the [role="group"] that contains the reply button
    const replyBtn   = article.querySelector('[data-testid="reply"]');
    if (!replyBtn) return;
    const actionGroup = replyBtn.closest('[role="group"]');
    if (!actionGroup) return;

    const btn = document.createElement('button');
    btn.className = 'sts-tweet-btn';
    btn.textContent = '💾';
    btn.title = 'Save tweet to team sheet';
    btn.setAttribute('aria-label', 'Save to team sheet');

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const data = extractTweetData(article);
      const capture = buildCapture('x', {
        // title = handle + first 100 chars of tweet
        title:          data.authorUsername
          ? `${data.authorUsername}: ${data.tweetText.slice(0, 100)}`
          : data.tweetText.slice(0, 100),
        url:            data.tweetUrl,
        domain:         location.hostname,
        tweetId:        data.tweetId,
        tweetText:      data.tweetText,
        authorName:     data.authorName,
        authorUsername: data.authorUsername,
        tweetDate:      data.tweetDate,
        author:         data.authorName,
        publishDate:    data.tweetDate,
        canonicalUrl:   data.tweetUrl,
        // Timeline tweets are not the open page; only a tweet's own page carries text.
        text:           data.tweetId && location.pathname.includes(`/status/${data.tweetId}`) ? pipelinePageText() : '',
      });
      saveWithButton(btn, capture, `Saved tweet${data.authorUsername ? ` by ${data.authorUsername}` : ''} to team queue`);
    });

    actionGroup.appendChild(btn);
  });
}

function initTwitter() {
  addTweetSaveButtons();

  // Debounce to avoid hammering addTweetSaveButtons on every micro-mutation
  const debouncedAdd = debounce(addTweetSaveButtons, 300);

  const observer = new MutationObserver(mutations => {
    if (mutations.some(m => m.addedNodes.length > 0)) debouncedAdd();
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ── YouTube ───────────────────────────────────────────────────────────────────

function extractYouTubeData() {
  const videoId  = new URLSearchParams(location.search).get('v') || '';
  const videoUrl = location.href;

  // Title — yt-formatted-string inside h1, fallback to document.title
  const titleEl = document.querySelector('h1.ytd-video-primary-info-renderer yt-formatted-string')
    || document.querySelector('#title h1 yt-formatted-string')
    || document.querySelector('h1 yt-formatted-string');
  const title = titleEl?.textContent?.trim()
    || document.title.replace(/\s*[-–]\s*YouTube\s*$/, '').trim();

  // View count — prefer full number, fall back to abbreviated
  const viewCount =
    document.querySelector('span.view-count')?.textContent?.trim()
    || document.querySelector('span.short-view-count')?.textContent?.trim()
    || '';

  // Channel name + URL
  const channelAnchor = document.querySelector('#channel-name a')
    || document.querySelector('ytd-channel-name a');
  const channelName = channelAnchor?.textContent?.trim() || '';
  const channelHref = channelAnchor?.getAttribute('href') || '';
  const channelUrl  = channelHref
    ? new URL(channelHref, location.origin).href
    : '';

  // Description — grab collapsed text; good enough for logging purposes
  const descEl = document.querySelector('ytd-expandable-video-description-body-renderer');
  const videoDescription = descEl?.textContent?.trim() || '';

  // Upload date + duration from JSON-LD (most reliable)
  let uploadDate = '';
  let duration   = '';
  document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    try {
      const data = JSON.parse(s.textContent);
      if (data['@type'] === 'VideoObject') {
        uploadDate = data.uploadDate || data.datePublished || '';
        duration   = data.duration   || '';           // ISO 8601, e.g. PT4M13S
      }
    } catch {}
  });

  return { videoId, videoUrl, title, viewCount, channelName, channelUrl, videoDescription, uploadDate, duration };
}

function addYouTubeSaveButton() {
  if (!location.pathname.startsWith('/watch')) return;
  if (document.querySelector('.sts-yt-btn')) return;

  // Like/dislike bar — try a few selector paths YouTube has used
  const actionsEl = document.querySelector('#actions #top-level-buttons-computed')
    || document.querySelector('#top-level-buttons-computed')
    || document.querySelector('#actions');
  if (!actionsEl) return;

  const btn = document.createElement('button');
  btn.className = 'sts-yt-btn';
  btn.textContent = '💾';
  btn.title = 'Save video to team sheet';
  btn.setAttribute('aria-label', 'Save to team sheet');

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const data = extractYouTubeData();
    const capture = buildCapture('youtube', {
      title:            data.title,
      url:              data.videoUrl,
      domain:           location.hostname,
      videoId:          data.videoId,
      channelName:      data.channelName,
      channelUrl:       data.channelUrl,
      viewCount:        data.viewCount,
      videoDescription: data.videoDescription,
      uploadDate:       data.uploadDate,
      duration:         data.duration,
      author:           data.channelName,
      publishDate:      data.uploadDate,
      canonicalUrl:     data.videoUrl,
      text:             pipelinePageText(),
    });
    saveWithButton(btn, capture, `Saved to team queue: "${data.title.slice(0, 60)}"`);
  });

  actionsEl.appendChild(btn);
}

function initYouTube() {
  const debouncedAdd = debounce(addYouTubeSaveButton, 600);

  // YouTube fires this custom event on SPA navigation (new video loaded)
  document.addEventListener('yt-navigate-finish', () => {
    document.querySelectorAll('.sts-yt-btn').forEach(b => b.remove());
    if (location.pathname.startsWith('/watch')) debouncedAdd();
  });

  // MutationObserver as fallback for initial load and slow renders
  const observer = new MutationObserver(mutations => {
    if (
      location.pathname.startsWith('/watch') &&
      !document.querySelector('.sts-yt-btn') &&
      mutations.some(m => m.addedNodes.length > 0)
    ) {
      debouncedAdd();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Attempt immediately (may already be rendered)
  debouncedAdd();
}

// ── Facebook ──────────────────────────────────────────────────────────────────

function isFacebookPostPage() {
  const path   = location.pathname;
  const search = location.search;
  return path.includes('/posts/')
    || path.includes('/videos/')
    || path.includes('/photos/')
    || /\/permalink(\.php)?/.test(path)
    || search.includes('story_fbid=');
}

function extractFacebookData() {
  const postUrl = location.href;

  // Post ID — several URL formats exist
  const postId =
    location.pathname.match(/\/posts\/([^/?#]+)/)?.[1]
    || location.pathname.match(/\/videos\/([^/?#]+)/)?.[1]
    || location.pathname.match(/\/photos\/([^/?#]+)/)?.[1]
    || new URLSearchParams(location.search).get('story_fbid')
    || '';

  // Post text — data-testid is more stable than hashed class names
  const postTextEl =
    document.querySelector('[data-testid="post_message"]')
    || document.querySelector('[data-ad-preview="message"]');
  const postText = postTextEl?.innerText?.trim() || '';

  // Author name
  const authorEl =
    document.querySelector('[data-testid="actor-name"]')
    || document.querySelector('h2 strong a')
    || document.querySelector('h3 strong a');
  const authorName = authorEl?.innerText?.trim() || '';

  // Post date — time[datetime] is most reliable (ISO string); fall back to
  // data-utime (Unix seconds) or abbr[title] (human-readable)
  let postDate = '';
  const timeEl =
    document.querySelector('time[datetime]')
    || document.querySelector('abbr[data-utime]')
    || document.querySelector('abbr[title]');
  if (timeEl) {
    const raw =
      timeEl.getAttribute('datetime')
      || timeEl.getAttribute('data-utime')
      || timeEl.getAttribute('title')
      || '';
    postDate = /^\d{10}$/.test(raw)
      ? new Date(parseInt(raw, 10) * 1000).toISOString()
      : raw;
  }

  // Reaction count — first aria-label matching "reactions" pattern
  let reactionCount = '';
  for (const el of document.querySelectorAll('[aria-label]')) {
    const label = el.getAttribute('aria-label') || '';
    const m =
      label.match(/^([\d,]+)\s*(?:people\s+)?reaction/i)
      || label.match(/All reactions:\s*([\d,]+)/i);
    if (m) { reactionCount = m[1].replace(/,/g, ''); break; }
  }

  return { postId, postUrl, postText, authorName, postDate, reactionCount };
}

function addFacebookSaveButton() {
  if (!isFacebookPostPage()) return;
  if (document.querySelector('.sts-fb-btn')) return;

  // Anchor on the Like button, then climb to the action bar row
  const likeBtn =
    document.querySelector('[aria-label="Like"][role="button"]')
    || document.querySelector('[aria-label^="Like"][type="button"]');
  if (!likeBtn) return;

  const actionBar =
    likeBtn.closest('[role="toolbar"]')
    || likeBtn.parentElement?.parentElement;
  if (!actionBar) return;

  const btn = document.createElement('button');
  btn.className = 'sts-fb-btn';
  btn.textContent = '💾';
  btn.title = 'Save post to team sheet';
  btn.setAttribute('aria-label', 'Save to team sheet');

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const data = extractFacebookData();
    const capture = buildCapture('facebook', {
      title:           data.authorName
        ? `${data.authorName}: ${data.postText.slice(0, 100)}`
        : data.postText.slice(0, 100),
      url:             data.postUrl,
      domain:          location.hostname,
      // generic page-level aliases
      author:          data.authorName,
      publishDate:     data.postDate,
      canonicalUrl:    data.postUrl,
      fbPostId:        data.postId,
      fbAuthorName:    data.authorName,
      fbPostText:      data.postText,
      fbPostDate:      data.postDate,
      fbReactionCount: data.reactionCount,
      text:            isFacebookPostPage() ? pipelinePageText() : '',
    });
    saveWithButton(btn, capture, `Saved post${data.authorName ? ` by ${data.authorName}` : ''} to team queue`);
  });

  actionBar.appendChild(btn);
}

function initFacebook() {
  const debouncedAdd = debounce(addFacebookSaveButton, 800);
  let lastFbUrl = location.href;

  // Facebook is a SPA — catch URL changes (pushState) via MutationObserver
  const observer = new MutationObserver(mutations => {
    if (location.href !== lastFbUrl) {
      lastFbUrl = location.href;
      document.querySelectorAll('.sts-fb-btn').forEach(b => b.remove());
    }
    if (
      isFacebookPostPage() &&
      !document.querySelector('.sts-fb-btn') &&
      mutations.some(m => m.addedNodes.length > 0)
    ) {
      debouncedAdd();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  debouncedAdd();
}

// ── Entry point ───────────────────────────────────────────────────────────────

function init() {
  const host = location.hostname;
  if (host === 'x.com' || host === 'twitter.com') {
    initTwitter();
  } else if (host === 'www.youtube.com') {
    initYouTube();
  } else if (host === 'www.facebook.com') {
    initFacebook();
  } else {
    initGoogle();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
