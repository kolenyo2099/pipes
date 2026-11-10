const assert = require('node:assert/strict');
const test = require('node:test');

const { load, Sheet, HRC, EXT } = require('./fake-apps-script');

const archiveWith = (...rows) => [new Sheet('Archive', [HRC, ...rows])];
const item = (id, url, extra = {}) => ({ action: 'add', id, url, ...extra });

test('token is required on POST and GET when TOKEN is set (trimmed compare)', () => {
  const b = load({ props: { TOKEN: ' secret ' } });
  const denied = { ok: false, error: 'Unauthorized: missing or wrong token' };
  assert.deepEqual(b.post({ action: 'getSheets' }), denied);
  assert.deepEqual(b.post({ action: 'getSheets', token: 'nope' }), denied);
  assert.deepEqual(b.get({}), denied);
  assert.deepEqual(b.get({ action: 'health', token: 'x' }), denied);
  assert.equal(b.post({ action: 'getSheets', token: ' secret' }).ok, true);
  assert.equal(b.get({ token: 'secret' }).auth, 'token');
  assert.equal(b.post({ action: 'health', token: 'secret' }).auth, 'token');
});

test('without TOKEN the bridge is open and says so', () => {
  const b = load();
  assert.equal(b.get({}).auth, 'open');
  assert.equal(b.get({}).bridge_version, 7);
  assert.equal(b.get({ action: 'health' }).auth, 'open');
  assert.equal(b.post({ action: 'getSheets' }).ok, true);
});

test('HRC add: same id + same url is unchanged, same id + different url is ok:false', () => {
  const b = load();
  const created = b.post(item('A-1', 'https://x.test/1', { title: 'One', tags: ['t'] }));
  assert.equal(created.created, true);
  assert.equal(b.post(item('A-1', 'https://x.test/1')).created, false);
  const conflict = b.post(item('A-1', 'https://x.test/other'));
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /different URL/);
  // add keeps id-only semantics: same url under a new id is a second row
  assert.equal(b.post(item('A-2', 'https://x.test/1')).created, true);
  assert.equal(b.archive().rows.length, 3);
  assert.equal(b.cell(1, 'Source'), 'sheet');
  assert.equal(b.cell(1, 'Tags'), '["t"]');
});

test('add without id gets a server id, incrementing, with ID_PREFIX', () => {
  const b = load({ props: { ID_PREFIX: 'HRC' } });
  const year = new Date().getFullYear();
  assert.equal(b.post({ action: 'add', url: 'https://x.test/a' }).id, `HRC-${year}-00001`);
  assert.equal(b.post({ action: 'add', url: 'https://x.test/b' }).id, `HRC-${year}-00002`);
  assert.equal(b.properties.ID_SEQ, '2');
  const plain = load();
  assert.match(plain.post({ action: 'add', url: 'https://x.test/a' }).id, /^ITEM-\d{4}-00001$/);
});

test('extension dataBatch with a colliding id reassigns; same id+url is unchanged', () => {
  const b = load({ sheets: archiveWith(['E-1', 'https://x.test/old']) });
  const saved = b.post({
    action: 'dataBatch', sheetName: 'Archive',
    items: [
      { capture: { id: 'E-1', url: 'https://x.test/old' } },
      { capture: { id: 'E-1', url: 'https://x.test/new', title: 'New' } },
      { capture: { url: 'https://x.test/third' } },
      { capture: { title: 'no url' } }
    ]
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.count, 2);
  assert.deepEqual(saved.results[0], { id: 'E-1', ok: true, created: false });
  assert.equal(saved.results[1].created, true);
  assert.equal(saved.results[1].reassigned_from, 'E-1');
  assert.match(saved.results[1].id, /^ITEM-\d{4}-00001$/);
  assert.match(saved.results[2].id, /^ITEM-\d{4}-00002$/);
  assert.equal(saved.results[3].ok, false);
  assert.equal(b.archive().rows.length, 4);
});

test('URL dedupe on extension paths merges Saved By without duplicates', () => {
  const b = load();
  const capture = (savedBy) => ({ action: 'data', sheetName: 'Archive', capture: { url: 'https://x.test/u', savedBy, query: 'q', snippet: 's', timestamp: '2026-01-02T03:04:05.000Z' } });
  const first = b.post(capture('Ana'));
  assert.equal(first.created, true);
  const second = b.post(capture('Ben'));
  assert.deepEqual([second.ok, second.created, second.id], [true, false, first.id]);
  b.post(capture('Ana'));
  assert.equal(b.archive().rows.length, 2);
  assert.equal(b.cell(1, 'Saved By'), 'Ana; Ben');
  assert.equal(b.cell(1, 'Query'), 'q');
  assert.equal(b.cell(1, 'Snippet'), 's');
  assert.equal(b.cell(1, 'Saved At'), '2026-01-02T03:04:05.000Z');
  assert.equal(b.cell(1, 'Source Type'), 'chrome-extension');
  assert.equal(b.cell(1, 'Notes'), '');
  assert.equal(b.cell(1, 'Source'), 'chrome-extension');
  assert.equal(b.cell(1, 'Extra'), '');
});

test('extension capture maps language/date/project and keeps site fields in Extra', () => {
  const b = load();
  b.post({ action: 'data', sheetName: 'Archive', capture: {
    url: 'https://x.com/a/status/1', sourceType: 'x', project: 'P1', language: 'en',
    publishDate: '2026-02-03', tweetId: '1', authorUsername: 'a', snippet: ''
  } });
  assert.equal(b.cell(1, 'Source Type'), 'x');
  assert.equal(b.cell(1, 'Project'), 'P1');
  assert.equal(b.cell(1, 'Language'), 'en');
  assert.equal(b.cell(1, 'Published At'), '2026-02-03');
  assert.deepEqual(JSON.parse(b.cell(1, 'Extra')), { tweetId: '1', authorUsername: 'a' });
});

test('legacy no-action extension post appends the 7 column row off Archive and goes to Archive when asked', () => {
  const b = load({ sheets: [new Sheet('Sheet1')] });
  assert.equal(b.post({ id: 'L-1', savedBy: 'Ana', query: 'q', title: 'T', url: 'https://x.test/l', snippet: 's' }).ok, true);
  const row = b.spreadsheet.getSheets()[0].rows[0];
  assert.deepEqual([row[0], row[2], row[5]], ['L-1', 'Ana', 'https://x.test/l']);
  const toArchive = b.post({ sheetName: 'Archive', url: 'https://x.test/l', savedBy: 'Ana' });
  assert.equal(toArchive.created, true);
});

test('canary payload becomes one Archive row and replies with text', () => {
  const b = load({ props: { TOKEN: 'tk' } });
  const headers = ['canary_item_id', 'project_id', 'saved_at', 'saved_by', 'source_type', 'query_bucket',
    'datetime_utc', 'status', 'tags', 'notes', 'title_or_summary', 'url', 'snippet_or_context',
    'doc_language', 'goldstein_scale', 'avg_tone', 'empty_field'];
  const values = ['c-9', 'P1', '2026-02-03T00:00:00Z', 'ana', 'rss', 'bucket-a', '20260203T000000Z',
    'new', 'a; b', 'note', 'A title', 'https://x.test/canary', 'ctx', 'es', -2.5, '-1', ''];
  assert.equal(b.postText({ headers, values, token: 'tk' }), 'OK');
  assert.equal(b.archive().rows.length, 2);
  const get = (name) => b.cell(1, name);
  assert.equal(get('URL'), 'https://x.test/canary');
  assert.equal(get('Title'), 'A title');
  assert.equal(get('Snippet'), 'ctx');
  assert.equal(get('Notes'), 'note');
  assert.equal(get('Tags'), '["a","b"]');
  assert.equal(get('Saved By'), 'ana');
  assert.equal(get('Saved At'), '2026-02-03T00:00:00Z');
  assert.equal(get('Query'), 'bucket-a');
  assert.equal(get('Project'), 'P1');
  assert.equal(get('Source Type'), 'canary-rss');
  assert.equal(get('Language'), 'es');
  assert.equal(get('Published At'), '20260203T000000Z');
  assert.equal(get('Canary Item ID'), 'c-9');
  assert.equal(get('Source'), 'canary');
  assert.equal(get('Status'), 'pending');
  assert.match(get('ID'), /^ITEM-\d{4}-00001$/);
  assert.deepEqual(JSON.parse(get('Extra')), { status: 'new', goldstein_scale: -2.5, avg_tone: '-1' });
  // same URL again: no new row, saver merged, still OK
  headers.push('x'); values.push('v');
  assert.equal(b.postText({ headers, values: values.map((v) => v), token: 'tk' }).startsWith('OK'), true);
  assert.equal(b.archive().rows.length, 2);

  assert.equal(b.postText({ headers: ['url'], values: ['https://x.test/z'], token: 'bad' }), 'Unauthorized');
  assert.equal(b.postText({ headers: ['url'], values: [] , token: 'tk' }).startsWith('ERROR: '), true);
  assert.equal(b.postText({ headers: ['title_or_summary'], values: ['t'], token: 'tk' }), 'ERROR: URL is required');
  assert.equal(b.spreadsheet.getSheets()[0].rows.length, 0); // never the legacy 7-column path
});

test('push legacy payload resets, appends, guards formulas; refuses reserved tabs and open bridges', () => {
  const b = load({ props: { TOKEN: 'tk' } });
  const rows = [['id', 'text'], ['1', '=HYPERLINK("x")'], ['2']];
  assert.deepEqual(b.post({ token: 'tk', tab: 'Canary', rows, reset: true }), { ok: true, rows: 3 });
  assert.deepEqual(b.spreadsheet.getSheetByName('Canary').rows, [['id', 'text'], ['1', "'=HYPERLINK(\"x\")"], ['2', '']]);
  b.post({ token: 'tk', tab: 'Canary', rows: [['3', 'c']], reset: false });
  assert.equal(b.spreadsheet.getSheetByName('Canary').rows.length, 4);
  b.post({ action: 'putTab', token: 'tk', tab: 'Canary', rows: [['only', 'row']], reset: true });
  assert.deepEqual(b.spreadsheet.getSheetByName('Canary').rows, [['only', 'row']]);
  for (const tab of ['Archive', 'searches', 'CONFIG']) {
    assert.equal(b.post({ token: 'tk', tab, rows: [['x']], reset: true }).ok, false);
  }
  assert.equal(b.post({ token: 'wrong', tab: 'Canary', rows }).ok, false);

  const open = load();
  const refused = open.post({ tab: 'Canary', rows, reset: true });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Team setup/);
  assert.equal(open.spreadsheet.getSheetByName('Canary'), null);
});

test('formula guard applies to every write path', () => {
  const b = load();
  b.post(item('F-1', 'https://x.test/f', { title: '=SUM(1)', notes: '+cmd', source: '@x' }));
  b.post(item('F-2', 'https://x.test/g', { title: '-5 degrees', notes: '- dash' }));
  assert.equal(b.cell(1, 'Title'), "'=SUM(1)");
  assert.equal(b.cell(1, 'Notes'), "'+cmd");
  assert.equal(b.cell(1, 'Source'), "'@x");
  assert.equal(b.cell(2, 'Title'), '-5 degrees');
  assert.equal(b.cell(2, 'Notes'), "'- dash");
  b.post({ action: 'updateMany', updates: [{ id: 'F-1', fields: { Notes: '=1+1' }, result_path: '@p' }] });
  assert.equal(b.cell(1, 'Notes'), "'=1+1");
  assert.equal(b.cell(1, 'Result Path'), "'@p");
  const plain = b.spreadsheet.getSheets()[0];
  b.post({ action: 'setHeaders', sheetName: plain.getName(), headers: ['a', 'b'] });
  b.post({ action: 'data', sheetName: plain.getName(), rowData: { a: '=1', b: '+2' } });
  assert.deepEqual(plain.rows[1], ["'=1", "'+2"]);
});

test('updateMany: evidence shorthands, fields map, completed status', () => {
  const b = load({ sheets: archiveWith(['U-1', 'https://x.test/1', 'T', '', '[]', 'pending', 0, '', '', '', '', 'x', 'worker-1', ''], ['U-2', 'https://x.test/2']) });
  const res = b.post({
    action: 'updateMany',
    updates: [
      {
        id: 'U-1', status: 'done', archived_at: '2026-03-01T00:00:00Z', result_path: '/p',
        evidence_hash: 'abc', evidence_files: ['a.png', 'b.pdf'], captured_by: 'ana',
        captured_at: '2026-03-01T01:00:00Z', timestamp_token: 'tsa', processed_at: '2026-03-01T02:00:00Z',
        fields: { Language: 'es', ID: 'HACK', URL: 'https://evil', 'No Such Column': 'x', Extra: { k: 1 } }
      },
      { id: 'U-2', status: 'skipped' },
      { id: 'missing', status: 'done' }
    ]
  });
  assert.equal(res.count, 2);
  assert.equal(b.cell(1, 'ID'), 'U-1');
  assert.equal(b.cell(1, 'URL'), 'https://x.test/1');
  assert.equal(b.cell(1, 'Status'), 'done');
  assert.equal(b.cell(1, 'Archived At'), '2026-03-01T00:00:00Z');
  assert.equal(b.cell(1, 'Locked By'), '');
  assert.equal(b.cell(1, 'Evidence Hash'), 'abc');
  assert.equal(b.cell(1, 'Evidence Files'), '["a.png","b.pdf"]');
  assert.equal(b.cell(1, 'Captured By'), 'ana');
  assert.equal(b.cell(1, 'Timestamp Token'), 'tsa');
  assert.equal(b.cell(1, 'Language'), 'es');
  assert.equal(b.cell(1, 'Extra'), '{"k":1}');
  assert.equal(b.archive().rows[0].includes('No Such Column'), false);
  assert.equal(b.cell(2, 'Status'), 'skipped');
  assert.equal(b.cell(2, 'Archived At'), '');

  const one = b.post({ action: 'updateStatus', id: 'U-2', status: 'failed', fields: { Project: 'P' } });
  assert.equal(one.ok, true);
  assert.equal(b.cell(2, 'Project'), 'P');
  assert.notEqual(b.cell(2, 'Archived At'), '');
  assert.equal(b.post({ action: 'updateStatus', id: 'nope', status: 'done' }).error, 'Item not found');

  const listed = b.get({ action: 'list', status: 'all', include_locked: 'true' }).items[0];
  assert.deepEqual(listed.evidence_files, ['a.png', 'b.pdf']);
  assert.deepEqual(listed.extra, { k: 1 });
});

test('lock, unlock and clearStaleLocks count correctly', () => {
  const b = load();
  ['L1', 'L2', 'L3'].forEach((id) => b.post(item(id, `https://x.test/${id}`)));
  assert.equal(b.post({ action: 'lock', ids: ['L1', 'L2'], locked_by: 'w1' }).count, 2);
  assert.equal(b.post({ action: 'lock', ids: ['L1', 'L3'], locked_by: 'w2' }).count, 1); // L1 already locked
  assert.equal(b.post({ action: 'lock', ids: ['L1'] }).ok, false);
  assert.equal(b.post({ action: 'clearStaleLocks', active_locks: ['w1'] }).count, 1); // w2 on L3
  assert.equal(b.post({ action: 'unlock', ids: [], locked_by: 'w1' }).count, 2);
  assert.equal(b.get({ action: 'list', status: 'pending' }).total, 3);
});

test('list and health shapes include extended fields', () => {
  const b = load({ props: { TOKEN: 't' } });
  b.post({ token: 't', action: 'data', sheetName: 'Archive', capture: { id: 'S1', url: 'https://x.test/s', savedBy: 'Ana' } });
  const listed = b.get({ token: 't', action: 'list', status: 'pending', limit: '5' });
  assert.deepEqual([listed.total, listed.offset, listed.limit, listed.spreadsheet.spreadsheet_id], [1, 0, 5, 'spreadsheet-123']);
  const it = listed.items[0];
  for (const key of ['saved_by', 'saved_at', 'query', 'project', 'source_type', 'snippet', 'language',
    'published_at', 'evidence_hash', 'evidence_files', 'captured_by', 'captured_at',
    'timestamp_token', 'processed_at', 'canary_item_id', 'extra']) assert.ok(key in it, key);
  assert.equal(it.saved_by, 'Ana');
  const viaPost = b.post({ token: 't', action: 'list', status: 'all', include_locked: true });
  assert.equal(viaPost.total, 1);
  for (const health of [b.get({ token: 't', action: 'health' }), b.post({ token: 't', action: 'health' })]) {
    assert.equal(health.schema_version, 4);
    assert.equal(health.bridge_version, 7);
    assert.equal(health.item_count, 1);
    assert.equal(health.sheet_name, 'Archive');
    assert.equal(health.spreadsheet_name, 'Team sheet');
  }
});

test('searches: upsert assigns ids, updates in place, disable hides, filter by project', () => {
  const b = load();
  const a = b.post({ action: 'upsertSearch', search: { project: 'P1', lane: 'rss', name: 'A', query: { q: 'x' }, interval_mins: 30, owner: 'ana' } });
  assert.deepEqual([a.ok, a.id, a.created], [true, 'S-0001', true]);
  const c = b.post({ action: 'upsertSearch', search: { project: 'P2', lane: 'gdelt', name: 'C', query: { q: 'y' }, enabled: true } });
  assert.equal(c.id, 'S-0002');
  const upd = b.post({ action: 'upsertSearch', search: { id: 'S-0001', name: 'A2' } });
  assert.deepEqual([upd.id, upd.created], ['S-0001', false]);
  let list = b.post({ action: 'listSearches' }).searches;
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { id: 'S-0001', project: 'P1', lane: 'rss', name: 'A2', query: { q: 'x' }, interval_mins: 30, owner: 'ana', enabled: true, updated_at: list[0].updated_at });
  assert.ok(list[0].updated_at);
  assert.equal(b.post({ action: 'listSearches', project: 'P2' }).searches.length, 1);
  b.post({ action: 'upsertSearch', search: { id: 'S-0001', enabled: false } });
  assert.deepEqual(b.post({ action: 'listSearches' }).searches.map((s) => s.id), ['S-0002']);
  list = b.post({ action: 'listSearches', include_disabled: true }).searches;
  assert.equal(list.length, 2);
  assert.equal(list[0].enabled, false);
  assert.equal(b.spreadsheet.getSheetByName('Searches').rows.length, 3);
});

test('getConfig creates the tab and reads key/value pairs', () => {
  const b = load();
  assert.deepEqual(b.post({ action: 'getConfig' }), { ok: true, config: {} });
  assert.deepEqual(b.spreadsheet.getSheetByName('Config').rows[0], ['Key', 'Value']);
  b.spreadsheet.getSheetByName('Config').appendRow(['mode', 'prod']);
  b.spreadsheet.getSheetByName('Config').appendRow(['n', 3]);
  assert.deepEqual(b.post({ action: 'getConfig' }).config, { mode: 'prod', n: 3 });
});

test('unknown actions keep the v5 text', () => {
  const b = load();
  assert.match(b.post({ action: 'nope' }).error, /Unknown action: nope/);
  assert.match(b.get({ action: 'nope' }).error, /Unknown action: nope/);
});

test('a 14 column Archive gets the extended headers appended, existing rows intact', () => {
  const b = load({ sheets: archiveWith(['K-1', 'https://x.test/k', 'T']) });
  assert.equal(b.get({ action: 'health' }).item_count, 1);
  assert.deepEqual(b.archive().rows[0], [...HRC, ...EXT]);
  assert.equal(b.archive().rows[1][0], 'K-1');
  assert.equal(b.get({ action: 'list', status: 'all' }).items[0].saved_by, '');
});

test('a wrong A-N layout throws the HRC layout error and is left untouched', () => {
  const legacy = ['ID', 'Timestamp', 'Saved By', 'Query', 'Title', 'URL', 'Snippet'];
  const b = load({ sheets: [new Sheet('Archive', [legacy])] });
  const health = b.get({ action: 'health' });
  assert.equal(health.ok, false);
  assert.match(health.error, /does not use the HRC column layout/);
  assert.match(b.post({ action: 'add', url: 'https://x.test' }).error, /does not use the HRC column layout/);
  assert.deepEqual(b.archive().rows[0], legacy);
});

test('Team setup creates TOKEN once and shows a decodable join code', () => {
  const b = load();
  b.context.teamSetup();
  const token = b.properties.TOKEN;
  assert.match(token, /^[0-9a-f-]{20,}$/);
  assert.equal(token.includes('-'), false);
  const text = b.alerts.at(-1)[1];
  const code = text.trim().split('\n').pop();
  assert.deepEqual(JSON.parse(Buffer.from(code, 'base64url').toString()), { url: 'https://script.test/exec', token });
  b.context.teamSetup();
  assert.equal(b.properties.TOKEN, token);
  b.context.showJoinCode();
  assert.equal(b.alerts.length, 3);

  const undeployed = load({ url: null });
  undeployed.context.teamSetup();
  assert.ok(undeployed.properties.TOKEN);
  assert.match(undeployed.alerts[0].join(' '), /Deploy/);
  const fresh = load();
  fresh.context.showJoinCode();
  assert.equal(fresh.properties.TOKEN, undefined);
});

test('onOpen keeps header seeding', () => {
  const b = load();
  b.context.onOpen();
  assert.equal(b.spreadsheet.getSheets()[0].rows[0][5], 'URL');
  const archived = load({ sheets: [new Sheet('Archive')] });
  archived.context.onOpen();
  assert.deepEqual(archived.archive().rows[0], [...HRC, ...EXT]);
});

const capture = (url, extra = {}) => ({ action: 'data', sheetName: 'Archive', capture: { url, ...extra } });
const textRows = (b) => b.spreadsheet.getSheetByName('Texts').rows.slice(1);

test('page text: stored in Texts across two cells, capped at 90k, never in Extra', () => {
  const b = load();
  const text = 'a'.repeat(45000) + 'b'.repeat(45000) + 'c'.repeat(10);
  const saved = b.post(capture('https://x.test/t', { text, tweetId: '9' }));
  const [row] = textRows(b);
  assert.deepEqual(row.slice(0, 1), [saved.id]);
  assert.equal(row[1], 'a'.repeat(45000));
  assert.equal(row[2], 'b'.repeat(45000));
  assert.equal(b.cell(1, 'Extra'), '{"tweetId":"9"}');
  assert.equal(b.post({ action: 'getTexts', ids: [saved.id] }).texts[0].text.length, 90000);
});

test('page text: first wins (also when the URL already existed), putText replace overwrites', () => {
  const b = load();
  const first = b.post(capture('https://x.test/t', { text: 'one' }));
  const again = b.post(capture('https://x.test/t', { text: 'two', savedBy: 'Ana' }));
  assert.equal(again.created, false);
  assert.equal(again.id, first.id);
  assert.equal(textRows(b).length, 1);
  assert.equal(textRows(b)[0][1], 'one');
  assert.deepEqual(b.post({ action: 'putText', id: first.id, text: 'three' }), { ok: true });
  assert.equal(textRows(b)[0][1], 'one');
  b.post({ action: 'putText', id: first.id, text: 'three', replace: true });
  assert.equal(textRows(b)[0][1], 'three');
  // dedupe path for a URL saved earlier without text gets its text
  const bare = b.post(capture('https://x.test/bare'));
  b.post(capture('https://x.test/bare', { text: 'late' }));
  assert.equal(b.post({ action: 'getTexts', ids: [bare.id] }).texts[0].text, 'late');
  assert.equal(b.post({ action: 'putText', id: '', text: 'x' }).ok, false);
});

test('dataBatch stores text against the final (reassigned) id', () => {
  const b = load({ sheets: archiveWith(['E-1', 'https://x.test/old']) });
  const saved = b.post({ action: 'dataBatch', sheetName: 'Archive', items: [
    { capture: { id: 'E-1', url: 'https://x.test/new', text: 'body' } }] });
  assert.equal(textRows(b)[0][0], saved.results[0].id);
  assert.notEqual(saved.results[0].id, 'E-1');
});

test('getTexts returns at most 50 and only known ids; list items carry has_text', () => {
  const b = load();
  const ids = [];
  for (let i = 0; i < 55; i++) ids.push(b.post(capture('https://x.test/' + i, { text: 't' + i })).id);
  b.post(capture('https://x.test/none'));
  assert.equal(b.post({ action: 'getTexts', ids }).texts.length, 50);
  assert.deepEqual(b.post({ action: 'getTexts', ids: ['nope'] }).texts, []);
  const items = b.post({ action: 'list', limit: 100 }).items;
  assert.equal(items.filter((i) => i.has_text).length, 55);
  assert.equal(items.find((i) => i.url === 'https://x.test/none').has_text, false);
  assert.equal(load().post({ action: 'getTexts', ids: ['a'] }).texts.length, 0); // no Texts tab yet
});

test('getStatus reads pipeline_status; empty when the tab is absent', () => {
  assert.deepEqual(load().post({ action: 'getStatus' }), { ok: true, status: {} });
  const b = load({ sheets: [new Sheet('pipeline_status', [['key', 'value'], ['ok', 'True'], ['explorer_url', 'https://a.github.io/b/']])] });
  assert.deepEqual(b.post({ action: 'getStatus' }).status, { ok: 'True', explorer_url: 'https://a.github.io/b/' });
});

test('run trigger: fires once, throttled for 5 minutes, skipped when unconfigured, never fails the save', () => {
  const props = { GITHUB_REPO: 'me/repo', GITHUB_TOKEN: 'tok' };
  const b = load({ props });
  b.post(capture('https://x.test/1'));
  b.post(capture('https://x.test/1', { savedBy: 'Ana' })); // no new row: no dispatch
  b.post(capture('https://x.test/2'));
  assert.equal(b.fetches.length, 1);
  assert.equal(b.fetches[0].url, 'https://api.github.com/repos/me/repo/dispatches');
  assert.equal(b.fetches[0].options.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(b.fetches[0].options.payload), { event_type: 'saved' });
  assert.equal(b.fetches[0].options.muteHttpExceptions, true);
  b.properties.LAST_DISPATCH = String(Date.now() - 6 * 60 * 1000);
  b.post(item('A-1', 'https://x.test/3'));
  assert.equal(b.fetches.length, 2);
  const open = load();
  open.post(capture('https://x.test/1'));
  assert.equal(open.fetches.length, 0);
  const down = load({ props });
  down.fetcher.fail = true;
  assert.equal(down.post(capture('https://x.test/1')).created, true);
  assert.equal(down.archive().rows.length, 2);
  const canary = load({ props });
  assert.equal(canary.postText({ headers: ['url'], values: ['https://x.test/c'] }), 'OK');
  assert.equal(canary.fetches.length, 1);
});

test('Connect GitHub stores repo and token; blank token keeps the stored one', () => {
  const b = load({ props: { GITHUB_TOKEN: 'old' } });
  b.prompts.push({ text: ' me/repo ' }, { text: '' });
  b.context.connectGithub();
  assert.equal(b.properties.GITHUB_REPO, 'me/repo');
  assert.equal(b.properties.GITHUB_TOKEN, 'old');
  b.prompts.push({ text: 'me/repo' }, { text: 'new' });
  b.context.connectGithub();
  assert.equal(b.properties.GITHUB_TOKEN, 'new');
});

test('Texts is reserved for putTab', () => {
  const b = load({ props: { TOKEN: 't' } });
  const r = b.post({ action: 'putTab', token: 't', tab: 'texts', rows: [['a']] });
  assert.equal(r.ok, false);
  assert.match(r.error, /reserved/);
});
