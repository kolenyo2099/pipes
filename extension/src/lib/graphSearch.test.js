import { describe, expect, it } from 'vitest'
import { searchGraphNodes } from './graphSearch.js'

const nodes = [
  { id: 'person:Maria', name: 'Maria Ressa', type: 'person', count: 4 },
  { id: 'org:Maria', name: 'Maria Foundation', type: 'org', count: 8 },
  { id: 'article:1', name: 'Interview with Maria Ressa', type: 'article', count: 1 },
  { id: 'location:Manila', name: 'Manila', type: 'location', count: 3 },
]

describe('graph node search', () => {
  it('matches case-insensitively and ranks prefix matches before contains matches', () => {
    expect(searchGraphNodes(nodes, 'mArIa').map(node => node.id)).toEqual([
      'org:Maria',
      'person:Maria',
      'article:1',
    ])
  })

  it('returns no results for an empty query', () => {
    expect(searchGraphNodes(nodes, '   ')).toEqual([])
  })
})
