/**
 * creator/placeholder-retention.ts
 *
 * Retention for abandoned sign-in placeholders.
 *
 * verifyChallenge creates a Creator row — a user_xxxxxxxx slug and a
 * matching @user_xxxxxxxx jar — the first time any wallet signs in. Wallets
 * cost nothing, and the per-process /auth/challenge rate limit is the only
 * other brake, so nothing bounds how many of these pile up from wallets that
 * sign in once and never claim a slug. Each one also holds a jar id no real
 * tip can ever use.
 *
 * A placeholder is only deleted once it is provably inert: still on its
 * placeholder slug (never claimed — see PLACEHOLDER_SLUG_REGEX), with no
 * tips, webhooks, notifications or released slugs, and older than the
 * configured retention window. Deletes run in bounded batches, the same
 * shape as the webhook delivery pruner in webhooks/retention.ts.
 */

import { db } from "../../db.js";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { PLACEHOLDER_SLUG_REGEX } from "./creator.service.js";

const retentionLogger = logger.child({ component: "placeholder-retention" });

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Narrows the DB scan; PLACEHOLDER_SLUG_REGEX is the exact check. */
const PLACEHOLDER_SLUG_PREFIX = "user_";

/**
 * Ceiling on batches per run. A first run against a long-abandoned backlog
 * has more to delete than one pass should attempt; stopping early leaves the
 * rest for the next tick rather than running a single multi-hour scan. At
 * the default batch size this is 25k rows a run.
 */
const MAX_BATCHES_PER_RUN = 50;

/** Delay before the first prune, so it doesn't compete with server startup. */
const FIRST_RUN_DELAY_MS = 60_000;

export interface PlaceholderPruneResult {
  deleted: number;
  /** True when the batch ceiling was hit with rows still outstanding. */
  truncated: boolean;
}

/** The timestamp before which a placeholder is old enough to delete. */
export function cutoffFor(days: number, now: Date): Date {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

/** Whether the job is active. 0 means keep every placeholder forever. */
export function retentionEnabled(): boolean {
  return config.creators.placeholderRetentionDays > 0;
}

/**
 * A relation-emptiness predicate reused for both the candidate scan and the
 * delete itself, so a webhook, tip, notification or released-slug row
 * created in the window between the two naturally drops that creator out of
 * the delete rather than racing a foreign-key error.
 */
const isInert = {
  tips: { none: {} },
  webhooks: { none: {} },
  notifications: { none: {} },
  releasedSlugs: { none: {} },
} as const;

/**
 * Delete one batch of eligible placeholders, cursoring forward by id so a
 * page of near-misses (slug starts with "user_" but isn't the exact
 * placeholder pattern — see PLACEHOLDER_SLUG_REGEX) can never stall the loop
 * on the same unselectable rows.
 */
async function pruneBatch(
  cutoff: Date,
  batchSize: number,
  maxBatches: number,
): Promise<{ deleted: number; batchesUsed: number; done: boolean }> {
  let deleted = 0;
  let batchesUsed = 0;
  let cursor: string | undefined;

  while (batchesUsed < maxBatches) {
    const candidates = await db.creator.findMany({
      where: {
        slug: { startsWith: PLACEHOLDER_SLUG_PREFIX },
        createdAt: { lt: cutoff },
        ...isInert,
      },
      select: { id: true, slug: true },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor !== undefined && { cursor: { id: cursor }, skip: 1 }),
    });

    if (candidates.length === 0) return { deleted, batchesUsed, done: true };

    const eligibleIds = candidates
      .filter((candidate) => PLACEHOLDER_SLUG_REGEX.test(candidate.slug))
      .map((candidate) => candidate.id);

    if (eligibleIds.length > 0) {
      const { count } = await db.creator.deleteMany({
        where: { id: { in: eligibleIds }, ...isInert },
      });
      deleted += count;
    }

    cursor = candidates[candidates.length - 1]!.id;
    batchesUsed += 1;

    if (candidates.length < batchSize) {
      return { deleted, batchesUsed, done: true };
    }
  }

  return { deleted, batchesUsed, done: false };
}

/**
 * Run one retention pass. Safe to call directly (a manual backfill, a test)
 * as well as from the scheduler.
 */
export async function prunePlaceholderCreators(
  now: Date = new Date(),
): Promise<PlaceholderPruneResult> {
  if (!retentionEnabled()) return { deleted: 0, truncated: false };

  const { placeholderRetentionDays, placeholderPruneBatchSize } =
    config.creators;

  const result = await pruneBatch(
    cutoffFor(placeholderRetentionDays, now),
    placeholderPruneBatchSize,
    MAX_BATCHES_PER_RUN,
  );

  return { deleted: result.deleted, truncated: !result.done };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let pruneTimer: NodeJS.Timeout | null = null;
let pruneActive = false;

/**
 * Start the periodic prune. Safe to call once at server startup.
 *
 * Each run reschedules itself on completion rather than firing on a fixed
 * interval, so a slow pass against a large backlog can never overlap the
 * next.
 */
export function startPlaceholderCreatorPruner(): void {
  if (pruneTimer !== null || pruneActive) return;

  if (!retentionEnabled()) {
    retentionLogger.info(
      "retention disabled — abandoned sign-in placeholders are kept indefinitely",
    );
    return;
  }

  const {
    placeholderRetentionDays,
    placeholderPruneBatchSize,
    placeholderPruneIntervalMinutes,
  } = config.creators;

  retentionLogger.info(
    {
      placeholderRetentionDays,
      placeholderPruneBatchSize,
      placeholderPruneIntervalMinutes,
    },
    "starting placeholder creator pruner",
  );

  pruneActive = true;
  scheduleNext(FIRST_RUN_DELAY_MS);
}

/** Stop the periodic prune. Called from the server's shutdown path. */
export function stopPlaceholderCreatorPruner(): void {
  pruneActive = false;

  if (pruneTimer !== null) {
    clearTimeout(pruneTimer);
    pruneTimer = null;
  }
}

function scheduleNext(delayMs: number): void {
  pruneTimer = setTimeout(() => {
    void runPrune();
  }, delayMs);

  // Housekeeping must never be the reason the process stays alive.
  pruneTimer.unref();
}

async function runPrune(): Promise<void> {
  if (!pruneActive) return;

  try {
    const result = await prunePlaceholderCreators();

    if (result.deleted > 0) {
      retentionLogger.info(
        { deleted: result.deleted, truncated: result.truncated },
        result.truncated
          ? "pruned placeholder creators — batch ceiling reached, continuing next run"
          : "pruned placeholder creators",
      );
    }
  } catch (err) {
    // Retention is housekeeping: a failed pass is logged and retried on the
    // next tick, never allowed to take the server down.
    retentionLogger.error({ err }, "placeholder creator prune failed");
  }

  if (pruneActive) {
    scheduleNext(config.creators.placeholderPruneIntervalMinutes * 60_000);
  }
}
