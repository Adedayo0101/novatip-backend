/**
 * delivery-filter.test.ts
 *
 * Tests for filtering webhook deliveries by success status.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { db } from "../../db.js";
import { listWebhookDeliveries } from "../../modules/webhooks/webhooks.service.js";

describe("Webhook delivery success filter", () => {
  let creatorId: string;
  let webhookId: string;

  beforeEach(async () => {
    const creator = await db.creator.create({
      data: {
        walletAddress: "GWEBHOOK123",
        slug: "webhooktest",
        jarId: "@webhooktest",
      },
    });
    creatorId = creator.id;

    const webhook = await db.webhook.create({
      data: {
        creatorId,
        url: "https://example.com/webhook",
        secret: "test-secret-1234567890",
      },
    });
    webhookId = webhook.id;

    // Create successful deliveries
    await db.webhookDelivery.create({
      data: {
        webhookId,
        statusCode: 200,
        success: true,
        payload: { test: true },
      },
    });

    await db.webhookDelivery.create({
      data: {
        webhookId,
        statusCode: 204,
        success: true,
        payload: { test: true },
      },
    });

    // Create failed deliveries
    await db.webhookDelivery.create({
      data: {
        webhookId,
        statusCode: 500,
        success: false,
        payload: { test: true },
      },
    });

    await db.webhookDelivery.create({
      data: {
        webhookId,
        statusCode: 404,
        success: false,
        payload: { test: true },
      },
    });
  });

  it("should return all deliveries when no filter is applied", async () => {
    const deliveries = await listWebhookDeliveries(creatorId, webhookId, 20, 0);

    expect(deliveries).toHaveLength(4);
  });

  it("should filter successful deliveries", async () => {
    const deliveries = await listWebhookDeliveries(creatorId, webhookId, 20, 0, true);

    expect(deliveries).toHaveLength(2);
    expect(deliveries?.every((d) => d.success)).toBe(true);
  });

  it("should filter failed deliveries", async () => {
    const deliveries = await listWebhookDeliveries(creatorId, webhookId, 20, 0, false);

    expect(deliveries).toHaveLength(2);
    expect(deliveries?.every((d) => !d.success)).toBe(true);
  });

  it("should return null for webhook not owned by creator", async () => {
    const otherCreator = await db.creator.create({
      data: {
        walletAddress: "GOTHER789",
        slug: "otherwebhook",
        jarId: "@otherwebhook",
      },
    });

    const deliveries = await listWebhookDeliveries(otherCreator.id, webhookId, 20, 0, true);

    expect(deliveries).toBeNull();
  });
});
