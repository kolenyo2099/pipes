// Small helpers for the capture engine.
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(data) {
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
