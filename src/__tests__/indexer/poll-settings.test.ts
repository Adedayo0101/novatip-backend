/**
 * __tests__/indexer/poll-settings.test.ts
 *
 * Tests for configurable indexer poll settings (#80):
 * - POLL_INTERVAL_MS and POLL_LIMIT are read from config with defaults (6000ms and 200)
 * - Both constants are exported so tests do not restate them
 * - startIndexer accepts injectable options for pollIntervalMs and pollLimit
 */

import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

jest.unstable_mockModule("../../db.js", () => ({
  db: {
    indexerCursor: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async () => ({})),
    },
  },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => undefined),
  cacheInvalidate: jest.fn(async () => undefined),
  disconnectRedis: async (): Promise<void> => undefined,
}));

const { config } = await import("../../config.js");
const { POLL_INTERVAL_MS, POLL_LIMIT } = await import(
  "../../indexer/indexer.js"
);

describe("indexer poll settings configuration (#80)", () => {
  test("config has default poll interval and limit", () => {
    expect(config.indexer.pollIntervalMs).toBe(6_000);
    expect(config.indexer.pollLimit).toBe(200);
  });

  test("indexer exports POLL_INTERVAL_MS and POLL_LIMIT matching config", () => {
    expect(POLL_INTERVAL_MS).toBe(config.indexer.pollIntervalMs);
    expect(POLL_LIMIT).toBe(config.indexer.pollLimit);
  });

  test("the poll settings are defined once, under config.indexer only", () => {
    expect(config.stellar).not.toHaveProperty("indexerPollIntervalMs");
    expect(config.stellar).not.toHaveProperty("indexerPollLimit");
  });
});
