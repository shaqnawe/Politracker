import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExpectedFiling } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const LABELS_DIR = resolve(__dirname, "labels");
export const FIXTURES_DIR = resolve(__dirname, "fixtures");

/** Load all hand-labeled fixtures. Skips the README and `_`-prefixed scratch files. */
export function loadLabels(): ExpectedFiling[] {
  return readdirSync(LABELS_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .sort()
    .map((f) => JSON.parse(readFileSync(resolve(LABELS_DIR, f), "utf8")) as ExpectedFiling);
}
