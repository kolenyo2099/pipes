const params = new URLSearchParams(location.search);
const requestId = params.get('requestId') || '';
const titleInput = document.getElementById('titleInput');

titleInput.value = params.get('title') || '';
titleInput.select();

function sendTitle(title) {
  chrome.runtime.sendMessage({
    type: 'pipeline:pdf-title',
    requestId,
    title
  });
}

document.getElementById('titleForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const title = titleInput.value.trim();
  if (!title) {
    titleInput.reportValidity();
    return;
  }
  sendTitle(title);
});

document.getElementById('cancelBtn').addEventListener('click', () => {
  sendTitle(null);
});
