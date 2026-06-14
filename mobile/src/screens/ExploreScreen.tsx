import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { api, type Stats } from "../api";
import Caveats from "../components/Caveats";
import { chamberLabel } from "../format";
import type { TabScreenProps } from "../navigation";
import { cardShadow, fonts, numeric, radius, space, tint, useScheme, useTheme } from "../theme";

type Props = TabScreenProps<"Explore">;

export default function ExploreScreen({ navigation }: Props) {
  const t = useTheme();
  const scheme = useScheme();
  const [stats, setStats] = useState<Stats | null>(null);
  const [tickerQuery, setTickerQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setError(null);
      setStats(await api.getStats());
    } catch (e) {
      setError((e as Error).message || "Could not reach the server");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: t.bg }]}>
        <ActivityIndicator color={t.accent3} size="large" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.center, { backgroundColor: t.bg }]}>
        <Text style={[styles.error, { color: t.danger, fontFamily: fonts.ui }]}>{error}</Text>
        <Pressable onPress={load} style={[styles.retry, { backgroundColor: t.accent3 }]}>
          <Text style={{ color: "#fff", fontFamily: fonts.uiSemiBold }}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const members = stats?.topMembers ?? [];
  const tickers = stats?.topTickers ?? [];

  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            load();
          }}
          tintColor={t.accent3}
        />
      }
    >
      <TextInput
        style={[styles.search, numeric, { backgroundColor: t.panel, color: t.ink, borderColor: t.border }]}
        placeholder="Look up a ticker (e.g. NVDA)"
        placeholderTextColor={t.inkFaint}
        value={tickerQuery}
        onChangeText={setTickerQuery}
        autoCapitalize="characters"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={() => {
          const tk = tickerQuery.trim().toUpperCase();
          if (tk) {
            navigation.navigate("Company", { ticker: tk });
            setTickerQuery("");
          }
        }}
      />

      <Text style={[styles.section, { color: t.ink, fontFamily: fonts.head }]}>Most active members</Text>
      <View style={styles.group}>
        {members.map((m, i) => (
          <Pressable
            key={m.id}
            onPress={() => navigation.navigate("Member", { id: m.id, name: m.fullName })}
            style={({ pressed }) => [
              styles.row,
              cardShadow(scheme),
              { backgroundColor: pressed ? t.panel2 : t.panel, borderColor: t.border },
            ]}
          >
            <Text style={[styles.rank, numeric, { color: t.inkFaint }]}>{i + 1}</Text>
            <View style={styles.rowMain}>
              <Text style={[styles.name, { color: t.ink, fontFamily: fonts.uiSemiBold }]} numberOfLines={1}>
                {m.fullName}
              </Text>
              <View style={[styles.badge, { backgroundColor: tint(t.accent3) }]}>
                <Text style={[styles.badgeText, { color: t.accent3, fontFamily: fonts.uiSemiBold }]}>
                  {chamberLabel(m.chamber)}
                </Text>
              </View>
            </View>
            <View style={styles.countCol}>
              <Text style={[styles.count, numeric, { color: t.ink }]}>{m.tradeCount}</Text>
              <Text style={[styles.countLabel, { color: t.inkFaint, fontFamily: fonts.ui }]}>trades</Text>
            </View>
          </Pressable>
        ))}
      </View>

      <Text style={[styles.section, { color: t.ink, fontFamily: fonts.head }]}>Most traded tickers</Text>
      <View style={styles.group}>
        {tickers.map((tk) => (
          <Pressable
            key={tk.ticker}
            onPress={() => navigation.navigate("Company", { ticker: tk.ticker })}
            style={({ pressed }) => [
              styles.row,
              cardShadow(scheme),
              { backgroundColor: pressed ? t.panel2 : t.panel, borderColor: t.border },
            ]}
          >
            <View style={styles.rowMain}>
              <Text style={[styles.ticker, numeric, { color: t.accent3 }]}>{tk.ticker}</Text>
            </View>
            <View style={styles.countCol}>
              <Text style={[styles.count, numeric, { color: t.ink }]}>{tk.count}</Text>
              <Text style={[styles.countLabel, { color: t.inkFaint, fontFamily: fonts.ui }]}>trades</Text>
            </View>
          </Pressable>
        ))}
      </View>

      <Caveats ranking />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  content: { padding: space.lg, paddingBottom: space.xxl },
  search: { borderRadius: radius.card, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15 },
  section: { fontSize: 18, marginTop: space.md, marginBottom: space.sm },
  group: { gap: space.sm + 2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.card,
    borderWidth: 1,
    paddingHorizontal: space.lg,
    paddingVertical: 13,
    gap: space.md,
  },
  rank: { fontSize: 14, width: 22, textAlign: "center" },
  rowMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  name: { fontSize: 15.5, flexShrink: 1 },
  ticker: { fontSize: 16, fontWeight: "600" },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.chip },
  badgeText: { fontSize: 10, letterSpacing: 0.6 },
  countCol: { alignItems: "flex-end" },
  count: { fontSize: 18, fontWeight: "700" },
  countLabel: { fontSize: 11 },
  error: { textAlign: "center", fontSize: 15 },
  retry: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
});
