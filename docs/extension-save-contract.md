# Extension save contract (Phase 1)

Every save in the extension, from any source, goes through one outbox that lives in the service worker and posts to the team bridge (`bridge/Code.gs`, see `docs/bridge-contract.md`).

## Team settings

`chrome.storage.local` key `pipelineTeams` = `[{ id, label, url, token, name }]` (every joined project) and `pipelineTeam` = the active one, same shape. Each queued outbox entry is stamped with `team: { url, token }` when saved and delivered to that sheet, even if the active project changes meanwhile.
- `url` and `token` come from the join code: `base64url(JSON.stringify({url, token}))` (made by the sheet's "Pipeline → Team setup" menu). Decode by mapping `-`→`+` and `_`→`/` and restoring `=` padding, then `atob`, then `JSON.parse`. Reject it unless `url` starts with `https://script.google.com/` and `token` is a non-empty string.
- `name` is the person's display name. It becomes `savedBy` / `saved_by`.

## Service worker files (classic scripts)

`public/background.js` starts with `importScripts('outbox.js', 'capture-bg.js');`
- `public/outbox.js` (core): the queue, delivery, and the message API below. It defines the global `pipelineEnqueue(item)`.
- `public/capture-bg.js` (capture): context menus, the PDF title prompt. It calls `pipelineEnqueue` directly.

## Save item shapes

```js
// Browser capture (content scripts, context menus)
{ kind: 'capture', key?: string, capture: { url, title, snippet?, query?, notes?, sourceType, timestamp, language?, publishDate?, project?, ...siteFields } }
// Canary inbox save (app page)
{ kind: 'canary', ref: item_id, headers: [...], values: [...] }   // headers/values = buildSheetRow(item) from src/backend/sheets.js
```

- `sourceType` values: `google`, `x`, `youtube`, `facebook`, `page`, `link`, `pdf`, `image`.
- The outbox fills `capture.savedBy` from `pipelineTeam.name` when it is empty. Client-side ids are never sent: the bridge assigns them.
- `key` is optional. The outbox ignores an enqueue whose key is already queued, or was sent in the last 5000 deliveries. This dedupes Google "Save all".

## Messages (`chrome.runtime.sendMessage`, handled in outbox.js)

| type | payload | reply |
|---|---|---|
| `pipeline:save` | `{ item }` | `{ ok: true, queued: boolean }` or `{ ok: false, error }` (for example, team not configured) |
| `pipeline:status` | — | `{ pending, parked, lastError, team: { configured, name, url } }` |
| `pipeline:retry` | — | `{ ok }`: un-parks everything and drains |
| `pipeline:drain` | — | `{ ok }` |

Results are broadcast with `chrome.runtime.sendMessage({ type: 'pipeline:delivered', results: [{ kind, ref?, key?, ok, error?, id? }] })`. They are also stored under `chrome.storage.local` key `pipelineResults` as a map ref → `{ ok, error, id, at }`, holding canary refs only and capped at 1000. The app page reconciles `sheet_send_status` from that map on load and when this message arrives.

## Delivery rules

- Up to 25 consecutive `capture` items are sent as one POST: `{ token, action: 'dataBatch', sheetName: 'Archive', items: [{ capture }] }`. Each `results[i]` is that item's result.
- Each `canary` item is sent as `{ token, headers, values }`. The reply is plain text: `OK` means success, `Unauthorized` or `ERROR: …` means failure.
- Requests are POSTs with `Content-Type: text/plain`.
- On a network error, HTTP error, or `ok:false` / `status:'error'`, the retry count goes up and the next attempt waits `min(2000*2^(n-1), 20000)` ms. After 4 failures the item is parked. A wrong-token reply parks it immediately.
- The queue lives in `chrome.storage.local` under `pipelineOutbox`, so it survives service-worker restarts. Draining is single-flight. A 1-minute alarm named `pipeline-drain`, plus every service-worker start, resumes it.
- Badge: the number pending, red if anything is parked, cleared when the queue is empty.
