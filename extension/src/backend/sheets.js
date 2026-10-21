// Port of desktop export/sheets.rs: the same row layout, so existing Apps Script sinks keep working.
const HEADERS = ['canary_item_id', 'project_id', 'saved_at', 'saved_by', 'source_type', 'query_bucket', 'matched_buckets', 'datetime_utc',
  'countries_focus', 'status', 'tags', 'notes', 'title_or_summary', 'url', 'snippet_or_context', 'gdelt_primary_id', 'actor1_name',
  'actor1_country', 'actor2_name', 'actor2_country', 'event_code', 'quad_class', 'quad_class_label', 'goldstein_scale', 'avg_tone',
  'num_mentions', 'action_geo_fullname', 'action_geo_country', 'doc_domain', 'doc_language', 'doc_source_country', 'rss_source_name',
  'rss_source_url', 'rss_query_label', 'rss_query_text', 'rss_matched_countries', 'rss_matched_people', 'rss_matched_organizations',
  'rss_matched_action_core', 'rss_matched_action_alt']

const str = v => v == null ? '' : typeof v === 'string' ? v : ''
const num = v => typeof v === 'number' ? v : ''
const joined = v => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x).join('; ') : ''

export function buildSheetRow(item) {
  const n = item.normalized || {}
  const events = item.source_type === 'events', doc = ['doc', 'context', 'gkg'].includes(item.source_type), rss = item.source_type === 'rss'
  const only = (flag, value) => flag ? value : ''
  return {
    headers: HEADERS,
    values: [
      item.item_id, item.project_id, item.saved_at || '', item.saved_by || '', item.source_type, item.query_bucket,
      (item.matched_buckets || []).join('; '), item.datetime_utc || '', (item.countries_focus || []).join('; '), item.status,
      (item.tags || []).join('; '), item.notes || '', item.title_or_summary || '', item.url || '', item.snippet_or_context || '',
      rss ? '' : item.gdelt_primary_id || '',
      only(events, str(n.actor1_name)), only(events, str(n.actor1_country)), only(events, str(n.actor2_name)), only(events, str(n.actor2_country)),
      only(events, str(n.event_code)), only(events, str(n.quad_class)), only(events, str(n.quad_class_label)), only(events, num(n.goldstein_scale)),
      only(events, num(n.avg_tone)), only(events, num(n.num_mentions)), only(events, str(n.action_geo_fullname)), only(events, str(n.action_geo_country)),
      only(doc, str(n.domain)), only(doc, str(n.language)), only(doc, str(n.source_country)),
      only(rss, str(n.source_name)), only(rss, str(n.source_url)), only(rss, str(n.query_label)), only(rss, str(n.query_text)),
      only(rss, joined(n.matched_countries)), only(rss, joined(n.matched_people)), only(rss, joined(n.matched_organizations)),
      only(rss, joined(n.matched_action_core)), only(rss, joined(n.matched_action_alt)),
    ],
  }
}

// Returns [ok, error].
export async function sendToSheet(item, sink) {
  let url
  try { url = new URL(sink.url) } catch (error) { return [false, `Invalid sheet sink URL: ${error.message}`] }
  if (url.protocol !== 'https:') return [false, 'Unsafe sheet sink URL: use the https:// web app address']
  const payload = { ...buildSheetRow(item), ...(sink.token ? { token: sink.token } : {}) }
  let response
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  } catch (error) {
    return [false, String(error.message || error).slice(0, 300)]
  }
  const body = (await response.text().catch(() => '')).trim()
  if (!response.ok) return [false, `HTTP ${response.status}: ${body.slice(0, 200)}`]
  if (body.toLowerCase() === 'unauthorized') return [false, 'Sheet rejected request: Unauthorized (check token)']
  if (body.toLowerCase().startsWith('error:')) return [false, body.slice(0, 300)]
  return [true, null]
}
