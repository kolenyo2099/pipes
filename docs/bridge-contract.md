# Bridge wire contract (as of 2026-10-21)

Inventory of every client that talks to the Apps Script bridges. Reference bridge: `experiments/HRCARchiver/scripts/Code.gs` (v5); `save-to-sheets-extension/apps-script.js` is byte-identical.

## Clients

### Save to Sheets extension (text/plain POST, GET without params)
- POST `data` `{rowData, capture, sheetName}` or **no action** legacy `{id,title,url,snippet,query,savedBy,sheetName}`.
- POST `dataBatch` `{sheetName, items:[{rowData,capture} | {row:[id,ts,savedBy,query,title,url,snippet]}]}` → reads `results[].ok`; fails only if all fail; non-Archive `count===0` = failure; `/unknown action/i` → falls back to per-row `data`.
- POST `setHeaders` `{headers[], sheetName}`.
- GET (no params) → reads `sheets[]`, `bridge_version`. GET `?sheetName=` → reads `headers[]`, `sheets[]`.
- Success rule (background.js:54-72): HTTP ok, JSON, not `ok===false`, not `status==='error'`, no `error`.
- HRC template: columns = HRC_HEADERS, Status `pending`, Source `chrome-extension`.

### HRC desktop (backend/app/services/sheet_sync.py) and HRC Chrome build (chrome-app/src/sync.js)
Same action set, same rules. JSON POST. No token sent today.
- GET `action=health` → `item_count` (if absent falls back to list limit 1 → `total`, `spreadsheet`).
- GET `action=list&status=all&offset&limit=5000&include_locked=true` → `items[]`, `total`; pages until total; rejects duplicate ids.
- GET `action=list&status=pending&offset=0&limit=100` (no include_locked).
- POST `add` `{id,url,title,notes,tags[],status,priority,added_at,archived_at,result_path,result_metadata,source,archived_by_instance}`.
- POST `updateMany` `{updates:[{id,status,result_path,result_metadata,archived_at,archived_by_instance}]}` (status free-form, e.g. `skipped`).
- POST `lock {ids, locked_by}` → `count`; `unlock {ids, locked_by}` (empty ids = all held by locked_by) → `count`; `clearStaleLocks {active_locks}` → `count`.
- Conflict rule: completed = {done, needs_review, failed}; newest `archived_at` wins.

### canary-lite (src/backend/sheets.js) and desktop canary (src/export/sheets.rs)
- POST JSON `{headers:[42 names], values:[42 values], token?}`, **no action**.
- Success: HTTP ok and body not `unauthorized` (case-insensitive) and not starting `error:`. Anything else = success. Its own script returns text `OK` / `Unauthorized` / `ERROR: ...`.
- Headers: canary_item_id, project_id, saved_at, saved_by, source_type, query_bucket, matched_buckets, datetime_utc, countries_focus, status, tags, notes, title_or_summary, url, snippet_or_context, gdelt_primary_id, actor1_name, actor1_country, actor2_name, actor2_country, event_code, quad_class, quad_class_label, goldstein_scale, avg_tone, num_mentions, action_geo_fullname, action_geo_country, doc_domain, doc_language, doc_source_country, rss_source_name, rss_source_url, rss_query_label, rss_query_text, rss_matched_countries, rss_matched_people, rss_matched_organizations, rss_matched_action_core, rss_matched_action_alt.

### Research pipeline push.py → apps_script.gs
- POST JSON `{token, tab, rows[][] (header row first), reset: chunk==0}`, **no action**. 5000 rows/chunk.
- `reset` clears the tab. Formula guard prefixes `'`. First column text-formatted. Reply `{ok:true, rows}`; `{ok:false,error}` on token mismatch (token compared trimmed).
- Readers (pipeline.py, extract.py) read the published Canary CSV by column name; id column is `l` (no known writer emits `l` — verify live sheet).

## Must-keeps
1. One URL serves GET and POST; HTTP 200 JSON with `ok`/`error` (except canary path: text).
2. No-action GET returns `bridge_version`, `sheets[]`, `headers[]` (`?sheetName=`).
3. Action names: data, dataBatch, setHeaders, getSheets, getHeaders, add, updateStatus, updateMany, lock, unlock, clearStaleLocks; GET list, health.
4. No-action POST with extension legacy fields appends the 7-column legacy row.
5. Unknown action error text contains `Unknown action: X`.
6. dataBatch returns `count` and `results[{ok,id,created|error}]`.
7. list: `items`, `total` (post-filter, pre-page), `offset`, `limit`, `spreadsheet`; `status` absent/`all` = no filter; `include_locked==="true"`.
8. health: `item_count`, `spreadsheet_id`, `spreadsheet_name`, `sheet_name`.
9. add: same id + same URL → ok `created:false`; same id + different URL → ok:false (HRC).
10. updateMany partial keys; `archived_at` set and lock cleared only for completed statuses.
11. lock skips already-locked rows; unlock with empty ids unlocks all held by `locked_by`.
12. Archive sheet: columns A–N exactly HRC_HEADERS; mismatch error text "does not use the HRC column layout".
13. Parse raw `e.postData.contents`; never key on Content-Type.
14. Every request needs the TOKEN (no open mode; no TOKEN set = all requests refused, canary gets text `Unauthorized: ... Team setup`). HRC clients must send `token`.
15. canary payload has no action: must not fall into the legacy 7-column path; must answer text.
16. push.py payload has no action: `{tab, rows, reset, token}`. Only tabs `articles`, `mentions`, `results_articles`, `results_relations`, `pipeline_status`, `answers_*` and (append only) `Queries` are accepted.
17. `addQueries {headers, rows}` → `{ok, added}`: appends rows whose `Entry ID` is new to `Queries`.
