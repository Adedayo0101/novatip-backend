import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "******localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const batchSize = 2;
const config = {
  webhooks: {
    retention: {
      successDays: 0,
      failureDays: 0,
      batchSize,
      intervalMinutes: 60,
    },
  },
  notifications: { retentionDays: 30 },
};

const mockFindMany =
  jest.fn<(args: { where: unknown; select: unknown; take: number }) => Promise<{ id: string }[]>>();
const mockDeleteMany =
  jest.fn<(args: { where: unknown }) => Promise<{ count: number }>>();
const mockDb = {
  notification: {
    findMany: mockFindMany,
    deleteMany: mockDeleteMany,
  },
  webhookDelivery: {
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
};

jest.unstable_mockModule("../../db.js", () => ({
  db: mockDb,
  disconnectDb: async (): Promise<void> => undefined,
}));
jest.unstable_mockModule("../../config.js", () => ({ config }));

const { cutoffFor, pruneRetainedRows } =
  await import("../../modules/webhooks/retention.js");

describe("notification retention", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeleteMany.mockImplementation(async ({ where }) => ({
      count: (where as { id: { in: string[] } }).id.in.length,
    }));
  });

  it("calculates the exclusive cutoff for the configured retention window", () => {
    const now = new Date("2026-10-20T12:00:00.000Z");
    expect(cutoffFor(30, now)).toEqual(new Date("2026-09-20T12:00:00.000Z"));
  });

  it("deletes only notifications older than the retention cutoff", async () => {
    mockFindMany.mockResolvedValue([]);
    const now = new Date("2026-10-20T12:00:00.000Z");

    await pruneRetainedRows(now);

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date("2026-09-20T12:00:00.000Z") } },
      select: { id: true },
      take: batchSize,
    });
  });

  it("stops notification deletes at the per-run batch ceiling", async () => {
    mockFindMany.mockResolvedValue([{ id: "notice_1" }, { id: "notice_2" }]);

    const result = await pruneRetainedRows(new Date("2026-10-20T12:00:00.000Z"));

    expect(mockFindMany).toHaveBeenCalledTimes(50);
    expect(mockDeleteMany).toHaveBeenCalledTimes(50);
    expect(result).toMatchObject({
      deletedNotifications: 100,
      truncated: true,
    });
  });
});
