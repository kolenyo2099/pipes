import { describe, expect, it } from 'vitest'
import { isKnownNlpTransportWarning, UNKNOWN_CONTENT_LENGTH_WARNING } from './nlpWarnings.js'

describe('isKnownNlpTransportWarning', () => {
  it('recognises only Transformers.js’s harmless unknown-length download warning', () => {
    expect(isKnownNlpTransportWarning([UNKNOWN_CONTENT_LENGTH_WARNING])).toBe(true)
    expect(isKnownNlpTransportWarning(['A different warning'])).toBe(false)
    expect(isKnownNlpTransportWarning([UNKNOWN_CONTENT_LENGTH_WARNING, 'details'])).toBe(false)
  })
})
