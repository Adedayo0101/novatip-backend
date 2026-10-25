/**
 * auth.routes.ts
 *
 * POST /api/v1/auth/challenge  — issue a one-time sign-in nonce
 * POST /api/v1/auth/verify     — verify signed nonce, return JWT
 * GET  /api/v1/auth/me         — return current user from JWT
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db.js";
import { generateChallenge, verifyChallenge } from "./auth.service.js";

/**
 * The challenge and verification endpoints have dedicated per-IP limits:
 * challenge bounds nonce creation and verification bounds signature checks
 * plus database work, independently of the shared global request budget.
 */
const AUTH_CHALLENGE_RATE_LIMIT = config.rateLimits.authChallenge;
const AUTH_VERIFY_RATE_LIMIT = config.rateLimits.authVerify;

interface SlidingWindow {
  count: number;
  windowStart: number;
}

/**
 * Fastify treats a two-argument hook as promise-based: it waits for the
 * returned promise before continuing. A plain synchronous function returns
 * undefined, so the request hangs until the client gives up. `async` is what
 * makes the non-limited path resolve and continue.
 */
function buildSlidingWindowLimiter(
  limit: number,
  windowMs: number = 60_000,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const clients = new Map<string, SlidingWindow>();

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const ip = request.ip;
    const now = Date.now();
    let entry = clients.get(ip);

    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 1, windowStart: now };
      clients.set(ip, entry);
      return;
    }

    entry.count += 1;
    if (entry.count > limit) {
      reply.status(429).send({
        error: {
          code: "AUTH_RATE_LIMITED",
          message: "Too many auth requests. Try again in a minute.",
        },
      });
    }
  };
}

const ChallengeBody = z.object({
  walletAddress: z.string().min(56).max(56),
});

const VerifyBody = z.object({
  walletAddress: z.string().min(56).max(56),
  message: z.string(),
  signatureHex: z.string().length(128),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  // ── POST /challenge ────────────────────────────────────────────────────────
  // Applied per-route via onRequest rather than as a plugin-wide hook.
  const challengeLimiter = buildSlidingWindowLimiter(AUTH_CHALLENGE_RATE_LIMIT);
  const verifyLimiter = buildSlidingWindowLimiter(AUTH_VERIFY_RATE_LIMIT);

  app.post(
    "/challenge",
    { onRequest: [challengeLimiter] },
    async (request, reply) => {
      const body = ChallengeBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const domain = new URL(config.appBaseUrl).host;
      const challenge = await generateChallenge(body.data.walletAddress, domain);
      return reply.send(challenge);
    },
  );

  // ── POST /verify ───────────────────────────────────────────────────────────
  app.post(
    "/verify",
    { onRequest: [verifyLimiter] },
    async (request, reply) => {
      const body = VerifyBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const { jwt, isNewUser } = await verifyChallenge(
        body.data.walletAddress,
        body.data.message,
        body.data.signatureHex,
        (payload) => app.jwt.sign(payload),
      );

      return reply.send({ jwt, isNewUser });
    },
  );

  // ── GET /me ────────────────────────────────────────────────────────────────
  app.get("/me", { onRequest: [app.authenticate] }, async (request, reply) => {
    const creator = await db.creator.findUnique({
      where: { id: request.user.sub },
      select: { slug: true, emailVerifiedAt: true },
    });

    if (!creator) {
      return reply.status(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "Creator not found.",
        },
      });
    }

    return reply.send({
      user: {
        ...request.user,
        slug: creator.slug,
        emailVerifiedAt: creator.emailVerifiedAt,
      },
    });
  });
};
