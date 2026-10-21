<script>
  import { onMount } from 'svelte'
  import { api } from '../api.js'
  import {
    currentView, currentProjectId, projects, notify,
  } from '../stores/app.js'
  import QueryBuilder from '../components/QueryBuilder.svelte'
  import {
    cloneMediaCloudCollections,
    enabledMediaCloudRulesAreConfigured,
    mediaCloudCollectionsForRules,
  } from '../lib/mediacloudRules.js'

  let name = ''
  let selectedCountries = []
  let watchlists = []
  let ontology = {}
  let allCountries = []
  let countrySearch = ''
  let sheetUrl = ''
  let sheetToken = ''
  let autoSend = true
  let eventsEnabled = true
  let docEnabled = true
  let rssEnabled = false
  let mediacloudEnabled = false
  let xEnabled = false
  let blueskyEnabled = false
  let telegramEnabled = false
  let mediacloudCollections = []
  let legacyMediaCloudCollections = []
  let creating = false
  let error = ''
  let scriptCopied = false

  // Apps Script pasted into a Google Sheet's bound script editor.
  // Uses getActiveSpreadsheet() — works automatically when created from
  // Extensions → Apps Script inside the sheet (container-bound, no ID needed).
  const APPS_SCRIPT = `// canary-script-version: 4
var CANARY_VERSION = '4';

// Visit the web app URL in a browser to confirm which version is deployed.
function doGet() {
  return ContentService.createTextOutput('canary-script-version: ' + CANARY_VERSION)
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  var SHEET_NAME = 'canary'; // tab name — created automatically if missing
  var step = 'init';

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    step = 'read-body';
    var raw = e.postData.contents;
    Logger.log('canary v' + CANARY_VERSION + ' | step=' + step + ' | raw=' + raw.substring(0, 300));

    step = 'parse-json';
    var data = JSON.parse(raw);

    step = 'check-token';
    var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (token && data.token !== token) {
      return ContentService.createTextOutput('Unauthorized')
        .setMimeType(ContentService.MimeType.TEXT);
    }

    step = 'extract-arrays';
    var headers = data.headers; // ordered column names sent by Canary
    var values  = data.values;  // ordered values — same index as headers
    if (!headers || !values || headers.length !== values.length) {
      return ContentService.createTextOutput(
        'ERROR: malformed payload — headers(' + (headers ? headers.length : 'null') +
        ') values(' + (values ? values.length : 'null') + ')'
      ).setMimeType(ContentService.MimeType.TEXT);
    }

    step = 'get-sheet';
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

    step = 'append-header';
    if (sheet.getLastRow() === 0) sheet.appendRow(headers);

    step = 'append-values';
    // Coerce any residual null/undefined cells to empty string to be safe.
    var safeValues = values.map(function(v) { return v == null ? '' : v; });
    sheet.appendRow(safeValues);

    return ContentService.createTextOutput('OK')
      .setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    Logger.log('canary v' + CANARY_VERSION + ' | FAILED at step=' + step + ' | ' + err.message);
    return ContentService.createTextOutput('ERROR: [' + step + '] ' + err.message)
      .setMimeType(ContentService.MimeType.TEXT);
  } finally {
    lock.releaseLock();
  }
}`

  async function copyScript() {
    await navigator.clipboard.writeText(APPS_SCRIPT)
    scriptCopied = true
    setTimeout(() => scriptCopied = false, 2000)
  }

  // QueryBuilder state
  let showQueryBuilder = false
  let editingRuleIdx = null  // null = new rule, number = editing existing

  // Ruleset import
  let importFileInput

  function hasLegacyMediaCloudRule(rules = watchlists) {
    return rules.some(rule => (
      rule?.lane === 'mediacloud'
      && !Array.isArray(rule.logic?.mediacloud_collections)
    ))
  }

  function recomputeMediaCloudCollections() {
    mediacloudCollections = mediaCloudCollectionsForRules(watchlists, legacyMediaCloudCollections)
  }

  function handleImportFile(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target.result)
        if (parsed.foresight_ruleset !== '1.0') {
          notify('error', 'Unrecognised ruleset format')
          return
        }
        const incoming = (parsed.rules || []).filter(r => r.bucket_name && r.lane && r.logic)
        if (incoming.length === 0) {
          notify('error', 'No valid rules found in file')
          return
        }
        const previousFallback = mediacloudCollections
        const hadLegacyRule = hasLegacyMediaCloudRule()
        watchlists = [...watchlists, ...incoming]
        if (!hadLegacyRule && hasLegacyMediaCloudRule(incoming)) {
          legacyMediaCloudCollections = cloneMediaCloudCollections(previousFallback)
        }
        recomputeMediaCloudCollections()
        if (incoming.some(r => r.lane === 'rss')) rssEnabled = true
        if (incoming.some(r => r.lane === 'mediacloud')) mediacloudEnabled = true
        if (incoming.some(r => r.lane === 'x')) xEnabled = true
        if (incoming.some(r => r.lane === 'bluesky')) blueskyEnabled = true
        if (incoming.some(r => r.lane === 'telegram')) telegramEnabled = true
        notify('success', `Loaded ${incoming.length} rule(s) from file`)
      } catch (_) {
        notify('error', 'Could not parse ruleset file')
      }
      e.target.value = ''
    }
    reader.readAsText(file)
  }

  onMount(async () => {
    const [presetsRes, ontologyRes] = await Promise.all([
      api.getWatchlistPresets(),
      api.getOntology(),
    ])
    if (presetsRes.ok) {
      watchlists = presetsRes.data.map(p => ({ ...p, enabled: true }))
      legacyMediaCloudCollections = hasLegacyMediaCloudRule()
        ? cloneMediaCloudCollections(mediacloudCollections)
        : []
      recomputeMediaCloudCollections()
      if (watchlists.some(w => w.lane === 'rss')) rssEnabled = true
      if (watchlists.some(w => w.lane === 'mediacloud')) mediacloudEnabled = true
    }
    if (ontologyRes.ok) {
      ontology = ontologyRes.data
      allCountries = ontologyRes.data.countries || []
    }
  })

  $: filteredCountries = countrySearch
    ? allCountries.filter(c =>
        c.name.toLowerCase().includes(countrySearch.toLowerCase()) ||
        c.code.toLowerCase().includes(countrySearch.toLowerCase())
      )
    : allCountries

  $: groupedRules = (() => {
    const seen = new Map()
    watchlists.forEach((rule, idx) => {
      if (!seen.has(rule.bucket_name)) {
        seen.set(rule.bucket_name, { bucket_name: rule.bucket_name, rules: [] })
      }
      seen.get(rule.bucket_name).rules.push({ rule, idx })
    })
    return [...seen.values()]
  })()

  function toggleCountry(code) {
    if (selectedCountries.includes(code)) {
      selectedCountries = selectedCountries.filter(c => c !== code)
    } else {
      selectedCountries = [...selectedCountries, code]
    }
  }

  function toggleWatchlist(idx) {
    watchlists = watchlists.map((w, i) =>
      i === idx ? { ...w, enabled: !w.enabled } : w
    )
  }

  function openNewRule() {
    editingRuleIdx = null
    showQueryBuilder = true
  }

  function openEditRule(idx) {
    editingRuleIdx = idx
    showQueryBuilder = true
  }

  function savedLaneWasAddedOrChanged(newRules, lane, editedBucket) {
    const savedRule = newRules.find(candidate => candidate.lane === lane)
    if (!savedRule) return false
    const existingRule = watchlists.find(candidate => (
      candidate.bucket_name === editedBucket && candidate.lane === lane
    ))
    if (!existingRule) return true
    return JSON.stringify({ logic: savedRule.logic, enabled: savedRule.enabled })
      !== JSON.stringify({ logic: existingRule.logic, enabled: existingRule.enabled })
  }

  function handleRuleSaved(saved) {
    const newRules = Array.isArray(saved) ? saved : [saved]
    const editedBucket = editingRuleIdx !== null ? watchlists[editingRuleIdx]?.bucket_name : null
    const rssChanged = savedLaneWasAddedOrChanged(newRules, 'rss', editedBucket)
    const mediaCloudChanged = savedLaneWasAddedOrChanged(newRules, 'mediacloud', editedBucket)
    const xChanged = savedLaneWasAddedOrChanged(newRules, 'x', editedBucket)
    const blueskyChanged = savedLaneWasAddedOrChanged(newRules, 'bluesky', editedBucket)
    const telegramChanged = savedLaneWasAddedOrChanged(newRules, 'telegram', editedBucket)
    const savedLanes = new Set(newRules.map(rule => rule.lane))
    watchlists = [
      ...watchlists.filter((rule, idx) => {
        if (editingRuleIdx !== null && rule.bucket_name === editedBucket && savedLanes.has(rule.lane)) {
          return false
        }
        return !newRules.some(newRule => (
          idx !== editingRuleIdx &&
          rule.bucket_name === newRule.bucket_name &&
          rule.lane === newRule.lane
        ))
      }),
      ...newRules,
    ]
    recomputeMediaCloudCollections()
    if (rssChanged) rssEnabled = true
    if (mediaCloudChanged) mediacloudEnabled = true
    if (xChanged) xEnabled = true
    if (blueskyChanged) blueskyEnabled = true
    if (telegramChanged) telegramEnabled = true
    showQueryBuilder = false
    editingRuleIdx = null
  }

  function removeRule(idx) {
    watchlists = watchlists.filter((_, i) => i !== idx)
    recomputeMediaCloudCollections()
  }

  function toggleGroupWatchlist(group) {
    const allEnabled = group.rules.every(r => r.rule.enabled)
    const idxSet = new Set(group.rules.map(r => r.idx))
    watchlists = watchlists.map((w, i) =>
      idxSet.has(i) ? { ...w, enabled: !allEnabled } : w
    )
  }

  function primaryEntryForGroup(group) {
    return group.rules.find(r => r.rule.lane === 'events')
      || group.rules.find(r => r.rule.lane === 'doc' || r.rule.lane === 'context')
      || group.rules.find(r => r.rule.lane === 'rss')
      || group.rules.find(r => r.rule.lane === 'mediacloud')
      || group.rules[0]
  }

  function openEditGroupRule(group) {
    editingRuleIdx = primaryEntryForGroup(group).idx
    showQueryBuilder = true
  }

  function removeGroupRule(group) {
    const idxSet = new Set(group.rules.map(r => r.idx))
    watchlists = watchlists.filter((_, i) => !idxSet.has(i))
    recomputeMediaCloudCollections()
  }

  async function create() {
    if (!name.trim()) { error = 'Project name is required'; return }
    if (selectedCountries.length === 0) { error = 'Select at least one country'; return }
    const activeWatchlists = watchlists.filter(w => w.enabled)
    if (activeWatchlists.length === 0) { error = 'At least one rule must be enabled'; return }
    if (mediacloudEnabled && !enabledMediaCloudRulesAreConfigured(watchlists, mediacloudCollections)) {
      error = 'Add or edit an enabled Media Cloud rule and choose at least one collection.'
      return
    }
    error = ''
    creating = true

    const data = {
      name: name.trim(),
      countries_focus: selectedCountries,
      watchlists: watchlists,
      polling_config: {
        events_interval_minutes: 30,
        doc_interval_minutes: 60,
        rss_interval_minutes: 60,
        mediacloud_interval_minutes: 1440,
        x_interval_minutes: 60,
        bluesky_interval_minutes: 60,
        telegram_interval_minutes: 60,
        overlap_minutes: 15,
        events_enabled: eventsEnabled,
        doc_enabled: docEnabled,
        rss_enabled: rssEnabled,
        mediacloud_enabled: mediacloudEnabled,
        x_enabled: xEnabled,
        bluesky_enabled: blueskyEnabled,
        telegram_enabled: telegramEnabled,
      },
      mediacloud_collections: mediacloudCollections,
    }

    if (sheetUrl.trim()) {
      data.sheet_sink = {
        url: sheetUrl.trim(),
        token: sheetToken.trim() || null,
        auto_send_on_save: autoSend,
      }
    }

    const result = await api.createProject(data)
    creating = false

    if (result.ok) {
      projects.update(ps => [result.data, ...ps])
      currentProjectId.set(result.data.project_id)
      const anyEnabled = eventsEnabled || docEnabled || rssEnabled || mediacloudEnabled || xEnabled || blueskyEnabled || telegramEnabled
      notify('success', `Project "${result.data.name}" created${anyEnabled ? ' – collection started' : ''}`)
      currentView.set('inbox')
      if (anyEnabled) {
        api.triggerCollect(result.data.project_id)
      }
    } else {
      error = result.error
    }
  }
</script>

<div class="new-project">
  <div class="page-header">
    <button class="btn-back" on:click={() => currentView.set('inbox')}>← Back</button>
    <h1 class="view-title">New Project</h1>
  </div>

  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  <!-- Step 1: Name -->
  <section class="step">
    <h2 class="step-title">1. Project name</h2>
    <input
      type="text"
      class="form-input form-input--wide"
      placeholder="e.g. Central America Transfers 2025"
      bind:value={name}
    />
  </section>

  <!-- Step 2: Countries -->
  <section class="step">
    <h2 class="step-title">2. Countries of interest</h2>
    <p class="step-hint">
      Used to filter GDELT events to relevant actors and locations.
      Select all countries you want to monitor.
    </p>
    {#if selectedCountries.length > 0}
      <div class="selected-countries">
        {#each selectedCountries as code}
          {@const country = allCountries.find(c => c.code === code)}
          <span class="country-chip">
            {country ? country.name : code}
            <button class="chip-remove" on:click={() => toggleCountry(code)}>✕</button>
          </span>
        {/each}
      </div>
    {/if}
    <input
      type="text"
      class="form-input country-search"
      placeholder="Search countries…"
      bind:value={countrySearch}
    />
    <div class="country-list">
      {#each filteredCountries.slice(0, 80) as c}
        <button
          class="country-option"
          class:selected={selectedCountries.includes(c.code)}
          on:click={() => toggleCountry(c.code)}
        >
          {c.name} <span class="country-code">({c.code})</span>
        </button>
      {/each}
      {#if filteredCountries.length > 80}
        <span class="country-overflow">+{filteredCountries.length - 80} more — refine search</span>
      {/if}
    </div>
  </section>

  <!-- Step 3: Monitoring rules -->
  <section class="step">
    <h2 class="step-title">
      3. Monitoring rules
      <span class="ruleset-actions">
        <button class="btn-ruleset" on:click={() => importFileInput.click()} title="Load rules from .json file">Load ruleset</button>
      </span>
    </h2>
    <input type="file" accept=".json" bind:this={importFileInput} style="display:none" on:change={handleImportFile} />
    <p class="step-hint">
      Rules tell Canary what to look for. Toggle presets on/off,
      or create custom rules using the query builder.
    </p>

    <div class="rule-list">
      {#each groupedRules as group}
        {@const allEnabled = group.rules.every(r => r.rule.enabled)}
        {@const anyEnabled = group.rules.some(r => r.rule.enabled)}
        {@const primaryRule = primaryEntryForGroup(group).rule}
        <div class="rule-item" class:rule-disabled={!anyEnabled}>
          <div class="rule-main">
            <label class="rule-check">
              <input
                type="checkbox"
                checked={allEnabled}
                on:change={() => toggleGroupWatchlist(group)}
              />
              <span class="rule-name">{group.bucket_name}</span>
            </label>
            <div class="rule-badges">
              {#each group.rules as { rule }}
                <span class="lane-badge lane-badge--{rule.lane}">{rule.lane}</span>
              {/each}
            </div>
            <div class="rule-actions">
              <button class="btn-rule-edit" on:click={() => openEditGroupRule(group)}>Edit</button>
              <button class="btn-rule-remove" on:click={() => removeGroupRule(group)}>✕</button>
            </div>
          </div>
          <div class="rule-desc">{primaryRule.logic?.description || ''}</div>
          <details class="rule-query-details">
            <summary>View rule logic</summary>
            {#each group.rules as { rule }}
              {#if group.rules.length > 1}
                <div class="rule-lane-header">{rule.lane}</div>
              {/if}
              <pre class="rule-query">{JSON.stringify(rule.logic, null, 2)}</pre>
            {/each}
          </details>
        </div>
      {/each}
    </div>

    <button class="btn-add-rule" on:click={openNewRule}>
      + Add custom rule
    </button>
  </section>

  <!-- Step 4: Data sources -->
  <section class="step">
    <h2 class="step-title">4. Data sources</h2>
    <div class="toggle-row">
      <label class="toggle-label">
        <input type="checkbox" bind:checked={eventsEnabled} />
        <span>
          <strong>GDELT Events</strong> — structured coded event data (every 30 min)
        </span>
      </label>
    </div>
    <div class="toggle-row">
      <label class="toggle-label">
        <input type="checkbox" bind:checked={docEnabled} />
        <span>
          <strong>GDELT DOC (News articles)</strong> — full-text news search (every 60 min)
        </span>
      </label>
    </div>
    <div class="toggle-row">
      <label class="toggle-label">
        <input type="checkbox" bind:checked={rssEnabled} />
        <span>
          <strong>Google News RSS</strong> — wizard-built Google News headline searches (every 60 min)
        </span>
      </label>
    </div>
    <div class="toggle-row">
      <label class="toggle-label">
        <input type="checkbox" bind:checked={mediacloudEnabled} />
        <span>
          <strong>Media Cloud</strong> — curated collection searches (once daily)
        </span>
      </label>
    </div>
    <div class="toggle-row">
      <label class="toggle-label">
        <input type="checkbox" bind:checked={xEnabled} />
        <span>
          <strong>X (Twitter)</strong> — searches and accounts, read in this browser while you are signed in to x.com (every 60 min)
        </span>
      </label>
    </div>
    <div class="toggle-row">
      <label class="toggle-label">
        <input type="checkbox" bind:checked={blueskyEnabled} />
        <span>
          <strong>Bluesky</strong> — searches and accounts through Bluesky's API, with an app password (every 60 min)
        </span>
      </label>
    </div>
    <div class="toggle-row">
      <label class="toggle-label">
        <input type="checkbox" bind:checked={telegramEnabled} />
        <span>
          <strong>Telegram</strong> — public channels through their t.me web preview, no sign-in (every 60 min)
        </span>
      </label>
    </div>
    {#if mediacloudEnabled && !enabledMediaCloudRulesAreConfigured(watchlists, mediacloudCollections)}
      <p class="lane-hint">Add or edit a Media Cloud rule to choose its collections.</p>
    {/if}
  </section>

  <!-- Step 5: Google Sheets -->
  <section class="step">
    <h2 class="step-title">5. Google Sheets export <span class="optional">(optional)</span></h2>
    <p class="step-hint">
      Push saved items to a Google Sheet automatically. Takes 2 minutes to set up — no
      spreadsheet ID needed. Leave blank to skip.
    </p>

    <!-- Setup steps (collapsed once URL is filled in) -->
    {#if !sheetUrl.trim()}
      <div class="sheet-setup">
        <div class="setup-step">
          <span class="step-num">1</span>
          <div class="step-body">
            <strong>Open your Google Sheet</strong>, then go to
            <strong>Extensions → Apps Script</strong>.
            This creates a script automatically linked to that sheet —
            no IDs to copy.
          </div>
        </div>
        <div class="setup-step">
          <span class="step-num">2</span>
          <div class="step-body">
            <strong>Replace any existing code</strong> with the script below, then save (⌘S / Ctrl+S).
            <div class="script-block">
              <pre class="script-pre">{APPS_SCRIPT}</pre>
              <button class="btn-copy-script" on:click={copyScript}>
                {scriptCopied ? '✓ Copied!' : 'Copy script'}
              </button>
            </div>
          </div>
        </div>
        <div class="setup-step">
          <span class="step-num">3</span>
          <div class="step-body">
            Click <strong>Deploy → New deployment</strong>.
            Set type to <em>Web app</em>, execute as <em>Me</em>,
            and access to <strong>Anyone</strong> (not "Anyone with a Google account").
            Click <strong>Deploy</strong> and authorise when prompted.
          </div>
        </div>
        <div class="setup-step">
          <span class="step-num">4</span>
          <div class="step-body">
            Copy the <strong>Web app URL</strong> and paste it below.
            A new tab named <em>canary</em> will be created in your sheet automatically.
          </div>
        </div>
      </div>
    {/if}

    <div class="form-group">
      <label for="sheet-url">Apps Script URL</label>
      <input
        id="sheet-url"
        type="url"
        class="form-input form-input--wide"
        placeholder="https://script.google.com/macros/s/…/exec"
        bind:value={sheetUrl}
      />
    </div>
    <div class="form-group">
      <label for="sheet-token">Shared token <span class="hint">(optional)</span></label>
      <input
        id="sheet-token"
        type="text"
        class="form-input"
        placeholder="your-secret-token"
        bind:value={sheetToken}
      />
    </div>
    <div class="toggle-row">
      <label class="toggle-label">
        <input type="checkbox" bind:checked={autoSend} />
        Auto-send to Sheet when item is saved
      </label>
    </div>
  </section>

  <div class="create-actions">
    <button class="btn-cancel" on:click={() => currentView.set('inbox')}>Cancel</button>
    <button class="btn-create" on:click={create} disabled={creating}>
      {creating ? 'Creating…' : 'Create Project & Start Collecting'}
    </button>
  </div>
</div>

<!-- QueryBuilder slide-in -->
{#if showQueryBuilder}
  <QueryBuilder
    rule={editingRuleIdx !== null ? watchlists[editingRuleIdx] : null}
    relatedRules={editingRuleIdx !== null
      ? watchlists.filter((_, i) => i !== editingRuleIdx && watchlists[i].bucket_name === watchlists[editingRuleIdx]?.bucket_name)
      : []}
    projectCountries={selectedCountries}
    mediaCloudCollections={mediacloudCollections}
    {ontology}
    onSave={handleRuleSaved}
    onCancel={() => { showQueryBuilder = false; editingRuleIdx = null }}
  />
{/if}

<style>
  .new-project { max-width: 680px; padding: 1.5rem 2rem; }

  .page-header {
    align-items: center;
    display: flex;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  .btn-back {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.85rem;
    padding: 0;
  }
  .btn-back:hover { color: var(--text); }
  .view-title { font-size: 1.3rem; font-weight: 700; margin: 0; }

  .error-banner {
    background: #fee2e2;
    border: 1px solid #fca5a5;
    border-radius: 5px;
    color: #991b1b;
    font-size: 0.85rem;
    margin-bottom: 1rem;
    padding: 0.6rem 0.9rem;
  }

  .step {
    border-bottom: 1px solid var(--border-light);
    margin-bottom: 1.5rem;
    padding-bottom: 1.5rem;
  }
  .step-title { font-size: 1rem; font-weight: 600; margin: 0 0 0.5rem; display: flex; align-items: center; gap: 0.5rem; }
  .ruleset-actions { display: flex; gap: 0.3rem; margin-left: auto; }
  .btn-ruleset { background: transparent; border: 1px solid var(--border); border-radius: 4px; color: var(--text-muted); cursor: pointer; font-size: 0.75rem; padding: 0.2rem 0.6rem; }
  .btn-ruleset:hover { background: var(--bg-hover); color: var(--text); }
  .step-hint { color: var(--text-muted); font-size: 0.82rem; margin: 0 0 0.75rem; }
  .optional { color: var(--text-muted); font-size: 0.8rem; font-weight: normal; }

  .form-input {
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    background: var(--bg-card);
    font-size: 0.85rem;
    padding: 0.45rem 0.6rem;
  }
  .form-input:focus { border-color: var(--accent); outline: none; }
  .form-input--wide { width: 100%; box-sizing: border-box; }

  .country-search { margin-bottom: 0.5rem; width: 280px; }
  .selected-countries { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-bottom: 0.6rem; }
  .country-chip {
    align-items: center; background: var(--accent-soft); border-radius: 4px; color: var(--accent-strong);
    display: flex; font-size: 0.78rem; gap: 0.3rem; padding: 0.2rem 0.5rem;
  }
  .chip-remove { background: none; border: none; color: var(--accent-light); cursor: pointer; font-size: 0.7rem; padding: 0; }
  .chip-remove:hover { color: var(--accent-strong); }
  .country-list { display: flex; flex-wrap: wrap; gap: 0.3rem; max-height: 160px; overflow-y: auto; }
  .country-option {
    background: var(--bg-hover); border: 1px solid var(--border); border-radius: 4px;
    color: var(--text); cursor: pointer; font-size: 0.75rem; padding: 0.2rem 0.5rem; transition: background 0.1s;
  }
  .country-option:hover { background: var(--line); }
  .country-option.selected { background: var(--accent-soft); border-color: var(--accent-light); color: var(--accent-strong); }
  .country-code { color: var(--text-muted); }
  .country-overflow { color: var(--text-muted); font-size: 0.72rem; font-style: italic; padding: 0.3rem; }

  .rule-list { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.75rem; }
  .rule-item {
    border: 1px solid var(--border); border-radius: 7px; padding: 0.65rem 0.85rem; transition: border-color 0.1s;
  }
  .rule-item:hover { border-color: var(--accent-light); }
  .rule-disabled { opacity: 0.5; }
  .rule-main { align-items: center; display: flex; gap: 0.5rem; }
  .rule-check {
    align-items: center; cursor: pointer; display: flex; flex: 1;
    font-size: 0.85rem; font-weight: 500; gap: 0.5rem; min-width: 0;
  }
  .rule-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rule-badges { display: flex; gap: 0.3rem; }
  .lane-badge { border-radius: 3px; font-size: 0.65rem; font-weight: 600; padding: 0.1rem 0.4rem; white-space: nowrap; }
  .lane-badge--events { background: var(--accent-soft); color: var(--accent-strong); }
  .lane-badge--doc    { background: #d1fae5; color: #065f46; }
  .lane-badge--rss    { background: var(--accent-soft); color: var(--accent-strong); }
  .lane-badge--mediacloud { background: #ede9fe; color: #5b21b6; }
  .lane-badge--x { background: #e5e7eb; color: #111827; }
  .lane-badge--bluesky { background: #dbeafe; color: #1d4ed8; }
  .lane-badge--telegram { background: #e0f2fe; color: #0369a1; }
  .rule-actions { display: flex; gap: 0.25rem; }
  .btn-rule-edit {
    background: none; border: 1px solid var(--border); border-radius: 3px;
    color: var(--text-muted); cursor: pointer; font-size: 0.72rem; padding: 0.15rem 0.5rem;
  }
  .btn-rule-edit:hover { background: var(--bg-hover); color: var(--text); }
  .btn-rule-remove {
    background: none; border: none; color: var(--text-muted); cursor: pointer;
    font-size: 0.8rem; padding: 0.15rem 0.3rem;
  }
  .btn-rule-remove:hover { color: #dc2626; }
  .rule-desc { color: var(--text-muted); font-size: 0.75rem; margin-top: 0.3rem; }
  .rule-query-details { margin-top: 0.3rem; }
  .rule-query-details summary { color: var(--text-muted); cursor: pointer; font-size: 0.72rem; }
  .rule-lane-header {
    color: var(--text-muted);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    margin-top: 0.45rem;
    text-transform: uppercase;
  }
  .rule-query {
    background: var(--bg-code); border: 1px solid var(--border); border-radius: 3px;
    color: var(--text-code); display: block; font-size: 0.7rem; margin-top: 0.35rem;
    padding: 0.4rem 0.6rem; white-space: pre-wrap; word-break: break-all;
  }

  .btn-add-rule {
    background: none; border: 1px dashed var(--border); border-radius: 7px;
    color: var(--accent); cursor: pointer; font-size: 0.82rem; font-weight: 600;
    padding: 0.5rem 1rem; width: 100%;
  }
  .btn-add-rule:hover { background: var(--bg-hover); border-color: var(--accent); }

  .toggle-row { margin-bottom: 0.6rem; }
  .toggle-label { align-items: flex-start; cursor: pointer; display: flex; font-size: 0.85rem; gap: 0.5rem; }
  .toggle-label input { flex-shrink: 0; margin-top: 2px; }
  .lane-hint { color: #b45309; font-size: 0.78rem; margin: -0.2rem 0 0.6rem 1.5rem; }

  .form-group { margin-bottom: 0.75rem; }
  .form-group label { display: block; font-size: 0.8rem; font-weight: 500; margin-bottom: 0.3rem; }
  .hint { color: var(--text-muted); font-weight: normal; }

  .create-actions { display: flex; gap: 0.75rem; justify-content: flex-end; margin-top: 2rem; }
  .btn-cancel {
    background: none; border: 1px solid var(--border); border-radius: 5px;
    color: var(--text-muted); cursor: pointer; font-size: 0.9rem; padding: 0.5rem 1.25rem;
  }
  .btn-cancel:hover { background: var(--bg-hover); }
  .btn-create {
    background: var(--accent); border: none; border-radius: 5px; color: white;
    cursor: pointer; font-size: 0.9rem; font-weight: 600; padding: 0.5rem 1.5rem;
  }
  .btn-create:hover { background: var(--accent-strong); }
  .btn-create:disabled { background: var(--accent-light); cursor: default; }

  /* ── Google Sheets setup walkthrough ───────────────────────────────────── */
  .sheet-setup {
    border: 1px solid var(--border);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 0;
    margin-bottom: 1.25rem;
    overflow: hidden;
  }
  .setup-step {
    align-items: flex-start;
    border-bottom: 1px solid var(--border-light, var(--paper-2));
    display: flex;
    gap: 0.85rem;
    padding: 0.85rem 1rem;
  }
  .setup-step:last-child { border-bottom: none; }
  .step-num {
    align-items: center;
    background: var(--accent);
    border-radius: 50%;
    color: white;
    display: flex;
    flex-shrink: 0;
    font-size: 0.7rem;
    font-weight: 700;
    height: 20px;
    justify-content: center;
    margin-top: 1px;
    width: 20px;
  }
  .step-body {
    color: var(--text);
    font-size: 0.82rem;
    line-height: 1.5;
  }
  .step-body strong { color: var(--text); }
  .step-body em { font-style: normal; color: var(--text-muted); }

  .script-block {
    border: 1px solid var(--border);
    border-radius: 6px;
    margin-top: 0.6rem;
    overflow: hidden;
    position: relative;
  }
  .script-pre {
    background: #1e1e2e;
    color: #cdd6f4;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.68rem;
    line-height: 1.5;
    margin: 0;
    max-height: 180px;
    overflow-y: auto;
    padding: 0.75rem 1rem;
    scrollbar-width: thin;
    white-space: pre;
  }
  .btn-copy-script {
    background: rgba(255,255,255,0.08);
    border: none;
    border-top: 1px solid rgba(255,255,255,0.1);
    color: var(--muted-2);
    cursor: pointer;
    font-size: 0.72rem;
    padding: 0.35rem 0.75rem;
    text-align: right;
    transition: background 0.12s, color 0.12s;
    width: 100%;
  }
  .btn-copy-script:hover { background: rgba(255,255,255,0.14); color: var(--line); }
</style>
