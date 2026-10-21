// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'

const api = vi.hoisted(() => ({ getNlpStatus: vi.fn(), installNlpModel: vi.fn(), setNlpEnabled: vi.fn(), removeNlpModel: vi.fn() }))
vi.mock('../api.js', () => ({ api }))
import NlpSettings from './NlpSettings.svelte'
import { notification } from '../stores/app.js'
import { get } from 'svelte/store'

let component, status
async function settle() { await new Promise(resolve => setTimeout(resolve, 0)); await tick() }
const button = text => [...document.querySelectorAll('button')].find(node => node.textContent.includes(text))

beforeEach(() => {
  document.body.innerHTML = '<div id="target"></div>'
  status = { models: {} }
  for (const mock of Object.values(api)) mock.mockReset()
  api.getNlpStatus.mockImplementation(async () => ({ ok: true, data: structuredClone(status) }))
})
afterEach(async () => { if (component) await unmount(component); component = null; notification.set(null) })

describe('optional NLP model controls', () => {
  it('downloads, disables, and removes a model', async () => {
    api.installNlpModel.mockImplementation(async pack => {
      status.models[pack] = { installed: true, enabled: true }
      return { ok: true, data: structuredClone(status) }
    })
    api.setNlpEnabled.mockImplementation(async (pack, enabled) => {
      status.models[pack].enabled = enabled
      return { ok: true, data: structuredClone(status) }
    })
    api.removeNlpModel.mockImplementation(async pack => {
      status.models[pack] = { installed: false, enabled: false }
      return { ok: true, data: structuredClone(status) }
    })
    component = mount(NlpSettings, { target: document.getElementById('target') })
    await settle()
    button('Download and enable').click()
    await settle()
    expect(api.installNlpModel).toHaveBeenCalledWith('ner')
    const checkbox = document.querySelector('input[type=checkbox]')
    expect(checkbox.checked).toBe(true)
    checkbox.click()
    await settle()
    expect(api.setNlpEnabled).toHaveBeenCalledWith('ner', false)
    expect(document.querySelector('input[type=checkbox]').checked).toBe(false)
    button('Remove').click()
    await settle()
    expect(api.removeNlpModel).toHaveBeenCalledWith('ner')
    expect(document.querySelector('input[type=checkbox]')).toBeNull()
  })
  it('shows a download failure and allows a retry', async () => {
    api.installNlpModel.mockResolvedValue({ ok: false, error: 'Chrome did not grant access' })
    component = mount(NlpSettings, { target: document.getElementById('target') })
    await settle()
    button('Download and enable').click()
    await settle()
    expect(get(notification)).toMatchObject({ type: 'error', message: 'Chrome did not grant access' })
    expect(button('Download and enable').disabled).toBe(false)
  })
})
