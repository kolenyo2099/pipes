# Pipeline

One Google Apps Script bridge per team sheet. It replaces the HRC Archiver / Save to Sheets bridge (v5), the canary-lite receiver and the research-pipeline push receiver. Every client talks to the same web app URL; the wire contract is in `docs/bridge-contract.md`.

## Deploy the bridge

1. Copy the team sheet, or open a sheet and go to Extensions → Apps Script.
2. Replace the script with `bridge/Code.gs` and save. Reload the sheet.
3. Menu **Pipeline → Team setup**. This creates the `TOKEN` script property.
4. Deploy → New deployment → Web app. Execute as: **Me**, Who has access: **Anyone**.
5. Run **Pipeline → Team setup** (or **Show join code**) again. The dialog shows the join code, which is `base64url({url, token})`. Share it with the team.

With no `TOKEN` the bridge is open (v5 behaviour) so older clients keep working; `health` and the no-action GET report `auth: "open"` so clients can warn. With a `TOKEN`, every request needs it: `token` in the POST body or the GET query. Research push refuses to run without a `TOKEN`.

Other script properties: `ID_PREFIX` (default `ITEM`), `ID_SEQ` and `SEARCH_SEQ` (counters, managed by the bridge).

**Connect GitHub** (optional): menu **Pipeline → Connect GitHub** stores `GITHUB_REPO` (`owner/name`) and `GITHUB_TOKEN` (blank keeps the stored one). After a save that creates an Archive row, the bridge sends a `repository_dispatch` `saved` event, at most one per 5 minutes (`LAST_DISPATCH`), so the pipeline runs right away. Failures are ignored.

## Sheets

- `Archive`: columns A–N are the HRC layout. Extended columns follow (Saved By … Extra) and are added automatically.
- `Searches`: shared Canary search definitions. `Config`: Key / Value, edited by humans.
- `Texts`: page text sent by the extension (`ID`, `Text 1`, `Text 2`, `Saved At`; 90,000 chars max). Reserved.
- Any other tab is a plain Save to Sheets worksheet or a push target.

## Actions

POST JSON (raw body, any content type):

- Extension: `data`, `dataBatch`, `setHeaders`, `getSheets`, `getHeaders`, or no action with legacy fields.
- HRC: `add`, `updateStatus`, `updateMany` (accepts `fields` and evidence shorthands), `lock`, `unlock`, `clearStaleLocks`, `list`, `health`.
- Canary: no action, `{headers[], values[]}`. Replies with text `OK`, `Unauthorized` or `ERROR: ...`.
- Page text and status: `putText`, `getTexts` (max 50 ids), `getStatus` (the `pipeline_status` tab as an object); `list` items carry `has_text`.
- Push: `putTab` or no action with `{tab, rows, reset}`. Reserved tabs are refused.
- Shared: `listSearches`, `upsertSearch`, `getConfig`.

GET: no params (sheets, headers, `bridge_version`, `auth`), `?action=list`, `?action=health`.

Items get server ids like `ITEM-2026-00001`. Extension and canary writes dedupe by URL (the saver is merged into Saved By); HRC `add` dedupes by id only.

## Tests

```
node --test test/bridge.test.js
```

No dependencies. Runs `test/bridge.test.js` against a fake SpreadsheetApp in `node:vm`.

## Extension

`extension/` is the Pipeline Chrome extension. One app, four parts, all coordinated through the team sheet:

- **Library** (home): everything the team saved, with who saved it and whether it is archived and processed.
- **Save**: buttons on Google, X, YouTube and Facebook, right-click save for pages, links, PDFs and images. Page text is sent with the save. One outbox delivers everything and retries.
- **Archive**: HRC Archiver's capture engine. Screenshot, PDF, MHTML, HAR, DOM, SHA-256 hashes and an RFC 3161 timestamp go to `Downloads/Pipeline/<id>/` on the capturing machine; the sheet gets the hashes. Rows are locked while a teammate captures them.
- **Explore**: the entity explorer published by the research pipeline, with the time of the last run.
- **Monitor (Canary)**: optional news and social monitoring. Inboxes stay in each browser; a monitoring setup can be shared with the team under Team searches.

```
cd extension && npm install && npm run build
```

Load `extension/dist` with "Load unpacked" in `chrome://extensions`, open the extension and paste the join code and your name. Tests: `npx vitest run`. Contracts: `docs/product-contract.md`, `docs/extension-save-contract.md`.

## Research pipeline

`research/` is the entity-extraction pipeline and explorer (formerly kolenyo2099/entityview). `.github/workflows/pipeline.yml` runs it every 30 minutes against the team bridge, keeps its state on the orphan `data` branch and deploys the explorer to GitHub Pages. Setup (secrets `PIPELINE_TEAM_CODE`, `ANTHROPIC_API_KEY`; Pages source: GitHub Actions) is in `research/README.md`. Tests: `cd research && python3 test_pipeline.py`.

## Smoke test

`smoke/run.mjs` loads the built extension in headless Chromium against `smoke/fake-bridge.js` (the real `bridge/Code.gs` on an in-memory sheet) and checks joining a team, Google capture, Save all, canary saves, retry/park, wrong-token handling, the Library, a real evidence capture of a local page, and Explore. Set `SMOKE_SHOTS=<folder>` to save screenshots of each view.

```
cd extension && npm run build && cd ../smoke && npm install && npx playwright install chromium && node run.mjs
```
