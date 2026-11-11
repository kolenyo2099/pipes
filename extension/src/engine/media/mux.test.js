import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny'
import { muxAV } from './mux.js'

// Synthetic fixtures (ffmpeg testsrc / sine, 1 second): a fragmented MP4 with only video, a WebM with only audio.
const fixture = (name) => new Blob([readFileSync(new URL(`./fixtures/${name}`, import.meta.url))])

describe('muxAV', () => {
  it('joins a video-only and an audio-only recording into one MP4 with both tracks', async () => {
    const out = []
    const writable = new WritableStream({ write: ({ data, position }) => { out.push({ data: data.slice(), position }) } })
    await muxAV(fixture('video-only.mp4'), fixture('audio-only.webm'), writable)
    const bytes = new Uint8Array(Math.max(...out.map((c) => c.position + c.data.length)))
    for (const c of out) bytes.set(c.data, c.position)
    const input = new Input({ source: new BlobSource(new Blob([bytes])), formats: ALL_FORMATS })
    expect((await input.getPrimaryVideoTrack()).codec).toBe('avc')
    expect((await input.getPrimaryAudioTrack()).codec).toBe('opus')
    expect(await input.computeDuration()).toBeCloseTo(1, 0)
  })
})
