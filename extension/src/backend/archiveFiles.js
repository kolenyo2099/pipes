// Only remove downloads that Chrome identifies as this extension's archive.
// Backups can contain download IDs from another profile, so the ID alone is insufficient.
export async function removeArchiveFiles(records) {
  if (typeof chrome === 'undefined' || !chrome.downloads?.removeFile) return
  for (const record of records) {
    if (record.download_id == null) continue
    const [download] = await chrome.downloads.search({ id: record.download_id })
    const filename = download?.filename?.replaceAll('\\', '/')
    if (!download || download.byExtensionId !== chrome.runtime.id ||
      !filename?.endsWith(`/${record.archive_id}.mhtml`)) continue
    if (download.state === 'in_progress') await chrome.downloads.cancel(record.download_id)
    if (download.exists) await chrome.downloads.removeFile(record.download_id)
  }
}
