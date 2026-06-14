import { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, type CompanyProfile, type FeedTrade, type FinancialDatum, type InsiderTrade, type NewsItem } from "../api";
import Caveats from "../components/Caveats";
import TradeRow from "../components/TradeRow";
import {
  eventLabel,
  flagMeta,
  formatDate,
  formatDateTime,
  formatMoney,
  METRIC_ORDER,
  metricLabel,
  sentimentTone,
  txMeta,
} from "../format";
import type { RootStackParamList } from "../navigation";
import { cardShadow, fonts, numeric, radius, tint, useScheme, useTheme, type Scheme, type Theme } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Company">;

export default function CompanyScreen({ route, navigation }: Props) {
  const t = useTheme();
  const scheme = useScheme();
  const { ticker } = route.params;
  const [data, setData] = useState<CompanyProfile | null>(null);
  const [memberTrades, setMemberTrades] = useState<FeedTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    navigation.setOptions({ title: ticker });
    (async () => {
      // Company context (financials/insiders/news) 404s for a ticker we have no agent data on — but
      // the "who traded it" list should still show, so fetch both independently.
      const [ctx, feed] = await Promise.allSettled([
        api.getCompany(ticker),
        api.getTrades({ ticker, limit: 50 }),
      ]);
      if (ctx.status === "fulfilled") setData(ctx.value);
      if (feed.status === "fulfilled") setMemberTrades(feed.value.trades);
      if (ctx.status === "rejected" && feed.status === "rejected") setError((ctx.reason as Error).message);
      setLoading(false);
    })();
  }, [ticker, navigation]);

  if (loading) {
    return (
      <View style={[styles.fill, styles.center, { backgroundColor: t.bg }]}>
        <ActivityIndicator color={t.accent3} size="large" />
      </View>
    );
  }
  if (!data && memberTrades.length === 0) {
    return (
      <View style={[styles.fill, styles.center, { backgroundColor: t.bg }]}>
        <Text style={{ color: t.inkFaint, fontFamily: fonts.ui, textAlign: "center", paddingHorizontal: 24 }}>
          {error ?? `No data for ${ticker} yet.`}
        </Text>
      </View>
    );
  }

  const company = data?.company ?? { ticker, cik: null, name: null };
  const financials = data?.financials ?? [];
  const note = data?.note ?? null;
  const insiderTrades = data?.insiderTrades ?? [];
  const news = data?.news ?? [];
  const years = [...new Set(financials.map((f) => f.fiscalYear))].sort((a, b) => b - a).slice(0, 3);
  const finIndex = new Map(financials.map((f) => [`${f.metric}-${f.fiscalYear}`, f] as const));
  const metricsPresent = METRIC_ORDER.filter((m) => financials.some((f) => f.metric === m));

  return (
    <ScrollView style={[styles.fill, { backgroundColor: t.bg }]} contentContainerStyle={styles.list}>
      {/* Header */}
      <View style={[styles.header, cardShadow(scheme, 2), { backgroundColor: t.panel, borderColor: t.border }]}>
        <Text style={[styles.ticker, numeric, { color: t.ink }]}>{company.ticker}</Text>
        {company.name ? (
          <Text style={[styles.coName, { color: t.inkSoft, fontFamily: fonts.ui }]}>{company.name}</Text>
        ) : null}
        {company.cik ? (
          <Pressable
            hitSlop={8}
            style={({ pressed }) => [styles.secLink, { backgroundColor: tint(t.accent3, pressed ? "33" : "1c") }]}
            onPress={() =>
              Linking.openURL(
                `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${company.cik}&type=&dateb=&owner=include&count=40`,
              )
            }
          >
            <Text style={[styles.secLinkText, { color: t.accent3, fontFamily: fonts.uiSemiBold }]}>
              SEC filings ↗
            </Text>
          </Pressable>
        ) : null}
      </View>

      {/* Who traded it — the heart of the ticker view; shows even without SEC company context. */}
      {memberTrades.length > 0 ? (
        <Section t={t} title="Congressional trades">
          {memberTrades.map((tr) => (
            <Pressable key={tr.id} onPress={() => navigation.navigate("Member", { id: tr.memberId, name: tr.memberName })}>
              <TradeRow trade={tr} memberName={tr.memberName} />
            </Pressable>
          ))}
        </Section>
      ) : null}

      {/* AI financial-review note */}
      {note ? (
        <Section t={t} title="Financial summary">
          <View style={[styles.card, cardShadow(scheme), { backgroundColor: t.panel, borderColor: t.border }]}>
            <View style={[styles.aiBadge, { backgroundColor: tint(t.accent2) }]}>
              <Text style={[styles.aiBadgeText, { color: t.accent2, fontFamily: fonts.uiSemiBold }]}>
                AI SUMMARY
              </Text>
            </View>
            <Text style={[styles.noteBody, { color: t.ink, fontFamily: fonts.ui }]}>{note.body}</Text>
            {note.flags.length > 0 ? (
              <View style={styles.chipRow}>
                {note.flags.map((f) => {
                  const meta = flagMeta(f);
                  const tone = t[meta.tone];
                  return (
                    <View key={f} style={[styles.chip, { backgroundColor: tint(tone) }]}>
                      <Text style={[styles.chipText, { color: tone, fontFamily: fonts.uiSemiBold }]}>
                        {meta.label}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ) : null}
            <Text style={[styles.aiMeta, { color: t.inkFaint, fontFamily: fonts.ui }]}>
              AI-generated from disclosed financials · {note.model}
            </Text>
          </View>
        </Section>
      ) : null}

      {/* Financials table */}
      {metricsPresent.length > 0 ? (
        <Section t={t} title="Annual financials">
          <View style={[styles.card, cardShadow(scheme), { backgroundColor: t.panel, borderColor: t.border }]}>
            <View style={styles.finRow}>
              <Text style={[styles.finMetric, { color: t.inkFaint, fontFamily: fonts.uiMedium }]} />
              {years.map((y) => (
                <Text key={y} style={[styles.finCell, numeric, { color: t.inkFaint }]}>
                  FY{String(y).slice(2)}
                </Text>
              ))}
            </View>
            {metricsPresent.map((m) => (
              <View key={m} style={[styles.finRow, styles.finBody, { borderTopColor: t.border }]}>
                <Text style={[styles.finMetric, { color: t.inkSoft, fontFamily: fonts.ui }]}>
                  {metricLabel(m)}
                </Text>
                {years.map((y) => {
                  const d = finIndex.get(`${m}-${y}`) as FinancialDatum | undefined;
                  return (
                    <Text key={y} style={[styles.finCell, numeric, { color: t.ink }]}>
                      {d ? formatMoney(d.value, d.unit) : "—"}
                    </Text>
                  );
                })}
              </View>
            ))}
          </View>
        </Section>
      ) : null}

      {/* Company context (insiders + news) — only when we actually have SEC/agent data. */}
      {data ? (
        <>
          <Section t={t} title="Insider activity">
            {insiderTrades.length > 0 ? (
              insiderTrades.map((it, i) => <InsiderRow key={i} t={t} scheme={scheme} trade={it} />)
            ) : (
              <Empty t={t} text="No insider filings collected yet." />
            )}
          </Section>

          <Section t={t} title="Recent news">
            {news.length > 0 ? (
              news.map((n, i) => <NewsRow key={i} t={t} scheme={scheme} item={n} />)
            ) : (
              <Empty t={t} text="No news collected yet." />
            )}
          </Section>
        </>
      ) : null}

      <Caveats context={!!data} />
    </ScrollView>
  );
}

function Section({ t, title, children }: { t: Theme; title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionHeading, { color: t.ink, fontFamily: fonts.head }]}>{title}</Text>
      {children}
    </View>
  );
}

function Empty({ t, text }: { t: Theme; text: string }) {
  return <Text style={[styles.empty, { color: t.inkFaint, fontFamily: fonts.ui }]}>{text}</Text>;
}

function InsiderRow({ t, scheme, trade }: { t: Theme; scheme: Scheme; trade: InsiderTrade }) {
  const meta = txMeta(trade.txType);
  const tone = t[meta.tone];
  const sharesLine =
    trade.shares != null
      ? `${trade.shares.toLocaleString("en-US")} sh${trade.price ? ` @ $${trade.price.toFixed(2)}` : ""}`
      : null;
  return (
    <View style={[styles.card, cardShadow(scheme), { backgroundColor: t.panel, borderColor: t.border }]}>
      <View style={styles.head}>
        <Text style={[styles.insider, { color: t.ink, fontFamily: fonts.uiSemiBold }]} numberOfLines={1}>
          {trade.insider ?? "Insider"}
        </Text>
        <View style={[styles.pill, { backgroundColor: tint(tone) }]}>
          <Text style={[styles.pillText, { color: tone, fontFamily: fonts.uiSemiBold }]}>{meta.label}</Text>
        </View>
      </View>
      {trade.title || trade.relationship ? (
        <Text style={[styles.dim, { color: t.inkFaint, fontFamily: fonts.ui }]} numberOfLines={1}>
          {trade.title || trade.relationship}
        </Text>
      ) : null}
      <View style={[styles.footer, { borderTopColor: t.border }]}>
        <Text style={[styles.amount, numeric, { color: t.ink }]}>
          {sharesLine ?? "—"}
          {trade.value ? `  ·  ${formatMoney(trade.value, "USD")}` : ""}
        </Text>
        <Text style={[styles.dim, numeric, { color: t.inkFaint }]}>{formatDate(trade.date)}</Text>
      </View>
      {trade.sourceUrl ? (
        <Pressable onPress={() => Linking.openURL(trade.sourceUrl!)} hitSlop={8}>
          <Text style={[styles.link, { color: t.accent3, fontFamily: fonts.uiSemiBold }]}>Form 4 ↗</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function NewsRow({ t, scheme, item }: { t: Theme; scheme: Scheme; item: NewsItem }) {
  const sTone = t[sentimentTone(item.sentiment)];
  const body = (
    <View style={[styles.card, cardShadow(scheme), { backgroundColor: t.panel, borderColor: t.border }]}>
      <Text style={[styles.newsTitle, { color: item.url ? t.accent3 : t.ink, fontFamily: fonts.uiSemiBold }]}>
        {item.title}
      </Text>
      {item.summary ? (
        <Text style={[styles.asset, { color: t.inkSoft, fontFamily: fonts.ui }]}>{item.summary}</Text>
      ) : null}
      <View style={styles.newsMeta}>
        <View style={styles.newsTags}>
          <View style={[styles.eventChip, { backgroundColor: t.panel2 }]}>
            <Text style={[styles.eventText, { color: t.inkSoft, fontFamily: fonts.uiMedium }]}>
              {eventLabel(item.eventType)}
            </Text>
          </View>
          <View style={[styles.dot, { backgroundColor: sTone }]} />
          <Text style={[styles.dim, { color: t.inkFaint, fontFamily: fonts.ui }]} numberOfLines={1}>
            {item.source ?? "—"}
          </Text>
        </View>
        <Text style={[styles.dim, numeric, { color: t.inkFaint }]}>{formatDateTime(item.publishedAt)}</Text>
      </View>
    </View>
  );
  return item.url ? <Pressable onPress={() => Linking.openURL(item.url!)}>{body}</Pressable> : body;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
  list: { padding: 16, paddingBottom: 32 },

  header: { borderRadius: radius.card, padding: 20, borderWidth: 1 },
  ticker: { fontSize: 30, fontWeight: "700", letterSpacing: 0.5 },
  coName: { fontSize: 15, marginTop: 4 },
  secLink: { alignSelf: "flex-start", marginTop: 12, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.chip },
  secLinkText: { fontSize: 13 },

  section: { marginTop: 24 },
  sectionHeading: { fontSize: 18, marginBottom: 12 },

  card: { borderRadius: radius.card, padding: 16, marginBottom: 12, borderWidth: 1 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },

  aiBadge: { alignSelf: "flex-start", paddingHorizontal: 9, paddingVertical: 4, borderRadius: radius.chip, marginBottom: 10 },
  aiBadgeText: { fontSize: 10, letterSpacing: 0.6 },
  noteBody: { fontSize: 14.5, lineHeight: 21 },
  aiMeta: { fontSize: 11, marginTop: 12 },

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 12 },
  chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  chipText: { fontSize: 11 },

  finRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8 },
  finBody: { borderTopWidth: StyleSheet.hairlineWidth },
  finMetric: { flex: 1.4, fontSize: 13 },
  finCell: { flex: 1, fontSize: 12.5, textAlign: "right" },

  insider: { fontSize: 14.5, flex: 1, paddingRight: 10 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  pillText: { fontSize: 10.5, letterSpacing: 0.6 },
  asset: { fontSize: 13.5, marginTop: 6, lineHeight: 19 },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  amount: { fontSize: 13.5 },
  dim: { fontSize: 12, marginTop: 4 },
  link: { fontSize: 12, marginTop: 10 },

  newsTitle: { fontSize: 14.5, lineHeight: 20 },
  newsMeta: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 10 },
  newsTags: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1, paddingRight: 8 },
  eventChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.chip },
  eventText: { fontSize: 10, letterSpacing: 0.3 },
  dot: { width: 7, height: 7, borderRadius: 4 },

  empty: { fontSize: 13, paddingVertical: 6 },
});
