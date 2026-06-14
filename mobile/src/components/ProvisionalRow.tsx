import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import type { ProvisionalTrade } from "../api";
import { formatDate, ownerLabel, txMeta } from "../format";
import { cardShadow, fonts, numeric, radius, tint, useScheme, useTheme } from "../theme";

/**
 * A provisional (OCR-extracted, NOT yet verified) trade. Visually distinct from a confirmed
 * TradeRow: amber (accent2 = warning) framing + an "UNVERIFIED" flag with the model's confidence,
 * so it can never be mistaken for validated data. BUY/SELL keeps its fixed green/red meaning.
 */
export default function ProvisionalRow({ trade }: { trade: ProvisionalTrade }) {
  const t = useTheme();
  const scheme = useScheme();
  const meta = txMeta(trade.txType);
  const tone = t[meta.tone];
  const conf = trade.confidence != null ? Math.round(trade.confidence * 100) : null;

  return (
    <View style={[styles.card, cardShadow(scheme), { backgroundColor: t.panel, borderColor: tint(t.accent2, "66") }]}>
      <View style={styles.head}>
        <Text style={[styles.ticker, numeric, { color: t.ink }]} numberOfLines={1}>
          {trade.ticker ?? (trade.assetName ? trade.assetName.slice(0, 16) : "—")}
        </Text>
        <View style={[styles.pill, { backgroundColor: tint(tone) }]}>
          <Text style={[styles.pillText, { color: tone, fontFamily: fonts.uiSemiBold }]}>{meta.label}</Text>
        </View>
      </View>

      {trade.assetName ? (
        <Text style={[styles.asset, { color: t.inkSoft, fontFamily: fonts.ui }]} numberOfLines={2}>
          {trade.assetName}
        </Text>
      ) : null}

      <View style={styles.metaRow}>
        <Text style={[styles.amount, numeric, { color: t.ink }]}>{trade.amountLabel ?? "—"}</Text>
        <Text style={[styles.dim, { color: t.inkFaint, fontFamily: fonts.ui }]}>
          {trade.owner ? ownerLabel(trade.owner) : ""}
          {trade.transactionDate ? ` · ${formatDate(trade.transactionDate)}` : ""}
        </Text>
      </View>

      <View style={[styles.footer, { borderTopColor: t.border }]}>
        <View style={[styles.flag, { backgroundColor: tint(t.accent2) }]}>
          <Text style={[styles.flagText, { color: t.accent2, fontFamily: fonts.uiSemiBold }]}>
            UNVERIFIED{conf != null ? ` · ${conf}%` : ""}
          </Text>
        </View>
        {trade.sourceUrl ? (
          <Pressable onPress={() => Linking.openURL(trade.sourceUrl!)} hitSlop={8}>
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
  ticker: { fontSize: 17, fontWeight: "700", flex: 1, paddingRight: 10 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  pillText: { fontSize: 10.5, letterSpacing: 0.6 },
  asset: { fontSize: 13.5, marginTop: 6, lineHeight: 19 },
  metaRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 },
  amount: { fontSize: 15 },
  dim: { fontSize: 12 },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  flag: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: radius.chip },
  flagText: { fontSize: 10, letterSpacing: 0.6 },
  link: { fontSize: 12 },
});
