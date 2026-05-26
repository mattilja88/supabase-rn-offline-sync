import { deleteLocal, queryLocal } from "../localDatabase";

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

describe("deleteLocal (soft delete)", () => {
  it("asettaa deleted_at, updated_at ja merkitsee rivin synkronoimattomaksi", async () => {
    await deleteLocal(db, "tasks", "row-1");

    expect(runAsync).toHaveBeenCalledTimes(1);
    const [sql, params] = runAsync.mock.calls[0];

    expect(sql).toContain("UPDATE tasks");
    expect(sql).toContain("deleted_at = ?");
    expect(sql).toContain("updated_at = ?");
    expect(sql).toContain("is_synced = 0");
    expect(sql).toContain("WHERE id = ?");

    // Parametrit: [deleted_at, updated_at, id]
    expect(params).toHaveLength(3);
    expect(params[2]).toBe("row-1");

    // deleted_at ja updated_at ovat sama ISO-aikaleima
    expect(params[0]).toBe(params[1]);
    expect(typeof params[0]).toBe("string");
    expect(() => new Date(params[0] as string).toISOString()).not.toThrow();
  });
});

describe("queryLocal (soft delete -suodatus)", () => {
  it("suodattaa oletuksena pois soft-deletetyt rivit (deleted_at IS NULL)", async () => {
    getAllAsync.mockResolvedValueOnce([]);

    await queryLocal(db, "tasks");

    expect(getAllAsync).toHaveBeenCalledTimes(1);
    const [sql] = getAllAsync.mock.calls[0];

    expect(sql).toContain("SELECT * FROM tasks");
    expect(sql).toContain("WHERE deleted_at IS NULL");
  });

  it("sisällyttää soft-deletetyt rivit, kun includeDeleted = true", async () => {
    getAllAsync.mockResolvedValueOnce([]);

    await queryLocal(db, "tasks", { includeDeleted: true });

    expect(getAllAsync).toHaveBeenCalledTimes(1);
    const [sql] = getAllAsync.mock.calls[0];

    expect(sql).toContain("SELECT * FROM tasks");
    expect(sql).not.toContain("deleted_at IS NULL");
  });
});
