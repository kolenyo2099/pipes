// The team bridge settings (shared with the service worker's outbox), kept in chrome.storage.local under pipelineTeam.
export function decodeJoinCode(code) {
  let parsed
  try {
    const base64 = String(code).trim().replace(/-/g, '+').replace(/_/g, '/')
    parsed = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')))
  } catch { throw new Error('That join code is not valid') }
  if (!String(parsed?.url).startsWith('https://script.google.com/') || typeof parsed.token !== 'string' || !parsed.token) throw new Error('That join code is not valid')
  return { url: parsed.url, token: parsed.token }
}

// Null outside the extension (tests, plain web page) as well as before the join code is pasted.
export const getTeam = async () => (await globalThis.chrome?.storage?.local?.get('pipelineTeam'))?.pipelineTeam || null
export const setTeam = async ({ code, name }) => {
  const team = { ...decodeJoinCode(code), name: String(name || '').trim() }
  await chrome.storage.local.set({ pipelineTeam: team })
  return team
}
