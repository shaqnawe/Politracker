# PoliTracker — mobile

Expo (React Native) app that shows Congressional trading activity by member. It reads the
[backend API](../server) — it does not scrape anything itself.

## Setup

Start the backend first (see [../server](../server)), then:

```bash
npm install
npm start          # Expo dev server: press i (iOS), a (Android), or w (web)
npm run web        # run directly in the browser
```

## Pointing the app at the API

`src/api.ts` chooses a sensible default:

| Target | URL |
| --- | --- |
| iOS simulator / web | `http://localhost:4000` |
| Android emulator | `http://10.0.2.2:4000` |
| Physical device | set `EXPO_PUBLIC_API_BASE=http://<your-LAN-ip>:4000` |

```bash
EXPO_PUBLIC_API_BASE=http://192.168.1.50:4000 npm start
```

## Screens

- **Members** (`src/screens/MembersScreen.tsx`) — every member with ≥1 disclosed trade,
  sorted by activity. Search by name/state, filter by chamber.
- **Member** (`src/screens/MemberScreen.tsx`) — profile: buy/sell stats, date range,
  most-traded tickers, and full trade history with amounts, owner, and a link to the
  original filing.

Navigation is a native stack ([App.tsx](App.tsx)); web URLs are wired via linking
(`/` = members, `/member/:id` = profile).

> Note: `src/theme/theme.ts` is a richer design-token set (light/dark, fonts) that the app
> does not consume yet — `src/theme.ts` holds the colors currently in use.
