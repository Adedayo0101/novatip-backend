/**
 * Webhook delivery retention keeps successful and failed attempts on separate
 * schedules while sharing one bounded amount of deletion work per run.
 */

import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const { createFakeDb } = await import("./fake-db.helper.js");
type Fake = ReturnType<typeof createFakeDb>;

let fake: Fake;

jest.unstable_mockModule("../../db.js", () => ({
  db: new Proxy(
    {},
    {
      get: (_target, property: string) =>
        (fake.db as Record<string, unknown>)[property],
    },
  ),
  disconnectDb: async (): Promise<void> => undefined,
}));

const { config } = await import("../../config.js");
const { cutoffFor, pruneWebhookDeliveries, retentionEnabled } =
  await import("../../modules/webhooks/retention.js");

const NOW = new Date("2026-06-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

type RetentionConfig = typeof config.webhooks.retention;

async function withRetentionConfig(
  override: Partial<RetentionConfig>,
  run: () => Promise<void>,
): Promise<void> {
  const retention = config.webhooks.retention as unknown as Record<
    keyof RetentionConfig,
    number
  >;
  const original = { ...config.webhooks.retention };
  Object.assign(retention, override);
  try {
    await run();
  } finally {
    Object.assign(retention, original);
  }
}

function seedDelivery(
  success: boolean,
  attemptedAt: Date,
  suffix: string,
): void {
  fake.seedDelivery({
    id: `delivery-${suffix}`,
    webhookId: "webhook-1",
    success,
    attemptedAt,
  });
}

beforeEach(() => {
  fake = createFakeDb();
});

describe("cutoffFor", () => {
  it("subtracts a known retention window from the supplied date", () => {
    expect(cutoffFor(30, NOW)).toEqual(new Date("2026-05-02T12:00:00.000Z"));
  });
});

describe("retentionEnabled", () => {
  it.each([
    { successDays: 0, failureDays: 30, expected: true },
    { successDays: 7, failureDays: 0, expected: true },
    { successDays: 0, failureDays: 0, expected: false },
  ])(
    "returns $expected for successDays=$successDays and failureDays=$failureDays",
    async ({ successDays, failureDays, expected }) => {
      await withRetentionConfig({ successDays, failureDays }, async () => {
        expect(retentionEnabled()).toBe(expected);
      });
    },
  );
});

describe("pruneWebhookDeliveries", () => {
  it("uses the success and failure windows independently", async () => {
    await withRetentionConfig(
      { successDays: 7, failureDays: 30, batchSize: 10 },
      async () => {
        seedDelivery(true, new Date(NOW.getTime() - 8 * DAY_MS), "old-success");
        seedDelivery(true, new Date(NOW.getTime() - 6 * DAY_MS), "new-success");
        seedDelivery(
          false,
          new Date(NOW.getTime() - 31 * DAY_MS),
          "old-failure",
        );
        seedDelivery(
          false,
          new Date(NOW.getTime() - 29 * DAY_MS),
          "new-failure",
        );

        await expect(pruneWebhookDeliveries(NOW)).resolves.toEqual({
          deletedSuccesses: 1,
          deletedFailures: 1,
          truncated: false,
        });
        expect(fake.deliveries.map((row) => row.id).sort()).toEqual([
          "delivery-new-failure",
          "delivery-new-success",
        ]);
      },
    );
  });

  it.each([
    { successDays: 0, failureDays: 30, kept: "success" },
    { successDays: 7, failureDays: 0, kept: "failure" },
  ])("leaves $kept rows untouched when its window is 0", async (window) => {
    await withRetentionConfig(
      {
        successDays: window.successDays,
        failureDays: window.failureDays,
        batchSize: 10,
      },
      async () => {
        seedDelivery(true, new Date(NOW.getTime() - 365 * DAY_MS), "success");
        seedDelivery(false, new Date(NOW.getTime() - 365 * DAY_MS), "failure");

        const result = await pruneWebhookDeliveries(NOW);

        expect(fake.deliveries.map((row) => row.id)).toEqual([
          `delivery-${window.kept}`,
        ]);
        expect(result.truncated).toBe(false);
      },
    );
  });

  it("shares the batch ceiling and reports remaining rows as truncated", async () => {
    await withRetentionConfig(
      { successDays: 7, failureDays: 30, batchSize: 1 },
      async () => {
        for (let index = 0; index < 49; index += 1) {
          seedDelivery(
            true,
            new Date(NOW.getTime() - 8 * DAY_MS),
            `success-${index}`,
          );
        }
        seedDelivery(false, new Date(NOW.getTime() - 31 * DAY_MS), "failure-1");
        seedDelivery(false, new Date(NOW.getTime() - 31 * DAY_MS), "failure-2");

        await expect(pruneWebhookDeliveries(NOW)).resolves.toEqual({
          deletedSuccesses: 49,
          deletedFailures: 1,
          truncated: true,
        });
        expect(fake.deliveries.map((row) => row.id)).toEqual([
          "delivery-failure-2",
        ]);
      },
    );
  });
});
