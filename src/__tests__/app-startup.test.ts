import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const startupError = new Error("invalid indexer network");
const logErrorMock = jest.fn();
const logInfoMock = jest.fn();
const listenMock = jest.fn<() => Promise<void>>(async () => undefined);
const closeMock = jest.fn<() => Promise<void>>(async () => undefined);
const processExitMock = jest
  .spyOn(process, "exit")
  .mockImplementation((() => undefined) as never);

jest.unstable_mockModule("../server.js", () => ({
  buildServer: async () => ({
    log: { error: logErrorMock, info: logInfoMock },
    listen: listenMock,
    close: closeMock,
  }),
}));
jest.unstable_mockModule("../indexer/indexer.js", () => ({
  startIndexer: () => Promise.reject(startupError),
  stopIndexer: async () => undefined,
}));
jest.unstable_mockModule("../modules/webhooks/retention.js", () => ({
  startDeliveryPruner: jest.fn(),
  stopDeliveryPruner: jest.fn(),
}));
jest.unstable_mockModule("../modules/webhooks/webhooks.service.js", () => ({
  migrateWebhookSecrets: async () => undefined,
}));

describe("application startup", () => {
  afterAll(() => {
    processExitMock.mockRestore();
  });

  it("exits non-zero when the indexer fails during startup", async () => {
    await import("../app.js");

    expect(logErrorMock).toHaveBeenCalledWith(
      startupError,
      "[indexer] fatal startup error",
    );
    expect(processExitMock).toHaveBeenCalledWith(1);
    expect(listenMock).toHaveBeenCalled();
  });
});
