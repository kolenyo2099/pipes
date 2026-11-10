import { describe, expect, it } from 'vitest'
import { toDefinition, fromDefinition } from './searches.js'

const project = {
  project_id: 'p1', name: 'Mine', countries_focus: ['NL'], collecting_since: 'x', created_at: 'y',
  watchlists: [{ bucket_name: 'a', lane: 'events', enabled: true, logic: { query_terms: ['vote'] } }],
  polling_config: { events_enabled: true, events_interval_minutes: 15, x_enabled: true, x_interval_minutes: 30, paused: true, x_bearer_token: 'SECRET', bluesky_app_password: 'SECRET' },
  mediacloud_collections: [{ id: 1, name: 'NL' }],
  last_events_url: 'u', last_x_collected_at: 't', rss_cursors: { a: 1 }, x_cursors: { b: 2 }, telegram_session: 'SECRET', broken_lanes: ['x'], items: [1],
}

describe('shared search definitions', () => {
  it('keeps only the monitoring setup', () => {
    const def = toDefinition(project)
    expect(def.version).toBe(1)
    expect(Object.keys(def).sort()).toEqual(['countries_focus', 'mediacloud_collections', 'polling_config', 'version', 'watchlists'])
    expect(def.polling_config).toEqual({ events_enabled: true, events_interval_minutes: 15, x_enabled: true, x_interval_minutes: 30 })
    expect(JSON.stringify(def)).not.toMatch(/SECRET|cursor|last_|project_id|paused/)
  })

  it('round-trips into a create payload', () => {
    const payload = fromDefinition(toDefinition(project), 'Copy')
    expect(payload).toEqual({ name: 'Copy', countries_focus: ['NL'], watchlists: project.watchlists, polling_config: toDefinition(project).polling_config, mediacloud_collections: project.mediacloud_collections })
    expect(payload.watchlists).not.toBe(project.watchlists)
  })

  it('refuses unknown versions', () => {
    expect(() => fromDefinition({ version: 2 }, 'x')).toThrow()
  })
})
