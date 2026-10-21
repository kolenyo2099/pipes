export function cloneMediaCloudCollections(collections = []) {
  return collections
    .filter(collection => collection && Number.isFinite(Number(collection.id)))
    .map(collection => ({
      id: Number(collection.id),
      name: String(collection.name || `Collection ${collection.id}`),
      source_count: collection.source_count == null ? null : Number(collection.source_count),
      monitored: collection.monitored !== false,
    }))
}

export function mediaCloudCollectionsForRule(rule, legacyCollections = []) {
  if (rule?.lane !== 'mediacloud') return []
  if (Array.isArray(rule.logic?.mediacloud_collections)) {
    return cloneMediaCloudCollections(rule.logic.mediacloud_collections)
  }
  return cloneMediaCloudCollections(legacyCollections)
}

export function mediaCloudCollectionsForRules(rules = [], legacyCollections = []) {
  const mediaCloudRules = rules.filter(rule => rule?.lane === 'mediacloud')
  if (mediaCloudRules.length === 0) return []

  const collections = mediaCloudRules.flatMap(rule =>
    mediaCloudCollectionsForRule(rule, legacyCollections)
  )
  const unique = new Map()
  for (const collection of collections) {
    if (!unique.has(collection.id)) unique.set(collection.id, collection)
  }
  return [...unique.values()]
}

export function mediaCloudRuleIsConfigured(rule, legacyCollections = []) {
  return rule?.lane === 'mediacloud'
    && mediaCloudCollectionsForRule(rule, legacyCollections).length > 0
}

export function enabledMediaCloudRulesAreConfigured(rules = [], legacyCollections = []) {
  const enabledRules = rules.filter(rule => rule?.lane === 'mediacloud' && rule.enabled !== false)
  return enabledRules.length > 0
    && enabledRules.every(rule => mediaCloudRuleIsConfigured(rule, legacyCollections))
}
