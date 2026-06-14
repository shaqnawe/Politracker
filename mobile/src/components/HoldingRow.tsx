import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Holding } from "../api";
import { assetClassLabel } from "../format";
import { cardShadow, fonts, numeric, radius, tint, useScheme, useTheme } from "../theme";

/**
 * One holding from an annual OGE 278e snapshot. NOT a transaction — there is no buy/sell, so it
 * never uses the green/red trade semantics. The asset-class tag uses accent3 (blue = info), the
 * value range is the emphasis (mono), and income is secondary. If a ticker resolved (e.g. DJT) it
 * links to the company-context screen.
 */
export default function HoldingRow({ holding, onTicker }: { holding: Holding; onTicker?: (ticker: string) => void }) {
  const t = useTheme();
  const scheme = useScheme();

  return (
    <View style={[styles.card, cardShadow(scheme), { backgroundColor: t.panel, borderColor: t.border }]}>
      <View style={styles.head}>
        {holding.ticker ? (
          <Pressable onPress={() => onTicker?.(holding.ticker!)} hitSlop={6}>
            <Text style={[styles.ticker, numeric, { color: onTicker ? t.accent3 : t.ink }]}>
              {holding.ticker}
              {onTicker ? " ↗" : ""}
            </Text>
          </Pressable>
        ) : (
          <Text style={[styles.assetTitle, { color: t.ink, fontFamily: fonts.uiSemiBold }]} numberOfLines={2}>
            {holding.assetName}
          </Text>
        )}
        <View style={[styles.tag, { backgroundColor: tint(t.accent3) }]}>
          <Text style={[styles.tagText, { color: t.accent3, fontFamily: fonts.uiSemiBold }]}>
            {assetClassLabel(holding.assetClass)}
          </Text>
        </View>
      </View>

      {holding.ticker ? (
        <Text style={[styles.asset, { color: t.inkSoft, fontFamily: fonts.ui }]} numberOfLines={2}>
          {holding.assetName}
        </Text>
      ) : null}

      <View style={[styles.footer, { borderTopColor: t.border }]}>
        <View style={styles.valueCol}>
          <Text style={[styles.valueLabelCap, { color: t.inkFaint, fontFamily: fonts.uiMedium }]}>VALUE</Text>
          <Text style={[styles.value, numeric, { color: t.ink }]}>{holding.valueLabel}</Text>
        </View>
        {holding.incomeType || holding.incomeLabel ? (
          <View style={styles.incomeCol}>
            <Text style={[styles.valueLabelCap, { color: t.inkFaint, fontFamily: fonts.uiMedium }]}>
              {holding.incomeType ?? "INCOME"}
            </Text>
            <Text style={[styles.income, numeric, { color: t.inkSoft }]}>{holding.incomeLabel ?? "—"}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.card, padding: 16, marginBottom: 12, borderWidth: 1 },
  head: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 10 },
  ticker: { fontSize: 19, fontWeight: "700", letterSpacing: 0.3 },
  assetTitle: { fontSize: 14.5, flex: 1, lineHeight: 20 },
  tag: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.chip },
  tagText: { fontSize: 10, letterSpacing: 0.5 },
  asset: { fontSize: 13, marginTop: 6, lineHeight: 18 },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  valueCol: { flex: 1 },
  incomeCol: { alignItems: "flex-end" },
  valueLabelCap: { fontSize: 9, letterSpacing: 0.8, marginBottom: 3 },
  value: { fontSize: 14.5, fontWeight: "700" },
  income: { fontSize: 12.5 },
});
