import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ tables: new Map(), failItemWrites: false, fetchForProject: vi.fn(), configuredToken: vi.fn() }))
vi.mock('./mediacloud.js', () => ({ fetchForProject: mocks.fetchForProject, configuredToken: mocks.configuredToken }))
vi.mock('./db.js', () => {
  const table = name => {
    if (!mocks.tables.has(name)) mocks.tables.set(name, new Map())
    return mocks.tables.get(name)
  }
  const keys = { items: 'item_id', meta: 'project_id', projects: 'project_id', archives: 'archive_id', settings: 'key' }
  const put = async (name, value) => table(name).set(value[keys[name]], structuredClone(value))
  const get = async (name, key) => structuredClone(table(name).get(key))
  const all = async name => [...table(name).values()].map(value => structuredClone(value))
  const byIndex = async (name, index, value) => (await all(name)).filter(row => index === 'project_status'
    ? row.project_id === value[0] && row.status === value[1] : row[index] === value)
  return {
    get, put, all, byIndex, projectItems: id => byIndex('items', 'project_id', id),
    putMany: async (name, rows) => {
      if (name === 'items' && mocks.failItemWrites) throw new Error('Storage quota exceeded')
      for (const row of rows) await put(name, row)
    },
    del: async (name, key) => table(name).delete(key),
    delMany: async (name, keys) => keys.forEach(key => table(name).delete(key)),
    getMeta: async id => (await get('meta', id)) || { project_id: id, source_prefs: {}, pinned: {} },
    putMeta: value => put('meta', value),
    getSetting: async key => (await get('settings', key))?.value,
    setSetting: (key, value) => put('settings', { key, value }),
    tx: (name, mode, action) => new Promise((resolve, reject) => {
      action({
        get(key) {
          const request = { result: structuredClone(table(name).get(key)) }
          queueMicrotask(() => {
            try { request.onsuccess?.(); resolve() } catch (error) { reject(error) }
          })
          return request
        },
        put: value => { table(name).set(value[keys[name]], structuredClone(value)) },
      })
    }),
  }
})

import { put, get, getMeta } from './db.js'
import { collectMediaCloud } from './collect.js'
import { itemUpserter, reviewDuplicate, exportBackup, deleteItem } from './store.js'

const item = (id, title) => ({ item_id: id, project_id: 'p', source_type: 'mediacloud', query_bucket: 'news',
  title_or_summary: title, url: `https://example.com/${id}`, normalized: {} })
const project = () => ({ project_id: 'p', last_mediacloud_collected_at: '2026-09-20T00:00:00Z',
  watchlists: [{ bucket_name: 'news', lane: 'mediacloud', enabled: true, logic: { query_terms: ['flood'], require_any: ['Italy'] } }] })

beforeEach(() => {
  mocks.tables.clear()
  mocks.failItemWrites = false
  mocks.fetchForProject.mockReset()
  mocks.configuredToken.mockResolvedValue('test-token')
})

describe('Media Cloud collection parity', () => {
  it('applies required terms and advances the cursor after a successful run', async () => {
    const p = project()
    await put('projects', p)
    mocks.fetchForProject.mockResolvedValue([[item('a', 'Flood in Italy'), item('b', 'Flood in Canada')], null])
    const log = {}
    await collectMediaCloud(p, log, new AbortController().signal)
    expect(await get('items', 'a')).toBeDefined()
    expect(await get('items', 'b')).toBeUndefined()
    expect(log).toMatchObject({ fetch_count: 2, new_count: 1 })
    expect((await get('projects', 'p')).last_mediacloud_collected_at).not.toBe(p.last_mediacloud_collected_at)
  })
  it('preserves the window after partial failure, then retries without duplicating items', async () => {
    const p = project()
    await put('projects', p)
    mocks.fetchForProject.mockResolvedValue([[item('a', 'Flood in Italy')], 'news: HTTP 502'])
    expect(await collectMediaCloud(p, {}, new AbortController().signal)).toBe('news: HTTP 502')
    expect((await get('projects', 'p')).last_mediacloud_collected_at).toBe(p.last_mediacloud_collected_at)
    mocks.fetchForProject.mockResolvedValue([[item('a', 'Flood in Italy')], null])
    const log = {}
    await collectMediaCloud(p, log, new AbortController().signal)
    expect(log.new_count).toBe(0)
  })
  it('does not advance the cursor when storage fails', async () => {
    const p = project()
    await put('projects', p)
    mocks.fetchForProject.mockResolvedValue([[item('a', 'Flood in Italy')], null])
    mocks.failItemWrites = true
    await expect(collectMediaCloud(p, {}, new AbortController().signal)).rejects.toThrow('Storage quota exceeded')
    expect((await get('projects', 'p')).last_mediacloud_collected_at).toBe(p.last_mediacloud_collected_at)
  })
})

describe('persistent duplicate evidence', () => {
  it('records decisions and includes evidence and constraints in backups', async () => {
    const upsert = await itemUpserter('p')
    await upsert([item('a', 'Flood kills 12 people in northern Italy'), item('b', 'Northern Italy flood kills 12 people')], false)
    expect((await getMeta('p')).duplicate_edges).toHaveLength(1)
    expect(await reviewDuplicate('p', 'b', { other_item_id: 'a', action: 'not_duplicates' })).toBe(true)
    const meta = (await exportBackup()).meta[0]
    expect(meta.duplicate_edges[0].human_decision).toBe('not_duplicates')
    expect(meta.group_constraints).toMatchObject([{ left_item_id: 'a', right_item_id: 'b', constraint_type: 'not_duplicates' }])
    await deleteItem('p', 'a')
    expect((await getMeta('p')).duplicate_edges).toEqual([])
    expect((await getMeta('p')).group_constraints).toEqual([])
  })
  it('rejects self-pairs, unknown items, and invalid actions', async () => {
    expect(await reviewDuplicate('p', 'a', { other_item_id: 'a', action: 'keep_both' })).toBe(false)
    expect(await reviewDuplicate('p', 'a', { other_item_id: 'missing', action: 'keep_both' })).toBe(false)
    await expect(reviewDuplicate('p', 'a', { other_item_id: 'b', action: 'unknown' })).rejects.toThrow()
  })
})
