/**
 * redis.test.ts
 *
 * Unit tests for cache helper misses and failures.
 *
 * ioredis is mocked with an in-memory store so this runs without a Redis
 * server: the behaviour under test is cacheGet's own error handling, not the
 * client's. config.ts validates required env vars at module load, so those are
 * set before the module graph is imported.
 */

import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const store = new Map<string, string>();
let getError: Error | null = null;
let setError: Error | null = null;
let delError: Error | null = null;
const loggerWarnMock = jest.fn();

const mockClient = {
  get: async (key: string): Promise<string | null> => {
    if (getError) throw getError;
    return store.get(key) ?? null;
  },
  set: async (key: string, value: string): Promise<"OK"> => {
    if (setError) throw setError;
    store.set(key, value);
    return "OK";
  },
  del: async (key: string): Promise<number> => {
    if (delError) throw delError;
    return store.delete(key) ? 1 : 0;
  },
  on: () => undefined,
  quit: async (): Promise<"OK"> => "OK",
};

jest.unstable_mockModule("ioredis", () => ({
  Redis: function Redis() {
    return mockClient;
  },
  default: function Redis() {
    return mockClient;
  },
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: {
    child: (): Record<string, unknown> => ({
      warn: loggerWarnMock,
      error: jest.fn(),
      info: jest.fn(),
    }),
  },
}));

const { cacheGet, cacheSet, cacheInvalidate } = await import("../redis.js");

describe("cacheGet", () => {
  const testKey = "test-corrupt-entry";
  const fullKey = `cache:${testKey}`;

  beforeEach(() => {
    store.clear();
    getError = null;
    setError = null;
    delError = null;
    jest.clearAllMocks();
  });

  it("returns the parsed value for a valid entry", async () => {
    const data = { id: 123, name: "Alice" };
    await cacheSet(testKey, data, 60);

    await expect(cacheGet<typeof data>(testKey)).resolves.toEqual(data);
  });

  it("returns null on a miss", async () => {
    await expect(cacheGet("never-written")).resolves.toBeNull();
  });

  it("treats a corrupt entry as a miss rather than throwing", async () => {
    store.set(fullKey, '{ "id": 123, "name": invalid_json ');

    await expect(cacheGet(testKey)).resolves.toBeNull();
  });

  it("evicts a corrupt entry so the next read repopulates it", async () => {
    store.set(fullKey, "not json at all");

    await cacheGet(testKey);

    expect(store.has(fullKey)).toBe(false);
  });

  it("treats a Redis read error as a cache miss and logs a warning", async () => {
    const error = new Error("Redis unavailable");
    getError = error;

    await expect(cacheGet(testKey)).resolves.toBeNull();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      { err: error, key: fullKey },
      "cache read failed — treating as a miss",
    );
  });

  it("logs Redis write and invalidation errors without throwing", async () => {
    const error = new Error("Redis unavailable");
    setError = error;
    await expect(cacheSet(testKey, { id: 1 }, 60)).resolves.toBeUndefined();

    setError = null;
    delError = error;
    await expect(cacheInvalidate(testKey)).resolves.toBeUndefined();

    expect(loggerWarnMock).toHaveBeenCalledWith(
      { err: error, key: fullKey },
      "failed to write cache entry",
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(
      { err: error, key: fullKey },
      "failed to invalidate cache entry",
    );
  });
});
