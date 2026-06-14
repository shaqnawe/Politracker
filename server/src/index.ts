import cors from "cors";
import express from "express";
import { db } from "./db.js";
import { jobsHealth } from "./agents/db.js";
import { agentsRouter } from "./agents/api.js";
import { membersRouter } from "./api/members.js";
import { tradesRouter } from "./api/trades.js";

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM members) AS members,
         (SELECT COUNT(*) FROM filings) AS filings,
         (SELECT COUNT(*) FROM trades)  AS trades`,
    )
    .get();
  res.json({ status: "ok", counts });
});

// Aggregate stats for a simple home/overview screen.
app.get("/api/stats", (_req, res) => {
  const topTickers = db
    .prepare(
      `SELECT ticker, COUNT(*) AS count FROM trades
       WHERE ticker IS NOT NULL GROUP BY ticker ORDER BY count DESC LIMIT 10`,
    )
    .all();
  const topMembers = db
    .prepare(
      `SELECT m.id, m.full_name AS fullName, m.chamber, COUNT(t.id) AS tradeCount
       FROM members m JOIN trades t ON t.member_id = m.id
       GROUP BY m.id ORDER BY tradeCount DESC LIMIT 10`,
    )
    .all();
  res.json({ topTickers, topMembers });
});

// Orchestrator status: each agent job's freshness + recent runs (Phase 1 of the agents system).
app.get("/api/health/jobs", (_req, res) => {
  res.json(jobsHealth());
});

app.use("/api/members", membersRouter);
app.use("/api/trades", tradesRouter);
// Agents/context read API: /api/companies/:ticker and /api/members/:id/context.
app.use("/api", agentsRouter);

app.listen(PORT, () => {
  console.log(`PoliTracker API listening on http://localhost:${PORT}`);
});
