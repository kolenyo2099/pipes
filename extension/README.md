# Canary for Chrome

Canary as a Chrome extension. It has the desktop app's interface and features, and collects GDELT Events, GDELT GKG, Google News RSS, Media Cloud, X, Bluesky and Telegram results in the background. No server or PHP relay: the extension's host permissions let it read Google News and the other sources directly. Everything is stored in this browser profile's IndexedDB.

## Build and install

```sh
cd canary-lite
npm install
npm run build
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and select `canary-lite/dist`. Click the Canary toolbar icon to open the app in a tab.

Checks: `npm run check`, `npm test`.

`npm run dev` serves the app at a local address for UI work. There it runs without extension APIs: collection runs only while the tab is open, Google News fails (no CORS), and archiving is unavailable.

## How it works

- **The app** (`index.html`) is desktop Canary's Svelte UI. `src/api.js` keeps the desktop HTTP client's interface but is implemented locally over IndexedDB (`src/backend/`).
- **Collection** runs in an offscreen document (`offscreen.html`), which the service worker (`public/background.js`) wakes on a one-minute alarm and for **Run now**. It keeps running with the Canary tab closed, as long as Chrome is open. Each lane follows the project's interval settings; GDELT lanes that are behind catch up eight 15-minute files per stream per run, English and translated.
- **Google News** searches use explicit `after:`/`before:` week windows, so time away is caught up. They are spaced 2.5 to 4 seconds apart, capped at 120 per run, and stop for an hour when Google answers 429/503. Searches come from your own IP address.
- **X** rules run an X search (typed search, accounts, X list links, or a mix) from the rule's start date, using this browser's own x.com sign-in. X only answers searches its web app signs, so the service worker loads each search page in a background tab and `public/x-hook.js` keeps the results the page receives, with X's rate-limit headers; the hook does nothing in tabs Canary did not open. Saving an X rule asks Chrome for access to x.com. X's terms restrict automated access, and these searches run under your account.
- **Bluesky** rules take the same search, accounts and start date, but call Bluesky's API directly, 100 posts per request, with no browser tab. Bluesky search has no OR across accounts, so each account is its own search; a Bluesky list link reads the list's feed instead, all members in one request. Since 2026 Bluesky search answers only signed-in requests, so the lane signs in with an app password connected in the Bluesky rule editor; it is stored in this browser and left out of backups. Accounts hosted outside Bluesky's own servers cannot sign in yet.
- **Telegram** rules list public channels (names or `t.me` links) and, optionally, comma-separated keywords. Telegram has no search across channels, so the lane reads each channel's public web preview at `t.me/s/<channel>`, without cookies or a Telegram account, about 20 posts a page, paging back by post number. Keywords filter posts after the fetch, so pages without matches never stop a backfill early. A new channel goes back at most 30 days. Channels that turn off the web preview are reported in the run's errors. Saving a Telegram rule asks Chrome for access to t.me.
- **Pacing for X, Bluesky and Telegram.** Each search keeps the stretches of time it has not collected yet. Each run adds the stretch since the last run, and every request goes to the newest stretch among the project's searches, filling it from the newest post down (as scrolling would; background tabs cannot scroll) until a page brings nothing new. New posts never wait behind a backfill, which only gets the requests left over. Searches that keep coming back empty are checked less often, up to 4× the interval. Every request draws on one budget per service shared by all projects: by default 20 X searches per 15 minutes, at least 15 seconds apart, 400 a day (X's web app allows about 50 per 15 minutes), 300 Bluesky requests per 5 minutes (Bluesky allows 3000 per IP address), and 60 Telegram pages per 5 minutes, 2.5 to 4 seconds apart (Telegram publishes no limit). Both services report their remaining requests; Canary keeps a reserve and, when told to stop, waits until the time they give. Over budget, collection falls behind and catches up later. The budgets can be changed in Project Settings, and the collector panel shows budget use, pauses and backlogs.
- **When a source changes.** X and Telegram are read from pages built for people, which change without notice. Each parser checks for the structure it expects, so a changed format is told apart from a quiet search: an X response without its timeline, a post missing its id or text fields, posts on screen that the hook never saw, or a Telegram page with neither posts nor a channel header. The lane then stops, and the collector panel shows "Something broke in the X lane" with the error and a link that drafts an email to info@osinv.org in your mail app. The error names only what changed, never your rules, searches or posts. The alert clears once a page reads fine again.
- **Archiving** opens a saved item in a background tab, saves it with `chrome.pageCapture` as MHTML and writes it to `Downloads/Canary/`. **View snapshot** opens that file. The page loads with your own cookies and logins. Desktop's WARC capture in an isolated profile is not available.
- **Event headlines** (Project Settings) optionally fetch each new GDELT event's article title. Turning this on asks Chrome for access to all sites; turning it off gives that access back.
- **On-device language analysis** (Project Settings) detects language automatically and optionally enriches new RSS and Media Cloud items with entities and sentiment. Download and enable either multilingual model once; the models run in a worker in the offscreen collector, using the same pinned ONNX weights as desktop. Text stays local. Disable a model to unload it, or remove it to delete its model cache. Inference uses single-threaded WASM so it works without GPU support. Model files are cached separately from backups; download them again after restoring in a new browser profile.
- **Google Sheets** and **Media Cloud** work as on desktop. The Media Cloud token is stored in this browser and left out of backups.
- **Media Cloud filtering** applies simple-mode required terms to headlines (or entity metadata when present). Failed or partially completed searches keep their collection cursor so the next run retries the same window.
- **Story grouping** retains probable duplicate scores and reasons, plus review decisions and not-duplicate constraints, in project metadata and backups. The review API records decisions; merge/split operations and a review interface are not implemented, matching desktop's current backend scope.
- **Deleting an item or project** also removes its archive files when Chrome can identify the matching download as created by this extension. Moved files, untracked downloads, and files restored from another browser profile must be managed separately.

## Differences from desktop

- Language detection uses `franc-min` rather than desktop's `whatlang`, so results on short or ambiguous headlines may differ. Entity and sentiment models match desktop, with a 256-token input limit. Fuzzy grouping detects headline language and uses source metadata when detection is inconclusive.
- No WARC archives (MHTML only, see above).
- Item IDs use a 64-bit hash instead of a SHA-256 prefix, so desktop and extension data are not interchangeable.
- GKG items record the countries they mention, so the country filter works on them.

## Your data

Data lives in one Chrome profile. **Removing the extension deletes it**, so use **Download backup** in the sidebar regularly. **Restore backup** loads that file into another profile or computer. Archive files stay in Downloads.
