// Records the bytes a page's player appends to its Media Source Extensions
// buffers. The player has already resolved signatures, tokens and manifests, so
// what it appends is the media as the server sent it, whatever the site's
// obfuscation. DRM-protected media arrives encrypted and cannot be used.
//
// capture.js registers this in every frame (MAIN world, document_start) only
// while a recording runs, and reads it back with executeScript. A caller that
// drains while recording (the HRC Archiver engine) keeps page memory small:
// drained chunks are released, and duplicates are recognised by fingerprint.
// ponytail: MSE inside workers (MediaSourceHandle) is not hooked; add when a site needs it.
(() => {
  if (window.__hrcMse) return;
  const MAX_BYTES = 3_000_000_000;
  const READ_BYTES = 8_000_000; // per executeScript round trip, sent as base64
  const records = [];
  const bySourceBuffer = new WeakMap();
  let total = 0;
  let held = 0; // recorded and not yet drained
  let truncated = false;
  let stopped = false;

  const tag = (b) => String.fromCharCode(b[4], b[5], b[6], b[7]);
  // An init segment starts a new encoding: fMP4 ftyp/moov, or a WebM EBML header.
  const isInit = (b) =>
    (b.length >= 8 && (tag(b) === 'ftyp' || tag(b) === 'moov')) ||
    (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3);
  const same = (a, b) => a && a.length === b.length && a.every((v, i) => v === b[i]);
  // Two 32-bit FNV-1a style passes with different multipliers, plus the length:
  // enough to recognise a re-appended segment without keeping its bytes.
  const fingerprint = (b) => {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193 ^ b.length;
    for (let i = 0; i < b.length; i += 1) {
      h1 = Math.imul(h1 ^ b[i], 0x01000193);
      h2 = Math.imul(h2 ^ b[i], 0x5bd1e995);
    }
    return `${b.length}:${h1 >>> 0}:${h2 >>> 0}`;
  };
  const newRun = (first) => ({ chunks: first ? [first] : [], bytes: first?.length ?? 0, hasInit: Boolean(first), drained: 0, seen: new Set() });
  const toBase64 = (parts) => {
    let binary = '';
    for (const part of parts) {
      for (let i = 0; i < part.length; i += 0x8000) binary += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  };
  const copy = (data) =>
    data instanceof ArrayBuffer
      ? new Uint8Array(data.slice(0))
      : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));

  const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mimeType) {
    const sourceBuffer = addSourceBuffer.call(this, mimeType);
    const record = { mimeType, init: null, runs: [] };
    records.push(record);
    bySourceBuffer.set(sourceBuffer, record);
    return sourceBuffer;
  };

  const appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const record = bySourceBuffer.get(this);
    if (record && !stopped && !truncated) {
      const bytes = copy(data);
      if (isInit(bytes)) {
        // Players re-append the same init on seeks; only a different one (a
        // quality switch) starts a new run. Each run is one playable file.
        if (!same(record.init, bytes)) {
          record.init = bytes;
          record.runs.push(newRun(bytes));
        } else return appendBuffer.call(this, data);
      } else {
        if (!record.runs.length) record.runs.push(newRun(null));
        const run = record.runs.at(-1);
        // Media segments carry their own timestamps, so a byte-identical chunk
        // is the same segment appended again after a seek or a buffer flush.
        // Keeping it would put time going backwards into the file.
        const print = fingerprint(bytes);
        if (run.seen.has(print)) return appendBuffer.call(this, data);
        run.seen.add(print);
        run.chunks.push(bytes);
        run.bytes += bytes.length;
      }
      total += bytes.length;
      held += bytes.length;
      if (held > MAX_BYTES) truncated = true;
    }
    return appendBuffer.call(this, data);
  };

  window.__hrcMse = {
    totalBytes: () => total,
    summary: () => ({
      truncated,
      buffers: records.map((record) => ({
        mimeType: record.mimeType,
        runs: record.runs.map((run) => ({ bytes: run.bytes, chunks: run.chunks.length, hasInit: run.hasInit }))
      }))
    }),
    read(buffer, run, from) {
      const chunks = records[buffer].runs[run].chunks;
      const parts = [];
      let size = 0;
      let index = from;
      while (index < chunks.length && (size === 0 || size + chunks[index].length <= READ_BYTES)) {
        parts.push(chunks[index]);
        size += chunks[index].length;
        index += 1;
      }
      return { data: toBase64(parts), next: index < chunks.length ? index : null };
    },
    /** The next undrained bytes of a run, released from the page once handed over. */
    drain(buffer, run) {
      const target = records[buffer].runs[run];
      const parts = [];
      let size = 0;
      while (target.drained < target.chunks.length && (size === 0 || size + target.chunks[target.drained].length <= READ_BYTES)) {
        const chunk = target.chunks[target.drained];
        parts.push(chunk);
        size += chunk.length;
        held -= chunk.length;
        target.chunks[target.drained] = null;
        target.drained += 1;
      }
      return { data: parts.length ? toBase64(parts) : '', more: target.drained < target.chunks.length };
    },
    stop() {
      stopped = true;
      for (const record of records) record.runs = [];
      total = 0;
      held = 0;
    }
  };
})();
