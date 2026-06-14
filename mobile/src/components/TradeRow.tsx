import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import type { TradeRowData } from "../api";
import { formatDate, ownerLabel, txMeta } from "../format";
import { cardShadow, fonts, numeric, radius, tint, useScheme, useTheme } from "../theme";

interface Props {
  trade: TradeRowData;
  /** Show the member's name (for a cross-member trade feed); omit on a member profile. */
  memberName?: string;
}

/**
 * One transaction. Shared between the member profile and (future) trade feed.
 * Per the design system: ticker + amount in mono, BUY/SELL as a soft-filled pill in accent/danger,
 * dates in inkFaint. Elevated card with soft shadow ("refined fintech").
 */
export default function TradeRow({ trade, memberName }: Props) {
  const t = useTheme();
  const scheme = useScheme();
  const meta = txMeta(trade.txType);
  const tone = t[meta.tone];

  return (
    <View style={[styles.card, cardShadow(scheme), { backgroundColor: t.panel, borderColor: t.border }]}>
      <View style={styles.head}>
        <Text style={[styles.ticker, numeric, { color: t.ink }]}>{trade.ticker ?? "—"}</Text>
        <View style={[styles.pill, { backgroundColor: tint(tone) }]}>
          <Text style={[styles.pillText, { color: tone, fontFamily: fonts.uiSemiBold }]}>{meta.label}</Text>
        </View>
      </View>

      {memberName ? (
        <Text style={[styles.member, { color: t.ink, fontFamily: fonts.uiSemiBold }]}>{memberName}</Text>
      ) : null}

      <Text style={[styles.asset, { color: t.inkSoft, fontFamily: fonts.ui }]} numberOfLines={2}>
        {trade.assetName}
      </Text>

      <View style={[styles.footer, { borderTopColor: t.border }]}>
        <View>
          <Text style={[styles.amount, numeric, { color: t.ink }]}>{trade.amountLabel}</Text>
          <Text style={[styles.dim, { color: t.inkFaint, fontFamily: fonts.ui }]}>
            {ownerLabel(trade.owner)} · Traded <Text style={numeric}>{formatDate(trade.transactionDate)}</Text>
          </Text>
        </View>
        {trade.sourceUrl ? (
          <Pressable
            onPress={() => Linking.openURL(trade.sourceUrl!)}
            hitSlop={8}
            style={({ pressed }) => [styles.sourceBtn, { backgroundColor: tint(t.accent3, pressed ? "33" : "1c") }]}
          >
            <Text style={[styles.link, { color: t.accent3, fontFamily: fonts.uiSemiBold }]}>Source ↗</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.card, padding: 16, marginBottom: 12, borderWidth: 1 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  ticker: { fontSize: 19, fontWeight: "700", letterSpacing: 0.3 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  pillText: { fontSize: 10.5, letterSpacing: 0.6 },
  member: { fontSize: 14, marginTop: 8 },
  asset: { fontSize: 13.5, marginTop: 6, lineHeight: 19 },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  amount: { fontSize: 15 },
  dim: { fontSize: 12, marginTop: 3 },
  sourceBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.chip },
  link: { fontSize: 12 },
});
