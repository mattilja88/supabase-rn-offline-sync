# offlineSync

Offline-first package for React Native and Expo applications. Provides local 
SQLite storage and automatic synchronization with Supabase.

## Features

- SQLite as the local database
- Automatic synchronization when network connectivity is restored
- Soft delete support
- Version-based conflict detection
- Three conflict resolution strategies: server-wins, client-wins, manual-merge
- React hooks (`useOfflineFirst`, `useSyncConflicts`)

## Installation

\`\`\`bash
npm install supabase-rn-offline-sync
\`\`\`

## Quick start

\`\`\`tsx
import { OfflineSyncProvider, useOfflineFirst } from "supabase-rn-offline-sync";

// 1. Wrap your app with the Provider
<OfflineSyncProvider supabaseClient={supabase} tables={tables}>
  <App />
</OfflineSyncProvider>

// 2. Use the hook in your components
const { data, create, update, remove } = useOfflineFirst({ 
  table: "tasks" 
});
\`\`\`

## Documentation

- [Developer Guide](docs/offline-sync-guide.md) — installation and getting started

## Requirements

- React Native 0.72+
- Expo 50+
- expo-sqlite
- Supabase JS Client

## License

MIT