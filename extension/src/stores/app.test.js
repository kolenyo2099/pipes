import { describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import { clearFilters, filters } from './app.js'

describe('shared filters', () => {
  it('clears graph and ordinary filters together', () => {
    filters.update(f => ({
      ...f,
      person: 'Ada Lovelace',
      sourceType: 'gkg',
      vizItemIds: ['item-1'],
      vizFilterLabel: 'graph person: Ada Lovelace',
    }))

    clearFilters()

    expect(get(filters)).toMatchObject({
      person: '',
      sourceType: '',
      vizItemIds: [],
      vizFilterLabel: '',
      offset: 0,
    })
  })
})
