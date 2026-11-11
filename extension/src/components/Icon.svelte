<!-- One stroke-icon set for the whole app, so navigation does not depend on the platform's emoji. -->
<script>
  export let name
  const paths = {
    library: 'M4 5v14M9 5v14M14 6l4 13M4 19h6',
    explore: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15.5 8.5l-2 5-5 2 2-5z',
    archive: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4',
    queries: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l5 5',
    shared: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3 3-5 6-5s6 2 6 5M17 11a3 3 0 0 0 0-6M18 15c2 .6 3 2.500 3 5',
    inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5',
    timeline: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
    saved: 'M6 4h12v17l-6-4-6 4z',
    dismissed: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    logs: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
    settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
    guide: 'M4 5c3-1 6-1 8 1 2-2 5-2 8-1v14c-3-1-6-1-8 1-2-2-5-2-8-1zM12 6v14',
    download: 'M12 4v11M7 11l5 5 5-5M4 20h16',
    upload: 'M12 16V5M7 9l5-5 5 5M4 20h16',
    setup: 'M14 6l4 4M4 20l1-5L15 5l4 4L9 19zM13 7l4 4',
  }
</script>

<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>

<style>
  .icon { flex-shrink: 0; }
</style>
