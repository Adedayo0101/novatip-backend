/**
 * read-state.test.ts
 *
 * Tests for notification read state tracking.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { db } from "../../db.js";
import {
  listNotifications,
  markNotificationsRead,
  markAllNotificationsRead,
} from "../../modules/notifications/notifications.service.js";

describe("Notification read state", () => {
  let creatorId: string;
  let notificationIds: string[];

  beforeEach(async () => {
    const creator = await db.creator.create({
      data: {
        walletAddress: "GREAD123",
        slug: "readtest",
        jarId: "@readtest",
      },
    });
    creatorId = creator.id;

    // Create multiple notifications
    const n1 = await db.notification.create({
      data: {
        creatorId,
        type: "TIP_RECEIVED",
        payload: { amount: "10000000" },
      },
    });

    const n2 = await db.notification.create({
      data: {
        creatorId,
        type: "TIP_RECEIVED",
        payload: { amount: "20000000" },
      },
    });

    const n3 = await db.notification.create({
      data: {
        creatorId,
        type: "WEBHOOK_FAILED",
        payload: { webhookId: "test" },
      },
    });

    notificationIds = [n1.id, n2.id, n3.id];
  });

  it("should return unread count", async () => {
    const result = await listNotifications(creatorId, 20, 0, false);

    expect(result.unreadCount).toBe(3);
    expect(result.notifications).toHaveLength(3);
    expect(result.notifications.every((n) => !n.read)).toBe(true);
  });

  it("should mark specific notifications as read", async () => {
    const count = await markNotificationsRead(creatorId, [notificationIds[0]!, notificationIds[1]!]);

    expect(count).toBe(2);

    const result = await listNotifications(creatorId, 20, 0, false);
    expect(result.unreadCount).toBe(1);
  });

  it("should mark all notifications as read", async () => {
    const count = await markAllNotificationsRead(creatorId);

    expect(count).toBe(3);

    const result = await listNotifications(creatorId, 20, 0, false);
    expect(result.unreadCount).toBe(0);
    expect(result.notifications.every((n) => n.read)).toBe(true);
  });

  it("should filter unread notifications", async () => {
    await markNotificationsRead(creatorId, [notificationIds[0]!]);

    const result = await listNotifications(creatorId, 20, 0, true);

    expect(result.notifications).toHaveLength(2);
    expect(result.unreadCount).toBe(2);
  });

  it("should not mark another creator's notifications", async () => {
    const otherCreator = await db.creator.create({
      data: {
        walletAddress: "GOTHER456",
        slug: "otherread",
        jarId: "@otherread",
      },
    });

    const count = await markNotificationsRead(otherCreator.id, notificationIds);

    expect(count).toBe(0);
  });

  it("should support cursor paging", async () => {
    const page1 = await listNotifications(creatorId, 2, 0, false, null);

    expect(page1.notifications).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listNotifications(creatorId, 2, 0, false, page1.nextCursor);

    expect(page2.notifications).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
  });
});
