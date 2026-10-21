<script>
  import { createEventDispatcher, onMount } from 'svelte'
  import { api } from '../api.js'
  import { notify, currentProjectId } from '../stores/app.js'

  export let item = null

  const dispatch = createEventDispatcher()

  // Edit mode: item is already saved — updating tags/notes only, no re-save side-effects
  $: isEditMode = item?.status === 'saved'

  let tagsInput = ''
  let notes = ''
  let savedBy = 'investigator'
  let isSaving = false

  // Use onMount (not $: reactive) so that form state is only initialised once
  // when the modal opens. A reactive $: block re-runs during Svelte's update
  // flush and resets the values while the user is typing.
  onMount(() => {
    tagsInput = (item?.tags || []).join(', ')
    notes = item?.notes || ''
    savedBy = item?.saved_by || 'investigator'
  })

  function parseTags(input) {
    return input.split(',').map(t => t.trim()).filter(Boolean)
  }

  async function handleSave() {
    if (!item) return
    isSaving = true
    const result = await api.saveItem($currentProjectId, item.item_id, {
      tags: parseTags(tagsInput),
      notes,
      saved_by: savedBy,
    })
    isSaving = false
    if (result.ok) {
      notify('success', 'Item saved')
      dispatch('saved', result.data)
      close()
    } else {
      notify('error', `Save failed: ${result.error}`)
    }
  }

  function addNeedsReview() {
    const existing = parseTags(tagsInput)
    if (!existing.includes('needs_review')) {
      tagsInput = [...existing, 'needs_review'].join(', ')
    }
  }

  function close() {
    dispatch('close')
  }
</script>

{#if item}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="overlay" on:click|self={close}>
    <div class="modal">
      <div class="modal-header">
        <h3>{isEditMode ? 'Edit Tags & Notes' : 'Save Item'}</h3>
        <button class="btn-icon" on:click={close}>✕</button>
      </div>

      <div class="item-preview">
        <div class="preview-title">{item.title_or_summary || '(no title)'}</div>
        <div class="preview-meta">
          <span class="badge badge--{item.source_type}">{item.source_type}</span>
          <span class="muted">{item.query_bucket}</span>
        </div>
      </div>

      <div class="form-group">
        <label for="save-tags">Tags <span class="hint">(comma-separated)</span></label>
        <input
          id="save-tags"
          type="text"
          bind:value={tagsInput}
          placeholder="e.g. injunction, transfer_agreement"
          class="form-input"
        />
        <button class="btn-secondary btn-sm" on:click={addNeedsReview} type="button">
          + needs_review
        </button>
      </div>

      <div class="form-group">
        <label for="save-notes">Note <span class="hint">(optional)</span></label>
        <textarea
          id="save-notes"
          bind:value={notes}
          placeholder="Add context for collaborators…"
          rows="3"
          class="form-input"
        ></textarea>
      </div>

      <div class="form-group">
        <label for="save-by">Saved by</label>
        <input id="save-by" type="text" bind:value={savedBy} class="form-input" />
      </div>

      {#if !isEditMode && item.sheet_send_status !== 'not_configured'}
        <p class="sheet-note">
          This item will be sent to Google Sheets automatically after saving.
        </p>
      {/if}

      <div class="modal-actions">
        <button class="btn-secondary" on:click={close} disabled={isSaving}>Cancel</button>
        <button class="btn-primary" on:click={handleSave} disabled={isSaving}>
          {#if isSaving}
            {isEditMode ? 'Updating…' : 'Saving…'}
          {:else}
            {isEditMode ? 'Update' : 'Save Item'}
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .modal {
    background: var(--bg-card);
    border-radius: 8px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.25);
    max-width: 480px;
    padding: 1.5rem;
    width: 100%;
  }
  .modal-header {
    align-items: center;
    display: flex;
    justify-content: space-between;
    margin-bottom: 1rem;
  }
  .modal-header h3 {
    font-size: 1rem;
    font-weight: 600;
    margin: 0;
  }
  .item-preview {
    background: var(--bg);
    border-radius: 6px;
    margin-bottom: 1rem;
    padding: 0.75rem;
  }
  .preview-title {
    font-size: 0.85rem;
    font-weight: 500;
    margin-bottom: 0.4rem;
  }
  .preview-meta {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.75rem;
  }
  .muted { color: var(--text-muted); }
  .form-group {
    margin-bottom: 1rem;
  }
  label {
    display: block;
    font-size: 0.8rem;
    font-weight: 500;
    margin-bottom: 0.3rem;
  }
  .hint { color: var(--text-muted); font-weight: normal; }
  .form-input {
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    background: var(--bg);
    font-size: 0.85rem;
    padding: 0.5rem 0.6rem;
    width: 100%;
    box-sizing: border-box;
  }
  .form-input:focus {
    border-color: var(--accent);
    outline: none;
  }
  textarea.form-input { resize: vertical; }
  .btn-sm {
    font-size: 0.75rem;
    margin-top: 0.3rem;
    padding: 0.2rem 0.6rem;
  }
  .sheet-note {
    background: #fffbeb;
    border: 1px solid #fcd34d;
    border-radius: 4px;
    color: #92400e;
    font-size: 0.78rem;
    margin-bottom: 1rem;
    padding: 0.5rem 0.75rem;
  }
  .modal-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }
  .badge { border-radius: 3px; font-size: 0.7rem; padding: 0.1rem 0.4rem; }
  .badge--events  { background: var(--accent-soft); color: var(--accent-strong); }
  .badge--doc     { background: #d1fae5; color: #065f46; } /* legacy */
  .badge--gkg     { background: #ede9fe; color: #5b21b6; }
  .badge--rss     { background: var(--accent-soft); color: var(--accent-strong); }
  .badge--mediacloud { background: #ede9fe; color: #5b21b6; }
  .badge--x { background: #e5e7eb; color: #111827; }
  .badge--bluesky { background: #dbeafe; color: #1d4ed8; }
  .badge--telegram { background: #e0f2fe; color: #0369a1; }
  .badge--context { background: #ede9fe; color: #5b21b6; }
</style>
