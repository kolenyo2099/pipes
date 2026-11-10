# Product contract (Phase 3: one product, not Canary plus a queue)

The extension is "Pipeline". Home is the team Library. Canary is one section (Monitor). Everything coordinates through the team sheet via `bridge/Code.gs`.

## Shared client (exists): `extension/src/backend/bridge.js`

`bridge(action, body)` posts `{token, action, ...body}` to the team URL and returns the parsed reply; it throws `Error(reply.error)` on `ok:false`, HTTP errors, or when no team is joined. New app-page code calls the sheet only through this. Do not add methods to `src/api.js`.

## Views (`currentView` store values) and owners

| view | component | owner |
|---|---|---|
| `library` (home) | `src/views/Library.svelte` | shell |
| `explore` | `src/views/Explore.svelte` | shell |
| `archive` | `src/views/Archive.svelte` (stub exists) | archive |
| `team-searches` | `src/components/TeamSearches.svelte` (stub exists) | searches |
| `team` | `src/components/TeamSettings.svelte` | shell |
| inbox, saved, dismissed, timeline, logs, settings, new-project | existing Canary views, grouped under "Monitor" | unchanged |

File ownership: **shell** = `src/App.svelte`, `src/components/Sidebar.svelte`, `src/stores/app.js`, `TeamSettings.svelte`, `About.svelte`, `TutorialTour.svelte`, Library, Explore, their tests, `index.html`. **archive** = `public/**` (manifest, outbox, capture, background), `src/views/Archive.svelte`, `src/backend/evidence*.js`, `src/engine/**`, `src/offscreen.js` if needed. **searches** = `src/components/TeamSearches.svelte`, `src/backend/searches.js`, `src/views/ProjectSettings.svelte`. **bridge** = `bridge/**`, `test/**`, `research/**`, `.github/**`, `smoke/fake-bridge.js`. Nobody else edits another owner's files.

## Bridge additions (bridge owner; everyone codes against these)

- **Page text.** `capture.text` (string) on `data` / `dataBatch` → Archive is stored in tab `Texts` (`ID`, `Text 1`, `Text 2`, `Saved At`; 45,000 chars per cell, 90,000 max, rest dropped), never in `Extra`. First text wins. `putText {id, text}` → `{ok}` (same rule, `replace:true` overwrites). `getTexts {ids}` (max 50 ids) → `{ok, texts:[{id, text}]}`. `list` items gain `has_text: boolean`.
- **Status.** `getStatus` → `{ok, status:{key:value}}` from the `pipeline_status` tab (empty object if absent). The pipeline writes `explorer_url`, `finished_at`, `articles_total`, `ok`, `error`, `action` there.
- **Run trigger.** Script properties `GITHUB_REPO` (`owner/name`) and `GITHUB_TOKEN`. After any Archive write that created a row, if both are set and `LAST_DISPATCH` is older than 5 minutes, POST `repository_dispatch` `{event_type:'saved'}` with `UrlFetchApp` (errors swallowed, never fails the save). Menu item "Pipeline → Connect GitHub" prompts for both.
- Existing and used by the app: `list` (POST, `status`, `offset`, `limit`, `include_locked`), `updateMany` (evidence shorthands `evidence_hash`, `evidence_files`, `captured_by`, `captured_at`, `timestamp_token`, plus `status`, `result_metadata`), `lock` / `unlock`, `listSearches`, `upsertSearch`, `getConfig`, `health`.

## Evidence (archive owner)

Evidence files stay on the capturing machine under `Downloads/Pipeline/<item id>/`; the sheet gets `evidence_hash` (SHA-256 of the manifest or main file), `evidence_files` (names + hashes), `captured_by` (team name), `captured_at`, and `status` (`done` / `needs_review` / `failed`). Rows are locked (`lock` with `locked_by` = a per-install id) while being captured.

## Shared searches (searches owner)

A shared definition is one Canary project's monitoring setup without secrets: `upsertSearch {search:{id?, project: <project name>, lane:'project', name, query:<definition object>, interval_mins, owner:<team name>, enabled}}`. Subscribing creates a local project from the definition. Inbox items, cursors and triage never leave the browser.
