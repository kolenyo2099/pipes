<script>
  export let data = {}
  export let label = 'Raw JSON'
  let expanded = false
</script>

<div class="raw-viewer">
  <button class="raw-toggle" on:click={() => expanded = !expanded}>
    <span class="toggle-icon">{expanded ? '▼' : '▶'}</span>
    {label}
  </button>
  {#if expanded}
    <pre class="raw-pre">{JSON.stringify(data, null, 2)}</pre>
  {/if}
</div>

<style>
  .raw-viewer {
    margin-top: 0.5rem;
  }
  .raw-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0.25rem 0.6rem;
  }
  .raw-toggle:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .toggle-icon {
    font-size: 0.6rem;
  }
  .raw-pre {
    background: var(--bg-code);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-code);
    font-family: 'SFMono-Regular', Consolas, monospace;
    font-size: 0.7rem;
    line-height: 1.4;
    margin-top: 0.4rem;
    max-height: 320px;
    overflow: auto;
    padding: 0.75rem;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
