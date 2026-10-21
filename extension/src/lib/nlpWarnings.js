// Transformers.js emits this when a model host streams a response without a
// Content-Length header. It falls back to a growing buffer and continues safely.
export const UNKNOWN_CONTENT_LENGTH_WARNING = 'Unable to determine content-length from response headers. Will expand buffer when needed.'

export function isKnownNlpTransportWarning(args) {
  return args.length === 1 && args[0] === UNKNOWN_CONTENT_LENGTH_WARNING
}
