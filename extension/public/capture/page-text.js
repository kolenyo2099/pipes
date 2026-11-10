// Main text of the open page for the team sheet's Texts tab: <main>, else <article>, else the whole body.
// Whitespace collapsed, capped at 90,000 characters (the sheet's limit). Classic script: loaded before content.js,
// injected by capture-bg.js, and evaluated by the archive engine in the page it captures.
function pipelinePageText() {
  const text = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim()
  return (text(document.querySelector('main')) || text(document.querySelector('article')) || text(document.body)).slice(0, 90000)
}
