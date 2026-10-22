/**
 * indexer/persist.ts
 *
 * Persists a decoded TipEvent to PostgreSQL and updates the indexer cursor.
 * Called by the indexer loop after each confirmed event batch.
 */

import type { TipEvent } from "@novatip/sdk";
import { db } from "../db.js";
import { logger } from "../utils/logger.js";

const persistLogger = logger.child({ component: "indexer:persist" });

/**
 * The IndexerCursor table holds exactly one row by design to track the
 * indexer's progress across restarts.
 */
export const INDEXER_CURSOR_ID = 1;

/**
 * Persist a single TipEvent.
 * Uses upsert on txHash so re-runs are idempotent.
 * Returns true when the tip was newly created, false when it already existed.
 *
 * @param event     - Decoded TipEvent from the SDK event parser
 * @param txHash    - Soroban transaction hash (used as idempotency key)
 */
export async function persistTip(
  event: TipEvent,
  txHash: string,
): Promise<boolean> {
  const creator = await db.creator.findUnique({
    where: { jarId: event.jarId },
  });

  const result = await db.tip.upsert({
    where: { txHash },
    update: {},
    create: {
      txHash,
      ledger: event.ledger,
      ledgerAt: new Date(event.timestamp),
      fromAddress: event.from,
      amount: event.amount.toString(),
      message: event.message,
      jarId: event.jarId,
      creatorId: creator?.id ?? null,
    },
  });

  if (!creator) {
    persistLogger.info(
      { jarId: event.jarId },
      "Tip received for unclaimed jar; stored without owner (tip will be attached when jar is claimed)",
    );
  }

  return result.createdAt.getTime() === result.ledgerAt.getTime();
}

/**
 * Update the indexer cursor to the last processed ledger.
 * Uses upsert on the single-row IndexerCursor table (id = 1).
 */
export async function updateCursor(ledger: number): Promise<void> {
  await db.indexerCursor.upsert({
    where: { id: INDEXER_CURSOR_ID },
    update: { lastLedger: ledger },
    create: { id: INDEXER_CURSOR_ID, lastLedger: ledger },
  });
}

/**
 * Read the last processed ledger from the cursor table.
 * Returns 0 if the cursor has never been set.
 */
export async function readCursor(): Promise<number> {
  const cursor = await db.indexerCursor.findUnique({
    where: { id: INDEXER_CURSOR_ID },
  });
  return cursor?.lastLedger ?? 0;
}

/**
 * Prune unowned tips older than the configured number of days.
 * Tips with no creatorId may belong to another application, so they are not
 * kept indefinitely.
 */
export async function pruneUnownedTips(olderThanDays: number): Promise<number> {
  if (olderThanDays <= 0) return 0;

  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);

  const result = await db.tip.deleteMany({
    where: {
      creatorId: null,
      ledgerAt: { lt: cutoff },
    },
  });

  return result.count;
}
