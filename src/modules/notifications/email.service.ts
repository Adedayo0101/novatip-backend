/**
 * notifications/email.service.ts
 *
 * Email notifications via Resend (https://resend.com).
 *
 * Sends a "You received a tip!" email to the creator after each indexed tip.
 * Skips quietly when RESEND_API_KEY is not configured (the local dev default),
 * when the creator has switched the channel off (emailEnabled is false), or
 * when the creator has not given an address — a creator who only wants
 * webhooks is not required to.
 */

import type { TipEvent } from "@novatip/sdk";
import { formatUsdc } from "@novatip/sdk";
import { db } from "../../db.js";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { escapeHtml } from "../../utils/html.js";

const emailLogger = logger.child({ component: "notifications" });

/**
 * Send a tip-received email notification to the creator.
 *
 * Called from the indexer's per-event path, so it never throws: a notification
 * failing must not stop a tip being recorded or its webhooks being delivered.
 */
export async function sendTipNotification(event: TipEvent): Promise<void> {
  try {
    const creator = await db.creator.findUnique({
      where: { jarId: event.jarId },
    });

    if (!creator) return;

    const notification = await db.notification.create({
      data: {
        creatorId: creator.id,
        type: "TIP_RECEIVED",
        payload: {
          from: event.from,
          amount: event.amount.toString(),
          message: event.message,
          ledger: event.ledger,
          timestamp: event.timestamp,
        },
      },
    });

    // The feed entry is recorded even when the email channel is unavailable
    // or disabled. `sentAt` stays null until Resend accepts the message.
    if (!config.resend.apiKey) return;

    if (!creator.emailEnabled) {
      emailLogger.debug(
        { slug: creator.slug },
        "creator has email notifications switched off — skipping tip notification",
      );
      return;
    }

    if (!creator.email) {
      emailLogger.debug(
        { slug: creator.slug },
        "creator has no email on record — skipping tip notification",
      );
      return;
    }

    const amount = formatUsdc(event.amount, 2);
    const displayName = creator.displayName ?? creator.slug;
    const message = event.message ? `"${event.message}"` : "No message left.";

    const safeDisplayName = escapeHtml(displayName);
    const safeAmount = escapeHtml(amount);
    const safeMessage = event.message
      ? `"${escapeHtml(event.message)}"`
      : "No message left.";

    // Dynamic import so Resend is only loaded when the API key is set
    const { Resend } = await import("resend");
    const resend = new Resend(config.resend.apiKey);

    const text = [
      `Hey ${displayName}!`,
      "",
      `Someone just tipped you $${amount} USDC on Novatip.`,
      "",
      message,
      "",
      `View your dashboard: ${config.appBaseUrl}/dashboard`,
    ].join("\n");

    // Resend reports API failures via the returned `error` rather than by
    // throwing, so the catch below never sees them — check it explicitly.
    const { error } = await resend.emails.send({
      from: config.resend.from,
      to: [creator.email],
      subject: `💸 You received $${amount} USDC on Novatip!`,
      text,
      html: `
        <h2>Hey ${safeDisplayName}!</h2>
        <p>
          Someone just tipped you <strong>$${safeAmount} USDC</strong> on Novatip.
        </p>
        <p><em>${safeMessage}</em></p>
        <p>
          <a href="${config.appBaseUrl}/dashboard">View your dashboard →</a>
        </p>
      `,
    });

    if (error) {
      emailLogger.error({ err: error }, "Resend rejected the email");
      return;
    }

    await db.notification.update({
      where: { id: notification.id },
      data: { sentAt: new Date() },
    });
  } catch (err) {
    emailLogger.error({ err }, "failed to record or send tip notification");
  }
}
