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

## Sheets

- `Archive`: columns A–N are the HRC layout. Extended columns follow (Saved By … Extra) and are added automatically.
- `Searches`: shared Canary search definitions. `Config`: Key / Value, edited by humans.
- Any other tab is a plain Save to Sheets worksheet or a push target.

## Actions

POST JSON (raw body, any content type):

- Extension: `data`, `dataBatch`, `setHeaders`, `getSheets`, `getHeaders`, or no action with legacy fields.
- HRC: `add`, `updateStatus`, `updateMany` (accepts `fields` and evidence shorthands), `lock`, `unlock`, `clearStaleLocks`, `list`, `health`.
- Canary: no action, `{headers[], values[]}`. Replies with text `OK`, `Unauthorized` or `ERROR: ...`.
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

`extension/` is the unified Chrome extension: the canary-lite base, Save to Sheets capture (Google, X, YouTube, Facebook, right-click page/link/PDF/image), and one outbox that delivers every save to the team bridge. Canary inboxes stay in each browser; only saved items are sent.

```
cd extension && npm install && npm run build
```

Load `extension/dist` with "Load unpacked" in `chrome://extensions`, open the extension, Settings → Team, paste the join code and your name. Tests: `npx vitest run`. Save flow contract: `docs/extension-save-contract.md`.

## Research pipeline

`research/` is the entity-extraction pipeline and explorer (formerly kolenyo2099/entityview). `.github/workflows/pipeline.yml` runs it every 30 minutes against the team bridge, keeps its state on the orphan `data` branch and deploys the explorer to GitHub Pages. Setup (secrets `PIPELINE_TEAM_CODE`, `ANTHROPIC_API_KEY`; Pages source: GitHub Actions) is in `research/README.md`. Tests: `cd research && python3 test_pipeline.py`.
