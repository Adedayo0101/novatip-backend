import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

const DATABASE_URL = process.env.DATABASE_URL;

// Skip these tests when no database is configured
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('Analytics Postgres Integration', () => {
  let prisma: PrismaClient;
  let creatorId: string;
  let creatorWallet: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();

    // Create a test creator
    creatorWallet = 'GTEST' + 'A'.repeat(51);
    const creator = await prisma.creator.create({
      data: {
        walletAddress: creatorWallet,
        slug: 'test-analytics-' + Date.now(),
        jarId: '@test-analytics-' + Date.now(),
      },
    });
    creatorId = creator.id;
  });

  afterAll(async () => {
    // Clean up test data
    if (prisma && creatorId) {
      await prisma.tip.deleteMany({ where: { creatorId } });
      await prisma.creator.delete({ where: { id: creatorId } });
    }
    await prisma.$disconnect();
  });

  describe('getTotals', () => {
    it('should calculate totals correctly', async () => {
      // Seed tips
      await prisma.tip.createMany({
        data: [
          {
            creatorId,
            txHash: 'hash1' + Date.now(),
            ledger: 1000,
            fromAddress: 'GSENDER' + 'A'.repeat(49),
            amount: '1000000', // 1 USDC
            ledgerAt: new Date(),
          },
          {
            creatorId,
            txHash: 'hash2' + Date.now(),
            ledger: 1001,
            fromAddress: 'GSENDER' + 'B'.repeat(49),
            amount: '2500000', // 2.5 USDC
            ledgerAt: new Date(),
          },
          {
            creatorId,
            txHash: 'hash3' + Date.now(),
            ledger: 1002,
            fromAddress: 'GSENDER' + 'A'.repeat(49), // Same supporter
            amount: '500000', // 0.5 USDC
            ledgerAt: new Date(),
          },
        ],
      });

      // Execute the query
      const result = await prisma.$queryRaw<
        Array<{ tipCount: bigint; totalAmount: string; supporters: bigint }>
      >`
        SELECT
          COUNT(*)::bigint AS "tipCount",
          SUM(amount::numeric)::text AS "totalAmount",
          COUNT(DISTINCT "fromAddress")::bigint AS supporters
        FROM "Tip"
        WHERE "creatorId" = ${creatorId}
      `;

      expect(result).toHaveLength(1);
      expect(result[0].tipCount).toBe(3n);
      expect(result[0].totalAmount).toBe('4000000'); // 4 USDC
      expect(result[0].supporters).toBe(2n); // 2 unique senders
    });

    it('should handle large i128 amounts', async () => {
      // Max i128 is 170141183460469231731687303715884105727
      const largeAmount = '170141183460469231731687303715884105727';

      await prisma.tip.create({
        data: {
          creatorId,
          txHash: 'hash-large-' + Date.now(),
          ledger: 2000,
          fromAddress: 'GBIG' + 'A'.repeat(52),
          amount: largeAmount,
          ledgerAt: new Date(),
        },
      });

      const result = await prisma.$queryRaw<
        Array<{ totalAmount: string }>
      >`
        SELECT SUM(amount::numeric)::text AS "totalAmount"
        FROM "Tip"
        WHERE "creatorId" = ${creatorId}
          AND "txHash" = ${'hash-large-' + Date.now()}
      `;

      expect(result[0].totalAmount).toBe(largeAmount);
    });
  });

  describe('getTimeSeries', () => {
    it('should aggregate tips by day', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

      await prisma.tip.createMany({
        data: [
          {
            creatorId,
            txHash: 'ts1-' + Date.now(),
            ledger: 3000,
            fromAddress: 'GADDR' + 'A'.repeat(51),
            amount: '1000000',
            ledgerAt: twoDaysAgo,
          },
          {
            creatorId,
            txHash: 'ts2-' + Date.now(),
            ledger: 3001,
            fromAddress: 'GADDR' + 'B'.repeat(51),
            amount: '2000000',
            ledgerAt: yesterday,
          },
          {
            creatorId,
            txHash: 'ts3-' + Date.now(),
            ledger: 3002,
            fromAddress: 'GADDR' + 'C'.repeat(51),
            amount: '3000000',
            ledgerAt: now,
          },
        ],
      });

      const days = 3;
      const result = await prisma.$queryRaw<
        Array<{ day: Date; tipCount: bigint; amountRaw: string }>
      >`
        WITH RECURSIVE days AS (
          SELECT (CURRENT_DATE - ${days - 1})::date AS day
          UNION ALL
          SELECT (day + INTERVAL '1 day')::date
          FROM days
          WHERE day < CURRENT_DATE
        )
        SELECT
          days.day,
          COALESCE(COUNT(t.id), 0)::bigint AS "tipCount",
          COALESCE(SUM(t.amount::numeric), 0)::text AS "amountRaw"
        FROM days
        LEFT JOIN "Tip" t
          ON DATE_TRUNC('day', t."ledgerAt" AT TIME ZONE 'UTC') = days.day
          AND t."creatorId" = ${creatorId}
        GROUP BY days.day
        ORDER BY days.day ASC
      `;

      expect(result).toHaveLength(days);
      expect(result.every((r) => r.day instanceof Date)).toBe(true);
      expect(result.every((r) => typeof r.amountRaw === 'string')).toBe(true);
    });
  });

  describe('getTopSupporters', () => {
    it('should rank supporters by total amount', async () => {
      const supporter1 = 'GTOP1' + 'A'.repeat(51);
      const supporter2 = 'GTOP2' + 'B'.repeat(51);
      const supporter3 = 'GTOP3' + 'C'.repeat(51);

      await prisma.tip.createMany({
        data: [
          {
            creatorId,
            txHash: 'top1-' + Date.now() + '-1',
            ledger: 4000,
            fromAddress: supporter1,
            amount: '5000000',
            ledgerAt: new Date(),
          },
          {
            creatorId,
            txHash: 'top1-' + Date.now() + '-2',
            ledger: 4001,
            fromAddress: supporter1,
            amount: '3000000',
            ledgerAt: new Date(),
          },
          {
            creatorId,
            txHash: 'top2-' + Date.now(),
            ledger: 4002,
            fromAddress: supporter2,
            amount: '6000000',
            ledgerAt: new Date(),
          },
          {
            creatorId,
            txHash: 'top3-' + Date.now(),
            ledger: 4003,
            fromAddress: supporter3,
            amount: '1000000',
            ledgerAt: new Date(),
          },
        ],
      });

      const limit = 3;
      const result = await prisma.$queryRaw<
        Array<{
          fromAddress: string;
          tipCount: bigint;
          totalAmount: string;
        }>
      >`
        SELECT
          "fromAddress",
          COUNT(*)::bigint AS "tipCount",
          SUM(amount::numeric)::text AS "totalAmount"
        FROM "Tip"
        WHERE "creatorId" = ${creatorId}
        GROUP BY "fromAddress"
        ORDER BY SUM(amount::numeric) DESC
        LIMIT ${limit}
      `;

      expect(result).toHaveLength(3);
      expect(result[0].fromAddress).toBe(supporter1);
      expect(result[0].totalAmount).toBe('8000000');
      expect(result[1].fromAddress).toBe(supporter2);
      expect(result[1].totalAmount).toBe('6000000');
    });
  });

  describe('getCollaborators', () => {
    it('should calculate per-recipient earnings', async () => {
      const recipient1 = 'GCOLLAB1' + 'A'.repeat(48);
      const recipient2 = 'GCOLLAB2' + 'B'.repeat(48);

      // Set up splits: 50% to recipient1, 30% to recipient2
      await prisma.creator.update({
        where: { id: creatorId },
        data: {
          splits: [
            { to: recipient1, bps: 5000 },
            { to: recipient2, bps: 3000 },
          ],
        },
      });

      await prisma.tip.createMany({
        data: [
          {
            creatorId,
            txHash: 'collab1-' + Date.now(),
            ledger: 5000,
            fromAddress: 'GSEND' + 'A'.repeat(51),
            amount: '10000000', // 10 USDC
            ledgerAt: new Date(),
          },
          {
            creatorId,
            txHash: 'collab2-' + Date.now(),
            ledger: 5001,
            fromAddress: 'GSEND' + 'B'.repeat(51),
            amount: '5000000', // 5 USDC
            ledgerAt: new Date(),
          },
        ],
      });

      // Query that mimics the collaborator breakdown logic
      const result = await prisma.$queryRaw<
        Array<{ to: string; totalEarned: string }>
      >`
        WITH split AS (
          SELECT
            jsonb_array_elements(c.splits) AS recipient
          FROM "Creator" c
          WHERE c.id = ${creatorId}
        ),
        expanded AS (
          SELECT
            (recipient->>'to')::text AS "to",
            (recipient->>'bps')::integer AS bps
          FROM split
        ),
        earnings AS (
          SELECT
            e."to",
            e.bps,
            SUM(FLOOR(t.amount::numeric * e.bps / 10000))::text AS "totalEarned"
          FROM expanded e
          CROSS JOIN "Tip" t
          WHERE t."creatorId" = ${creatorId}
          GROUP BY e."to", e.bps
        )
        SELECT "to", "totalEarned" FROM earnings
        ORDER BY "totalEarned" DESC
      `;

      expect(result).toHaveLength(2);
      const r1 = result.find((r) => r.to === recipient1);
      const r2 = result.find((r) => r.to === recipient2);

      // 15 USDC total * 50% = 7.5 USDC = 7500000 stroops
      expect(r1?.totalEarned).toBe('7500000');
      // 15 USDC total * 30% = 4.5 USDC = 4500000 stroops
      expect(r2?.totalEarned).toBe('4500000');
    });
  });
});
