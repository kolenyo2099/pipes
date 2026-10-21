// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p) => readFileSync(resolve(__dirname, '../public', p), 'utf8');

describe('capture content script (Google)', () => {
  it('sends per-row and save-all items through pipeline:save', async () => {
    const sent = [];
    globalThis.chrome = {
      runtime: { id: 'x', sendMessage: vi.fn(async (m) => { sent.push(m.item); return { ok: true, queued: true }; }) }
    };
    window.history.replaceState({}, '', '/search?q=cats');
    document.body.innerHTML = `<div id="center_col"><div id="rso">
      <div class="g"><a href="https://a.example/1"><h3>Alpha</h3></a><div class="VwiC3b">snip a</div></div>
      <div class="g"><a href="https://b.example/2"><h3>Beta</h3></a><div class="VwiC3b">snip b</div></div>
    </div></div>`;
    Object.defineProperty(globalThis, 'location', { value: window.location, configurable: true });
    const observers = [];
    const RealMO = globalThis.MutationObserver;
    globalThis.MutationObserver = class extends RealMO { constructor(cb) { super(cb); observers.push(this); } };
    (0, eval)(read('capture/content.js'));
    globalThis.MutationObserver = RealMO;

    const rowBtns = document.querySelectorAll('.sts-save-btn');
    expect(rowBtns.length).toBe(2);
    rowBtns[0].click();
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toMatchObject({
      kind: 'capture', key: 'cats|https://a.example/1',
      capture: { sourceType: 'google', url: 'https://a.example/1', title: 'Alpha', query: 'cats', position: '1', snippet: 'snip a' }
    });
    expect(sent[0].capture.savedBy).toBeUndefined();
    await vi.waitFor(() => expect(rowBtns[0].textContent).toBe('✅'));

    document.querySelector('.sts-save-all-btn').click();
    await vi.waitFor(() => expect(sent.length).toBe(2)); // row 0 is already saved
    expect(sent[1]).toMatchObject({ key: 'cats|https://b.example/2', capture: { sourceType: 'google', title: 'Beta', position: '2' } });
    observers.forEach((o) => o.disconnect()); // avoid callbacks after env teardown
  });
});

describe('capture-bg', () => {
  let onClicked, enqueue;
  beforeEach(() => {
    enqueue = vi.fn(async () => ({ ok: true, queued: true }));
    globalThis.pipelineEnqueue = enqueue;
    globalThis.chrome = {
      runtime: { onMessage: { addListener: vi.fn() }, onInstalled: { addListener: vi.fn() }, getURL: (p) => p },
      windows: { onRemoved: { addListener: vi.fn() }, create: vi.fn(), remove: vi.fn() },
      storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(), remove: vi.fn() } },
      contextMenus: { create: vi.fn(), removeAll: vi.fn(), onClicked: { addListener: (f) => { onClicked = f; } } },
      scripting: { executeScript: vi.fn(async ({ func }) => [{ result: func.toString().includes('__pipelineContext') ? 'Link text' : undefined }]) }
    };
    (0, eval)(read('capture-bg.js'));
  });

  it('enqueues a link capture with the tracked link text', async () => {
    await onClicked({ menuItemId: 'pipeline-save-link', linkUrl: 'https://x.example/a' }, { id: 7, url: 'https://p.example/', title: 'P' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const { kind, capture } = enqueue.mock.calls[0][0];
    expect(kind).toBe('capture');
    expect(capture).toMatchObject({ sourceType: 'link', url: 'https://x.example/a', title: 'Link text', domain: 'x.example' });
  });
});
