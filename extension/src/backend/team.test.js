import { describe, it, expect, vi } from 'vitest'
import { decodeJoinCode, getTeam, setTeam, addTeam, listTeams, switchTeam, removeTeam } from './team.js'

const encode = value => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('team', () => {
  it('decodes a base64url join code', () => {
    const team = { url: 'https://script.google.com/macros/s/abc/exec', token: 'sé?>cret' }
    expect(decodeJoinCode(' ' + encode(team) + ' ')).toEqual(team)
  })
  it('rejects other hosts, empty tokens and garbage', () => {
    expect(() => decodeJoinCode(encode({ url: 'https://evil.example/x', token: 't' }))).toThrow()
    expect(() => decodeJoinCode(encode({ url: 'https://script.google.com/x', token: '' }))).toThrow()
    expect(() => decodeJoinCode('%%%')).toThrow()
  })
  it('stores the team with its name', async () => {
    const data = {}
    vi.stubGlobal('chrome', { storage: { local: { set: async v => Object.assign(data, v), get: async k => ({ [k]: data[k] }) } } })
    await setTeam({ code: encode({ url: 'https://script.google.com/a', token: 't' }), name: ' Ana ' })
    expect(await getTeam()).toMatchObject({ url: 'https://script.google.com/a', token: 't', name: 'Ana', label: 'Team project' })
  })
  it('keeps several projects, switches, updates a rejoined sheet and leaves one', async () => {
    const data = {}
    vi.stubGlobal('chrome', { storage: { local: { set: async v => Object.assign(data, v), remove: async k => { delete data[k] }, get: async k => Object.fromEntries([k].flat().map(key => [key, data[key]])) } } })
    const code = u => encode({ url: 'https://script.google.com/' + u, token: u })
    const a = await addTeam({ code: code('a'), name: 'Ana', label: 'A' })
    const b = await addTeam({ code: code('b'), name: 'Ana', label: 'B' })
    expect((await getTeam()).id).toBe(b.id)
    expect((await switchTeam(a.id)).label).toBe('A')
    await addTeam({ code: code('a'), name: 'Anna', label: 'A2' })
    expect((await listTeams()).map(t => [t.id, t.label, t.name])).toEqual([[a.id, 'A2', 'Anna'], [b.id, 'B', 'Ana']])
    expect((await getTeam()).id).toBe(a.id)
    expect((await removeTeam(a.id)).id).toBe(b.id)
    expect(await removeTeam(b.id)).toBeNull()
    expect(data.pipelineTeam).toBeUndefined()
    await expect(addTeam({ code: code('c'), name: 'x', label: ' ' })).rejects.toThrow()
  })
  it('migrates a single pipelineTeam into the list', async () => {
    const data = { pipelineTeam: { url: 'https://script.google.com/a', token: 't', name: 'Ana' } }
    vi.stubGlobal('chrome', { storage: { local: { set: async v => Object.assign(data, v), get: async k => Object.fromEntries([k].flat().map(key => [key, data[key]])) } } })
    const [team] = await listTeams()
    expect(team).toMatchObject({ label: 'Team project', name: 'Ana' })
    expect(data.pipelineTeam.id).toBe(team.id)
  })
})
