import { describe, expect, it } from 'vitest'
import {
  cloneMediaCloudCollections,
  enabledMediaCloudRulesAreConfigured,
  mediaCloudCollectionsForRule,
  mediaCloudCollectionsForRules,
} from './mediacloudRules.js'

const national = { id: 34412234, name: 'United States - National', source_count: 247, monitored: true }
const local = { id: 34412235, name: 'United States - State & Local', source_count: 9035, monitored: true }

function rule(name, collections, enabled = true) {
  return {
    bucket_name: name,
    lane: 'mediacloud',
    enabled,
    logic: collections === undefined ? {} : { mediacloud_collections: collections },
  }
}

describe('Media Cloud rule collections', () => {
  it('deep-clones collection snapshots for modal draft isolation', () => {
    const original = [national]
    const draft = cloneMediaCloudCollections(original)
    draft[0].name = 'Changed in draft'
    expect(original[0].name).toBe('United States - National')
  })

  it('uses embedded rule collections without leaking a project-level sibling collection', () => {
    expect(mediaCloudCollectionsForRule(rule('National', [national]), [local])).toEqual([national])
  })

  it('falls back to project collections for legacy Media Cloud rules', () => {
    expect(mediaCloudCollectionsForRule(rule('Legacy'), [national])).toEqual([national])
  })

  it('builds a stable de-duplicated project snapshot from independently configured rules', () => {
    const collections = mediaCloudCollectionsForRules([
      rule('National', [national]),
      rule('National and local', [national, local]),
      { bucket_name: 'RSS', lane: 'rss', enabled: true, logic: {} },
    ])
    expect(collections.map(collection => collection.id)).toEqual([national.id, local.id])
  })

  it('requires every enabled Media Cloud rule to own at least one collection', () => {
    expect(enabledMediaCloudRulesAreConfigured([rule('Ready', [national])])).toBe(true)
    expect(enabledMediaCloudRulesAreConfigured([rule('Missing', [])])).toBe(false)
    expect(enabledMediaCloudRulesAreConfigured([rule('Disabled', [], false)])).toBe(false)
  })
})
