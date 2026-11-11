// A recorded player hands over its video and its audio as two files (that is how adaptive streaming works).
// Copy both, without re-encoding, into the one MP4 people expect to play.
import { ALL_FORMATS, BlobSource, EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource, Input, Mp4OutputFormat, Output, StreamTarget } from 'mediabunny'

/** `writable` takes { type: 'write', data, position } chunks: an OPFS file's createWritable() does. */
export async function muxAV(video, audio, writable) {
  const open = (blob) => new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const v = await open(video).getPrimaryVideoTrack()
  const a = await open(audio).getPrimaryAudioTrack()
  if (!v?.codec || !a?.codec) throw new Error('no video or audio track to join')
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable, { chunked: true }) })
  const copy = async (track, source) => {
    let meta = { decoderConfig: await track.getDecoderConfig() }
    for await (const packet of new EncodedPacketSink(track).packets()) {
      await source.add(packet, meta)
      meta = undefined
    }
  }
  const vs = new EncodedVideoPacketSource(v.codec)
  const as = new EncodedAudioPacketSource(a.codec)
  output.addVideoTrack(vs)
  output.addAudioTrack(as)
  await output.start()
  await Promise.all([copy(v, vs), copy(a, as)])
  await output.finalize()
}
