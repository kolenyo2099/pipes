// In-memory Apps Script globals (SpreadsheetApp, PropertiesService, ...) running bridge/Code.gs in node:vm.
// Used by the bridge tests and by smoke/fake-bridge.js.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BRIDGE_PATH = path.resolve(__dirname, '..', 'bridge', 'Code.gs');
const HRC = ['ID', 'URL', 'Title', 'Notes', 'Tags', 'Status', 'Priority', 'Added At',
  'Archived At', 'Result Path', 'Result Metadata', 'Source', 'Locked By', 'Instance'];
const EXT = ['Saved By', 'Saved At', 'Query', 'Project', 'Source Type', 'Snippet', 'Language',
  'Published At', 'Evidence Hash', 'Evidence Files', 'Captured By', 'Captured At',
  'Timestamp Token', 'Processed At', 'Canary Item ID', 'Extra'];

class Range {
  constructor(sheet, row, column, rowCount = 1, columnCount = 1) {
    Object.assign(this, { sheet, row, column, rowCount, columnCount });
  }
  getValues() {
    return Array.from({ length: this.rowCount }, (_, r) =>
      Array.from({ length: this.columnCount }, (_, c) =>
        this.sheet.rows[this.row - 1 + r]?.[this.column - 1 + c] ?? ''));
  }
  setValues(values) {
    values.forEach((valuesRow, r) => {
      const target = this.row - 1 + r;
      if (!this.sheet.rows[target]) this.sheet.rows[target] = [];
      valuesRow.forEach((value, c) => { this.sheet.rows[target][this.column - 1 + c] = value; });
    });
    return this;
  }
  setValue(value) { return this.setValues([[value]]); }
  setFontWeight() { return this; }
  setNumberFormat() { return this; }
}

class Sheet {
  constructor(name, rows = []) { this.name = name; this.rows = rows.map((row) => [...row]); }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((max, row) => Math.max(max, row.length), 0); }
  getRange(row, column, rowCount = 1, columnCount = 1) { return new Range(this, row, column, rowCount, columnCount); }
  getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  appendRow(row) { this.rows.push([...row]); }
  clearContents() { this.rows = []; }
}

class Spreadsheet {
  constructor(sheets = [new Sheet('Sheet1')]) { this.sheets = sheets; }
  getSheets() { return this.sheets; }
  getSheetByName(name) { return this.sheets.find((sheet) => sheet.getName() === name) || null; }
  insertSheet(name) { const sheet = new Sheet(name); this.sheets.push(sheet); return sheet; }
  getId() { return 'spreadsheet-123'; }
  getName() { return 'Team sheet'; }
}

function load({ sheets, props = {}, url = 'https://script.test/exec' } = {}) {
  const spreadsheet = new Spreadsheet(sheets);
  const properties = { ...props };
  let uuid = 0;
  const alerts = [];
  const context = {
    console, Date, JSON, Math, Number, Object, String, Array,
    ContentService: {
      MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } })
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (key in properties ? properties[key] : null),
        setProperty: (key, value) => { properties[key] = value; }
      })
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      flush() {},
      getUi: () => ({
        ButtonSet: { OK: 'OK' },
        createMenu: () => ({ addItem() { return this; }, addToUi() {} }),
        alert: (...args) => alerts.push(args)
      })
    },
    Utilities: {
      getUuid: () => `0000-${String(++uuid).padStart(4, '0')}-aaaa`,
      base64EncodeWebSafe: (text) => Buffer.from(text).toString('base64url')
    },
    ScriptApp: { getService: () => ({ getUrl: () => url }) }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(BRIDGE_PATH, 'utf8'), context);
  const get = (parameter = {}) => JSON.parse(context.doGet({ parameter }).text);
  const post = (body) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  const postText = (body) => context.doPost({ postData: { contents: JSON.stringify(body) } }).text;
  const archive = () => spreadsheet.getSheetByName('Archive');
  const col = (name) => archive().rows[0].indexOf(name);
  const cell = (row, name) => archive().rows[row][col(name)];
  return { context, spreadsheet, properties, alerts, get, post, postText, archive, col, cell };
}

module.exports = { load, Sheet, HRC, EXT };
