import { describe, it, expect, vi } from 'vitest'
import { decodeJoinCode, getTeam, setTeam } from './team.js'

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
    expect(await getTeam()).toEqual({ url: 'https://script.google.com/a', token: 't', name: 'Ana' })
  })
})
