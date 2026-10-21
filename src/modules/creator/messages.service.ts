/**
 * messages.service.ts
 *
 * Service for managing tip message visibility.
 * Creators can hide abusive or spam messages from their public tip feed.
 */

import { db } from "../../db.js";
import { cacheInvalidate } from "../../redis.js";

/**
 * Set the messageHidden flag for a tip.
 * Returns null if the tip does not exist or doesn't belong to the creator.
 */
export async function setTipMessageHidden(
  creatorId: string,
  tipId: string,
  hidden: boolean,
): Promise<{ id: string; messageHidden: boolean } | null> {
  const { count } = await db.tip.updateMany({
    where: { id: tipId, creatorId },
    data: { messageHidden: hidden },
  });

  if (count === 0) return null;

  const tip = await db.tip.findUnique({
    where: { id: tipId },
    select: { id: true, messageHidden: true },
  });

  // Invalidate public feed cache
  const creator = await db.creator.findUnique({
    where: { id: creatorId },
    select: { slug: true },
  });

  if (creator) {
    await invalidatePublicFeedCache(creator.slug);
  }

  return tip;
}

/**
 * Invalidate all cached public feed pages for a creator's slug.
 * This ensures hidden messages disappear promptly from the public view.
 */
async function invalidatePublicFeedCache(slug: string): Promise<void> {
  // Delete all cache keys matching analytics:public-recent:{slug}:*
  // Since we don't have a pattern-based delete, we'll delete common cursors
  // The 15-second TTL means stale cached entries expire quickly anyway
  const commonKeys = [
    `analytics:public-recent:${slug}:20:head`,
    `analytics:public-recent:${slug}:50:head`,
  ];

  for (const key of commonKeys) {
    await cacheInvalidate(key);
  }
}
