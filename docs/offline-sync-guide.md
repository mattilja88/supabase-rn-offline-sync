# Offline Sync -paketin käyttöohje

Tämä dokumentti selittää, miten `offlineSync`-pakettia käytetään sovelluksessa. Paketti tarjoaa offline-first-arkkitehtuurin React Native / Expo -sovellukselle, jossa:

- SQLite toimii ensisijaisena tietolähteenä  
- Supabase toimii synkronointikerroksena  

---

## 1. Paketin perusidea

Paketti toimii seuraavalla mallilla:

1. Data luetaan aina paikallisesta SQLite-tietokannasta  
2. Käyttäjän muutokset tallennetaan heti paikallisesti  
3. Muutokset lisätään `sync_queue`-jonoon  
4. Online-tilassa muutokset pusketaan Supabaseen  
5. Supabasesta haetaan uudet muutokset takaisin SQLiteen  
6. Mahdolliset ristiriidat tallennetaan konflikteina  

👉 Sovellus toimii täysin offline-tilassa ilman viivettä.

---

## 2. Pääkomponentit

### OfflineSyncProvider
- Luo SQLite-tietokannan  
- Luo taulut ja migraatiot  
- Luo `sync_queue` ja `sync_conflicts`  
- Jakaa db:n ja Supabase-clientin Contextin kautta  

### useOfflineFirst
- Pääasiallinen hook sovellukselle  
- CRUD + sync  
- Palauttaa synkronoinnin tilan  

### localDatabase.ts
- SQLite CRUD-operaatiot  
- `upsertFromRemote` (server → local)

### offlineQueue.ts
- `sync_queue` (push)  
- `sync_conflicts` (conflict storage)  
- retry/backoff  
- queue compaction  

### syncEngine.ts
- push (local → server)  
- pull (server → local)  
- konfliktien tunnistus  

### conflictResolution.ts
- konfliktien ratkaisu  

### useSyncConflicts
- konfliktien hallinta  

### useConflictHelpers
- UI-ystävällinen API konflikteille  

---

## 3. Providerin käyttöönotto

```tsx
<OfflineSyncProvider
  supabaseClient={supabase}
  tables={tables}
>
  <App />
</OfflineSyncProvider>
```

Provider lisää automaattisesti:

```
created_at
updated_at
deleted_at
version
is_synced
```

---

## 4. Taulujen määrittely

```ts
{
  name: "tasks",
  columns: `
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL
  `
}
```

Vaaditaan:
- id
- samat kentät Supabasessa

---

## 5. useOfflineFirst

```ts
const {
  data,
  create,
  update,
  remove,
  sync,
  pendingChanges,
  pendingConflicts,
  syncState
} = useOfflineFirst({ table: "tasks" });
```

---

## 6. Create

```ts
await create({ title: "Testi" });
```

→ SQLite  
→ queue  
→ sync  

---

## 7. Update

```ts
await update(id, { title: "Uusi" });
```

→ base_version tallennetaan  
→ konfliktit mahdollisia  

---

## 8. Delete

```ts
await remove(id);
```

→ soft delete (`deleted_at`)  

---

## 9. Synkronointi

```ts
await sync();
```

Suorittaa:
1. compactQueue  
2. pushChanges  
3. pullChanges  

---

## 10. RPC-pohjainen synkronointi

```ts
useRpcSync: true
```

Käyttää:
```
apply_sync_insert
apply_sync_update
```

---

## 11. Supabase-vaatimukset

```
id uuid primary key
updated_at timestamptz
deleted_at timestamptz
version integer
client_operation_id uuid
```

---

## 12. Konfliktimalli

```
local version ≠ remote version
→ konflikti
```

```
pending → resolving → resolved
```

---

## 13. Konfliktistrategiat

- server-wins  
- client-wins  
- manual-merge  

Manual merge EI käytä INSERT OR REPLACE  
→ estää datan katoamisen  

---

## 14. Konfliktien ratkaisu

```ts
resolveConflict(db, conflict, "server-wins");
```

---

## 15. useConflictHelpers

```ts
resolve(conflict, "server");
resolve(conflict, "client");
merge(conflict, payload);
ignore(conflict);
```

---

## 16. Pull-suojaus

```
is_synced = 0 → ei overwritea
```

---

## 17. Version hallinta

```
server omistaa version
```

---

## 18. Queue compaction

```
INSERT + UPDATE → INSERT
UPDATE + UPDATE → UPDATE
INSERT + DELETE → poistetaan
```

---

## 19. Sync status

```
idle | syncing | offline | error | conflict
```

---

## 20. Verkkoyhteys

```
offline → online → auto sync
```

---

## 21. Retry

```ts
resetRetry(conflict);
```

---

## 22. Kehittäjän muistilista

- Käytä Provideria  
- Käytä useOfflineFirst  
- Älä käytä suoraa Supabasea  
- Lisää metadata Supabaseen  
- Käytä RPC:tä  
- Käsittele konfliktit UI:ssa  

---

## 23. Rajoitteet

- force-update RPC puuttuu  
- ei automaattista mergeä  
- ei UI:ta mukana  

---

## 24. Yhteenveto

- offline-first data layer  
- synkronointi queue + retry  
- konfliktien hallinta  
- turvallinen pull  

👉 Sovellus toimii offline-tilassa ja säilyttää datan eheyden.
