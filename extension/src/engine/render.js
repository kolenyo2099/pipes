// Pixel statistics for the blank-render check, matching utils/png_stats.py:
// the share of sampled pixels that are the single most common colour, over a
// bounded band from the top of the image, every 4th pixel of each row.

const PIXEL_BUDGET = 1_200_000;
const SAMPLE_STEP = 4;

export async function dominantColourFraction(blob) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null; // undecodable means "unknown", never "blank"
  }
  const { width, height } = bitmap;
  if (!width || !height) return null;
  const rows = Math.max(1, Math.min(height, Math.floor(PIXEL_BUDGET / width)));
  const canvas = new OffscreenCanvas(width, rows);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = new Uint32Array(context.getImageData(0, 0, width, rows).data.buffer);
  const counts = new Map();
  let total = 0;
  let top = 0;
  for (let y = 0; y < rows; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += SAMPLE_STEP) {
      const colour = pixels[row + x];
      const count = (counts.get(colour) ?? 0) + 1;
      counts.set(colour, count);
      if (count > top) top = count;
      total += 1;
    }
  }
  if (!total) return null;
  return top / total;
}
