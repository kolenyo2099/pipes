// Small helpers for the capture engine.
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')

// SubtleCrypto has no incremental digest, so a Blob over this size (recorded or downloaded media) is hashed in a
// streaming pass instead of being read into memory whole. Slower than native, bounded memory.
const STREAM_ABOVE = 32 * 1024 * 1024

const primes = []
for (let n = 2; primes.length < 64; n += 1) if (primes.every((p) => n % p)) primes.push(n)
const frac = (x) => Math.floor((x % 1) * 2 ** 32)
const K = primes.map((p) => frac(Math.cbrt(p)))
const H0 = primes.slice(0, 8).map((p) => frac(Math.sqrt(p)))

export async function sha256Stream(blob) {
  const h = Uint32Array.from(H0)
  const w = new Uint32Array(64)
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  const block = (b, o) => {
    for (let i = 0; i < 16; i += 1) w[i] = (b[o + 4 * i] << 24) | (b[o + 4 * i + 1] << 16) | (b[o + 4 * i + 2] << 8) | b[o + 4 * i + 3]
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    let [a, b1, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b1) ^ (a & c) ^ (b1 & c))) | 0
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b1; b1 = a; a = (t1 + t2) | 0
    }
    const next = [a, b1, c, d, e, f, g, hh]
    for (let i = 0; i < 8; i += 1) h[i] = (h[i] + next[i]) | 0
  }
  let carry = new Uint8Array(0)
  let length = 0
  for await (const chunk of blob.stream()) {
    length += chunk.length
    let bytes = chunk
    if (carry.length) { bytes = new Uint8Array(carry.length + chunk.length); bytes.set(carry); bytes.set(chunk, carry.length) }
    const whole = bytes.length - (bytes.length % 64)
    for (let o = 0; o < whole; o += 64) block(bytes, o)
    carry = bytes.slice(whole)
  }
  const pad = new Uint8Array(carry.length + 1 + ((119 - carry.length) % 64) + 8)
  pad.set(carry)
  pad[carry.length] = 0x80
  const view = new DataView(pad.buffer)
  view.setUint32(pad.length - 8, Math.floor(length / 2 ** 29))
  view.setUint32(pad.length - 4, (length << 3) >>> 0)
  for (let o = 0; o < pad.length; o += 64) block(pad, o)
  return [...h].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('')
}

export async function sha256Hex(data) {
  if (data instanceof Blob && data.size > STREAM_ABOVE) return sha256Stream(data)
  const bytes = data instanceof Blob ? await data.arrayBuffer() : typeof data === 'string' ? new TextEncoder().encode(data) : data
  return hex(await crypto.subtle.digest('SHA-256', bytes))
}

export const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export const uuid = () => crypto.randomUUID()
