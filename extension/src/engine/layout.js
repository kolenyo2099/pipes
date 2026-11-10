// Two page-layout probes ported from HRC desktop's browser_capture.py (commits 8b6f0b1 and f5863b4):
// text that has a layout box but is hidden by opacity/visibility, and app shells whose main panel scrolls
// inside a one-screen document. The probes run in the page (each is self-contained: it is serialized);
// the decisions around them are plain functions so they are testable without a browser.

// SSR animation libraries can hide a complete article until JS reveals it. Count text with layout boxes, not
// HTML source text: display:none menus, templates and off-canvas controls are intentionally absent from a render.
export function textVisibilityProbe() {
  const opacity = new WeakMap()
  const transparent = (el) => {
    if (!el) return false
    if (!opacity.has(el)) opacity.set(el, Number(getComputedStyle(el).opacity) <= 0.01 || transparent(el.parentElement))
    return opacity.get(el)
  }
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let visible = 0, hidden = 0, visited = 0
  for (let node; (node = walker.nextNode()) && visited++ < 20000;) {
    const text = node.textContent.trim()
    const el = node.parentElement
    if (!text || !el || el.closest('script, style, noscript, template')) continue
    range.selectNodeContents(node)
    const rects = [...range.getClientRects()]
    if (!rects.some((r) => r.width > 1 && r.height > 1 && r.right > 0 && r.left < innerWidth && r.bottom + scrollY > 0)) continue
    const style = getComputedStyle(el)
    if (style.visibility !== 'visible' || transparent(el)) hidden += text.length
    else visible += text.length
  }
  return { visible, hidden }
}

// How much a large viewport-bound scroller holds beyond its own height.
export function scrollContainerProbe(referenceHeight) {
  let extra = 0
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width < innerWidth * 0.35 || el.clientHeight < (referenceHeight || innerHeight) * 0.5 ||
      r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue
    const style = getComputedStyle(el)
    if (!['auto', 'scroll'].includes(style.overflowY) || style.visibility !== 'visible') continue
    extra = Math.max(extra, el.scrollHeight - el.clientHeight)
  }
  return { extra, height: innerHeight + extra }
}

export const MAX_EXPANDED_VIEWPORT = 30_000

/**
 * Reveal a large viewport-bound scroller by growing the viewport, without touching site CSS. Keeps the larger
 * viewport only if it removed the clipping; fixed-height panels and unbounded feeds go back to `originalHeight`.
 * Returns the height used (recorded as provenance) or null. `probe(referenceHeight)`, `setHeight(h)` and
 * `wait(ms)` are the page operations.
 */
export async function expandScrollContainer({ probe, setHeight, wait, originalHeight, max = MAX_EXPANDED_VIEWPORT }) {
  const before = await probe()
  if (!before || typeof before.extra !== 'number' || before.extra <= 100) return null
  let after = before
  let height = originalHeight
  try {
    for (let round = 0; round < 3; round += 1) {
      height = Math.min(Math.floor(after.height) + 2, max)
      if (height <= originalHeight) {
        await setHeight(originalHeight)
        return null
      }
      await setHeight(height)
      await wait(500)
      after = await probe(originalHeight)
      if (after.extra <= 1 || height === max) break
    }
  } catch (error) {
    await setHeight(originalHeight)
    throw error
  }
  if (after.extra > 1) {
    await setHeight(originalHeight)
    return null
  }
  return height
}
