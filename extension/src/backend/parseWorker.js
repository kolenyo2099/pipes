import { unzipSync } from 'fflate'
import { eventItems, gkgItems } from './gdelt.js'
import { rssItems } from './rss.js'

function unzipText(buffer) {
  const files = unzipSync(new Uint8Array(buffer), { filter: file => Number.isFinite(file.originalSize) && file.originalSize <= 150_000_000 })
  const csv = Object.entries(files).find(([name]) => /\.csv$/i.test(name))
  if (!csv) throw new Error('Source ZIP has no CSV file under the 150 MB unpacked limit')
  return new TextDecoder().decode(csv[1])
}

self.onmessage = ({ data }) => {
  const { id, kind, buffer, project, start, end, stream, rule, query, deferSimpleFilter } = data
  try {
    const items = kind === 'events' ? eventItems(unzipText(buffer), project, start, end, stream)
      : kind === 'gkg' ? gkgItems(unzipText(buffer), project, start, end, stream)
        : rssItems(new TextDecoder().decode(buffer), project, rule, query, start, end, { deferSimpleFilter })
    self.postMessage({ id, items })
  } catch (error) {
    self.postMessage({ id, error: error.message || String(error) })
  }
}
