/* ============================================================
   PoliTracker — Design Tokens (React Native / Expo)
   Consume these via a ThemeContext driven by useColorScheme().
   Never hardcode hex values in components — read from `theme`.
   "Refined fintech": deep layered surfaces, soft elevation, soft-fill chips.
   ============================================================ */
import type { TextStyle, ViewStyle } from "react-native";

export const darkTheme = {
  // Surfaces (back -> front): deep, slightly-cool base so cards lift off it.
  bg:       '#0a0e15',
  bg2:      '#0d121b',
  panel:    '#141a25', // cards
  panel2:   '#1b2433', // raised / pressed / inset
  border:   '#222c3c',

  // Text
  ink:      '#eceef2',
  inkSoft:  '#a7afbd',
  inkFaint: '#6b7585',

  // Semantic accents — fixed meaning, do not repurpose
  accent:   '#6ee0bf', // BUY  / gain / positive   (mint)
  accent2:  '#f4c479', // flag / warning / neutral (amber)
  accent3:  '#84b4f7', // link / info / interactive (blue)
  danger:   '#f0888c', // SELL / loss / conflict   (red)

  codeBg:   '#070b11',
} as const;

export const lightTheme: Theme = {
  // Soft, cool off-white base; white cards get depth from shadow, not heavy borders.
  bg:       '#f3f5fa',
  bg2:      '#eceff5',
  panel:    '#ffffff',
  panel2:   '#f5f7fc',
  border:   '#e5e9f1',

  ink:      '#121620',
  inkSoft:  '#4d5765',
  inkFaint: '#838d9c',

  accent:   '#0c9b6f', // deeper teal-green for contrast on light
  accent2:  '#b3730e',
  accent3:  '#1c60d6',
  danger:   '#d23b3b',

  codeBg:   '#eef1f7',
};

export type Theme = { [K in keyof typeof darkTheme]: string };

export const radius = { card: 16, chip: 8, pill: 999 } as const;

/** Consistent spacing scale — use instead of ad-hoc numbers. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 } as const;

/** Soft-fill tint: a low-opacity wash of a semantic color, for chips/pills/badges. */
export const tint = (color: string, alpha = '22'): string => `${color}${alpha}`;

/**
 * Card elevation. Light mode lifts with a soft cool shadow; dark mode uses a deeper shadow
 * (and the lighter panel + border carry most of the separation). level 2 = more prominent.
 */
export function cardShadow(scheme: 'light' | 'dark', level: 1 | 2 = 1): ViewStyle {
  if (scheme === 'light') {
    return level === 2
      ? { shadowColor: '#0b1220', shadowOpacity: 0.1, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 6 }
      : { shadowColor: '#0b1220', shadowOpacity: 0.07, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2 };
  }
  return level === 2
    ? { shadowColor: '#000000', shadowOpacity: 0.55, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 8 }
    : { shadowColor: '#000000', shadowOpacity: 0.4, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 4 };
}

/* Font family names AS LOADED by @expo-google-fonts.
   In RN, fontFamily is the loaded name string, not a CSS stack. */
export const fonts = {
  head:        'Newsreader_600SemiBold',   // page titles, section headings
  headRegular: 'Newsreader_400Regular',
  ui:          'SplineSans_400Regular',    // body, labels, nav
  uiMedium:    'SplineSans_500Medium',
  uiSemiBold:  'SplineSans_600SemiBold',
  mono:        'JetBrainsMono_400Regular', // ALL numbers/tickers/money/%
  monoMedium:  'JetBrainsMono_500Medium',
} as const;

/* tabular-nums keeps figures aligned in tables/leaderboards.
   Spread this into any <Text> that renders numbers. */
export const numeric: TextStyle = {
  fontFamily: fonts.mono,
  fontVariant: ['tabular-nums'],
};

/* ---- Usage sketch ----------------------------------------------------

// ThemeContext.tsx
import { createContext, useContext } from 'react';
import { useColorScheme } from 'react-native';
import { darkTheme, lightTheme, Theme } from './theme';

const ThemeContext = createContext<Theme>(darkTheme);
export const useTheme = () => useContext(ThemeContext);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const scheme = useColorScheme();            // 'light' | 'dark' | null
  const theme = scheme === 'light' ? lightTheme : darkTheme; // dark default
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

// In a component — build styles from the theme, don't hardcode:
const t = useTheme();
<View style={{ backgroundColor: t.panel, borderColor: t.border, borderWidth: 1,
               borderRadius: radius.card }}>
  <Text style={{ color: t.ink, fontFamily: fonts.uiSemiBold }}>Nancy Pelosi</Text>
  <Text style={{ color: t.accent, ...numeric }}>+51.7M</Text>
</View>

// Fonts (e.g. in App.tsx):
//   npx expo install @expo-google-fonts/newsreader \
//     @expo-google-fonts/spline-sans @expo-google-fonts/jetbrains-mono expo-font
// then load Newsreader_600SemiBold, SplineSans_400/500/600, JetBrainsMono_400/500
// with useFonts(...) and gate render until fontsLoaded.

----------------------------------------------------------------------- */
