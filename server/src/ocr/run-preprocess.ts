/**
 * `npm run ocr:preprocess` — exercise + inspect the preprocessing pipeline.
 *
 *   npm run ocr:preprocess -- --check-orient            # detect orientation of page 1 of every fixture
 *   npm run ocr:preprocess -- --fixture=<f> --page=2 --out=/tmp   # write a preprocessed page to inspect
 *   npm run ocr:preprocess -- --compare-format --fixture=<f> --page=2   # PNG vs JPEG size
 */
import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { FIXTURES_DIR } from "./labels.js";
import {
  detectOrientation,
  orientationStats,
  preprocessPage,
  rasterizePdf,
  type ImageFormat,
  type Rotation,
} from "./preprocess.js";

const arg = (n: string, d = "") =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? d;
const has = (n: string) => process.argv.includes(`--${n}`);

async function checkOrient(): Promise<void> {
  const pdfs = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".pdf")).sort();
  console.log("Detected orientation of page 1 (degrees to rotate to upright):\n");
  for (const f of pdfs) {
    const [page1] = await rasterizePdf(resolve(FIXTURES_DIR, f), 150); // low DPI is enough to detect
    const deg = await detectOrientation(page1);
    if (has("debug")) {
      const s = await orientationStats(page1);
      const lead = (d: Rotation) => (s.perDeg[d].bottomInk - s.perDeg[d].topInk).toFixed(3);
      const shape = s.h > s.w ? "portrait" : "landscape";
      console.log(
        `  ${String(deg).padStart(3)}deg  ${f}  [raw ${s.w}x${s.h} ${shape}; bottom-top lead 0:${lead(0)} 90:${lead(90)} 180:${lead(180)} 270:${lead(270)}]`,
      );
    } else {
      console.log(`  ${String(deg).padStart(3)}deg  ${f}`);
    }
  }
}

async function compareFormat(fixture: string, page: number): Promise<void> {
  const pages = await rasterizePdf(resolve(FIXTURES_DIR, fixture), Number(arg("dpi", "300")));
  const raw = pages[page - 1];
  const png = await preprocessPage(raw, { orient: "auto", format: "png" });
  const jpeg = await preprocessPage(raw, { orient: "auto", format: "jpeg" });
  const kb = (b: Buffer) => `${(b.length / 1024).toFixed(0)} KB`;
  console.log(`${fixture} p${page} (rotation ${png.rotation}deg):`);
  console.log(`  PNG  ${kb(png.buffer)}   (lossless — recommended for text fidelity)`);
  console.log(`  JPEG ${kb(jpeg.buffer)}   (${((jpeg.buffer.length / png.buffer.length) * 100).toFixed(0)}% of PNG)`);
}

async function dumpPage(fixture: string, page: number): Promise<void> {
  const outDir = arg("out", "/tmp/ocr-preprocess");
  mkdirSync(outDir, { recursive: true });
  const format = (arg("format", "png") as ImageFormat);
  const orientArg = arg("orient", "auto");
  const orient = orientArg === "auto" ? "auto" : (Number(orientArg) as Rotation);
  const pages = await rasterizePdf(resolve(FIXTURES_DIR, fixture), Number(arg("dpi", "300")));
  const { buffer, rotation } = await preprocessPage(pages[page - 1], {
    orient,
    format,
    binarize: has("binarize"),
  });
  const dest = resolve(outDir, `${fixture.replace(/\.pdf$/, "")}-p${page}.${format}`);
  writeFileSync(dest, buffer);
  console.log(`wrote ${dest} (rotation ${rotation}deg, ${(buffer.length / 1024).toFixed(0)} KB)`);
}

async function main(): Promise<void> {
  if (has("check-orient")) return checkOrient();
  const fixture = arg("fixture");
  const page = Number(arg("page", "1"));
  if (!fixture) {
    console.log("Specify --check-orient, or --fixture=<name.pdf> [--page=N] [--compare-format].");
    return;
  }
  if (has("compare-format")) return compareFormat(fixture, page);
  return dumpPage(fixture, page);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
