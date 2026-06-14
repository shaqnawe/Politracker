import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { setSymbolCoverage, upsertBars, type PriceBar } from "./db.js";

/**
 * Pre-warm the price cache (`price_bars`) from CSV you supply, so the analysis models run offline.
 * Two input shapes:
 *   --dir=<path>   a directory of per-symbol files (SYMBOL.csv: Date + Adj Close/Close columns)
 *   --file=<path>  a single CSV with a Symbol column (Symbol,Date,Adj Close/Close)
 * See server/data/prices/README.md for the format. Idempotent (upserts).
 */

interface Args {
  dir?: string;
  file?: string;
}
function parseArgs(argv: string[]): Args {
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  return { dir: get("dir"), file: get("file") };
}

function col(header: string[], ...names: string[]): number {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

/** Parse a per-symbol CSV (Date + close column). `#` lines ignored. */
function parsePerSymbol(text: string): PriceBar[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const di = col(header, "date");
  const ci = col(header, "adj close", "adjclose", "adj_close", "close");
  const vi = col(header, "volume");
  if (di < 0 || ci < 0) return [];
  const out: PriceBar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    const date = (c[di] ?? "").trim().slice(0, 10);
    const close = Number(c[ci]);
    const vol = vi >= 0 ? Number(c[vi]) : NaN;
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(close) && close > 0)
      out.push({ date, close, volume: Number.isFinite(vol) && vol > 0 ? vol : null });
  }
  return out;
}

/** Parse a multi-symbol CSV (Symbol + Date + close column) → bars grouped by symbol. */
function parseMultiSymbol(text: string): Map<string, PriceBar[]> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  const groups = new Map<string, PriceBar[]>();
  if (lines.length < 2) return groups;
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const si = col(header, "symbol", "ticker");
  const di = col(header, "date");
  const ci = col(header, "adj close", "adjclose", "adj_close", "close");
  const vi = col(header, "volume");
  if (si < 0 || di < 0 || ci < 0) return groups;
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    const sym = (c[si] ?? "").trim().toUpperCase();
    const date = (c[di] ?? "").trim().slice(0, 10);
    const close = Number(c[ci]);
    if (!sym || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close) || close <= 0) continue;
    const vol = vi >= 0 ? Number(c[vi]) : NaN;
    (groups.get(sym) ?? groups.set(sym, []).get(sym)!).push({ date, close, volume: Number.isFinite(vol) && vol > 0 ? vol : null });
  }
  return groups;
}

function loadSymbol(symbol: string, bars: PriceBar[]): number {
  bars.sort((a, b) => a.date.localeCompare(b.date));
  if (!bars.length) return 0;
  upsertBars(symbol, "csv", bars);
  setSymbolCoverage({
    symbol,
    source: "csv",
    status: "ok",
    first_date: bars[0].date,
    last_date: bars[bars.length - 1].date,
  });
  return bars.length;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let symbols = 0;
  let rows = 0;

  if (args.file) {
    if (!existsSync(args.file)) throw new Error(`no such file: ${args.file}`);
    const groups = parseMultiSymbol(readFileSync(args.file, "utf8"));
    for (const [sym, bars] of groups) {
      const n = loadSymbol(sym, bars);
      if (n) { symbols++; rows += n; console.log(`  ${sym}: ${n} bars (${bars[0].date}…${bars[bars.length - 1].date})`); }
    }
  } else {
    const dir = args.dir ?? join(process.cwd(), "data/prices");
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`no such dir: ${dir}`);
    for (const f of readdirSync(dir)) {
      if (!f.toLowerCase().endsWith(".csv")) continue;
      const sym = f.slice(0, -4).toUpperCase();
      const bars = parsePerSymbol(readFileSync(join(dir, f), "utf8"));
      const n = loadSymbol(sym, bars);
      if (n) { symbols++; rows += n; console.log(`  ${sym}: ${n} bars (${bars[0].date}…${bars[bars.length - 1].date})`); }
      else console.log(`  ${sym}: skipped (no parseable Date + close columns)`);
    }
  }

  console.log(`\nImported ${rows} bars across ${symbols} symbol(s) into price_bars.`);
  if (!symbols) console.log("Nothing imported — check the path and CSV columns (see server/data/prices/README.md).");
}

main();
