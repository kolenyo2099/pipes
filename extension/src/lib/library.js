// Pure helpers for the team Library: everything here works on rows from the sheet's `list` action.
export const domain = url => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } }
export const sourceType = item => item.source_type || 'link'
export const savedAt = item => item.saved_at || item.added_at || ''

// 'archived' | 'needs_review' | 'failed' | 'none'
export function archiveState(item) {
  if (item.status === 'needs_review' || item.status === 'failed') return item.status
  return item.evidence_hash ? 'archived' : 'none'
}

export const newestFirst = items => [...items].sort((a, b) => String(savedAt(b)).localeCompare(String(savedAt(a))))

export function filterItems(items, { q = '', savedBy = '', type = '', archive = '' } = {}) {
  const needle = q.trim().toLowerCase()
  return items.filter(item =>
    (!savedBy || item.saved_by === savedBy) &&
    (!type || sourceType(item) === type) &&
    (!archive || archiveState(item) === archive) &&
    (!needle || [item.title, item.url, item.snippet, item.query].some(v => String(v || '').toLowerCase().includes(needle))))
}

export const summarize = items => ({
  total: items.length,
  archived: items.filter(i => i.evidence_hash).length,
  processed: items.filter(i => i.processed_at).length,
})

export const distinct = (items, pick) => [...new Set(items.map(pick).filter(Boolean))].sort()
