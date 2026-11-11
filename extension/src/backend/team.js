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
// pipelineTeams = [{id, label, url, token, name}]; pipelineTeam = the active one (public/outbox.js reads it).
const local = () => globalThis.chrome?.storage?.local
export const getTeam = async () => (await local()?.get('pipelineTeam'))?.pipelineTeam || null

export async function listTeams() {
  const stored = await local()?.get(['pipelineTeams', 'pipelineTeam'])
  if (!stored) return []
  if (stored.pipelineTeams) return stored.pipelineTeams
  if (!stored.pipelineTeam) return []
  // Lazy migration of a single-team install.
  const team = { id: stored.pipelineTeam.id || crypto.randomUUID(), label: 'Team project', ...stored.pipelineTeam }
  await local().set({ pipelineTeams: [team], pipelineTeam: team })
  return [team]
}

export async function addTeam({ code, name, label }) {
  const joined = decodeJoinCode(code)
  label = String(label || '').trim()
  if (!label) throw new Error('Give the project a name')
  const teams = await listTeams()
  const existing = teams.find(t => t.url === joined.url)
  const team = { id: existing?.id || crypto.randomUUID(), label, ...joined, name: String(name || '').trim() }
  await local().set({ pipelineTeams: existing ? teams.map(t => t === existing ? team : t) : [...teams, team], pipelineTeam: team })
  return team
}

export async function switchTeam(id) {
  const team = (await listTeams()).find(t => t.id === id)
  if (!team) throw new Error('Unknown project')
  await local().set({ pipelineTeam: team })
  return team
}

export async function removeTeam(id) {
  const teams = (await listTeams()).filter(t => t.id !== id)
  const active = await getTeam()
  await local().set({ pipelineTeams: teams })
  if (active?.id !== id) return active
  if (!teams.length) { await local().remove('pipelineTeam'); return null }
  await local().set({ pipelineTeam: teams[0] })
  return teams[0]
}

// Single-project callers: join (or update) with a default label.
export const setTeam = ({ code, name, label }) => addTeam({ code, name, label: label || 'Team project' })
