// Pipeline — context tracker
// Runs on all pages; stores right-clicked link data so the background
// service worker can read it via chrome.scripting.executeScript

document.addEventListener('contextmenu', e => {
  const link = e.target.closest('a[href]');
  window.__pipelineContext = link
    ? { linkText: link.textContent.trim(), href: link.href }
    : null;
});
