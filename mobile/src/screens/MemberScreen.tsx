import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, type MemberProfile } from "../api";
import Caveats from "../components/Caveats";
import HoldingRow from "../components/HoldingRow";
import ProvisionalRow from "../components/ProvisionalRow";
import TradeRow from "../components/TradeRow";
import { chamberLabel, formatDate, memberLocation } from "../format";
import type { RootStackParamList } from "../navigation";
import { cardShadow, fonts, numeric, radius, tint, useScheme, useTheme, type Theme } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Member">;

export default function MemberScreen({ route, navigation }: Props) {
  const t = useTheme();
  const scheme = useScheme();
  const { id } = route.params;
  const [data, setData] = useState<MemberProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const profile = await api.getMember(id);
        setData(profile);
        navigation.setOptions({ title: profile.member.fullName });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [id, navigation]);

  if (loading) {
    return (
      <View style={[styles.fill, styles.center, { backgroundColor: t.bg }]}>
        <ActivityIndicator color={t.accent3} size="large" />
      </View>
    );
  }
  if (error || !data) {
    return (
      <View style={[styles.fill, styles.center, { backgroundColor: t.bg }]}>
        <Text style={{ color: t.danger, fontFamily: fonts.ui }}>{error ?? "Not found"}</Text>
      </View>
    );
  }

  const { member, stats, topTickers } = data;
  const isExecutive = member.chamber === "executive";
  const reportYear = data.holdings[0]?.reportYear ?? null;

  return (
    <FlatList
      style={[styles.fill, { backgroundColor: t.bg }]}
      data={data.trades}
      keyExtractor={(tr) => String(tr.id)}
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        <View>
          <View style={[styles.header, cardShadow(scheme, 2), { backgroundColor: t.panel, borderColor: t.border }]}>
            <View style={styles.headerTop}>
              <Text style={[styles.name, { color: t.ink, fontFamily: fonts.head }]}>
                {member.fullName}
              </Text>
              <View style={[styles.badge, { backgroundColor: tint(t.accent3) }]}>
                <Text style={[styles.badgeText, { color: t.accent3, fontFamily: fonts.uiSemiBold }]}>
                  {chamberLabel(member.chamber)}
                </Text>
              </View>
            </View>
            <Text style={[styles.loc, { color: t.inkSoft, fontFamily: fonts.ui }]}>
              {memberLocation(member.chamber, member.state, member.district)}
            </Text>

            <View style={[styles.statsRow, { borderTopColor: t.border, borderBottomColor: t.border }]}>
              {isExecutive ? (
                <>
                  <Stat t={t} value={data.holdings.length} label="holdings" color={t.ink} />
                  <View style={[styles.statDivider, { backgroundColor: t.border }]} />
                  <Stat t={t} value={reportYear ?? 0} label="OGE 278e" color={t.accent3} />
                </>
              ) : (
                <>
                  <Stat t={t} value={stats.tradeCount} label="trades" color={t.ink} />
                  <View style={[styles.statDivider, { backgroundColor: t.border }]} />
                  <Stat t={t} value={stats.buys} label="buys" color={t.accent} />
                  <View style={[styles.statDivider, { backgroundColor: t.border }]} />
                  <Stat t={t} value={stats.sells} label="sells" color={t.danger} />
                </>
              )}
            </View>
            {!isExecutive && stats.firstTradeDate && stats.lastTradeDate ? (
              <Text style={[styles.range, numeric, { color: t.inkFaint }]}>
                {formatDate(stats.firstTradeDate)} – {formatDate(stats.lastTradeDate)}
              </Text>
            ) : null}

            {topTickers.length > 0 && (
              <View style={styles.tickerWrap}>
                <Text style={[styles.sectionLabel, { color: t.inkFaint, fontFamily: fonts.uiMedium }]}>
                  MOST TRADED · tap for company context
                </Text>
                <View style={styles.tickerRow}>
                  {topTickers.map((tk) => (
                    <Pressable
                      key={tk.ticker}
                      onPress={() => navigation.navigate("Company", { ticker: tk.ticker })}
                      style={({ pressed }) => [
                        styles.tickerChip,
                        { backgroundColor: pressed ? tint(t.accent3) : t.panel2, borderColor: t.border },
                      ]}
                    >
                      <Text style={[styles.tickerText, numeric, { color: t.ink }]}>{tk.ticker}</Text>
                      <Text style={[styles.tickerCount, numeric, { color: t.accent3 }]}>{tk.count}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}
          </View>
          {!isExecutive ? (
            <Text style={[styles.tradesHeading, { color: t.ink, fontFamily: fonts.head }]}>
              Trade history
            </Text>
          ) : null}
        </View>
      }
      renderItem={({ item }) => <TradeRow trade={item} />}
      ListEmptyComponent={
        isExecutive ? null : (
          <Text style={{ color: t.inkFaint, textAlign: "center", marginTop: 20, fontFamily: fonts.ui }}>
            No verified trades for this member.
          </Text>
        )
      }
      ListFooterComponent={
        <View>
          {data.holdings.length > 0 ? (
            <View style={styles.holdingsWrap}>
              <Text style={[styles.tradesHeading, { color: t.ink, fontFamily: fonts.head }]}>
                Public holdings · annual snapshot
              </Text>
              <Caveats holdings />
              <View style={{ height: 12 }} />
              {data.holdings.map((h) => (
                <HoldingRow
                  key={h.id}
                  holding={h}
                  onTicker={(ticker) => navigation.navigate("Company", { ticker })}
                />
              ))}
            </View>
          ) : null}
          {data.unverifiedTrades.length > 0 ? (
            <View style={styles.unverifiedWrap}>
              <Text style={[styles.tradesHeading, { color: t.accent2, fontFamily: fonts.head }]}>
                Unverified · OCR-extracted ({data.unverifiedTrades.length})
              </Text>
              <Text style={[styles.unverifiedNote, { color: t.inkFaint, fontFamily: fonts.ui }]}>
                Read from scanned filings by OCR and NOT yet verified — values may be wrong, and rows
                that read cleanly enough were promoted to the list above. Treat these as provisional.
              </Text>
              {data.unverifiedTrades.map((u) => (
                <ProvisionalRow key={u.id} trade={u} />
              ))}
            </View>
          ) : null}
          {!isExecutive ? <Caveats spouse /> : null}
        </View>
      }
    />
  );
}

function Stat({ t, value, label, color }: { t: Theme; value: number; label: string; color: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, numeric, { color }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: t.inkFaint, fontFamily: fonts.ui }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
  list: { padding: 16, paddingBottom: 32 },

  header: { borderRadius: radius.card, padding: 20, borderWidth: 1 },
  headerTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  name: { fontSize: 24, flex: 1, paddingRight: 10 },
  loc: { marginTop: 4, fontSize: 14 },
  badge: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.chip },
  badgeText: { fontSize: 10, letterSpacing: 0.6 },

  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 18,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  stat: { flex: 1, alignItems: "center" },
  statDivider: { width: StyleSheet.hairlineWidth, height: 30 },
  statValue: { fontSize: 26, fontWeight: "700" },
  statLabel: { fontSize: 12, marginTop: 2 },
  range: { fontSize: 12, marginTop: 12, textAlign: "center" },

  tickerWrap: { marginTop: 18 },
  sectionLabel: { fontSize: 11, letterSpacing: 1 },
  tickerRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  tickerChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
  },
  tickerText: { fontWeight: "700", fontSize: 13 },
  tickerCount: { fontWeight: "700", fontSize: 12 },

  tradesHeading: { fontSize: 18, marginTop: 24, marginBottom: 12 },
  holdingsWrap: { marginTop: 4 },
  unverifiedWrap: { marginTop: 4 },
  unverifiedNote: { fontSize: 12, lineHeight: 17, marginBottom: 12, marginTop: -4 },
});
