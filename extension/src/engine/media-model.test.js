import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { extensionForMime, isAV, MediaFiles } from './media-model.js'
import { playsMedia } from './media-layer.js'
import { sha256Hex, sha256Stream } from './util.js'

describe('media model', () => {
  it('numbers files per kind and names them from the mime type or an explicit extension', () => {
    const files = new MediaFiles()
    files.add('video', 'embedded-media', new Blob(['a']), 'video/webm')
    files.add('video', 'hls-video', new Blob(['b']), 'video/mp2t', { capture_method: 'hls' }, '.ts')
    files.add('audio', 'embedded-media', new Blob(['c']), 'audio/mpeg')
    expect(files.list.map((f) => [f.id, f.name])).toEqual([
      ['video_1', 'embedded-media-1.webm'], ['video_2', 'hls-video-2.ts'], ['audio_1', 'embedded-media-1.mp3']
    ])
    expect(files.list[1].properties).toEqual({ capture_method: 'hls' })
    expect(files.hasAV).toBe(true)
    expect(new MediaFiles().hasAV).toBe(false)
  })

  it('knows extensions and what is audio/video', () => {
    expect(extensionForMime('video/mp4; codecs="avc1"')).toBe('.mp4')
    expect(extensionForMime('text/html', '.bin')).toBe('.bin')
    expect(isAV({ mimetype: 'audio/aac' })).toBe(true)
    expect(isAV({ mimetype: 'image/png' })).toBe(false)
  })

  it('runs the media layer only for pages that play media', () => {
    expect(playsMedia({ url: 'https://e.com/a' })).toBe(false)
    expect(playsMedia({ url: 'https://e.com/a', sources: ['https://e.com/v.mp4'] })).toBe(true)
    expect(playsMedia({ url: 'https://e.com/a', indicator: true })).toBe(true)
    expect(playsMedia({ url: 'https://x.com/u/status/1' })).toBe(true)
  })
})

describe('streaming SHA-256 (big media files)', () => {
  it('matches the platform digest for every padding boundary', async () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) & 255)
      expect(await sha256Stream(new Blob([bytes])), `size ${size}`).toBe(createHash('sha256').update(bytes).digest('hex'))
    }
  })

  it('sha256Hex of a small blob still uses the platform digest', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(createHash('sha256').update('abc').digest('hex'))
  })
})

import { mediaLine } from '../backend/evidenceQueue.js'
import { mediaSummary } from '../backend/evidence.js'
import { bestQualityImageUrl, isRelevantImageUrl } from './media/page-media.js'

describe('what the Archive view shows per item', () => {
  it('summarises saved media from the stored result', () => {
    const media = mediaSummary([
      { name: 'hls-video-1.ts', capture_method: 'hls', width: 1280, height: 720, source_urls: ['x'] },
      { name: 'embedded-media-1.webm', capture_method: 'direct', duration: 62, width: 640, height: 360 },
      { name: 'media_image_1.jpg', capture_method: 'direct', width: 800, height: 600 },
      { name: 'media_image_2.jpg', capture_method: 'direct' },
      { name: 'subtitles-1.vtt', capture_method: 'direct' }
    ])
    expect(media[0]).toEqual({ name: 'hls-video-1.ts', method: 'hls', width: 1280, height: 720 })
    expect(mediaLine({ result_metadata: { media } })).toBe('2 video/audio (1280x720 hls; 1:02 640x360 direct), 2 images, 1 caption file')
    expect(mediaLine({ result_metadata: {} })).toBe('')
  })

  it('image selection: originals, not icons or avatars', () => {
    expect(bestQualityImageUrl('https://pbs.twimg.com/media/a?format=jpg&name=small')).toContain('name=orig')
    expect(isRelevantImageUrl('https://x.com/profile_images/a.jpg')).toBe(true)
    expect(isRelevantImageUrl('https://pbs.twimg.com/profile_images/1/a.jpg')).toBe(false)
    expect(isRelevantImageUrl('https://e.com/logo.svg')).toBe(false)
  })
})

describe('embedded players', () => {
  it('lists player frames as openable addresses and sends YouTube embeds to the watch page', async () => {
    const { embedUrls } = await import('./media-layer.js')
    const dom = `<iframe src="https://www.youtube-nocookie.com/embed/abc123XYZ_-?rel=0"></iframe>
      <iframe width="560" src="//player.vimeo.com/video/42?h=1&amp;dnt=1"></iframe>
      <iframe src="/ads/frame.html"></iframe><iframe src="https://www.youtube.com/embed/abc123XYZ_-"></iframe>`
    expect(embedUrls(dom, 'https://news.example/story')).toEqual([
      'https://www.youtube.com/watch?v=abc123XYZ_-', 'https://player.vimeo.com/video/42?h=1&dnt=1'])
    expect(embedUrls('', 'https://news.example/')).toEqual([])
  })
})
