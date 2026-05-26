# offlineSync

Offline-first-paketti React Native ja Expo -sovelluksille. Tarjoaa paikallisen 
SQLite-tallennuksen ja automaattisen synkronoinnin Supabaseen.

## Ominaisuudet

- SQLite paikallisena tietokantana
- Automaattinen synkronointi verkkoyhteyden palautuessa
- Soft delete -tuki
- Versionumeroihin perustuva konfliktien tunnistus
- Kolme konfliktinratkaisustrategiaa: server-wins, client-wins, manual-merge
- React-hookit (`useOfflineFirst`, `useSyncConflicts`)

## Asennus

\`\`\`bash
npm install @sinunpakettisi/offline-sync
\`\`\`

## Pikaopas

\`\`\`tsx
import { OfflineSyncProvider, useOfflineFirst } from "@TODO;KEKSI NIMI PAKETILLE/offline-sync";

// 1. Kääri sovellus Providerilla
<OfflineSyncProvider supabaseClient={supabase} tables={tables}>
  <App />
</OfflineSyncProvider>

// 2. Käytä hookia komponentissa
const { data, create, update, remove } = useOfflineFirst({ 
  table: "tasks" 
});
\`\`\`

## Dokumentaatio

- [Käyttöopas](docs/offline-sync-guide.md) — asennus ja ensimmäinen käyttö

## Vaatimukset

- React Native 0.72+
- Expo 50+
- expo-sqlite
- Supabase JS Client

## Lisenssi

MIT
