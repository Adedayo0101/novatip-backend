/**
 * __tests__/indexer/interruptible-sleep.test.ts
 *
 * Tests for interruptible indexer sleep on shutdown (#81):
 * - stopIndexer remains safe to call when the indexer is not running
 * - A stop request wakes the loop rather than waiting out the sleep
 * - A poll already in progress is still allowed to finish
 */

import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const fetchTipEventsMock = jest.fn<() => Promise<any[]>>();
const readCursorMock = jest.fn(async () => 100);
const updateCursorMock = jest.fn(async () => {});
const persistedHashes: string[] = [];
let resolveSecondTipPersist: () => void = () => {};
let secondTipPersisted = new Promise<void>(() => {});
const persistTipMock = jest.fn(async (event: { txHash: string }) => {
  persistedHashes.push(event.txHash);
  return true;
});
const enqueueWebhookDispatchMock = jest.fn(() => {
  void new Promise<void>(() => {});
  if (enqueueWebhookDispatchMock.mock.calls.length === 2) {
    resolveSecondTipPersist();
  }
});

jest.unstable_mockModule("@novatip/sdk", () => ({
  fetchTipEvents: fetchTipEventsMock,
  getNetwork: jest.fn(() => ({ name: "testnet" })),
  networkFromEnv: jest.fn(() => ({ name: "testnet" })),
}));

jest.unstable_mockModule("../../indexer/rpc.js", () => ({
  fetchLatestLedger: jest.fn(async () => 100),
}));

jest.unstable_mockModule("../../indexer/persist.js", () => ({
  readCursor: readCursorMock,
  updateCursor: updateCursorMock,
  persistTip: persistTipMock,
}));

jest.unstable_mockModule("../../modules/webhooks/webhooks.service.js", () => ({
  enqueueWebhookDispatch: enqueueWebhookDispatchMock,
}));

jest.unstable_mockModule("../../modules/notifications/email.service.js", () => ({
  sendTipNotification: jest.fn(async () => {}),
}));

jest.unstable_mockModule("../../db.js", () => ({
  db: {},
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => undefined),
  cacheInvalidate: jest.fn(async () => undefined),
  disconnectRedis: async (): Promise<void> => undefined,
}));

const { startIndexer, stopIndexer } = await import(
  "../../indexer/indexer.js"
);

describe("interruptible indexer sleep (#81)", () => {
  beforeEach(async () => {
    await stopIndexer();
    fetchTipEventsMock.mockReset();
    readCursorMock.mockReset();
    readCursorMock.mockResolvedValue(100);
    updateCursorMock.mockReset();
    persistedHashes.length = 0;
    resolveSecondTipPersist = () => {};
    secondTipPersisted = new Promise<void>((resolve) => {
      resolveSecondTipPersist = resolve;
    });
    persistTipMock.mockClear();
    enqueueWebhookDispatchMock.mockClear();
  });

  afterEach(async () => {
    await stopIndexer();
  });

  test("stopIndexer is safe to call when the indexer is not running", async () => {
    await expect(stopIndexer()).resolves.toBeUndefined();
  });

  test("a stop request wakes the loop immediately rather than waiting out the sleep", async () => {
    fetchTipEventsMock.mockResolvedValue([]);

    const loopPromise = startIndexer({ pollIntervalMs: 10_000, pollLimit: 200 });

    // Wait until the loop has executed one fetch and entered sleep
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchTipEventsMock).toHaveBeenCalled();

    const startTime = Date.now();
    await stopIndexer();
    const elapsed = Date.now() - startTime;

    // Must resolve almost immediately, well below the 10,000ms sleep interval
    expect(elapsed).toBeLessThan(1_000);
    await expect(loopPromise).resolves.toBeUndefined();
  });

  test("a poll already in progress is allowed to finish before stopping", async () => {
    let resolvePoll: (val: any[]) => void = () => {};
    let pollFinished = false;

    fetchTipEventsMock.mockImplementationOnce(() => {
      return new Promise((resolve) => {
        resolvePoll = (val: any[]) => {
          pollFinished = true;
          resolve(val);
        };
      });
    });

    const loopPromise = startIndexer({ pollIntervalMs: 5_000, pollLimit: 200 });

    // Wait for the poll to start
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchTipEventsMock).toHaveBeenCalledTimes(1);
    expect(pollFinished).toBe(false);

    // Call stopIndexer while poll is still in progress
    const stopPromise = stopIndexer();

    // The stop promise should not resolve yet because the poll is still running
    let stopResolved = false;
    stopPromise.then(() => {
      stopResolved = true;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(stopResolved).toBe(false);
    expect(pollFinished).toBe(false);

    // Complete the in-progress poll
    resolvePoll([]);

    // Now both promises must resolve
    await stopPromise;
    await loopPromise;
    expect(pollFinished).toBe(true);
    expect(stopResolved).toBe(true);
  });

  test("a never-resolving delivery does not block persisting the next tip", async () => {
    fetchTipEventsMock
      .mockResolvedValueOnce([
        {
          jarId: "@alice",
          from: "GUSER123",
          amount: 1n,
          message: "",
          ledger: 101,
          timestamp: "2026-01-01T00:00:00Z",
          txHash: "tip-1",
        },
        {
          jarId: "@alice",
          from: "GUSER123",
          amount: 1n,
          message: "",
          ledger: 102,
          timestamp: "2026-01-01T00:00:00Z",
          txHash: "tip-2",
        },
      ])
      .mockResolvedValue([]);

    const loopPromise = startIndexer({ pollIntervalMs: 10_000, pollLimit: 200 });
    await secondTipPersisted;

    expect(persistedHashes).toEqual(["tip-1", "tip-2"]);
    expect(enqueueWebhookDispatchMock).toHaveBeenCalledTimes(2);

    await stopIndexer();
    await loopPromise;
  });
});
