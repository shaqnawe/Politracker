import { StyleSheet, Text, View } from "react-native";
import { fonts, radius, useTheme } from "../theme";

interface Props {
  /** Add the "rankings reflect only machine-readable filings" note (for activity-sorted views). */
  ranking?: boolean;
  /** Add the spouse/dependent ownership note (for member profiles). */
  spouse?: boolean;
  /** Add notes for the company-context screen (insiders/financials/news are external + AI-summarized). */
  context?: boolean;
  /** Add notes for an annual OGE 278e holdings snapshot (executive-branch filers). */
  holdings?: boolean;
  /** Add the note that the cross-member feed mixes online + OCR-extracted trades, unmarked. */
  feed?: boolean;
}

/**
 * Mandatory data caveats. Per the design system these must be surfaced wherever
 * trade data is shown — small, persistent, unobtrusive (inkFaint).
 */
export default function Caveats({ ranking, spouse, context, holdings, feed }: Props) {
  const t = useTheme();
  const lines = holdings
    ? [
        "From the annual OGE Form 278e — a yearly HOLDINGS snapshot, not dated buy/sell trades.",
        "Values are disclosed ranges (e.g. $1,001–$15,000), reported as of the filing.",
        "Only public-market assets (stocks, ETFs, funds, Treasuries) are shown; the filing also lists many private entities and individual bonds, not itemized here.",
      ]
    : context
    ? [
        "Insider trades and financials come from SEC filings — disclosed and lagged, not real-time.",
        "News is third-party: headlines link out; summaries and tags are AI-generated and may err.",
        "Context is shown for the companies behind a member's trades, not investment advice.",
      ]
    : [
        "Disclosures lag up to ~45 days under the STOCK Act — nothing here is real-time.",
        "Amounts are disclosed ranges (e.g. $1,001–$15,000), never exact figures.",
        "Coverage is partial: scanned/paper filings are skipped, so some trades may be missing.",
      ];
  if (ranking) lines.push("Activity rankings reflect only machine-readable filings.");
  if (feed) lines.push("The feed mixes verified online filings and OCR-extracted trades, not marked per row.");
  if (spouse) {
    lines.push(
      "Spouse- and dependent-owned trades are disclosed by the member but may not be their own.",
    );
  }

  return (
    <View style={[styles.wrap, { backgroundColor: t.panel2, borderColor: t.border }]}>
      <Text style={[styles.heading, { color: t.inkFaint, fontFamily: fonts.uiSemiBold }]}>
        ABOUT THIS DATA
      </Text>
      {lines.map((line) => (
        <View key={line} style={styles.row}>
          <Text style={[styles.dot, { color: t.inkFaint }]}>•</Text>
          <Text style={[styles.text, { color: t.inkFaint, fontFamily: fonts.ui }]}>{line}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 20,
    padding: 14,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 7,
  },
  heading: { fontSize: 10, letterSpacing: 1, marginBottom: 2 },
  row: { flexDirection: "row", gap: 7 },
  dot: { fontSize: 12, lineHeight: 17 },
  text: { fontSize: 11.5, lineHeight: 17, flex: 1 },
});
