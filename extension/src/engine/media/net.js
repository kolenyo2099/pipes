// Fetching with the live browser session. host_permissions let the extension
// send the site's cookies and read any response without CORS, which is what
// reaches media behind a login that a headless fetch is refused.

// ponytail: HLS/DASH segments are held in memory as Uint8Arrays until they are joined into one Blob, so a stream is
// capped well below chrome-extension's 1.5 GB. Raise it by writing each segment to OPFS as it arrives (the MSE
// recorder in ../media-layer.js already does that); progressive files use response.blob() and keep 1.5 GB.
export const MAX_FILE_BYTES = 500_000_000; // per HLS/DASH stream

export async function fetchText(url) {
  const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  // Playlists resolve their relative URIs against the URL after redirects.
  return { text: await response.text(), url: response.url || url };
}

export async function fetchBytes(url, range = null) {
  const headers = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {};
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { credentials: 'include', headers, signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      // A server that ignores Range sends the whole file; keep only the slice asked for.
      if (range && response.status === 200) return bytes.slice(range.offset, range.offset + range.length);
      return bytes;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Fetch the pieces of one stream in order. `transform` lets HLS decrypt a
// segment; everything else is kept exactly as the server sent it.
export async function downloadItems(items, { transform, onProgress, limit = 6 } = {}) {
  let total = 0;
  let done = 0;
  return mapLimit(items, limit, async (item) => {
    let bytes = await fetchBytes(item.url, item.range);
    if (transform) bytes = await transform(item, bytes);
    total += bytes.byteLength;
    if (total > MAX_FILE_BYTES) throw new Error(`stream is larger than the ${MAX_FILE_BYTES / 1e9} GB limit`);
    onProgress?.(++done, items.length);
    return bytes;
  });
}
