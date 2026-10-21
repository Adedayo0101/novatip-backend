import Fastify from "fastify";
import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const readCursorMock = jest.fn<() => Promise<number>>();
const fetchLatestLedgerMock =
  jest.fn<(url: string, timeoutMs: number) => Promise<number>>();
const loggerWarnMock = jest.fn();
const getIndexerPollStatusMock = jest.fn(() => ({
  lastSuccessfulPollAt: "2026-10-20T10:00:00.000Z",
  lastError: "RPC unavailable",
}));

jest.unstable_mockModule("../../indexer/persist.js", () => ({
  readCursor: readCursorMock,
}));
jest.unstable_mockModule("../../indexer/rpc.js", () => ({
  fetchLatestLedger: fetchLatestLedgerMock,
}));
jest.unstable_mockModule("../../indexer/status.js", () => ({
  getIndexerPollStatus: getIndexerPollStatusMock,
}));
jest.unstable_mockModule("../../utils/logger.js", () => ({
  logger: {
    child: (): Record<string, unknown> => ({
      error: jest.fn(),
      warn: loggerWarnMock,
    }),
  },
}));

const { healthRoutes } = await import("../../modules/health/health.routes.js");

describe("GET /health/indexer", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(healthRoutes, { prefix: "/health" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    readCursorMock.mockResolvedValue(123);
  });

  it("reports the persisted cursor, chain head, and gap", async () => {
    fetchLatestLedgerMock.mockResolvedValue(150);

    const response = await app.inject({
      method: "GET",
      url: "/health/indexer",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      cursorLedger: 123,
      chainHead: { status: "known", ledger: 150 },
      gap: 27,
      lastSuccessfulPollAt: "2026-10-20T10:00:00.000Z",
      lastError: "RPC unavailable",
    });
    expect(fetchLatestLedgerMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
    );
  });

  it("returns the cursor and marks the chain head unknown when RPC fails", async () => {
    const rpcError = new Error("RPC unavailable");
    fetchLatestLedgerMock.mockRejectedValue(rpcError);

    const response = await app.inject({
      method: "GET",
      url: "/health/indexer",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      cursorLedger: 123,
      chainHead: { status: "unknown" },
      gap: null,
      lastSuccessfulPollAt: "2026-10-20T10:00:00.000Z",
      lastError: "RPC unavailable",
    });
    expect(loggerWarnMock).toHaveBeenCalledWith(
      { err: rpcError },
      "indexer status could not read chain head",
    );
  });
});
