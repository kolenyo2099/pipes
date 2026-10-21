import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectLanguage, entitiesFromTokens, mergeEnrichment, sentimentTone } from './nlpShared.js'

const mocks = vi.hoisted(() => ({ settings: {}, requestNlp: vi.fn() }))
vi.mock('./db.js', () => ({ getSetting: async key => mocks.settings[key], setSetting: async (key, value) => { mocks.settings[key] = value } }))
vi.mock('../lib/nlpClient.js', () => ({ requestNlp: mocks.requestNlp }))
import { configureNlp, enrichItems, nlpStatus } from './nlp.js'

beforeEach(() => { mocks.settings = {}; mocks.requestNlp.mockReset(); vi.stubGlobal('navigator', {}) })
afterEach(() => vi.unstubAllGlobals())

describe('browser NLP output compatibility', () => {
  it('detects English and Spanish without model downloads, leaving short text unknown', () => {
    expect(detectLanguage('President Zelensky called for more military aid as Russian forces advanced near Kharkiv.')).toBe('eng')
    expect(detectLanguage('El gobierno argentino anunció nuevas medidas económicas en medio de una profunda crisis financiera.')).toBe('spa')
    expect(detectLanguage('Hello')).toBeNull()
  })
  it('joins contiguous BIO spans and separates new entities and token gaps', () => {
    const tokens = [
      { entity: 'B-PER', index: 1 }, { entity: 'I-PER', index: 2 },
      { entity: 'B-PER', index: 3 }, { entity: 'I-PER', index: 5 }, { entity: 'B-ORG', index: 7 },
    ]
    expect(entitiesFromTokens(tokens, indices => indices.join(','))).toEqual({ persons: ['1,2', '3', '5'], organizations: ['7'], locations: [], miscellaneous: [] })
  })
  it('maps class probabilities to desktop nested tone regardless of label order', () => {
    expect(sentimentTone([{ label: 'negative', score: 0.8 }, { label: 'positive', score: 0.1 }, { label: 'neutral', score: 0.1 }]).tone).toBeCloseTo(-0.7)
    expect(() => sentimentTone([{ label: 'LABEL_0', score: 1 }])).toThrow('Unexpected sentiment model labels')
  })
  it('preserves existing non-null enrichment and never overwrites it with missing results', () => {
    expect(mergeEnrichment({ language: 'spa', persons: ['Petro'], tone: { tone: 0.2 } }, { language: 'eng', persons: ['Biden'], tone: null, organizations: ['NATO'] }))
      .toEqual({ language: 'spa', persons: ['Petro'], tone: { tone: 0.2 }, organizations: ['NATO'] })
  })
})

describe('model lifecycle and collection', () => {
  it('marks a model installed only after a successful download and supports disabling and removal', async () => {
    mocks.requestNlp.mockResolvedValue({ installed: true })
    await configureNlp({ type: 'install', pack: 'ner' })
    expect((await nlpStatus()).models.ner).toMatchObject({ installed: true, enabled: true })
    await configureNlp({ type: 'enable', pack: 'ner', enabled: false })
    expect((await nlpStatus()).models.ner).toMatchObject({ installed: true, enabled: false })
    expect(mocks.requestNlp).toHaveBeenCalledWith({ type: 'unload', pack: 'ner' })
    await configureNlp({ type: 'remove', pack: 'ner' })
    expect((await nlpStatus()).ner_present).toBe(false)
  })
  it('reports a failed download without falsely marking the model installed', async () => {
    mocks.requestNlp.mockRejectedValue(new Error('Network failed'))
    await expect(configureNlp({ type: 'install', pack: 'sentiment' })).rejects.toThrow('Network failed')
    expect((await nlpStatus()).models.sentiment).toMatchObject({ error: 'Network failed' })
    expect((await nlpStatus()).sentiment_present).toBe(false)
    await expect(configureNlp({ type: 'enable', pack: 'sentiment', enabled: true })).rejects.toThrow('Download this model first')
  })
  it('runs language detection without optional models and isolates failures from collection', async () => {
    const item = () => ({ title_or_summary: 'President Zelensky called for more military aid as Russian forces advanced near Kharkiv.', normalized: {} })
    expect((await enrichItems([item()]))[0].normalized.language).toBe('eng')
    expect(mocks.requestNlp).not.toHaveBeenCalled()
    mocks.settings.nlp_models = { ner: { installed: true, enabled: true } }
    mocks.requestNlp.mockResolvedValue({ enrichment: {}, errors: ['ner: cache missing'] })
    const items = await enrichItems([item(), item()])
    expect(items).toHaveLength(2)
    expect(mocks.requestNlp).toHaveBeenCalledTimes(1)
    expect((await nlpStatus()).models.ner.error).toBe('ner: cache missing')
  })
  it('enriches before filtering and respects cancellation', async () => {
    mocks.settings.nlp_models = { ner: { installed: true, enabled: true } }
    mocks.requestNlp.mockResolvedValue({ enrichment: { persons: ['Gustavo Petro'] }, errors: [] })
    const result = await enrichItems([{ title_or_summary: 'President addresses parliament', normalized: {} }])
    expect(result[0].normalized.persons).toEqual(['Gustavo Petro'])
    const controller = new AbortController()
    controller.abort()
    await expect(enrichItems(result, controller.signal)).rejects.toThrow()
  })
  it('stops using a model disabled during collection and clears recovered errors', async () => {
    mocks.settings.nlp_models = { ner: { installed: true, enabled: true, error: 'Previous failure' } }
    mocks.requestNlp.mockImplementation(async () => {
      mocks.settings.nlp_models.ner.enabled = false
      return { enrichment: { persons: ['Macron'] }, errors: [] }
    })
    const items = await enrichItems([
      { title_or_summary: 'President Macron visits Ukraine', normalized: {} },
      { title_or_summary: 'President Scholz visits Ukraine', normalized: {} },
    ])
    expect(mocks.requestNlp).toHaveBeenCalledTimes(1)
    expect(items[0].normalized.persons).toEqual(['Macron'])
    expect(items[1].normalized.persons).toBeUndefined()
    expect((await nlpStatus()).models.ner.error).toBeNull()
  })
})
