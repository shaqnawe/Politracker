import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractedFiling, OcrProvider } from "./types.js";

/**
 * Disk cache for (paid) vision extractions, keyed by provider + a label and a hash of the exact
 * page images. The image hash means the cache self-invalidates if preprocessing changes, so a
 * stale extraction never silently scores against new inputs. Lets the eval/confidence harnesses
 * re-run for free while iterating on the scorer.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname, ".cache");

export async function cachedExtract(
  provider: OcrProvider,
  key: string,
  images: Buffer[],
): Promise<ExtractedFiling> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const h = createHash("sha1");
  for (const img of images) h.update(img);
  const safeKey = key.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const file = resolve(CACHE_DIR, `${provider.name}__${safeKey}__${h.digest("hex").slice(0, 12)}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as ExtractedFiling;
  const extracted = await provider.extract(images);
  writeFileSync(file, JSON.stringify(extracted, null, 2));
  return extracted;
}
