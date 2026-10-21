import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

describe('vendored Telegram browser client', () => {
  it('ships the maintained browser-native loader and Go bootstrap', () => {
    const loader = readFileSync(new URL('../../public/vendor/mtgo-wasm.js', import.meta.url), 'utf8')
    const bootstrap = readFileSync(new URL('../../public/vendor/wasm_exec.js', import.meta.url), 'utf8')

    expect(loader).toContain('WebAssembly.instantiate')
    expect(loader).toContain('MTGoWasm')
    expect(bootstrap).toContain('globalThis.Go')
  })

  it('ships the explicit login, local-session, and lossless channel-history bridge', () => {
    const wasm = gunzipSync(readFileSync(new URL('../../public/vendor/mtgo-wasm.wasm.gz', import.meta.url))).toString('latin1')

    expect(wasm).toContain('manualAuth')
    expect(wasm).toContain('sendCode')
    expect(wasm).toContain('signIn')
    expect(wasm).toContain('sessionString')
    expect(wasm).toContain('channelHistory')
    expect(wasm).toContain('Telegram did not provide access')
  })
})
