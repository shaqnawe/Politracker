import type { ExtractedFiling, ExtractedTrade } from "./types.js";

/**
 * Shared extraction contract for both vision providers: the system prompt (the rules from
 * ptr-extraction-spec.md), the JSON schema the model must emit, and a coercion helper that
 * normalizes raw model JSON into a well-formed ExtractedFiling.
 */

export const SYSTEM_PROMPT = `You transcribe scanned U.S. House/Senate Periodic Transaction
Reports (PTRs) into structured JSON. These are checkbox-grid forms, often scanned and
sometimes rotated.

RULES — follow exactly:
- Transcribe ONLY what is visibly present. NEVER infer, complete, or guess a value. If a cell
  is unreadable, return value: null with a low confidence. If an entire row is unreadable, set
  row_unreadable: true and its field values to null.
- Every field is {value, confidence} with confidence 0..1 reflecting how sure you are of THAT
  cell. Be honest: faint/handwritten/ambiguous => low confidence.
- The image may be rotated (90/180/270deg) or skewed — read it correctly regardless.
- Process EVERY page provided; one transaction table may span pages. Merge rows in reading
  order; do not restart numbering per page. Output one object for the whole filing.
- IGNORE the blank printed EXAMPLE row that appears once just under the column headers (often
  "Example: Mega Corp, Common Stock" with sample dates like 09/06/20). It is a template, not a
  real transaction — do not output it.

FORM LAYOUT (columns left->right), map by the PRINTED HEADER LABEL, not a fixed position:
  Owner code (SP=spouse, DC=dependent_child, JT=joint, blank=self) | Asset full name (NOT a
  ticker) | [Type of Transaction checkboxes: Purchase, Sale, Exchange, "Capital gains exceed
  $200", Partial] | Transaction date (MM/DD/YYYY) | Notification date (MM/DD/YYYY) | [Amount
  of Transaction checkboxes: the dollar-range buckets].

FIELD RULES:
- owner: one of self | spouse | dependent_child | joint (blank owner column => self).
- transaction_type: the checked box -> Purchase="P", Sale="S", Exchange="E". If the Partial
  box is ALSO checked with Sale => "S_partial". NOTE: "Capital gains exceed $200" is a SEPARATE
  flag, NOT a transaction type and NOT Partial — ignore it for transaction_type.
- ticker: only if a ticker symbol is actually printed (often in parentheses). Otherwise null.
  Do NOT invent a ticker from a company name.
- asset_name: the company/asset name verbatim as printed.
- amount_label: copy the checked dollar range VERBATIM (e.g. "$1,001 - $15,000"). The special
  final column "Transaction in a Spouse/Dependent-Child asset over $1,000,000" is not a normal
  bucket: set amount_label: null and low confidence if that is what's checked.
- transaction_date / notification_date: MM/DD/YYYY, or null.
- filing.chamber: "house" or "senate" if determinable, else null.

Output STRICT JSON matching the provided schema. No prose outside it.`;

export const USER_INSTRUCTION =
  "Transcribe this PTR filing. The images are its pages in order. Return the JSON object.";

const confField = () => ({
  type: "object",
  additionalProperties: false,
  required: ["value", "confidence"],
  properties: {
    value: { type: ["string", "null"] },
    confidence: { type: "number" },
  },
});

/** JSON schema for structured output (OpenAI strict mode + Claude tool input_schema). */
export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["filing", "transactions", "extraction_notes"],
  properties: {
    filing: {
      type: "object",
      additionalProperties: false,
      required: ["filer_name", "filing_date", "chamber"],
      properties: { filer_name: confField(), filing_date: confField(), chamber: confField() },
    },
    transactions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "owner",
          "asset_name",
          "ticker",
          "asset_type",
          "transaction_type",
          "transaction_date",
          "notification_date",
          "amount_label",
          "row_unreadable",
        ],
        properties: {
          owner: confField(),
          asset_name: confField(),
          ticker: confField(),
          asset_type: confField(),
          transaction_type: confField(),
          transaction_date: confField(),
          notification_date: confField(),
          amount_label: confField(),
          row_unreadable: { type: "boolean" },
        },
      },
    },
    extraction_notes: { type: "string" },
  },
} as const;

const clamp01 = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;

function coerceField(raw: any): { value: any; confidence: number } {
  if (raw && typeof raw === "object") {
    const value = raw.value === undefined ? null : raw.value;
    return { value: value === "" ? null : value, confidence: clamp01(raw.confidence) };
  }
  return { value: null, confidence: 0 };
}

/** Normalize whatever the model returned into a valid ExtractedFiling. */
export function coerceExtraction(raw: any): ExtractedFiling {
  const f = raw?.filing ?? {};
  const txs: ExtractedTrade[] = Array.isArray(raw?.transactions)
    ? raw.transactions.map((t: any) => ({
        owner: coerceField(t?.owner),
        asset_name: coerceField(t?.asset_name),
        ticker: coerceField(t?.ticker),
        asset_type: coerceField(t?.asset_type),
        transaction_type: coerceField(t?.transaction_type),
        transaction_date: coerceField(t?.transaction_date),
        notification_date: coerceField(t?.notification_date),
        amount_label: coerceField(t?.amount_label),
        row_unreadable: Boolean(t?.row_unreadable),
      }))
    : [];
  return {
    filing: {
      filer_name: coerceField(f.filer_name),
      filing_date: coerceField(f.filing_date),
      chamber: coerceField(f.chamber),
    },
    transactions: txs,
    extraction_notes: typeof raw?.extraction_notes === "string" ? raw.extraction_notes : "",
  };
}
