import { franc } from 'franc-min'

export const NLP_MODELS = {
  ner: { repo: 'Xenova/bert-base-multilingual-cased-ner-hrl', revision: '263e82c06569c8c2ac46238a7ae5107598934234', task: 'token-classification' },
  sentiment: { repo: 'Xenova/distilbert-base-multilingual-cased-sentiments-student', revision: '9d9ac661fd7b0b48535a1fc99b20ae6947629e65', task: 'sentiment-analysis' },
}
export const NLP_SETTING = 'nlp_models'
export const cacheName = pack => `canary-nlp-${pack}-${NLP_MODELS[pack].revision}`

export function detectLanguage(text) {
  if (String(text || '').replace(/[^\p{L}]/gu, '').length < 20) return null
  const language = franc(text, { minLength: 20 })
  return language === 'und' ? null : language
}

// The multilingual BERT pipeline returns BIO-labelled tokens, not complete names.
// Decode each contiguous entity span together to join WordPiece fragments correctly.
export function entitySpans(tokens) {
  const spans = []
  for (const token of tokens) {
    const [prefix, type] = String(token.entity || '').split('-')
    if (!['PER', 'ORG', 'LOC', 'MISC'].includes(type)) continue
    const previous = spans.at(-1)
    if (prefix === 'I' && previous?.type === type && previous.indices.at(-1) + 1 === token.index) {
      previous.indices.push(token.index)
    } else spans.push({ type, indices: [token.index] })
  }
  return spans
}

export function entitiesFromTokens(tokens, decode) {
  const fields = { PER: 'persons', ORG: 'organizations', LOC: 'locations', MISC: 'miscellaneous' }
  const result = { persons: [], organizations: [], locations: [], miscellaneous: [] }
  for (const span of entitySpans(tokens)) {
    const value = decode(span.indices).trim()
    const target = result[fields[span.type]]
    if (value && !target.includes(value)) target.push(value)
  }
  return result
}

export function sentimentTone(scores) {
  const values = Object.fromEntries(scores.map(({ label, score }) => [String(label).toLowerCase(), score]))
  if (!Number.isFinite(values.positive) || !Number.isFinite(values.negative)) throw new Error('Unexpected sentiment model labels')
  return { tone: Math.max(-1, Math.min(1, values.positive - values.negative)) }
}

export function mergeEnrichment(normalized = {}, enrichment) {
  const result = { ...normalized }
  for (const [key, value] of Object.entries(enrichment)) {
    const current = result[key]
    const useful = typeof current === 'string' ? !!current.trim() : Array.isArray(current) ? !!current.length : current != null
    if (value != null && !useful) result[key] = value
  }
  return result
}
