jest.mock("expo-crypto", () => ({
  randomUUID: jest.fn(() => "fake-uuid-123"),
}));

import {
  addToQueue,
  compactQueue,
  markQueueItemFailed,
  type QueueItem,
} from "../offlineQueue";

const runAsync = jest.fn();
const getAllAsync = jest.fn();
const getFirstAsync = jest.fn();

const db: any = {
  runAsync,
  getAllAsync,
  getFirstAsync,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("addToQueue", () => {
  it("tallentaa payloadin client_operation_id:n kanssa ja täyttää row_id sekä base_version automaattisesti", async () => {
    await addToQueue(db, "tasks", "UPDATE", {
      id: "row-1",
      title: "Hello",
      version: 3,
    });

    expect(runAsync).toHaveBeenCalledTimes(1);
    const [sql, params] = runAsync.mock.calls[0];

    expect(sql).toContain("INSERT INTO sync_queue");

    // Parametrit järjestyksessä: table, operation, data, row_id, payload, base_version, client_operation_id
    expect(params[0]).toBe("tasks");
    expect(params[1]).toBe("UPDATE");
    expect(params[3]).toBe("row-1");
    expect(params[5]).toBe(3);
    expect(params[6]).toBe("fake-uuid-123");

    // Payload sisältää alkuperäisen datan ja siihen lisätyn client_operation_id:n
    const payload = JSON.parse(params[4] as string);
    expect(payload).toEqual({
      id: "row-1",
      title: "Hello",
      version: 3,
      client_operation_id: "fake-uuid-123",
    });
  });
});

describe("markQueueItemFailed", () => {
  it("kasvattaa attempts-laskuria ja asettaa eksponentiaalisen backoffin next_retry_at-kenttään", async () => {
    // Nykyinen rivi: epäonnistunut jo kerran aiemmin
    getFirstAsync.mockResolvedValueOnce({ attempts: 1 });

    const fakeNow = new Date("2026-01-01T00:00:00.000Z").getTime();
    jest.spyOn(Date, "now").mockReturnValue(fakeNow);

    try {
      await markQueueItemFailed(db, 42, new Error("Network down"));
    } finally {
      (Date.now as jest.Mock).mockRestore();
    }

    expect(runAsync).toHaveBeenCalledTimes(1);
    const [sql, params] = runAsync.mock.calls[0];

    expect(sql).toContain("UPDATE sync_queue");
    expect(sql).toContain("attempts = ?");
    expect(sql).toContain("next_retry_at = ?");

    // attempts: 1 → 2; backoff: 2^2 * 1000 = 4000 ms
    const [attempts, lastError, nextRetryAt, id] = params;
    expect(attempts).toBe(2);
    expect(lastError).toBe("Network down");
    expect(id).toBe(42);
    expect(nextRetryAt).toBe(new Date(fakeNow + 4000).toISOString());
  });
});

describe("compactQueue", () => {
  it("poistaa molemmat operaatiot, kun rivi luodaan ja poistetaan ennen synkronointia (INSERT + DELETE)", async () => {
    const insertItem: QueueItem = {
      id: 1,
      table_name: "tasks",
      operation: "INSERT",
      data: null,
      row_id: "row-1",
      payload: JSON.stringify({ id: "row-1", title: "Hello" }),
      base_version: null,
      client_operation_id: "op-1",
      attempts: 0,
      last_error: null,
      next_retry_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
    };

    const deleteItem: QueueItem = {
      ...insertItem,
      id: 2,
      operation: "DELETE",
      payload: JSON.stringify({
        id: "row-1",
        deleted_at: "2026-01-02T00:00:00.000Z",
      }),
      client_operation_id: "op-2",
      created_at: "2026-01-02T00:00:00.000Z",
    };

    getAllAsync.mockResolvedValueOnce([insertItem, deleteItem]);

    await compactQueue(db, "tasks");

    // Molempien jonorivien pitäisi tulla poistetuksi yhdellä DELETE...IN-kyselyllä
    const deleteCalls = runAsync.mock.calls.filter(([sql]) =>
      String(sql).includes("DELETE FROM sync_queue WHERE id IN"),
    );

    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][1]).toEqual([1, 2]);

    // Ja koska INSERT + DELETE → ei mitään, mitään uutta operaatiota ei pidä lisätä jonoon
    const insertCalls = runAsync.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO sync_queue"),
    );

    expect(insertCalls).toHaveLength(0);
  });
});
