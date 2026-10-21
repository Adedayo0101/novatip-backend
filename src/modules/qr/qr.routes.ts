/**
 * qr.routes.ts
 *
 * GET /api/v1/qr/:slug        — returns QR code as SVG (default)
 * GET /api/v1/qr/:slug/png    — returns QR code as PNG buffer
 *
 * No auth required — QR codes are public so creators can share/print them.
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import { config } from "../../config.js";
import { getCreatorBySlug } from "../creator/creator.service.js";
import { validateSlugParam } from "../../utils/validation.js";

export const PNG_QR_WIDTH_DEFAULT = 512;
export const PNG_QR_WIDTH_MIN = 64;
export const PNG_QR_WIDTH_MAX = 2048;

const PngQuery = z.object({
  width: z.coerce
    .number()
    .int()
    .min(PNG_QR_WIDTH_MIN)
    .max(PNG_QR_WIDTH_MAX)
    .default(PNG_QR_WIDTH_DEFAULT),
});

/**
 * QR generation is CPU-heavy (512 px PNG rasterisation) and the routes are
 * public. The global 100 req/min budget is far too permissive here — a single
 * client can exhaust it with QR requests alone, leaving no capacity for the
 * rest of the API.
 *
 * This dedicated limiter enforces a tighter 10 req/min per IP, configurable
 * via the QR_RATE_LIMIT env variable (default 10) — see config.ts, which
 * fails fast on a non-numeric value rather than letting a typo quietly fall
 * back to the default.
 */
const QR_RATE_LIMIT = config.rateLimits.qr;

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
function buildQrRateLimiter(
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
          code: "QR_RATE_LIMITED",
          message: "Too many QR requests. Try again in a minute.",
        },
      });
    }
  };
}

export const qrRoutes: FastifyPluginAsync = async (app) => {
  const qrLimiter = buildQrRateLimiter(QR_RATE_LIMIT);
  app.addHook("preHandler", qrLimiter);

  // ── GET /:slug — SVG ───────────────────────────────────────────────────────
  app.get("/:slug", async (request, reply) => {
    const slug = validateSlugParam(request.params, reply);
    if (slug === null) return;

    // Validate the creator exists before generating
    await getCreatorBySlug(slug);

    const tipUrl = `${config.appBaseUrl}/${slug}`;

    const svg = await QRCode.toString(tipUrl, {
      type: "svg",
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });

    return reply
      .header("Content-Type", "image/svg+xml")
      .header("Cache-Control", "public, max-age=3600")
      .send(svg);
  });

  // ── GET /:slug/png — PNG ───────────────────────────────────────────────────
  app.get("/:slug/png", async (request, reply) => {
    const slug = validateSlugParam(request.params, reply);
    if (slug === null) return;

    const query = PngQuery.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: query.error.flatten() });
    }

    await getCreatorBySlug(slug);

    const tipUrl = `${config.appBaseUrl}/${slug}`;

    const pngBuffer = await QRCode.toBuffer(tipUrl, {
      type: "png",
      margin: 2,
      width: query.data.width,
      color: { dark: "#000000", light: "#ffffff" },
    });

    return reply
      .header("Content-Type", "image/png")
      .header(
        "Content-Disposition",
        `attachment; filename="novatip-${slug}.png"`,
      )
      .header("Cache-Control", "public, max-age=3600")
      .send(pngBuffer);
  });
};
