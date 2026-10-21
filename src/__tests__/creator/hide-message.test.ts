/**
 * hide-message.test.ts
 *
 * Tests for hiding and unhiding supporter messages from the public feed.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { db } from "../../db.js";
import { setTipMessageHidden } from "../../modules/creator/messages.service.js";
import { getPublicRecentTips } from "../../modules/analytics/analytics.service.js";

describe("Hide supporter message", () => {
  let creatorId: string;
  let slug: string;
  let tipId: string;

  beforeEach(async () => {
    // Create a test creator
    const creator = await db.creator.create({
      data: {
        walletAddress: "GABC123HIDEMES",
        slug: "testcreator",
        jarId: "@testcreator",
      },
    });
    creatorId = creator.id;
    slug = creator.slug;

    // Create a tip with a message
    const tip = await db.tip.create({
      data: {
        txHash: "abc123",
        ledger: 1000,
        ledgerAt: new Date(),
        fromAddress: "GSENDER",
        amount: "10000000",
        message: "Spam message here!",
        creatorId,
      },
    });
    tipId = tip.id;
  });

  it("should hide a message when creator requests it", async () => {
    const result = await setTipMessageHidden(creatorId, tipId, true);

    expect(result).not.toBeNull();
    expect(result?.messageHidden).toBe(true);

    const tip = await db.tip.findUnique({ where: { id: tipId } });
    expect(tip?.messageHidden).toBe(true);
  });

  it("should unhide a message when creator requests it", async () => {
    await setTipMessageHidden(creatorId, tipId, true);
    const result = await setTipMessageHidden(creatorId, tipId, false);

    expect(result).not.toBeNull();
    expect(result?.messageHidden).toBe(false);
  });

  it("should return null for a tip that doesn't belong to the creator", async () => {
    const otherCreator = await db.creator.create({
      data: {
        walletAddress: "GOTHER123",
        slug: "othercreator",
        jarId: "@othercreator",
      },
    });

    const result = await setTipMessageHidden(otherCreator.id, tipId, true);
    expect(result).toBeNull();
  });

  it("should return empty message for hidden tips in public feed", async () => {
    await setTipMessageHidden(creatorId, tipId, true);

    const page = await getPublicRecentTips(slug, 20, null);

    expect(page.tips).toHaveLength(1);
    expect(page.tips[0]?.message).toBe("");
  });

  it("should show message for non-hidden tips in public feed", async () => {
    const page = await getPublicRecentTips(slug, 20, null);

    expect(page.tips).toHaveLength(1);
    expect(page.tips[0]?.message).toBe("Spam message here!");
  });
});
