<script>
  import { createEventDispatcher } from 'svelte'
  import { api } from '../api.js'
  import { currentProjectId, notify, saveModalItem } from '../stores/app.js'
  import { openUrl } from '../lib/openUrl.js'

  export let item
  export let status = null

  const dispatch = createEventDispatcher()

  let dismissing = false
  let restoring = false
  let openingSave = false

  $: itemStatus = item?.status || status
  $: modalItem = item ? { ...item, status: itemStatus } : item
  $: isSaved = itemStatus === 'saved'
  $: isDismissed = itemStatus === 'dismissed'
  $: saveLabel = isSaved ? 'Edit' : 'Save'
  $: saveTitle = isSaved ? 'Edit saved tags and notes' : 'Save this item'

  function openSource() {
    if (item?.url) openUrl(item.url)
  }

  async function openSave() {
    if (!item || openingSave) return
    openingSave = true
    let fullItem = modalItem
    if ($currentProjectId && item.item_id) {
      const result = await api.listItems($currentProjectId, {
        status: itemStatus || undefined,
        item_ids: item.item_id,
        limit: 1,
      })
      if (result.ok && result.data.items?.length > 0) {
        fullItem = result.data.items[0]
      } else if (!result.ok) {
        notify('error', `Could not load item: ${result.error}`)
        openingSave = false
        return
      }
    }
    openingSave = false
    saveModalItem.set({ ...fullItem, status: fullItem?.status || itemStatus })
  }

  async function dismissItem() {
    if (!$currentProjectId || !item || dismissing) return
    dismissing = true
    const result = await api.dismissItem($currentProjectId, item.item_id)
    dismissing = false
    if (result.ok) {
      notify('info', isSaved ? 'Saved item dismissed' : 'Item dismissed')
      dispatch('dismissed', item.item_id)
    } else {
      notify('error', `Dismiss failed: ${result.error}`)
    }
  }

  async function restoreItem() {
    if (!$currentProjectId || !item || restoring) return
    restoring = true
    const result = await api.undismissItem($currentProjectId, item.item_id)
    restoring = false
    if (result.ok) {
      notify('info', 'Moved back to Inbox')
      dispatch('undismissed', item.item_id)
    } else {
      notify('error', `Restore failed: ${result.error}`)
    }
  }
</script>

<div class="mini-card">
  <div class="mini-main">
    <span class="mini-source">{item.source_type}</span>
    <button
      class="mini-title"
      class:disabled={!item.url}
      on:click={openSource}
      disabled={!item.url}
      title={item.url ? 'Open source' : undefined}
    >
      {item.title_or_summary || item.url || '-'}
    </button>
  </div>

  <div class="mini-actions">
    {#if isDismissed}
      <button
        class="mini-action mini-action--restore"
        on:click={restoreItem}
        disabled={restoring}
        title="Restore to Inbox"
      >
        {restoring ? 'Restoring...' : 'Restore'}
      </button>
    {:else}
      <button
        class="mini-action mini-action--save"
        on:click={openSave}
        disabled={openingSave}
        title={saveTitle}
      >
        {openingSave ? 'Opening...' : saveLabel}
      </button>
      <button
        class="mini-action mini-action--dismiss"
        on:click={dismissItem}
        disabled={dismissing}
        title="Dismiss this item"
      >
        {dismissing ? 'Dismissing...' : 'Dismiss'}
      </button>
    {/if}
  </div>
</div>

<style>
  .mini-card {
    border-radius: 5px;
    display: grid;
    gap: 5px;
    padding: 7px 8px;
    transition: background 0.1s, box-shadow 0.1s;
  }
  .mini-card:hover {
    background: #132236;
    box-shadow: inset 0 0 0 1px #1e293b;
  }
  .mini-main {
    display: grid;
    gap: 3px;
    min-width: 0;
  }
  .mini-source {
    align-self: start;
    background: #1e293b;
    border-radius: 3px;
    color: #64748b;
    display: inline-block;
    font-size: 9px;
    letter-spacing: 0.05em;
    margin-bottom: 1px;
    padding: 1px 4px;
    text-transform: uppercase;
    width: fit-content;
  }
  .mini-title {
    background: none;
    border: none;
    color: #cbd5e1;
    cursor: pointer;
    display: -webkit-box;
    font: inherit;
    font-size: 12px;
    line-height: 1.35;
    overflow: hidden;
    padding: 0;
    text-align: left;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }
  .mini-title:hover {
    color: #e2e8f0;
  }
  .mini-title.disabled {
    cursor: default;
  }
  .mini-title.disabled:hover {
    color: #cbd5e1;
  }
  .mini-actions {
    align-items: center;
    display: flex;
    gap: 5px;
    min-height: 24px;
  }
  .mini-action {
    background: #0f1b2a;
    border: 1px solid #334155;
    border-radius: 4px;
    color: #94a3b8;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    padding: 5px 8px;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }
  .mini-action:hover:not(:disabled) {
    background: #1e293b;
    color: #e2e8f0;
  }
  .mini-action:disabled {
    cursor: default;
    opacity: 0.55;
  }
  .mini-action--save {
    border-color: #1d4ed8;
    color: #93c5fd;
  }
  .mini-action--save:hover:not(:disabled) {
    background: #172554;
    border-color: #3b82f6;
    color: #dbeafe;
  }
  .mini-action--dismiss:hover:not(:disabled) {
    border-color: #7f1d1d;
    color: #fca5a5;
  }
  .mini-action--restore {
    border-color: #166534;
    color: #86efac;
  }
  .mini-action--restore:hover:not(:disabled) {
    background: #052e16;
    border-color: #22c55e;
    color: #dcfce7;
  }
</style>
