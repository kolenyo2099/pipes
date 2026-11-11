import { writable, derived } from 'svelte/store'
import { getTeam, listTeams } from '../backend/team.js'

// ── Navigation ─────────────────────────────────────────────────────────────────
// Views: 'library' (home) | 'explore' | 'archive' | 'queries' | 'team-searches' | 'setup' | 'team' | Canary: 'inbox' | 'saved' | 'dismissed' | 'timeline' | 'settings' | 'logs' | 'new-project'
export const currentView = writable('library')
export const currentProjectId = writable(null)

// ── Data ───────────────────────────────────────────────────────────────────────
export const projects = writable([])
// The ACTIVE team project ({id, label, url, token, name}): null when not joined, undefined until boot has looked.
export const teamState = writable(undefined)
// Every joined team project.
export const teams = writable([])
// Re-read both from chrome.storage; App.svelte calls it at boot and on every storage change.
export async function syncTeams() {
  const [active, all] = await Promise.all([getTeam(), listTeams()])
  teams.set(all)
  teamState.update(current => (current?.id === active?.id && current?.url === active?.url && current?.token === active?.token ? current : active))
}
// First run = no team and no Canary project: home shows the welcome screen and the tour waits.
export const onboarding = derived([teamState, projects], ([t, p]) => t === null && p.length === 0)
export const currentProject = writable(null)
export const items = writable([])
export const itemsTotal = writable(0)
export const stats = writable(null)
// GDELT/CAMEO ontology — loaded once at boot, used for human-readable labels
export const ontology = writable({})

// ── Filters ────────────────────────────────────────────────────────────────────
export const defaultFilters = () => ({
  sourceType: '',       // '' | 'events' | 'gkg'
  queryBucket: '',      // '' or bucket name
  countries: '',        // comma-separated ISO codes or ''
  since: '',            // ISO datetime or ''
  tagFilter: '',        // client-side tag search (Saved view)
  titleSearch: '',      // client-side title search (Inbox / Dismissed views)
  sheetStatus: '',      // client-side sheet status filter: '' | 'pending' | 'sent' | 'failed'
  limit: 100,
  offset: 0,
  // GKG enhanced filters
  toneMin: '',          // numeric string or '' (min tone score)
  toneMax: '',          // numeric string or '' (max tone score)
  countType: '',        // comma-separated count types e.g. "KILL,ARREST"
  person: '',           // free-text person name search
  organization: '',     // free-text organization name search
  locationText: '',     // free-text location name search
  vizItemIds: [],       // client-side visual cluster filter (item ids)
  vizFilterLabel: '',   // label shown for visual cluster filters
})

export const filters = writable(defaultFilters())

// Filters are shared by every content view. Keep one reset path so filters set
// from a visualization cannot strand someone in another view without a way back.
export function clearFilters() {
  filters.set(defaultFilters())
}

// ── UI state ───────────────────────────────────────────────────────────────────
export const isLoading = writable(false)
export const tourOpen = writable(false)   // onboarding tour visibility
export const guideOpen = writable(false)  // GDELT reference guide visibility
export const aboutOpen = writable(false)  // About modal visibility
export const loadingItems = writable(false)
export const notification = writable(null)  // { type: 'success'|'error'|'info', message: string }
export const saveModalItem = writable(null)  // item to show in save modal

// ── Notification helper ────────────────────────────────────────────────────────
let _notifTimer = null

export function notify(type, message, duration = 4000) {
  notification.set({ type, message })
  if (_notifTimer) clearTimeout(_notifTimer)
  _notifTimer = setTimeout(() => notification.set(null), duration)
}
