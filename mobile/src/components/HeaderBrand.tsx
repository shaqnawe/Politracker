import { StyleSheet, Text, View } from "react-native";
import Monogram from "../../assets/monogram.svg";
import { fonts, radius, useTheme } from "../theme";

/**
 * Brand lockup for the home header: the candlestick "P" monogram (rendered natively from the SVG,
 * so it stays crisp at any size) + the "oliTracker" wordmark — together they read "PoliTracker".
 * The monogram is a fixed-color tile (dark background + mint glyph); we clip it to a rounded square
 * with a hairline border so it reads as a small app-icon-style badge in either theme.
 */
export default function HeaderBrand() {
  const t = useTheme();
  return (
    <View style={styles.row}>
      <View style={[styles.mark, { borderColor: t.border }]}>
        <Monogram width={30} height={30} />
      </View>
      <Text style={[styles.word, { color: t.ink, fontFamily: fonts.head }]}>oliTracker</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  mark: {
    width: 30,
    height: 30,
    borderRadius: radius.chip,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  word: { fontSize: 18 },
});
