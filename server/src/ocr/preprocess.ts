import { pdf } from "pdf-to-img";
import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { resolve } from "node:path";
import { FIXTURES_DIR } from "./labels.js";

/**
 * Turn a scanned PTR PDF into clean, upright page images for the vision extractors.
 *
 * Steps: rasterize at 300+ DPI -> auto-orient (scanned pages are often rotated, and the
 * rotation varies per filing) -> grayscale + contrast (optionally binarize). Output PNG
 * (lossless, best for text) or JPEG (smaller). Implemented with @napi-rs/canvas only — no
 * native system deps. Fine-angle deskew is deferred: the vision models tolerate small skew,
 * and the confidence gate (STEP 5/6) catches pages that still read poorly.
 */

export type Rotation = 0 | 90 | 180 | 270;
export type ImageFormat = "png" | "jpeg";

export interface PreprocessOptions {
  dpi?: number; // default 300
  orient?: Rotation | "auto"; // default "auto"
  binarize?: boolean; // default false: grayscale + contrast. true: Otsu black/white
  format?: ImageFormat; // default "png"
  pages?: number[]; // 1-based page numbers to keep; default all (used by the eval harness)
}

const DPI_BASE = 72;
type Cv = Canvas;

export async function rasterizePdf(
  src: string | Buffer,
  dpi = 300,
  pages?: number[],
): Promise<Buffer[]> {
  const want = pages && pages.length ? new Set(pages) : null;
  const maxPage = want ? Math.max(...pages!) : Infinity;
  const doc = await pdf(src, { scale: dpi / DPI_BASE });
  const out: Buffer[] = [];
  let i = 0;
  for await (const page of doc) {
    i++;
    if (!want || want.has(i)) out.push(page as Buffer);
    if (i >= maxPage) break;
  }
  return out;
}

async function toCanvas(buf: Buffer): Promise<Cv> {
  const img = await loadImage(buf);
  const c = createCanvas(img.width, img.height);
  c.getContext("2d").drawImage(img, 0, 0);
  return c;
}

function rotateCanvas(src: Cv, deg: Rotation): Cv {
  if (deg === 0) return src;
  const swap = deg === 90 || deg === 270;
  const w = swap ? src.height : src.width;
  const h = swap ? src.width : src.height;
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

function toGray(canvas: Cv): { gray: Uint8Array; w: number; h: number } {
  const w = canvas.width;
  const h = canvas.height;
  const d = canvas.getContext("2d").getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    gray[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
  }
  return { gray, w, h };
}

/** Otsu's method: threshold that best separates ink from paper. */
function otsuThreshold(gray: Uint8Array): number {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let max = 0;
  let thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > max) {
      max = between;
      thr = t;
    }
  }
  return thr;
}

function downscale(canvas: Cv, maxDim = 1000): Cv {
  const scale = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
  if (scale === 1) return canvas;
  const c = createCanvas(Math.round(canvas.width * scale), Math.round(canvas.height * scale));
  c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
  return c;
}

export interface OrientStats {
  w: number;
  h: number;
  perDeg: Record<Rotation, { topInk: number; bottomInk: number }>;
}

/** Ink density in the top vs bottom half of the page, per candidate rotation. */
export async function orientationStats(buf: Buffer): Promise<OrientStats> {
  const base = await toCanvas(buf);
  const small = downscale(base, 1000);
  const perDeg = {} as OrientStats["perDeg"];
  for (const deg of [0, 90, 180, 270] as Rotation[]) {
    const { gray, w, h } = toGray(rotateCanvas(small, deg));
    const thr = otsuThreshold(gray);
    const half = Math.max(1, Math.floor(h / 2));
    let top = 0;
    let bottom = 0;
    for (let y = 0; y < h; y++) {
      let c = 0;
      for (let x = 0; x < w; x++) if (gray[y * w + x] < thr) c++;
      if (y < half) top += c;
      else bottom += c;
    }
    perDeg[deg] = { topInk: top / (half * w), bottomInk: bottom / ((h - half) * w) };
  }
  return { w: base.width, h: base.height, perDeg };
}

/**
 * Detect upright orientation in two robust steps:
 *  1. The landscape/portrait axis from raw aspect ratio — a portrait raster (the common
 *     case: a landscape form rotated onto a portrait page) must rotate 90deg to read; a
 *     landscape raster is already on-axis. This fixes the dominant 90deg error and, unlike a
 *     projection profile, isn't fooled by the form's grid rules.
 *  2. The 180deg flip within that axis: PTRs put the title/name block at the top and the
 *     dense transaction grid below, so the upright option usually has more ink in the BOTTOM
 *     half. This is BEST-EFFORT — it's reliable on the standard single-filer forms but can
 *     coin-flip on pages with no top/bottom asymmetry (near-empty "nothing to report" pages,
 *     and uniformly-dense trust-grid pages). The STEP 4 vision extractor is the real backstop:
 *     it's prompted to read regardless of rotation, and the confidence gate catches failures.
 *     Callers can pass an explicit `orient` to override when the correct rotation is known.
 */
export async function detectOrientation(buf: Buffer): Promise<Rotation> {
  const s = await orientationStats(buf);
  const pair: [Rotation, Rotation] = s.h > s.w ? [90, 270] : [0, 180];
  const lead = (d: Rotation) => s.perDeg[d].bottomInk - s.perDeg[d].topInk;
  return lead(pair[0]) >= lead(pair[1]) ? pair[0] : pair[1];
}

function enhance(canvas: Cv, binarize: boolean): Cv {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    gray[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
  }
  const thr = otsuThreshold(gray);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    let v = gray[j];
    if (binarize) v = v < thr ? 0 : 255;
    else v = v < thr ? Math.max(0, v - 40) : Math.min(255, v + 40); // widen ink/paper gap
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function encode(canvas: Cv, format: ImageFormat): Buffer {
  return format === "jpeg" ? canvas.toBuffer("image/jpeg") : canvas.toBuffer("image/png");
}

/** Orient + enhance a single rasterized page. Returns the image and the rotation applied. */
export async function preprocessPage(
  buf: Buffer,
  opts: PreprocessOptions = {},
): Promise<{ buffer: Buffer; rotation: Rotation }> {
  const orient = opts.orient ?? "auto";
  const rotation = orient === "auto" ? await detectOrientation(buf) : orient;
  let canvas = rotateCanvas(await toCanvas(buf), rotation);
  // Cap the long edge at 1568px: it's the max the vision models use internally (so no accuracy
  // loss vs 300 DPI), it keeps each image under the API's 2000px many-image limit for multi-page
  // filings, and it cuts token cost.
  canvas = downscale(canvas, 1568);
  canvas = enhance(canvas, opts.binarize ?? false);
  return { buffer: encode(canvas, opts.format ?? "png"), rotation };
}

/**
 * Full path for any PDF (a file path or in-memory bytes) -> preprocessed, upright page images,
 * which is exactly what the vision extractors consume. The runner (STEP 7) feeds it the live
 * downloaded PDF buffer; the eval harness feeds it fixture paths via loadFixturePages.
 */
export async function loadPdfPages(src: string | Buffer, opts: PreprocessOptions = {}): Promise<Buffer[]> {
  const pages = await rasterizePdf(src, opts.dpi ?? 300, opts.pages);
  const out: Buffer[] = [];
  for (const page of pages) out.push((await preprocessPage(page, opts)).buffer);
  return out;
}

/** Full path: a fixture PDF -> preprocessed, upright page images (what the extractors consume). */
export async function loadFixturePages(fixture: string, opts: PreprocessOptions = {}): Promise<Buffer[]> {
  return loadPdfPages(resolve(FIXTURES_DIR, fixture), opts);
}
