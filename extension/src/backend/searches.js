// Shared searches: a Canary project's monitoring setup travels through the team sheet; inbox, cursors, triage and credentials never do.
import { bridge } from './bridge.js'
import { getTeam } from './team.js'
import * as store from './store.js'

// Shared: name, countries, rules, lane switches + intervals, Media Cloud collections. Withheld: ids, cursors, collecting_since, paused, items, secrets.
const LANES = ['events', 'doc', 'rss', 'mediacloud', 'x', 'bluesky', 'telegram']
const SHARED_POLLING = ['overlap_minutes', ...LANES.flatMap(l => [`${l}_enabled`, `${l}_interval_minutes`])]

const clone = v => JSON.parse(JSON.stringify(v ?? null))

export function toDefinition(project) {
  const polling = project.polling_config || {}
  return {
    version: 1,
    countries_focus: clone(project.countries_focus) || [],
    watchlists: clone(project.watchlists) || [],
    polling_config: Object.fromEntries(SHARED_POLLING.filter(k => polling[k] !== undefined).map(k => [k, polling[k]])),
    mediacloud_collections: clone(project.mediacloud_collections) || [],
  }
}

// Fields for store.createProject / updateProject; cursors start fresh because createProject creates them.
export function fromDefinition(definition, name) {
  if (definition?.version !== 1) throw new Error('This shared search was made by a newer version of the extension')
  const { version, ...setup } = clone(definition)
  return { name, ...setup }
}

export const activeLanes = def => LANES.filter(l => def.polling_config?.[`${l}_enabled`])
const shortestInterval = def => Math.min(...activeLanes(def).map(l => def.polling_config[`${l}_interval_minutes`] || 60), 1440)

export async function shareProject(project, ownerName) {
  const definition = toDefinition(project)
  const { id } = await bridge('upsertSearch', { search: {
    id: project.shared_search_id, project: project.name, lane: 'project', name: project.name, query: definition,
    interval_mins: shortestInterval(definition), owner: ownerName || (await getTeam())?.name || '', enabled: true,
  } })
  await store.patchProject(project.project_id, { shared_search_id: id })
  return id
}

export async function listTeamSearches() {
  return (await bridge('listSearches', {})).searches.filter(s => s.lane === 'project' && s.query?.version)
}

export async function subscribe(search) {
  const project = await store.createProject(fromDefinition(search.query, search.name))
  await store.patchProject(project.project_id, { subscribed_search: { id: search.id, updated_at: search.updated_at } })
  return project.project_id
}

// Replaces the monitoring setup only; items, cursors and the local pause switch stay.
export async function applyUpdate(projectId, search) {
  const local = await store.getProject(projectId)
  const { name, ...setup } = fromDefinition(search.query, search.name)
  await store.updateProject(projectId, { ...setup, polling_config: { ...local.polling_config, ...setup.polling_config } })
  await store.patchProject(projectId, { subscribed_search: { id: search.id, updated_at: search.updated_at } })
}

export async function unshare(search) {
  await bridge('upsertSearch', { search: { id: search.id, enabled: false } })
  const mine = (await store.listProjects()).find(p => p.shared_search_id === search.id)
  if (mine) await store.patchProject(mine.project_id, { shared_search_id: null })
}
