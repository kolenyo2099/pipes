// RFC 3161 timestamp request for a SHA-256 digest, built by hand (the HRC engine uses pkijs/asn1js; a request is
// ~20 bytes of DER, so no dependency). The reply is returned as is, status-checked but NOT chain-verified:
// ponytail: verify later with `openssl ts -verify -in x.tsr -data hashes.txt -CAfile <roots>`; add pkijs if the
// app must verify in the browser.
import { sleep } from './util.js'

export const TSA_URLS = ['http://timestamp.identrust.com', 'https://freetsa.org/tsr']

const der = (tag, ...parts) => {
  const body = parts.reduce((all, part) => [...all, ...part], [])
  const length = body.length < 128 ? [body.length] : [0x82, body.length >> 8, body.length & 255]
  return [tag, ...length, ...body]
}

export function timestampRequest(digest, nonce = crypto.getRandomValues(new Uint8Array(8))) {
  const sha256 = [0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]
  const positive = [0, ...nonce.map((b, i) => (i ? b : b & 0x7f))] // keep the INTEGER non-negative
  return new Uint8Array(der(0x30,
    [0x02, 0x01, 0x01],
    der(0x30, der(0x30, sha256, [0x05, 0x00]), der(0x04, [...digest])),
    der(0x02, positive),
    [0x01, 0x01, 0xff]))
}

// Reply is SEQUENCE { SEQUENCE { INTEGER status ... } ... }: status 0 or 1 means granted.
export function granted(reply) {
  const bytes = new Uint8Array(reply)
  let at = 1 + (bytes[1] < 128 ? 1 : 1 + (bytes[1] & 127))
  at += 1 + (bytes[at + 1] < 128 ? 1 : 1 + (bytes[at + 1] & 127))
  return bytes[at] === 0x02 && bytes[at + 1] === 1 && bytes[at + 2] <= 1
}

/** Stamp `text` (the hashes file) with the first TSA that answers. Returns { tsa, token: ArrayBuffer }, or null. */
export async function timestamp(text, urls = TSA_URLS) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  for (const tsa of urls) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(tsa, { method: 'POST', headers: { 'Content-Type': 'application/timestamp-query' }, body: timestampRequest(digest), signal: AbortSignal.timeout(10_000) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const token = await response.arrayBuffer()
        if (granted(token)) return { tsa, token }
      } catch { await sleep(500) }
    }
  }
  return null
}
