import { db } from "../db.js";
import { isArtifactTicker } from "../util/parse.js";

/**
 * Null out artifact "tickers" (name/legal fragments OCR misread as a symbol — "THE", "COM", …) on
 * existing trades, so they stop surfacing as real holdings in the app/API. The trade itself is kept
 * (asset_name is intact); only the bogus ticker is dropped. Idempotent.
 *   npm run clean:tickers            # dry-run (report only)
 *   npm run clean:tickers -- --apply # write the changes
 */

const apply = process.argv.includes("--apply");

const rows = db
  .prepare(`SELECT id, ticker FROM trades WHERE ticker IS NOT NULL AND ticker <> ''`)
  .all() as { id: number; ticker: string }[];

const bad = rows.filter((r) => isArtifactTicker(r.ticker));
const byTicker = bad.reduce<Record<string, number>>((m, r) => {
  const k = r.ticker.toUpperCase();
  m[k] = (m[k] ?? 0) + 1;
  return m;
}, {});

console.log(`Scanned ${rows.length} tickered trades; ${bad.length} have artifact tickers:`);
console.log("  " + (Object.entries(byTicker).map(([k, v]) => `${k}=${v}`).join(" · ") || "(none)"));

if (!bad.length) {
  console.log("Nothing to clean.");
} else if (!apply) {
  console.log("\nDry-run — re-run with `-- --apply` to null these tickers.");
} else {
  const upd = db.prepare(`UPDATE trades SET ticker = NULL WHERE id = ?`);
  const txn = db.transaction((ids: number[]) => ids.forEach((id) => upd.run(id)));
  txn(bad.map((r) => r.id));
  console.log(`\nNulled ${bad.length} artifact ticker(s).`);
}
