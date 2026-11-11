// The explorer address comes from the team sheet, so only embed GitHub Pages URLs.
export function trustedExplorerUrl(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname.endsWith('.github.io')
  } catch { return false }
}
