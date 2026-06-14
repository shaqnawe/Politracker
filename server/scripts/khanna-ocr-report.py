#!/usr/bin/env python3
"""Ad-hoc report: Khanna OCR backfill success-rate + confidence breakdown.

Reads the live SQLite DB. Distinguishes auto-accepted trades (cleared the gate)
from review_queue rows (parked), and within review_queue splits per-trade rows
from filing-level failure notes. Reports row-level accept rate and confidence.
"""
import json
import sqlite3
import sys

DB = sys.argv[1] if len(sys.argv) > 1 else "data/politracker.db"
MEMBER = "house-khanna-rohit-ca"

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row

# Filings ingested for Khanna (OCR).
filings = con.execute(
    "SELECT id, source, ocr_provider FROM filings WHERE member_id=?", (MEMBER,)
).fetchall()
filing_ids = [f["id"] for f in filings]

# Auto-accepted trades.
trades = con.execute(
    "SELECT ticker, asset_name, tx_type, amount_label, ocr_confidence, ocr_provider, filing_id "
    "FROM trades WHERE member_id=?",
    (MEMBER,),
).fetchall()

# Review queue rows (unresolved) for Khanna's filings.
rq = con.execute(
    """SELECT rq.id, rq.confidence, rq.raw_json, rq.reasons, rq.provider, rq.filing_id
       FROM review_queue rq JOIN filings f ON f.id = rq.filing_id
       WHERE f.member_id=? AND rq.resolved=0""",
    (MEMBER,),
).fetchall()

per_trade, filing_level = [], []
for r in rq:
    try:
        raw = json.loads(r["raw_json"])
    except Exception:
        filing_level.append(r)
        continue
    if not raw or raw.get("filing") or (not raw.get("transaction_type") and not raw.get("amount_label")):
        filing_level.append(r)
    else:
        per_trade.append((r, raw))

accepted = len(trades)
parked_rows = len(per_trade)
total_rows = accepted + parked_rows
accept_rate = (accepted / total_rows * 100) if total_rows else 0.0

filings_with_accept = len({t["filing_id"] for t in trades})

print("=" * 64)
print("KHANNA OCR BACKFILL — SUCCESS RATE & CONFIDENCE")
print("=" * 64)
print(f"Filings ingested (OCR):        {len(filing_ids)}")
print(f"  …with >=1 accepted trade:    {filings_with_accept}")
print()
print("ROW-LEVEL (the headline):")
print(f"  Trade rows extracted:        {total_rows}")
print(f"  Auto-accepted (-> trades):   {accepted}")
print(f"  Parked (-> unverified):      {parked_rows}")
print(f"  ACCEPT RATE:                 {accept_rate:.1f}%")
print()
print(f"Filing-level review notes:     {len(filing_level)}  (whole-filing problems, not trade rows)")
print()

# Confidence on accepted trades.
acc_conf = [t["ocr_confidence"] for t in trades if t["ocr_confidence"] is not None]
if acc_conf:
    print("ACCEPTED-TRADE confidence (ocr_confidence):")
    print(f"  min {min(acc_conf):.2f}  avg {sum(acc_conf)/len(acc_conf):.2f}  max {max(acc_conf):.2f}")
print()

# Confidence on parked per-trade rows (review_queue.confidence = filing-level gate score).
pk_conf = [r["confidence"] for (r, _) in per_trade if r["confidence"] is not None]
if pk_conf:
    print("PARKED-ROW confidence (review_queue.confidence):")
    print(f"  min {min(pk_conf):.2f}  avg {sum(pk_conf)/len(pk_conf):.2f}  max {max(pk_conf):.2f}")
    buckets = {"<.50": 0, ".50–.69": 0, ".70–.84": 0, ".85+": 0}
    for c in pk_conf:
        if c < 0.50:
            buckets["<.50"] += 1
        elif c < 0.70:
            buckets[".50–.69"] += 1
        elif c < 0.85:
            buckets[".70–.84"] += 1
        else:
            buckets[".85+"] += 1
    print("  distribution: " + "  ".join(f"{k}={v}" for k, v in buckets.items()))
print()

# Provider sanity.
provs = {t["ocr_provider"] for t in trades} | {r["provider"] for (r, _) in per_trade}
print(f"Provider(s): {sorted(p for p in provs if p)}")

# Top reasons rows were parked.
from collections import Counter
reasons = Counter()
for (r, _) in per_trade:
    try:
        for why in json.loads(r["reasons"] or "[]"):
            reasons[why.split(":")[0][:48]] += 1
    except Exception:
        pass
if reasons:
    print()
    print("Top reasons rows were parked:")
    for why, n in reasons.most_common(8):
        print(f"  {n:>4}  {why}")
con.close()
