// In-memory audio/video evidence files and how they are named, ported from chrome-app's media-model.js.
// A file is { id, name, blob, mimetype, properties } — the same { id, name, blob } shape evidence.js writes,
// plus provenance (capture_method, source_urls...) that goes to the manifest notes.

const EXTENSION_BY_MIME = {
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/ogg': '.ogv', 'video/mp2t': '.ts',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/ogg': '.ogg', 'audio/opus': '.opus',
  'audio/wav': '.wav', 'audio/webm': '.weba', 'audio/flac': '.flac',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif'
}

export const baseMime = (value) => (value || '').split(';')[0].trim().toLowerCase()
export const extensionForMime = (mime, fallback = '') => EXTENSION_BY_MIME[baseMime(mime)] ?? fallback
export const isAV = (file) => /^(audio|video)\//.test(file.mimetype || baseMime(file.blob?.type))

export const media = (id, name, blob, mimetype, properties = {}) => ({ id, name, blob, mimetype: mimetype || blob.type, properties })

/** The saved media of one capture: ids and names run video_1, video_2, audio_1... in the order they were added. */
export class MediaFiles {
  constructor() {
    this.list = []
    this.counts = { video: 0, audio: 0 }
  }

  /** `name` is the stem; the extension comes from the mime type unless `extension` is given. */
  add(kind, name, blob, mimetype, properties = {}, extension) {
    this.counts[kind] += 1
    const n = this.counts[kind]
    const file = media(`${kind}_${n}`, `${name}-${n}${extension ?? extensionForMime(mimetype, kind === 'audio' ? '.m4a' : '.mp4')}`, blob, mimetype, properties)
    this.list.push(file)
    return file
  }

  get hasAV() {
    return this.list.some(isAV)
  }
}
