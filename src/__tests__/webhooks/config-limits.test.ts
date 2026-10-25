/**
 * __tests__/webhooks/config-limits.test.ts
 *
 * Covers:
 * - Configurable delivery limits: WEBHOOK_TIMEOUT_MS, WEBHOOK_MAX_BODY_SIZE, WEBHOOK_MAX_PAYLOAD_SIZE
 * - Delivery does not follow redirects (redirect: "manual"), recording redirects as failed attempts with their status code.
 */

import { jest } from "@jest/globals";
import type { TipEvent } from "@novatip/sdk";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
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

const mockFetch = jest.fn<typeof fetch>();
globalThis.fetch = mockFetch as unknown as typeof fetch;

const { config } = await import("../../config.js");
const { dispatchWebhooks, sendTestPing } =
  await import("../../modules/webhooks/webhooks.service.js");

describe("webhook delivery limits and redirect handling", () => {
  beforeEach(() => {
    fake = createFakeDb();
    mockFetch.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const tip: TipEvent = {
    jarId: "@alice",
    from: "GUSER123",
    amount: 10000000n,
    message: "Test tip",
    ledger: 100,
    timestamp: "2026-10-17T12:00:00Z",
    txHash: "0xabcdef1234567890",
  };

  it("defaults timeoutMs to 5000, maxBodySize to 1024, and maxPayloadSize to 2048", () => {
    expect(config.webhooks.timeoutMs).toBe(5_000);
    expect(config.webhooks.maxBodySize).toBe(1_024);
    expect(config.webhooks.maxPayloadSize).toBe(2_048);
    expect(config.webhooks.deliveryConcurrency).toBe(10);
  });

  it("does not follow redirects and records a 302 as a failed delivery with its status code", async () => {
    fake.seedCreator({ id: "creator_1", jarId: "@alice" });
    const webhook = fake.seedWebhook({
      creatorId: "creator_1",
      url: "https://redirect.example.com/webhook",
      secret: "test_secret_1234567890",
    });

    mockFetch.mockResolvedValueOnce(
      new Response("", {
        status: 302,
        statusText: "Found",
        headers: { Location: "http://malicious.example.com/internal" },
      }),
    );

    await dispatchWebhooks(tip);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchInit = mockFetch.mock.calls[0]?.[1];

    // Verifies redirect: "manual" is set
    expect(fetchInit?.redirect).toBe("manual");

    // Verifies timestamp and signature headers were sent
    const headers = fetchInit?.headers as Record<string, string>;
    expect(headers["X-Novatip-Timestamp"]).toBeDefined();
    expect(headers["X-Novatip-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);

    // Verifies delivery attempt was recorded as a failure with statusCode 302
    const deliveries = Array.from(fake.deliveries.values()).filter(
      (d) => d.webhookId === webhook.id,
    );
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]?.statusCode).toBe(302);
    expect(deliveries[0]?.success).toBe(false);
  });

  it("truncates response bodies longer than maxBodySize", async () => {
    fake.seedCreator({ id: "creator_1", jarId: "@alice" });
    fake.seedWebhook({
      creatorId: "creator_1",
      url: "https://hooks.example.com/webhook",
      secret: "test_secret_1234567890",
    });

    // Provide a large response body > 1024 bytes
    const largeResponse = "x".repeat(2000);
    mockFetch.mockResolvedValueOnce(
      new Response(largeResponse, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    await dispatchWebhooks(tip);

    const deliveries = Array.from(fake.deliveries.values());
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]?.response?.length).toBe(config.webhooks.maxBodySize);
  });

  it("stops reading a response stream at the byte limit and cancels its remainder", async () => {
    fake.seedCreator({ id: "creator_1", jarId: "@alice" });
    fake.seedWebhook({
      creatorId: "creator_1",
      url: "https://hooks.example.com/webhook",
      secret: "test_secret_1234567890",
    });

    let chunksProduced = 0;
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksProduced += 1;
        controller.enqueue(new TextEncoder().encode("x".repeat(128)));
      },
      cancel() {
        canceled = true;
      },
    });
    mockFetch.mockResolvedValueOnce(new Response(stream, { status: 200 }));

    await dispatchWebhooks(tip);

    expect(Buffer.byteLength(fake.deliveries[0]?.response ?? "", "utf8")).toBe(
      config.webhooks.maxBodySize,
    );
    expect(chunksProduced).toBeLessThan(20);
    expect(canceled).toBe(true);
  });

  it("does not leave a partial UTF-8 character at the byte limit", async () => {
    fake.seedCreator({ id: "creator_1", jarId: "@alice" });
    fake.seedWebhook({
      creatorId: "creator_1",
      url: "https://hooks.example.com/webhook",
      secret: "test_secret_1234567890",
    });

    const responseBody = `${"x".repeat(config.webhooks.maxBodySize - 1)}€`;
    mockFetch.mockResolvedValueOnce(new Response(responseBody, { status: 200 }));

    await dispatchWebhooks(tip);

    expect(fake.deliveries[0]?.response).toBe(
      "x".repeat(config.webhooks.maxBodySize - 1),
    );
  });

  it("keeps the timeout active while reading the response body", async () => {
    const webhook = fake.seedWebhook({
      creatorId: "creator_1",
      url: "https://hooks.example.com/webhook",
      secret: "test_secret_1234567890",
    });
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    mockFetch.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    jest.useFakeTimers();

    const ping = sendTestPing("creator_1", webhook.id);
    await jest.advanceTimersByTimeAsync(config.webhooks.timeoutMs);

    await expect(ping).resolves.toMatchObject({
      statusCode: 200,
      success: false,
    });
    expect(canceled).toBe(true);
    expect(fake.deliveries[0]?.response).toContain("AbortError");
  });

  it("does not exceed the configured concurrent request limit", async () => {
    fake.seedCreator({ id: "creator_1", jarId: "@alice" });
    for (let index = 0; index < 3; index += 1) {
      fake.seedWebhook({
        creatorId: "creator_1",
        url: `https://hooks-${index}.example.com/webhook`,
        secret: "test_secret_1234567890",
      });
    }

    const webhookConfig = config.webhooks as {
      deliveryConcurrency: number;
    };
    const originalConcurrency = webhookConfig.deliveryConcurrency;
    const resolveResponses: Array<(response: Response) => void> = [];
    webhookConfig.deliveryConcurrency = 1;
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponses.push(resolve);
        }),
    );

    try {
      const dispatch = dispatchWebhooks(tip);

      for (let completed = 0; completed < 3; completed += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mockFetch).toHaveBeenCalledTimes(completed + 1);
        resolveResponses.shift()!(new Response("ok", { status: 200 }));
      }

      await dispatch;
    } finally {
      webhookConfig.deliveryConcurrency = originalConcurrency;
    }
  });
});
