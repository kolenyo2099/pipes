// Canary service worker: opens the app, and keeps collection running on a one-minute alarm.
// The collectors themselves run in an offscreen document (see src/offscreen.js).
const ensureAlarm = () => chrome.alarms.create('collect', { periodInMinutes: 1 })
chrome.runtime.onInstalled.addListener(ensureAlarm)
chrome.runtime.onStartup.addListener(ensureAlarm)

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('index.html') }))

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return
  try {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Downloads and parses GDELT files and news feeds in the background' })
  } catch (error) {
    // Two wake-ups can race to create it; only one document may exist.
    if (!String(error?.message).includes('single offscreen')) throw error
  }
}

// Runtime messages are delivered to every extension context.  Keep the relay
// messages out of this listener: otherwise a service worker that happens to
// receive its own relay can start forwarding the same request again instead of
// letting the offscreen document handle it.
async function sendToCollector(type, projectId) {
  await ensureOffscreen()
  const result = await chrome.runtime.sendMessage({ target: 'offscreen', type, projectId })
  if (result === undefined) throw new Error('The background collector did not respond')
  return result
}

// X lane: the collector asks for one search at a time. It opens in a background tab with the user's own x.com session,
// where x-hook.js keeps what X's web app receives. Offscreen documents cannot open tabs, so this runs here.
const X_ACCESS = { origins: ['https://x.com/*'] }
const X_HOOK = { id: 'x-hook', matches: ['https://x.com/*'], js: ['x-hook.js'], runAt: 'document_start', world: 'MAIN' }
async function readX(url) {
  if (!await chrome.permissions.contains(X_ACCESS)) return { error: 'Canary has no access to x.com. Turn the X lane off and on in Project Settings to allow it.', stop: true }
  if (!(await chrome.scripting.getRegisteredContentScripts({ ids: [X_HOOK.id] })).length) await chrome.scripting.registerContentScripts([X_HOOK])
  const tab = await chrome.tabs.create({ url, active: false })
  try {
    for (let second = 0; second < 30; second++) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      const current = (await chrome.tabs.get(tab.id)).url
      if (current && !current.startsWith('https://x.com/search')) return { error: 'X asked to sign in. Sign in to x.com in this browser.', stop: true }
      const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN',
        func: () => ({ responses: window.__canaryX, posts: !!document.querySelector('article') }) }).catch(() => [])
      if (injection?.result?.responses?.length) return { responses: injection.result.responses }
      // Posts on screen that x-hook.js never saw arrive means X renamed or reshaped its search request.
      if (second === 29 && injection?.result?.posts) return { error: 'X showed posts but sent no SearchTimeline response', formatChanged: true }
    }
    return { error: 'X showed no search results within 30 seconds. Check that you are signed in to x.com in this browser.' }
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {})
  }
}

chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name !== 'collect') return
  try {
    await sendToCollector('tick')
  } catch (error) {
    // Alarms must continue even if Chrome discarded an offscreen document.
    // The next alarm recreates it; keep the diagnostic in the service-worker log.
    console.error('Canary collector alarm failed:', error)
  }
})

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.target === 'offscreen') return
  if (message.type === 'prepare-nlp') {
    // Keep long model downloads between the app and offscreen document, so
    // they do not depend on the service worker's maximum event lifetime.
    ensureOffscreen().then(() => reply({ ready: true }), error => reply({ error: error.message || String(error) }))
    return true
  }
  if (message.type === 'prepare-telegram') {
    ensureOffscreen().then(() => reply({ ready: true }), error => reply({ error: error.message || String(error) }))
    return true
  }
  if (message.type === 'x-read') {
    readX(message.url).then(reply, error => reply({ error: error.message || String(error) }))
    return true
  }
  if (message.type !== 'run-now') return
  sendToCollector('run-now', message.projectId)
    .then(reply, () => reply(false))
  return true
})
