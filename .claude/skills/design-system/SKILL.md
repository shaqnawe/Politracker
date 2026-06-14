---
name: design-system
description: Apply the visual design system for the PoliTracker Expo / React Native app. Use whenever building, styling, or reviewing any UI — screens, components, lists, rows, badges, charts. Defines dark + light themes, typography, fixed color semantics (green=buy/gain, red=sell/loss), and React Native component patterns. Trigger on any frontend, styling, or layout work, or when the user mentions colors, themes, fonts, or screens.
---

# Design System (React Native / Expo)

The visual language for the mobile app. Tokens live in `theme.ts`.
Import them and read from a ThemeContext — NEVER hardcode hex in
components. This is React Native: there is no CSS, no className, no
CSS variables. Style with `StyleSheet` / inline style objects.
(`assets/theme.css` is only for a future web client — ignore it for the
Expo app.)

## Color semantics — fixed, never repurpose

| Token      | Meaning (always)                              |
|------------|-----------------------------------------------|
| `accent`   | BUY · gain · positive return  (green)         |
| `danger`   | SELL · loss · conflict flag   (red)           |
| `accent2`  | warning · conflict badge · neutral highlight (amber) |
| `accent3`  | links · info · interactive    (blue)          |

Buy is always green, sell always red, in both themes. Never invert,
never use these decoratively.

## Themes & switching

Dark is the default; light is derived from the same hues, darkened for
contrast on light surfaces. Switch with the `useColorScheme()` hook
inside a ThemeProvider (see the usage sketch in `theme.ts`) — there is
no `data-theme` or `prefers-color-scheme` in RN. Test every component in
both schemes.

Surface order back→front: `bg` → `bg2` → `panel` → `panel2`. Cards on
`panel`; pressed/raised rows on `panel2`. Borders always `border`, 1px.
Radius: `radius.card` (14) on cards/inputs, `radius.chip` (6) on chips.

## Typography

- `fonts.head` **Newsreader** (serif) — screen titles & section headers.
- `fonts.ui*` **Spline Sans** — body, labels, buttons, nav.
- `fonts.mono*` **JetBrains Mono** — REQUIRED for every number, ticker,
  dollar amount, percentage. Spread the `numeric` helper from `theme.ts`
  into those `<Text>` styles — it sets the mono family AND
  `fontVariant: ['tabular-nums']` so columns align. A finance list with
  proportional numerals looks broken.

Load fonts with `expo-font` + the `@expo-google-fonts/*` packages and
gate render on `fontsLoaded`. Install line is in `theme.ts`.

## Component patterns

- **Trade row** (shared by trade feed + member profile): member name ·
  ticker (mono) · BUY/SELL pill (tinted `accent` / `danger`) · amount
  RANGE in mono · dates in `inkFaint`. One reusable row component.
- **No CSS gradients in RN.** The dark theme's background glow can't be a
  radial-gradient. Use a flat `bg`, or `expo-linear-gradient` for a very
  subtle top glow. Don't fake it with heavy color.
- **Disclaimers** (see caveats below): `inkFaint`, small, persistent but
  unobtrusive under lists and on profiles.

## Data-coupled rules (current backend reality)

- **Party tags are NOT available yet.** The `party` field is always
  `null` (no scraper populates it). Do not render D/R/I chips until a
  party source is wired in; show nothing rather than a fake/empty tag.
- **No performance/return data.** The API stores disclosed ranges only,
  with no stock-price feed, so there is no "return vs S&P 500" to show.
  Any performance UI is a FUTURE feature — don't design screens around
  data that isn't there. v1 profile = holdings + trade history, not
  returns.
- **Conflict badge** (committee overlap, amber) is also a future pattern
  — committee data isn't in the backend yet.

## Mandatory disclaimers to surface in UI

- 45-day reporting lag — nothing is truly real-time.
- Amounts are RANGES ($1,001–$15,000), never exact.
- **Coverage is partial:** Senate paper PTRs and House scanned PTRs are
  skipped, so some members' trades may be missing entirely. Any
  "most active" / ranking view must say it reflects only machine-readable
  filings, or it will mislead.

## Do / don't

- DO read all colors/fonts from `theme.ts` via the ThemeProvider.
- DO test components in light and dark.
- DON'T hardcode hex in components.
- DON'T use `accent`/`danger` for anything but their fixed meaning.
- DON'T put numbers in a proportional font.
- DON'T render party tags or performance figures until that data exists.
