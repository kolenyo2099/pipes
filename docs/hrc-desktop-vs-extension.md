# HRC Archiver: desktop changes missing from the Chrome build

Repo: `/Users/guillen/Documents/experiments/HRCARchiver`, branch `startup-performance` (`main` and `public/main` are far behind it; Chrome work exists only here). Nothing was modified.

## Summary

Git history says the build is in sync: the last `chrome-app/` commit (`ea5efa3`, 2026-10-16) is HEAD. That is misleading. Source-date work (`f5863b4`, `2575b18`, `1e56d13`, `401740b`, `ea5efa3`) was ported. Two capture-engine changes were not, because they touched no `chrome-app/` file. `8b6f0b1` (2026-10-12, hidden dynamic content) touched only `engine/`, `backend/` and `docs/`. The `browser_capture.py` and `capture_quality.py` parts of `f5863b4` (scroll-container expansion, LinkedIn JS-required host) were also left out. Sheet sync, items, jobs, scheduler, schema columns, verification, audit, manual capture, manifests/README and enrichers were compared function by function and match. The frontend is built directly from `frontend/` (`chrome-app/build.mjs:15-22`), so UI changes arrive on rebuild. The main residual risk is a stale `chrome-app/dist`, which is gitignored and was built 2026-10-14 19:08, before the last `linkedin-job-dates.js` edit.

## Gap table

| Area | Desktop behaviour | Chrome build | Gap | Portable? | Effort | File refs |
|---|---|---|---|---|---|---|
| Hidden-content detection | Counts laid-out text hidden by opacity/visibility, forces a JS retry, waits for reveal animations, stores `dom_signals.text_visibility`, raises `hidden_content` issue | None of it. JS-on captures never re-probe | Entrance-animation pages are filed `done` with invisible text in the PNG/MHTML | Yes (`Runtime.evaluate` of the same script) | M | `browser_capture.py:279-310,856-859,893`; `capture_quality.py:192-205,333-335`; Chrome: `quality.js:65-72,103-139`, `browser.js:376-402` |
| Scroll-container expansion | `_expand_scroll_container` enlarges the viewport for apps whose main panel scrolls inside a one-screen document; `expanded_viewport` recorded | Only `expandVirtualizedList` | Screenshots of app-shell pages (Gmail-style) clip to the first screen | Yes (`Emulation.setDeviceMetricsOverride`) | M | `browser_capture.py:415-470,575-597` (commit `f5863b4`); `browser.js:174-196,248-252` |
| Static-capture load wait | Static captures wait for `load` before snapshotting | Waits only on the JS path | MHTML/PNG may lack styles and images | Yes | S | `browser_capture.py:593`; `browser.js:246-252` |
| LinkedIn handling | `requires_javascript` includes linkedin.com. `li_at` is the required session cookie | LinkedIn not in the JS-required list. Cookie diagnostics treat any cookie as a session | Static-first render of LinkedIn, and a false "session present" | Yes | S | `capture_quality.py:87`; `browser_capture.py:226-227`; `quality.js:34-36`, `browser.js:295-313` |
| Host-list drift (reverse) | JS-required hosts: facebook, instagram, twitter/x, linkedin | Adds youtube, tiktok, vimeo | Unreviewed behavioural difference between builds | Decide, then align | S | `quality.js:34-36` vs `capture_quality.py:87` |
| URL normalization | `urlsplit` plus `urlencode`: keeps `:443`/`:80`, unicode host, `~`, `%7E` and `..`; encodes `*` | WHATWG `URL`: strips default ports, punycodes the host, resolves `..`, encodes `~`, leaves `*` | Same URL gets different `url_hash`/stored `url`. Verified by running both: `https://Example.com:443/a?q=a~b&z=*` gives different strings. Hurts dedupe and sheet URL matching when a collection is shared | Yes (hand-split instead of `new URL`) | S | `url_utils.py:89-100`; `urls.js:79-87`; used at `sync.js:60-67` |
| Item uniqueness and DB migrations | `SCHEMA_VERSION=4`; unique indexes on `(collection_id,url_hash)` and `(collection_id,remote_id)`; pre-migration backup | IndexedDB `VERSION=1`, no unique indexes. `addItem` checks then puts non-atomically. No migration path or backup | Concurrent adds or sync can duplicate rows. Any future schema change has no upgrade hook | Yes | S/M | `connection.py:30,144,230`; `db.js:5,26`; `items.js:73-82` |
| Document fallback ladder | AMP/canonical/print/PDF discovery, crawler-UA retry on 403/429/451, Wayback CDX last resort, quality score (threshold 55), text-PDF, host-strategy store, `capture_strategy*` metadata | Plain `fetch` of the file only (the file itself says it is skipped) | Pages the browser cannot render get no alternate representation. See `FIXES.md` #2 and #18 for why this is contested | Partly (`fetch` with host permissions; profile store in IDB) | L | `simple_http_extractor.py:286-362,378-460`; `docs/adaptive-capture.md`; `document.js:1-41` |
| LinkedIn job-date lookup details | Honors `Retry-After` (capped 30s), also searches `.mhtml` for the title, 15s body deadline, `response_limit` status | Fixed waits, HTML only, overflow recorded as `request_failed` | Status vocabulary differs, so `source_date_lookup.status` is not comparable | Yes | S | `linkedin_job_dates.py:37-60,69-118`; `linkedin-job-dates.js:18-62` |
| Credential storage | Fernet-encrypted, key in OS keyring | Secret stored plain in IDB row | Weaker at rest, and shows in profile backups | Yes (WebCrypto AES-GCM, non-extractable key) | S/M | `credentials.py:26-71`; `credentials.js:22-29` |
| Background jobs | Loops run while the app process runs | Run only while the app tab is open (documented) | Missed pulls and archives when the tab is closed | Partly (`chrome.alarms` plus offscreen document) | L | `background_*.py`; `scheduler.js:42-49` |
| Stale build | n/a | `chrome-app/dist` predates last source edit | Loaded extension may lack the LinkedIn retry code | Yes | S | `chrome-app/build.mjs` |

Desktop bug found while comparing: `hidden_content` is missing from `_DERIVED_CODES` (`verification.py:39-54`). A stored `hidden_content` issue is therefore carried forward forever and never clears on re-audit. Fix it when porting.

## Verified at parity (no gap)

- **Sheet sync.** Actions `list`/`health`/`add`/`updateMany`/`lock`/`unlock`/`clearStaleLocks`, newest-`archived_at` conflict rule, remote_id/URL-hash matching, completed-row import as runnable work, duplicate-ID and missing-ID errors, `sync_runs` directions and statuses. `sheet_sync.py:256-498,551-617,640-757` vs `sync.js:144-420`. Cosmetic: JS does not follow `Retry-After`, and `pushItem` swallows errors (`sync.js:285`).
- **Source dates.** Platform identity table, `extractor_version 1.3`, selection/disagreement/relative handling. `source_dates.py:33-56` vs `source-dates.js:94-117,237`. This is a structural match only. JS uses `DOMParser` and Python uses `HTMLParser`, so run `backend/tests/fixtures/source_dates_archived.json` through both to confirm.
- **Verification and audit.** `verification.py:93-166` vs `quality.js:180-244`; `quality_audit.py:37-150` vs `audit.js:22-89`. Same derived codes (except the bug above), blank-render cache and job recount.
- **Manifests and README.** Manifest keys, `source_dates`, "NEEDS REVIEW" banner, custody names, linkedin files. `json_enricher.py:136-170` vs `enrichers.js:159-202`; `local_storage.py:88-130` vs `media-model.js:44-105`.
- **Manual capture.** Session TTL and supersede, document path, streams, `superseded_capture`, source dates and LinkedIn lookup. `manual_capture.py:786-840` vs `manual.js:220-365`. Desktop claim/launch/token routes are replaced by the popup messaging in `manual.js:370-420`.
- **Jobs, scheduler, schema columns, collection/item routes.** Compared against `job_runner.py`, `background_*.py`, `collections.py` and `items.py`. Only the gaps in the table differ. Every `frontend/src/lib/api.ts` endpoint is either routed or returns an explicit 501 in `chrome-app/src/index.js`.

## FIXES.md and UX plan cross-check

- UX Phase 1 (labels, Archive N, previews, 409 on empty job, bulk-add error naming) is in shared frontend code or ported (`jobs.js:30-34`, `items.js:84-98`).
- Phase 2 (readable names, custody names, review banner, `preview.jpg`, dedupe by hash) is ported (`media-model.js`, `enrichers.js:108`, `browser.js:450`).
- Phase 3 slug folders is ported (`collections.js:38`).
- Open in both builds: "left to do" #3, the import-preview TRACKING_PARAMS drift in TypeScript.
- FIXES #2: desktop still defaults `wayback_fallback` True and the Chrome build has no such fallback. The builds diverge, and porting the ladder must settle that default first.
- FIXES #3 (hardcoded per-URL overrides) was not carried to Chrome, which is correct.
- FIXES #17 (single verification path) holds in both.

## Inherently desktop-only, with browser-side substitutes

| Desktop feature | Chrome status / substitute |
|---|---|
| yt-dlp, ffmpeg install and update | Replaced by `media-layer.js` plus `chrome-media-capture` (HLS/DASH, MSE recording). Deps routes return "nothing to install" |
| Playwright / managed Chromium | CDP over `chrome.debugger` (`cdp.js`, `browser.js`) |
| Browser cookie-DB scan, cookie refresher, cookie profiles (now incl. LinkedIn, Reddit, Edge, Chromium) | Not needed: the tab uses the live session. `/api/extension/sites` already lists LinkedIn/Reddit login state (`index.js:150-160`) |
| Telethon / Telegram sign-in | No substitute. Public `t.me` posts are captured as pages. Private channels could go through the logged-in Telegram Web tab, which is a large project |
| Keyring | WebCrypto, see the credential row above |
| Tauri shell, Finder reveal, local API token | Replaced by the File System Access folder picker |
| `scripts/Code.gs` `dataBatch`/`getSheets` | Used by the older `chrome-extension/`, not by either sync path |

## Prioritized port list

1. Rebuild `chrome-app/dist` from HEAD (S).
2. Port the hidden-content probe: `text_visibility` script, retry condition, wait loop, `dom_signals` field and `hidden_content` issue. Add `hidden_content` to `_DERIVED_CODES` in both builds (M).
3. Align URL normalization byte for byte with `url_utils.py`, with a shared fixture test (S).
4. Add the static-capture `load` wait, LinkedIn to the JS-required hosts and `li_at` diagnostics, and settle the youtube/tiktok/vimeo divergence (S).
5. Port `_expand_scroll_container` and record `expanded_viewport_height` (M).
6. Bump the IDB schema to v2 with unique indexes, a dedupe pass, an atomic `addItem`, and an upgrade hook (S/M).
7. Encrypt stored credentials with WebCrypto (S/M).
8. Sync the LinkedIn lookup details: `Retry-After`, `response_limit` status, mhtml title source (S).
9. Decide the document-fallback policy (FIXES #2 and #18), then port the minimum: canonical/AMP/PDF discovery plus an opt-in, labelled Wayback candidate (L).
10. Move scheduling to `chrome.alarms` with an offscreen runner (L).
