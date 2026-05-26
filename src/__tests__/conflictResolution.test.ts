import {
  resolveConflict,
  type ConflictRemoteResolver,
  type SyncConflictForResolution,
} from "../conflictResolution";

const runAsync = jest.fn();
const getFirstAsync = jest.fn();

const db: any = {
  runAsync,
  getFirstAsync,
};

jest.mock("../localDatabase", () => ({
  upsertFromRemote: jest.fn(),
}));

jest.mock("../offlineQueue", () => ({
  markConflictResolved: jest.fn(),
  markConflictResolving: jest.fn(),
  markConflictFailed: jest.fn(),
}));

import { upsertFromRemote } from "../localDatabase";
import {
  markConflictResolved,
  markConflictResolving,
  markConflictFailed,
} from "../offlineQueue";

function makeConflict(
  overrides: Partial<SyncConflictForResolution> = {},
): SyncConflictForResolution {
  return {
    id: 1,
    table_name: "tasks",
    row_id: "row-1",
    operation: "UPDATE",
    local_payload: JSON.stringify({
      id: "row-1",
      title: "Local title",
      version: 1,
    }),
    remote_payload: JSON.stringify({
      id: "row-1",
      title: "Remote title",
      version: 2,
    }),
    base_version: 1,
    remote_version: 2,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

it("server-wins tallentaa remote_payloadin paikalliseen kantaan ja merkitsee konfliktin ratkaistuksi", async () => {
  const conflict = makeConflict();

  await resolveConflict(db, conflict, "server-wins");

  expect(markConflictResolving).toHaveBeenCalledWith(
    db,
    conflict.id,
    "server-wins",
  );

  expect(upsertFromRemote).toHaveBeenCalledWith(
    db,
    "tasks",
    expect.objectContaining({
      id: "row-1",
      title: "Remote title",
      version: 2,
    }),
  );

  expect(markConflictResolved).toHaveBeenCalledWith(
    db,
    conflict.id,
    "server-wins",
  );

  expect(markConflictFailed).not.toHaveBeenCalled();
});

it("server-wins poistaa paikallisen rivin, jos remote_payload sisältää deleted_at-arvon", async () => {
  const conflict = makeConflict({
    remote_payload: JSON.stringify({
      id: "row-1",
      title: "Remote title",
      deleted_at: "2026-01-01T00:00:00.000Z",
      version: 3,
    }),
  });

  await resolveConflict(db, conflict, "server-wins");

  expect(runAsync).toHaveBeenCalledWith("DELETE FROM tasks WHERE id = ?", [
    "row-1",
  ]);

  expect(markConflictResolved).toHaveBeenCalledWith(
    db,
    conflict.id,
    "server-wins",
  );
});

it("client-wins lähettää paikallisen rivin remoteResolverille ja tallentaa palvelimen palauttaman rivin", async () => {
  const conflict = makeConflict();

  getFirstAsync.mockResolvedValueOnce({
    id: "row-1",
    title: "Local title",
    version: 1,
    is_synced: 0,
  });

  const remoteResolver: ConflictRemoteResolver = {
    forceUpdate: jest.fn().mockResolvedValue({
      id: "row-1",
      title: "Local title",
      version: 3,
      updated_at: "2026-01-01T00:00:00.000Z",
    }),
  };

  await resolveConflict(db, conflict, "client-wins", {
    remoteResolver,
  });

  expect(remoteResolver.forceUpdate).toHaveBeenCalledWith(
    "tasks",
    "row-1",
    expect.objectContaining({
      id: "row-1",
      title: "Local title",
    }),
  );

  expect(upsertFromRemote).toHaveBeenCalledWith(
    db,
    "tasks",
    expect.objectContaining({
      id: "row-1",
      title: "Local title",
      version: 3,
    }),
  );

  expect(markConflictResolved).toHaveBeenCalledWith(
    db,
    conflict.id,
    "client-wins",
  );
});

it("client-wins epäonnistuu ilman remoteResolveria ja merkitsee konfliktin failed-tilaan", async () => {
  const conflict = makeConflict();

  getFirstAsync.mockResolvedValueOnce({
    id: "row-1",
    title: "Local title",
    version: 1,
    is_synced: 0,
  });

  await expect(resolveConflict(db, conflict, "client-wins")).rejects.toThrow(
    "remoteResolver",
  );

  expect(markConflictFailed).toHaveBeenCalledWith(
    db,
    conflict.id,
    expect.any(Error),
  );

  expect(markConflictResolved).not.toHaveBeenCalled();
});

it("manual-merge ilman remoteResolveria päivittää rivin paikallisesti UPDATE-lauseella ja merkitsee sen synkkaamattomaksi", async () => {
  const conflict = makeConflict();

  await resolveConflict(db, conflict, "manual-merge", {
    mergedPayload: {
      title: "Merged title",
      version: 2,
    },
  });

  expect(runAsync).toHaveBeenCalled();
  const [sql, params] = runAsync.mock.calls[0];

  expect(sql).toContain("UPDATE tasks");
  expect(sql).toContain("WHERE id = ?");
  expect(sql).toContain("is_synced = ?");

  // Viimeinen parametri on rowId, ja is_synced = 0 löytyy parametreista
  expect(params[params.length - 1]).toBe("row-1");
  expect(params).toContain("Merged title");
  expect(params).toContain(2);
  expect(params).toContain(0);

  // Tässä polussa ei kutsuta upsertFromRemote-funktiota
  expect(upsertFromRemote).not.toHaveBeenCalled();

  expect(markConflictResolved).toHaveBeenCalledWith(
    db,
    conflict.id,
    "manual-merge",
  );
});

it("manual-merge remoteResolverilla lähettää mergedPayloadin palvelimelle ja tallentaa palautetun rivin", async () => {
  const conflict = makeConflict();

  const remoteResolver: ConflictRemoteResolver = {
    forceUpdate: jest.fn().mockResolvedValue({
      id: "row-1",
      title: "Merged title from server",
      version: 5,
    }),
  };

  await resolveConflict(db, conflict, "manual-merge", {
    remoteResolver,
    mergedPayload: {
      title: "Merged title",
    },
  });

  expect(remoteResolver.forceUpdate).toHaveBeenCalledWith(
    "tasks",
    "row-1",
    expect.objectContaining({
      id: "row-1",
      title: "Merged title",
    }),
  );

  expect(upsertFromRemote).toHaveBeenCalledWith(
    db,
    "tasks",
    expect.objectContaining({
      id: "row-1",
      title: "Merged title from server",
      version: 5,
    }),
  );

  expect(markConflictResolved).toHaveBeenCalledWith(
    db,
    conflict.id,
    "manual-merge",
  );
});

it("manual-merge epäonnistuu ilman mergedPayloadia", async () => {
  const conflict = makeConflict();

  await expect(resolveConflict(db, conflict, "manual-merge")).rejects.toThrow(
    "manual-merge vaatii mergedPayload",
  );

  expect(markConflictFailed).toHaveBeenCalledWith(
    db,
    conflict.id,
    expect.any(Error),
  );
});
