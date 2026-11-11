/**
 * Pipeline unified Google Apps Script bridge (v7).
 *
 * One deployed web app per team sheet. Replaces the Save to Sheets / HRC
 * Archiver bridge (v5), the canary-lite receiver and the research push
 * receiver. See docs/bridge-contract.md for every client's wire contract.
 *
 * Deploy: paste this file, run menu Pipeline → Team setup, then
 *   Deploy → New deployment → Web app, Execute as: Me | Who has access: Anyone.
 * Run Team setup again after deploying to get the join code.
 *
 * Script properties: TOKEN (auth; unset = open), WEBAPP_URL (pasted at setup), ID_PREFIX, ID_SEQ, SEARCH_SEQ,
 * GITHUB_REPO / GITHUB_TOKEN (menu Connect GitHub), LAST_DISPATCH.
 */

const BRIDGE_VERSION = 7;
const SCHEMA_VERSION = 4;
const HRC_SHEET_NAME = "Archive";
const HRC_HEADERS = [
  "ID", "URL", "Title", "Notes", "Tags", "Status",
  "Priority", "Added At", "Archived At", "Result Path",
  "Result Metadata", "Source", "Locked By", "Instance"
];
// Extended columns live after N; always looked up by header name.
const EXT = [
  ["Saved By", "saved_by"], ["Saved At", "saved_at"], ["Query", "query"],
  ["Project", "project"], ["Source Type", "source_type"], ["Snippet", "snippet"],
  ["Language", "language"], ["Published At", "published_at"],
  ["Evidence Hash", "evidence_hash"], ["Evidence Files", "evidence_files"],
  ["Captured By", "captured_by"], ["Captured At", "captured_at"],
  ["Timestamp Token", "timestamp_token"], ["Processed At", "processed_at"],
  ["Canary Item ID", "canary_item_id"], ["Extra", "extra"]
];
const EXT_HEADERS = EXT.map((pair) => pair[0]);
const UPDATE_KEYS = [
  "evidence_hash", "evidence_files", "captured_by", "captured_at",
  "timestamp_token", "processed_at"
];
const SEARCHES_TAB = "Searches";
const CONFIG_TAB = "Config";
const TEXTS_TAB = "Texts";
const TEXT_CELL = 45000; // two cells per text, 90,000 chars max
const DISPATCH_GAP_MS = 5 * 60 * 1000;
const SEARCH_HEADERS = [
  "ID", "Project", "Lane", "Name", "Query", "Interval Mins", "Owner", "Enabled", "Updated At"
];
const RESERVED_TABS = [HRC_SHEET_NAME, SEARCHES_TAB, CONFIG_TAB, TEXTS_TAB].map((name) => name.toLowerCase());
const CANARY_MAPPED = [
  "canary_item_id", "url", "title_or_summary", "snippet_or_context", "notes", "tags",
  "saved_by", "saved_at", "query_bucket", "project_id", "source_type", "doc_language",
  "datetime_utc"
];

function doGet(e) {
  try {
    const params = e && e.parameter ? e.parameter : {};
    if (!authorized(params.token)) return jsonResponse(UNAUTHORIZED);
    const action = params.action || "";

    if (!action) return describeExtensionSheet(params);
    if (action === "list") return listItems(params);
    if (action === "health") return healthCheck();
    if (action === "getStatus") return getStatus();
    return jsonResponse({ ok: false, error: "Unknown action: " + action });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  }
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e && e.postData ? e.postData.contents : "{}");
  } catch (err) {
    return jsonResponse({ ok: false, error: "Request body is not valid JSON" });
  }

  const action = body.action || "";
  // Canary rows have no action: never let them reach the legacy 7-column path.
  const canary = !action && Array.isArray(body.headers) && Array.isArray(body.values);
  const fail = (message) => canary
    ? textResponse("ERROR: " + message)
    : jsonResponse({ ok: false, status: "error", error: message });

  if (!authorized(body.token)) return canary ? textResponse("Unauthorized") : jsonResponse(UNAUTHORIZED);
  if (action === "getSheets") return extensionGetSheets();
  if (action === "getHeaders") return extensionGetHeaders(body);

  const handlers = {
    setHeaders: extensionSetHeaders,
    data: extensionAddData,
    dataBatch: extensionAddDataBatch,
    add: addItem,
    updateStatus: updateStatus,
    updateMany: updateMany,
    lock: lockItems,
    unlock: unlockItems,
    clearStaleLocks: clearStaleLocks,
    list: listItems,
    health: healthCheck,
    putTab: putTab,
    listSearches: listSearches,
    upsertSearch: upsertSearch,
    getConfig: getConfig,
    getStatus: getStatus,
    putText: putText,
    getTexts: getTexts
  };
  const push = !action && body.tab && Array.isArray(body.rows);
  const handler = canary ? canaryAdd : push ? putTab : action ? handlers[action] : extensionAddLegacy;
  if (!handler) return jsonResponse({ ok: false, error: "Unknown action: " + action });

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return fail("Sheet is busy; could not acquire lock. Try again.");
  }

  try {
    return handler(body);
  } catch (err) {
    return fail(err && err.message ? err.message : String(err));
  } finally {
    lock.releaseLock();
  }
}

// ── Auth ────────────────────────────────────────────────────────────────────

const UNAUTHORIZED = { ok: false, error: "Unauthorized: missing or wrong token" };

function getToken() {
  return (PropertiesService.getScriptProperties().getProperty("TOKEN") || "").trim();
}

function authorized(sent) {
  const token = getToken();
  return !token || String(sent == null ? "" : sent).trim() === token;
}

const authMode = () => getToken() ? "token" : "open";

// ── Chrome extension compatibility ──────────────────────────────────────────

function describeExtensionSheet(params) {
  const spreadsheet = getSpreadsheet();
  const sheets = spreadsheet.getSheets().map((sheet) => sheet.getName());
  const sheet = getExtensionSheet(params.sheetName);
  const lastCol = sheet.getLastColumn();
  const headers = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    : [];
  return jsonResponse({
    ok: true,
    status: "ok",
    bridge_version: BRIDGE_VERSION,
    auth: authMode(),
    sheets,
    headers,
    hrc_sheet_name: HRC_SHEET_NAME
  });
}

function extensionGetSheets() {
  const names = getSpreadsheet().getSheets().map((sheet) => sheet.getName());
  return jsonResponse({
    ok: true,
    status: "ok",
    bridge_version: BRIDGE_VERSION,
    auth: authMode(),
    sheets: names,
    hrc_sheet_name: HRC_SHEET_NAME
  });
}

function extensionGetHeaders(body) {
  const sheet = getExtensionSheet(body.sheetName);
  const lastCol = sheet.getLastColumn();
  const headers = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    : [];
  return jsonResponse({ ok: true, status: "ok", headers });
}

function extensionSetHeaders(body) {
  const sheet = body.sheetName === HRC_SHEET_NAME
    ? getArchiveSheet()
    : getExtensionSheet(body.sheetName);
  const headers = Array.isArray(body.headers) ? body.headers.map(safe) : [];
  if (headers.length > 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    SpreadsheetApp.flush();
  }
  return jsonResponse({ ok: true, status: "ok" });
}

function extensionAddData(body) {
  const sheet = body.sheetName === HRC_SHEET_NAME
    ? getArchiveSheet()
    : getExtensionSheet(body.sheetName);
  if (sheet.getName() === HRC_SHEET_NAME) {
    const rowData = body.rowData && typeof body.rowData === "object" ? body.rowData : {};
    const capture = body.capture && typeof body.capture === "object" ? body.capture : {};
    return archiveReply(saveArchive([extensionArchiveItem(rowData, capture, body)], false)[0]);
  }

  if (body.rowData && typeof body.rowData === "object") {
    const lastCol = sheet.getLastColumn();
    const headers = lastCol > 0
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String)
      : [];
    const row = headers.map((header) => {
      const name = header.trim();
      return name && Object.prototype.hasOwnProperty.call(body.rowData, name)
        ? body.rowData[name]
        : "";
    });
    sheet.appendRow((row.length > 0 ? row : Object.values(body.rowData)).map(safe));
  } else if (Array.isArray(body.row)) {
    sheet.appendRow(body.row.map(safe));
  } else {
    return extensionAddLegacy(body);
  }
  SpreadsheetApp.flush();
  return jsonResponse({ ok: true, status: "ok" });
}

// Writes many rows in a single setValues() call instead of one appendRow()
// per item. The caller (background.js) already batches everything bound for
// the same sheet into one request, so this is what actually collapses N
// round-trips + N flushes into one of each.
function extensionAddDataBatch(body) {
  const sheet = body.sheetName === HRC_SHEET_NAME
    ? getArchiveSheet()
    : getExtensionSheet(body.sheetName);
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return jsonResponse({ ok: true, status: "ok", count: 0 });

  if (sheet.getName() === HRC_SHEET_NAME) {
    const results = saveArchive(items.map((item) => {
      const rowData = item.rowData && typeof item.rowData === "object" ? item.rowData : {};
      const capture = item.capture && typeof item.capture === "object" ? item.capture : {};
      return extensionArchiveItem(rowData, capture, item);
    }), false);
    return jsonResponse({
      ok: true,
      status: "ok",
      count: results.filter((result) => result.created).length,
      results
    });
  }

  // Regular worksheet: map each item to a row using the sheet's existing
  // headers (read once for the whole batch), same as extensionAddData does
  // per-item, then append everything in one call.
  const lastCol = sheet.getLastColumn();
  const headers = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String)
    : [];

  const rows = items.map((item) => {
    if (item.rowData && typeof item.rowData === "object") {
      if (headers.length > 0) {
        return headers.map((header) => {
          const name = header.trim();
          return name && Object.prototype.hasOwnProperty.call(item.rowData, name)
            ? item.rowData[name]
            : "";
        });
      }
      return Object.values(item.rowData);
    }
    return Array.isArray(item.row) ? item.row : [];
  }).filter((row) => row.length > 0);

  if (rows.length > 0) {
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const padded = rows.map((row) => {
      const copy = row.slice();
      while (copy.length < width) copy.push("");
      return copy.map(safe);
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, padded.length, width).setValues(padded);
    SpreadsheetApp.flush();
  }

  return jsonResponse({ ok: true, status: "ok", count: rows.length });
}

function extensionAddLegacy(body) {
  const sheet = body.sheetName === HRC_SHEET_NAME
    ? getArchiveSheet()
    : getExtensionSheet(body.sheetName);
  if (sheet.getName() === HRC_SHEET_NAME) {
    return archiveReply(saveArchive([extensionArchiveItem({}, body, body)], false)[0]);
  }
  sheet.appendRow([
    body.id || "",
    new Date(),
    body.savedBy || "",
    body.query || "",
    body.title || "",
    body.url || "",
    body.snippet || ""
  ].map(safe));
  SpreadsheetApp.flush();
  return jsonResponse({ ok: true, status: "ok" });
}

// Extension capture → Archive fields (keyed by header name). No id = server assigns one.
function extensionArchiveItem(rowData, capture, body) {
  const added = rowData["Added At"] || capture.timestamp || new Date().toISOString();
  return Object.assign(archiveFields({
    id: rowData.ID || capture.id || body.id || "",
    url: rowData.URL || capture.url || body.url || "",
    title: rowData.Title || capture.title || body.title || "",
    notes: rowData.Notes || capture.notes || "",
    tags: parseJsonArray(rowData.Tags),
    status: rowData.Status,
    priority: rowData.Priority,
    added_at: added,
    source: rowData.Source || "chrome-extension"
  }), {
    "Saved By": rowData["Saved By"] || capture.savedBy || body.savedBy || "",
    "Saved At": capture.timestamp || added,
    "Query": rowData.Query || capture.query || body.query || "",
    "Snippet": rowData.Snippet || capture.snippet || body.snippet || "",
    "Source Type": rowData["Source Type"] || capture.sourceType || capture.source || "chrome-extension",
    "Project": rowData.Project || capture.project || "",
    "Language": rowData.Language || capture.language || "",
    "Published At": rowData["Published At"] || capture.publishDate || "",
    "Extra": captureExtra(capture),
    "_text": typeof capture.text === "string" ? capture.text : ""
  });
}

// Site-specific capture fields (tweetId, viewCount, ogTitle, ...) that have no column of their own.
const CAPTURE_MAPPED = ["id", "url", "title", "notes", "timestamp", "savedBy", "query", "snippet",
  "sourceType", "source", "project", "language", "publishDate", "text"];
function captureExtra(capture) {
  const extra = {};
  Object.keys(capture).forEach((key) => {
    const value = capture[key];
    if (CAPTURE_MAPPED.indexOf(key) === -1 && value !== "" && value != null) extra[key] = value;
  });
  return Object.keys(extra).length ? JSON.stringify(extra) : "";
}

// ── Canary rows (text/plain reply: OK / Unauthorized / ERROR: msg) ──────────

function canaryAdd(body) {
  if (body.headers.length !== body.values.length) {
    throw new Error("headers and values differ in length");
  }
  const c = {};
  const extra = {};
  body.headers.forEach((header, i) => {
    const value = body.values[i];
    if (value === "" || value == null) return;
    c[header] = value;
    if (CANARY_MAPPED.indexOf(header) === -1) extra[header] = value;
  });

  const fields = Object.assign(archiveFields({
    url: c.url,
    title: c.title_or_summary,
    notes: c.notes,
    tags: String(c.tags || "").split(";").map((tag) => tag.trim()).filter(Boolean),
    status: "pending",
    source: "canary"
  }), {
    "Saved By": c.saved_by || "",
    "Saved At": c.saved_at || "",
    "Query": c.query_bucket || "",
    "Project": c.project_id || "",
    "Source Type": c.source_type ? "canary-" + c.source_type : "canary",
    "Snippet": c.snippet_or_context || "",
    "Language": c.doc_language || "",
    "Published At": c.datetime_utc || "",
    "Canary Item ID": c.canary_item_id || "",
    "Extra": Object.keys(extra).length ? JSON.stringify(extra) : ""
  });
  const result = saveArchive([fields], false)[0];
  if (!result.ok) throw new Error(result.error);
  return textResponse("OK");
}

// ── Research push (reset + append a whole tab) ──────────────────────────────

function putTab(body) {
  const tab = String(body.tab || "").trim();
  if (!tab || !Array.isArray(body.rows)) return jsonResponse({ ok: false, error: "tab and rows are required" });
  if (RESERVED_TABS.indexOf(tab.toLowerCase()) !== -1) {
    return jsonResponse({ ok: false, error: 'Tab "' + tab + '" is reserved' });
  }
  if (!getToken()) {
    return jsonResponse({ ok: false, error: "Push overwrites data and needs a TOKEN: run Pipeline → Team setup first" });
  }

  const spreadsheet = getSpreadsheet();
  const sheet = spreadsheet.getSheetByName(tab) || spreadsheet.insertSheet(tab);
  if (body.reset) sheet.clearContents();
  const rows = body.rows;
  if (rows.length) {
    const width = Math.max(...rows.map((row) => row.length));
    const values = rows.map((row) =>
      row.concat(Array(width - row.length).fill("")).map((v) => v == null ? "" : safe(v)));
    const start = sheet.getLastRow() + 1;
    sheet.getRange(start, 1, values.length, 1).setNumberFormat("@"); // ids stay text ("12e45" is not a number)
    sheet.getRange(start, 1, values.length, width).setValues(values);
  }
  return jsonResponse({ ok: true, rows: rows.length });
}

// ── Archive writes (ids, dedupe) ────────────────────────────────────────────

// Fields keyed by header name for the A–N HRC columns.
function archiveFields(o) {
  return {
    "ID": o.id || "",
    "URL": o.url || "",
    "Title": o.title || "",
    "Notes": o.notes || "",
    "Tags": JSON.stringify(o.tags || []),
    "Status": o.status || "pending",
    "Priority": o.priority || 0,
    "Added At": o.added_at || new Date().toISOString(),
    "Archived At": o.archived_at || "",
    "Result Path": o.result_path || "",
    "Result Metadata": o.result_metadata ? JSON.stringify(o.result_metadata) : "",
    "Source": o.source || "sheet",
    "Locked By": "",
    "Instance": o.archived_by_instance || ""
  };
}

// strict=true is HRC `add`: id-only dedupe, id/url conflict is an error.
// strict=false (extension, canary): URL dedupe merges "Saved By"; id collisions get a fresh id.
function saveArchive(list, strict) {
  const sheet = getArchiveSheet();
  ensureArchiveHeaders(sheet);
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(String);
  const c = colMap(headers);
  const existing = data.length;
  const byId = {};
  const byUrl = {};
  for (let i = 1; i < data.length; i++) {
    byId[String(data[i][0])] = i;
    const url = String(data[i][1] || "");
    if (url && byUrl[url] === undefined) byUrl[url] = i;
  }

  const results = [];
  const texts = {};
  for (const fields of list) {
    const url = String(fields.URL || "").trim();
    if (!url) {
      results.push({ ok: false, error: "URL is required" });
      continue;
    }
    let id = fields.ID ? String(fields.ID) : "";
    let reassignedFrom = "";
    if (id && byId[id] !== undefined) {
      if (String(data[byId[id]][1] || "") === url) {
        results.push({ id, ok: true, created: false });
        if (fields._text) texts[id] = fields._text;
        continue;
      }
      if (strict) {
        results.push({ id, ok: false, error: "Item ID already exists with a different URL" });
        continue;
      }
    }
    if (!strict && byUrl[url] !== undefined) {
      const i = byUrl[url];
      const saver = String(fields["Saved By"] || "").trim();
      const names = String(data[i][c["Saved By"]] || "").split(";").map((s) => s.trim()).filter(Boolean);
      if (saver && names.indexOf(saver) === -1) {
        data[i][c["Saved By"]] = names.concat(saver).join("; ");
        if (i < existing) sheet.getRange(i + 1, c["Saved By"] + 1).setValue(safe(data[i][c["Saved By"]]));
      }
      results.push({ id: String(data[i][0]), ok: true, created: false });
      if (fields._text) texts[String(data[i][0])] = fields._text;
      continue;
    }
    if (id && byId[id] !== undefined) reassignedFrom = id;
    if (!id || reassignedFrom) {
      do { id = nextId(); } while (byId[id] !== undefined);
    }

    fields.ID = id;
    fields.URL = url;
    data.push(headers.map((header) => fields[header] === undefined ? "" : safe(fields[header])));
    byId[id] = byUrl[url] = data.length - 1;
    if (fields._text) texts[id] = fields._text;
    results.push(reassignedFrom
      ? { id, ok: true, created: true, reassigned_from: reassignedFrom }
      : { id, ok: true, created: true });
  }

  const added = data.slice(existing);
  if (added.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, added.length, headers.length).setValues(added);
    SpreadsheetApp.flush();
  }
  saveTexts(texts, false);
  if (added.length > 0) dispatchRun();
  return results;
}

// ── Page text (Texts tab) and run trigger ───────────────────────────────────

// ids: {id: text}. First text wins unless replace. One read of the ID column.
function saveTexts(texts, replace) {
  const ids = Object.keys(texts).filter((id) => texts[id]);
  if (ids.length === 0) return;
  const sheet = ensureTab(TEXTS_TAB, ["ID", "Text 1", "Text 2", "Saved At"]);
  const col = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues() : [];
  const at = {};
  col.forEach((row, i) => { at[String(row[0])] = i + 2; });
  const now = new Date().toISOString();
  ids.forEach((id) => {
    const text = String(texts[id]).slice(0, 2 * TEXT_CELL);
    const row = [id, safe(text.slice(0, TEXT_CELL)), safe(text.slice(TEXT_CELL)), now];
    if (at[id] === undefined) {
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, 1).setNumberFormat("@");
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, 4).setValues([row]);
    } else if (replace) {
      sheet.getRange(at[id], 1, 1, 4).setValues([row]);
    }
  });
}

function putText(body) {
  if (!body.id || typeof body.text !== "string" || !body.text) {
    return jsonResponse({ ok: false, error: "id and text are required" });
  }
  saveTexts({ [String(body.id)]: body.text }, body.replace === true);
  return jsonResponse({ ok: true });
}

function getTexts(body) {
  const want = {};
  (Array.isArray(body.ids) ? body.ids : []).slice(0, 50).forEach((id) => { want[String(id)] = true; });
  const sheet = getSpreadsheet().getSheetByName(TEXTS_TAB);
  const rows = sheet && sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues() : [];
  const texts = rows.filter((row) => want[String(row[0])])
    .map((row) => ({ id: String(row[0]), text: String(row[1] || "") + String(row[2] || "") }));
  return jsonResponse({ ok: true, texts });
}

function textIds() {
  const sheet = getSpreadsheet().getSheetByName(TEXTS_TAB);
  const ids = {};
  if (sheet && sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().forEach((row) => { ids[String(row[0])] = true; });
  }
  return ids;
}

function getStatus() {
  const sheet = getSpreadsheet().getSheetByName("pipeline_status");
  const status = {};
  if (sheet && sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach((row) => {
      if (row[0] !== "") status[String(row[0])] = jsonCellValue(row[1]);
    });
  }
  return jsonResponse({ ok: true, status });
}

// Asks GitHub to run the pipeline. Never throws; at most one fetch per 5 minutes.
function dispatchRun() {
  try {
    const props = PropertiesService.getScriptProperties();
    const repo = props.getProperty("GITHUB_REPO");
    const token = props.getProperty("GITHUB_TOKEN");
    if (!repo || !token) return;
    const now = Date.now();
    if (now - (Number(props.getProperty("LAST_DISPATCH")) || 0) < DISPATCH_GAP_MS) return;
    props.setProperty("LAST_DISPATCH", String(now));
    UrlFetchApp.fetch("https://api.github.com/repos/" + repo + "/dispatches", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
      payload: JSON.stringify({ event_type: "saved" }),
      muteHttpExceptions: true
    });
  } catch (err) {}
}

const archiveReply = (result) => jsonResponse(result.ok
  ? Object.assign({ status: "ok" }, result)
  : { ok: false, error: result.error });

function nextSeq(prop) {
  const props = PropertiesService.getScriptProperties();
  const n = (parseInt(props.getProperty(prop), 10) || 0) + 1;
  props.setProperty(prop, String(n));
  return n;
}

function nextId() {
  const prefix = PropertiesService.getScriptProperties().getProperty("ID_PREFIX") || "ITEM";
  return prefix + "-" + new Date().getFullYear() + "-" + String(nextSeq("ID_SEQ")).padStart(5, "0");
}

// ── HRC Archiver API ────────────────────────────────────────────────────────

function healthCheck() {
  const sheet = getArchiveSheet();
  ensureArchiveHeaders(sheet);
  return jsonResponse(Object.assign({
    ok: true,
    schema_version: SCHEMA_VERSION,
    bridge_version: BRIDGE_VERSION,
    auth: authMode(),
    extension_compatible: true,
    item_count: Math.max(0, sheet.getLastRow() - 1)
  }, spreadsheetIdentity()));
}

function listItems(params) {
  const sheet = getArchiveSheet();
  ensureArchiveHeaders(sheet);
  const data = sheet.getDataRange().getValues();
  const c = colMap(data[0]);
  const offset = Math.max(0, parseInt(params.offset || "0", 10) || 0);
  const limit = Math.max(1, parseInt(params.limit || "100", 10) || 100);
  const status = params.status || null;
  const includeLocked = String(params.include_locked) === "true";
  const withText = textIds();
  let items = data.slice(1).map((row) => rowToObject(row, c)).filter((row) => row.id);
  items.forEach((item) => { item.has_text = withText[item.id] === true; });
  if (status && status !== "all") {
    items = items.filter((item) => (item.status || "pending") === status);
  }
  if (!includeLocked) items = items.filter((item) => !item.locked_by);
  return jsonResponse({
    ok: true,
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
    spreadsheet: spreadsheetIdentity()
  });
}

function addItem(body) {
  return archiveReply(saveArchive([archiveFields(body)], true)[0]);
}

function updateStatus(body) {
  return applyUpdates([body]) > 0
    ? jsonResponse({ ok: true })
    : jsonResponse({ ok: false, error: "Item not found" });
}

function updateMany(body) {
  return jsonResponse({ ok: true, count: applyUpdates(body.updates || []) });
}

// One read, one setValues for the whole data range.
function applyUpdates(updates) {
  const sheet = getArchiveSheet();
  ensureArchiveHeaders(sheet);
  const range = sheet.getDataRange();
  const rows = range.getValues();
  const c = colMap(rows[0]);
  const byId = {};
  updates.forEach((update) => { byId[String(update.id)] = update; });
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    const update = byId[String(rows[i][0])];
    if (!update) continue;
    const row = rows[i];
    if (update.status !== undefined) row[5] = safe(update.status);
    if (update.result_path !== undefined) row[9] = safe(update.result_path || "");
    if (update.result_metadata !== undefined) {
      row[10] = update.result_metadata ? JSON.stringify(update.result_metadata) : "";
    }
    if (update.archived_by_instance !== undefined) row[13] = safe(update.archived_by_instance || "");

    const fields = Object.assign({}, update.fields);
    EXT.forEach((pair) => {
      if (UPDATE_KEYS.indexOf(pair[1]) !== -1 && update[pair[1]] !== undefined) fields[pair[0]] = update[pair[1]];
    });
    Object.keys(fields).forEach((header) => {
      if (header === "ID" || header === "URL" || c[header] === undefined) return;
      const value = fields[header];
      row[c[header]] = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : safe(value);
    });

    if (isCompletedStatus(update.status)) {
      row[8] = update.archived_at || new Date().toISOString();
      row[12] = "";
    }
    count++;
  }
  if (count > 0) range.setValues(rows);
  return count;
}

function lockItems(body) {
  const sheet = getArchiveSheet();
  ensureArchiveHeaders(sheet);
  const ids = (body.ids || []).map(String);
  const lockedBy = body.locked_by || "";
  if (!lockedBy) return jsonResponse({ ok: false, error: "locked_by is required" });
  const rows = sheet.getDataRange().getValues();
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    if (ids.indexOf(String(rows[i][0])) !== -1 && !rows[i][12]) {
      sheet.getRange(i + 1, 13).setValue(lockedBy);
      count++;
    }
  }
  return jsonResponse({ ok: true, count });
}

function unlockItems(body) {
  const sheet = getArchiveSheet();
  ensureArchiveHeaders(sheet);
  const ids = (body.ids || []).map(String);
  const lockedBy = body.locked_by || "";
  const rows = sheet.getDataRange().getValues();
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    const idMatches = ids.length === 0 || ids.indexOf(String(rows[i][0])) !== -1;
    const lockMatches = !lockedBy || rows[i][12] === lockedBy;
    if (idMatches && lockMatches && rows[i][12]) {
      sheet.getRange(i + 1, 13).setValue("");
      count++;
    }
  }
  return jsonResponse({ ok: true, count });
}

function clearStaleLocks(body) {
  const sheet = getArchiveSheet();
  ensureArchiveHeaders(sheet);
  const activeLocks = body.active_locks || [];
  const rows = sheet.getDataRange().getValues();
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    const lockedBy = rows[i][12];
    if (lockedBy && activeLocks.indexOf(lockedBy) === -1) {
      sheet.getRange(i + 1, 13).setValue("");
      count++;
    }
  }
  return jsonResponse({ ok: true, count });
}

// ── Shared searches + config ────────────────────────────────────────────────

function listSearches(body) {
  const rows = ensureTab(SEARCHES_TAB, SEARCH_HEADERS).getDataRange().getValues().slice(1);
  const searches = rows.filter((row) => row[0]).map((row) => ({
    id: String(row[0]),
    project: row[1],
    lane: row[2],
    name: row[3],
    query: parseJsonValue(row[4]),
    interval_mins: row[5],
    owner: row[6],
    enabled: row[7] === true || String(row[7]).toLowerCase() === "true",
    updated_at: jsonCellValue(row[8])
  })).filter((s) => (!body.project || s.project === body.project) && (body.include_disabled || s.enabled));
  return jsonResponse({ ok: true, searches });
}

function upsertSearch(body) {
  const s = body.search && typeof body.search === "object" ? body.search : {};
  const sheet = ensureTab(SEARCHES_TAB, SEARCH_HEADERS);
  const rows = sheet.getDataRange().getValues();
  const at = s.id ? rows.findIndex((row, i) => i > 0 && String(row[0]) === String(s.id)) : -1;
  const created = at < 0;
  const id = s.id || "S-" + String(nextSeq("SEARCH_SEQ")).padStart(4, "0");
  const row = created ? SEARCH_HEADERS.map(() => "") : rows[at].slice();
  const set = {
    "ID": id,
    "Project": s.project,
    "Lane": s.lane,
    "Name": s.name,
    "Query": s.query === undefined ? undefined : JSON.stringify(s.query),
    "Interval Mins": s.interval_mins,
    "Owner": s.owner,
    "Enabled": s.enabled === undefined ? (created ? true : undefined) : s.enabled !== false && s.enabled !== "false",
    "Updated At": new Date().toISOString()
  };
  SEARCH_HEADERS.forEach((header, i) => { if (set[header] !== undefined) row[i] = safe(set[header]); });
  sheet.getRange(created ? sheet.getLastRow() + 1 : at + 1, 1, 1, row.length).setValues([row]);
  SpreadsheetApp.flush();
  return jsonResponse({ ok: true, id, created });
}

function getConfig() {
  const config = {};
  ensureTab(CONFIG_TAB, ["Key", "Value"]).getDataRange().getValues().slice(1).forEach((row) => {
    if (row[0] !== "") config[String(row[0])] = row[1];
  });
  return jsonResponse({ ok: true, config });
}

// ── Shared sheet helpers ─────────────────────────────────────────────────────

function getSpreadsheet() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getExtensionSheet(name) {
  const spreadsheet = getSpreadsheet();
  if (name) {
    const named = spreadsheet.getSheetByName(name);
    if (named) return named;
  }
  return spreadsheet.getSheets()[0];
}

function getArchiveSheet() {
  const spreadsheet = getSpreadsheet();
  return spreadsheet.getSheetByName(HRC_SHEET_NAME) || spreadsheet.insertSheet(HRC_SHEET_NAME);
}

function ensureTab(name, headers) {
  const spreadsheet = getSpreadsheet();
  const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
  }
  return sheet;
}

function spreadsheetIdentity() {
  const spreadsheet = getSpreadsheet();
  return {
    spreadsheet_id: spreadsheet.getId(),
    spreadsheet_name: spreadsheet.getName(),
    sheet_name: HRC_SHEET_NAME
  };
}

function ensureArchiveHeaders(sheet) {
  const lastCol = sheet.getLastColumn();
  const checkedColumns = Math.min(lastCol, HRC_HEADERS.length);
  const current = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  for (let i = 0; i < checkedColumns; i++) {
    if (current[i] !== HRC_HEADERS[i]) {
      throw new Error(
        'The "' + HRC_SHEET_NAME + '" worksheet does not use the HRC column layout. ' +
        'In Save to Sheets, select "Use HRC Archiver template" and apply it to this worksheet.'
      );
    }
  }
  const missing = HRC_HEADERS.concat(EXT_HEADERS).filter((header) => current.indexOf(header) === -1);
  if (missing.length > 0) {
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]).setFontWeight("bold");
  }
}

const colMap = (headers) => {
  const map = {};
  headers.forEach((header, i) => { if (map[String(header)] === undefined) map[String(header)] = i; });
  return map;
};

function rowToObject(row, c) {
  const item = {
    id: String(row[0] || ""),
    url: String(row[1] || ""),
    title: row[2] || "",
    notes: row[3] || "",
    tags: parseJsonArray(row[4]),
    status: row[5] || "pending",
    priority: Number(row[6] || 0),
    added_at: jsonCellValue(row[7]),
    archived_at: jsonCellValue(row[8]),
    result_path: row[9] || "",
    result_metadata: parseJsonValue(row[10]),
    source: row[11] || "",
    locked_by: row[12] || "",
    archived_by_instance: row[13] || ""
  };
  EXT.forEach((pair) => {
    const value = row[c[pair[0]]];
    item[pair[1]] = jsonCellValue(value === undefined ? "" : value);
  });
  item.evidence_files = parseJsonArray(item.evidence_files);
  item.extra = parseJsonValue(item.extra);
  return item;
}

// Formula-injection guard: = + @ and "-" followed by a non-digit get a leading apostrophe.
function safe(value) {
  return typeof value === "string" && /^([=+@]|-[^\d])/.test(value) ? "'" + value : value;
}

function jsonCellValue(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return String(value).split(",").map((item) => item.trim()).filter(Boolean);
  }
}

function parseJsonValue(value) {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return { raw: value };
  }
}

function isCompletedStatus(status) {
  return status === "done" || status === "needs_review" || status === "failed";
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function textResponse(text) {
  return ContentService
    .createTextOutput(text)
    .setMimeType(ContentService.MimeType.TEXT);
}

// ── Menu: team setup ─────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Pipeline")
    .addItem("Team setup", "teamSetup")
    .addItem("Show join code", "showJoinCode")
    .addItem("Connect GitHub", "connectGithub")
    .addToUi();

  const spreadsheet = getSpreadsheet();
  const firstSheet = spreadsheet.getSheets()[0];
  if (firstSheet.getName() === HRC_SHEET_NAME) {
    ensureArchiveHeaders(firstSheet);
  } else if (firstSheet.getLastRow() === 0) {
    firstSheet.appendRow(["ID", "Timestamp", "Saved By", "Query", "Title", "URL", "Snippet"]);
    firstSheet.getRange(1, 1, 1, 7).setFontWeight("bold");
  }
}

function teamSetup() {
  const props = PropertiesService.getScriptProperties();
  if (!getToken()) {
    props.setProperty("TOKEN", Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, ""));
  }
  showJoinCode();
}

// The join code carries the web app address. Apps Script cannot be trusted to report it (ScriptApp.getService()
// .getUrl() can return an address that answers 404), so the person who deployed pastes it once and it is stored.
function showJoinCode() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const token = getToken();
  if (!token) return ui.alert("No token yet", "Run Pipeline → Team setup first.", ui.ButtonSet.OK);
  const stored = props.getProperty("WEBAPP_URL") || "";
  const answer = ui.prompt(
    "Web app URL",
    "Paste the Web app URL from Deploy → Manage deployments (it ends in /exec)." +
    (stored ? "\n\nLeave blank to keep: " + stored : "\n\nNot deployed yet? Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone)."),
    ui.ButtonSet.OK_CANCEL
  );
  if (answer.getSelectedButton() !== ui.Button.OK) return;
  const url = answer.getResponseText().trim() || stored;
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
    return ui.alert("That is not a web app URL", "It should look like https://script.google.com/macros/s/…/exec. Copy it from Deploy → Manage deployments.", ui.ButtonSet.OK);
  }
  props.setProperty("WEBAPP_URL", url);
  const code = Utilities.base64EncodeWebSafe(JSON.stringify({ url, token }));
  ui.alert("Join code", "Share this with your team (the web app must stay deployed):\n\n" + code, ui.ButtonSet.OK);
}

// Optional: lets a save start a pipeline run. The token needs to create repository_dispatch events.
function connectGithub() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const repo = ui.prompt("Connect GitHub", "Repository (owner/name):", ui.ButtonSet.OK_CANCEL);
  if (repo.getSelectedButton() !== ui.Button.OK || !repo.getResponseText().trim()) return;
  const token = ui.prompt("Connect GitHub", "Token with Contents: read and write on that repo (blank keeps the stored one):", ui.ButtonSet.OK_CANCEL);
  if (token.getSelectedButton() !== ui.Button.OK) return;
  props.setProperty("GITHUB_REPO", repo.getResponseText().trim());
  if (token.getResponseText().trim()) props.setProperty("GITHUB_TOKEN", token.getResponseText().trim());
}
