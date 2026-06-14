/**
 * One-off migration: re-slug every member to the district-less id produced by the updated
 * `memberSlug` (chamber + name + state, no district) and merge any members that collapse to
 * the same id — i.e. the same person split across districts by redistricting (Pelosi CA-12 ->
 * CA-11). Reassigns all child rows (filings, trades, news_items) to the canonical id.
 *
 * Idempotent: members already at their new id are skipped. Run with:
 *   npx tsx src/scripts/dedupe-members.ts            (apply)
 *   npx tsx src/scripts/dedupe-members.ts --dry-run  (report only, no writes)
 */
import { db } from "../db.js";
import { memberSlug } from "../util/parse.js";

const dryRun = process.argv.includes("--dry-run");

interface MemberRow {
  id: string;
  chamber: string;
  first_name: string;
  last_name: string;
  full_name: string;
  state: string | null;
  district: string | null;
  party: string | null;
  source_url: string | null;
  first_seen: string;
  last_seen: string;
}

const members = db.prepare(`SELECT * FROM members`).all() as MemberRow[];

// Group members by the id the updated slug would assign them.
const groups = new Map<string, MemberRow[]>();
for (const m of members) {
  const newId = memberSlug(m.chamber, m.first_name, m.last_name, m.state, m.district);
  (groups.get(newId) ?? groups.set(newId, []).get(newId)!).push(m);
}

const maxFiled = db.prepare(`SELECT MAX(filed_date) AS d, COUNT(*) AS n FROM filings WHERE member_id = ?`);
const reassignFilings = db.prepare(`UPDATE filings    SET member_id = ? WHERE member_id = ?`);
const reassignTrades = db.prepare(`UPDATE trades     SET member_id = ? WHERE member_id = ?`);
const reassignNews = db.prepare(`UPDATE news_items SET member_id = ? WHERE member_id = ?`);
const deleteMember = db.prepare(`DELETE FROM members WHERE id = ?`);
const updateMember = db.prepare(
  `UPDATE members SET district = ?, source_url = COALESCE(?, source_url) WHERE id = ?`,
);
const insertMember = db.prepare(`
  INSERT INTO members (id, chamber, first_name, last_name, full_name, state, district, party,
                       source_url, first_seen, last_seen)
  VALUES (@id, @chamber, @first_name, @last_name, @full_name, @state, @district, @party,
          @source_url, @first_seen, @last_seen)
`);

/** Within a redistricting group, the canonical row is the one with the most recent filing
 *  (its district is the member's current seat); ties break to the higher district number. */
function pickCanonical(rows: MemberRow[]): MemberRow {
  let canonical = rows[0];
  let bestDate = "";
  for (const r of rows) {
    const info = maxFiled.get(r.id) as { d: string | null; n: number };
    const d = info.d ?? "";
    if (d > bestDate || (d === bestDate && (r.district ?? "") > (canonical.district ?? ""))) {
      bestDate = d;
      canonical = r;
    }
  }
  return canonical;
}

let reslugged = 0;
let mergedGroups = 0;

const migrate = db.transaction(() => {
  for (const [newId, rows] of groups) {
    const isNoop = rows.length === 1 && rows[0].id === newId;
    if (isNoop) continue;

    const canonical = pickCanonical(rows);
    const oldIds = rows.map((r) => r.id);
    const counts = rows.map((r) => {
      const info = maxFiled.get(r.id) as { n: number };
      return `${r.id}(${info.n}f, d=${r.district ?? "-"})`;
    });
    console.log(`${newId}  <=  ${counts.join(", ")}   keep district=${canonical.district ?? "-"}`);

    if (!dryRun) {
      // The canonical id may ALREADY exist as one of the group's rows (e.g. an idempotent re-run,
      // or a scrape that re-created an old-slug row mid-migration). If so, keep it and just refresh
      // its district; otherwise insert it. Then move children off every OTHER id and drop them.
      const existing = rows.find((r) => r.id === newId);
      if (existing) updateMember.run(canonical.district, canonical.source_url, newId);
      else insertMember.run({ ...canonical, id: newId });

      for (const old of oldIds) {
        if (old === newId) continue;
        reassignFilings.run(newId, old);
        reassignTrades.run(newId, old);
        reassignNews.run(newId, old);
      }
      for (const old of oldIds) {
        if (old === newId) continue;
        deleteMember.run(old);
      }
    }

    reslugged += oldIds.length;
    if (rows.length > 1) mergedGroups += 1;
  }
});

migrate();

console.log(
  `\n${dryRun ? "[dry-run] would re-slug" : "Re-slugged"} ${reslugged} member id(s); ` +
    `merged ${mergedGroups} duplicate group(s).`,
);
if (dryRun) console.log("No changes written (--dry-run).");
