/**
 * __tests__/webhooks/failure-notifications.test.ts
 *
 * Covers notifyWebhookFailure as wired into dispatchWebhooks: a failed
 * delivery used to be visible only in WebhookDelivery, a table a creator has
 * to think to go read. These tests pin that a failure now also writes a
 * WEBHOOK_FAILED notification naming the webhook, its URL and the status
 * code, that a success never does, that repeat failures of the same webhook
 * are throttled to one row per hour rather than one per tip, and that a
 * broken notification write cannot take the delivery loop down with it.
 *
 * config.ts validates required env vars at module load, so those are set
 * before the module graph is imported.
 */

import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const { createFakeDb } = await import("./fake-db.helper.js");

type Fake = ReturnType<typeof createFakeDb>;

let fake: Fake;
const webhookLoggerMock = {
  error: jest.fn<(fields: object, message: string) => void>(),
  warn: jest.fn<(fields: object, message: string) => void>(),
};

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

jest.unstable_mockModule("../../utils/logger.js", () => ({
  logger: { child: () => webhookLoggerMock },
}));

const { dispatchWebhooks, sendTestPing } =
  await import("../../modules/webhooks/webhooks.service.js");

const CREATOR = "creator_alice";

const tip = {
  jarId: "@alice",
  from: `G${"A".repeat(55)}`,
  amount: 25_000_000n,
  message: "nice work",
  ledger: 1_234,
  timestamp: "2026-01-01T00:00:00Z",
  txHash: "a".repeat(64),
};

const mockFetch = jest.fn<typeof fetch>();
const realFetch = globalThis.fetch;

function failWith(status: number, body: string): void {
  mockFetch.mockResolvedValue({
    ok: false,
    status,
    text: async () => body,
  } as unknown as Response);
}

function succeed(): void {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => "ok",
  } as unknown as Response);
}

beforeEach(() => {
  fake = createFakeDb();
  mockFetch.mockReset();
  webhookLoggerMock.error.mockClear();
  webhookLoggerMock.warn.mockClear();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  // The fake db's own clock (see fake-db.helper.ts) starts here regardless of
  // what each test does, so pinning the system clock to the same instant
  // keeps notifyWebhookFailure's Date.now()-based window comparable to the
  // createdAt timestamps the fake db hands out.
  jest.useFakeTimers();
  jest.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)));
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("a failing delivery", () => {
  it("writes a WEBHOOK_FAILED notification naming the webhook, URL and status", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    const webhook = fake.seedWebhook({
      creatorId: CREATOR,
      url: "https://hooks.example.com/novatip",
    });
    failWith(500, "boom");

    await dispatchWebhooks(tip);

    expect(fake.notifications).toHaveLength(1);
    expect(fake.notifications[0]).toMatchObject({
      creatorId: CREATOR,
      type: "WEBHOOK_FAILED",
      payload: {
        webhookId: webhook.id,
        url: "https://hooks.example.com/novatip",
        statusCode: 500,
      },
    });
  });

  it("records a null status code when the request never completed", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    const webhook = fake.seedWebhook({ creatorId: CREATOR });
    mockFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await dispatchWebhooks(tip);

    expect(fake.notifications[0]?.payload).toMatchObject({
      webhookId: webhook.id,
      statusCode: null,
    });
  });
});

describe("a successful delivery", () => {
  it("never writes a WEBHOOK_FAILED notification", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    fake.seedWebhook({ creatorId: CREATOR });
    succeed();

    await dispatchWebhooks(tip);

    expect(fake.notifications).toHaveLength(0);
  });
});

describe("repeat-failure suppression", () => {
  it("writes at most one notification per webhook within an hour", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    fake.seedWebhook({ creatorId: CREATOR });
    failWith(500, "boom");

    await dispatchWebhooks(tip); // first failure — writes
    await dispatchWebhooks(tip); // second failure, same hour — suppressed

    expect(fake.notifications).toHaveLength(1);
  });

  it("writes a new notification once the window has passed", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    fake.seedWebhook({ creatorId: CREATOR });
    failWith(500, "boom");

    await dispatchWebhooks(tip);
    expect(fake.notifications).toHaveLength(1);

    // +2h, comfortably past the 1h window even allowing for the few seconds
    // of drift the fake db's own tick-based clock adds to createdAt.
    jest.setSystemTime(new Date(Date.UTC(2026, 0, 1, 2, 0, 0)));

    await dispatchWebhooks(tip);
    expect(fake.notifications).toHaveLength(2);
  });

  it("tracks each webhook's suppression window independently", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    const first = fake.seedWebhook({ creatorId: CREATOR });
    const second = fake.seedWebhook({ creatorId: CREATOR });
    failWith(500, "boom");

    // Both webhooks are enabled for the same creator, so one dispatch reaches
    // both — a window keyed by webhook rather than by creator must still
    // produce one row per webhook, not one for the pair.
    await dispatchWebhooks(tip);

    const webhookIds = fake.notifications.map(
      (row) => (row.payload as { webhookId: string }).webhookId,
    );
    expect(webhookIds.sort()).toEqual([first.id, second.id].sort());
  });
});

describe("a broken notification write", () => {
  it("never stops the delivery from being recorded", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    fake.seedWebhook({ creatorId: CREATOR });
    failWith(500, "boom");

    const client = fake.db as {
      notification: { create: (...args: never[]) => unknown };
    };
    jest.spyOn(client.notification, "create").mockImplementation(() => {
      throw new Error("notifications table is down");
    });

    await expect(dispatchWebhooks(tip)).resolves.toBeUndefined();

    // The delivery itself — the thing the indexer actually depends on — went
    // through even though the notification could not be written.
    expect(fake.deliveries).toHaveLength(1);
    expect(fake.deliveries[0]).toMatchObject({ success: false });
  });

  it("logs a failed delivery-row write and still notifies the creator", async () => {
    fake.seedCreator({ id: CREATOR, jarId: "@alice" });
    const webhook = fake.seedWebhook({
      creatorId: CREATOR,
      url: "https://hooks.example.com/novatip",
    });
    failWith(500, "receiver failed");

    const client = fake.db as {
      webhookDelivery: { create: (...args: never[]) => unknown };
    };
    jest
      .spyOn(client.webhookDelivery, "create")
      .mockImplementation(() => {
        throw new Error("delivery table is down");
      });

    await expect(dispatchWebhooks(tip)).resolves.toBeUndefined();

    expect(webhookLoggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: webhook.id }),
      "failed to record webhook delivery",
    );
    expect(fake.deliveries).toHaveLength(0);
    expect(fake.notifications).toHaveLength(1);
    expect(fake.notifications[0]).toMatchObject({
      creatorId: CREATOR,
      type: "WEBHOOK_FAILED",
      payload: { webhookId: webhook.id, statusCode: 500 },
    });
  });

  it("returns a failed ping outcome instead of throwing when its row cannot be written", async () => {
    const webhook = fake.seedWebhook({ creatorId: CREATOR });
    const client = fake.db as {
      webhookDelivery: { create: (...args: never[]) => unknown };
    };
    jest
      .spyOn(client.webhookDelivery, "create")
      .mockImplementation(() => {
        throw new Error("delivery table is down");
      });
    succeed();

    await expect(sendTestPing(CREATOR, webhook.id)).resolves.toMatchObject({
      success: false,
      statusCode: 200,
    });
  });
});
