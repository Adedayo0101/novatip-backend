/**
 * server.ts
 *
 * Builds and configures the Fastify server instance.
 * All plugins, route registration, and lifecycle hooks live here.
 */

import Fastify, {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  RouteOptions,
} from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { disconnectDb } from "./db.js";
import { disconnectRedis, redis } from "./redis.js";
import { buildLoggerOptions } from "./utils/logger.js";

export interface BuildServerOptions {
  /**
   * Fires once per route registered on the server (including Fastify's
   * automatic HEAD route for every GET). Exists so tests can enumerate the
   * routes this server actually registers — e.g. to check each one has an
   * OpenAPI spec entry — without hand-maintaining a second list that can
   * drift from this one.
   */
  onRoute?: (routeOptions: RouteOptions & { url: string }) => void;
}

export async function buildServer(
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const isProduction = config.nodeEnv === "production";

  const server = Fastify({
    logger: buildLoggerOptions(isProduction),
  });

  if (options.onRoute) {
    server.addHook("onRoute", options.onRoute);
  }

  // ── Security plugins ──────────────────────────────────────────────────────
  await server.register(helmet, { contentSecurityPolicy: false });

  await server.register(cors, {
    origin: isProduction ? config.corsAllowedOrigins : true,
    credentials: true,
  });

  await server.register(rateLimit, {
    max: config.rateLimits.global.max,
    timeWindow: config.rateLimits.global.window,
    redis,
  });

  // ── Auth plugin ───────────────────────────────────────────────────────────
  await server.register(jwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.jwtExpiresIn },
  });

  // ── Decorators ────────────────────────────────────────────────────────────
  // Convenience decorator so route handlers can call request.authenticate()
  server.decorate(
    "authenticate",
    async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        await request.jwtVerify();
      } catch (err) {
        // err.code distinguishes a missing token (FST_JWT_NO_AUTHORIZATION_IN_HEADER)
        // from an invalid or expired one — kept in the log, not in the response,
        // since the client gets no more than "unauthorized" either way.
        server.log.warn({ err, url: request.url }, "authentication failed");
        reply.status(401).send({
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication required.",
          },
        });
      }
    },
  );

  // ── Routes ────────────────────────────────────────────────────────────────
  await server.register(
    async (app) => {
      // Simple health check — kept for backward compatibility. Richer
      // liveness/readiness probes live under /health (see healthRoutes).
      app.get("/health", async () => ({
        status: "ok",
        ts: new Date().toISOString(),
      }));

      // Feature routes registered in subsequent commits
      const { healthRoutes } =
        await import("./modules/health/health.routes.js");
      const { authRoutes } = await import("./modules/auth/auth.routes.js");
      const { creatorRoutes } =
        await import("./modules/creator/creator.routes.js");
      const { qrRoutes } = await import("./modules/qr/qr.routes.js");
      const { resolverRoutes } =
        await import("./modules/resolver/resolver.routes.js");
      const { analyticsRoutes } =
        await import("./modules/analytics/analytics.routes.js");
      const { webhookRoutes } =
        await import("./modules/webhooks/webhooks.routes.js");
      const { notificationRoutes } =
        await import("./modules/notifications/notifications.routes.js");
      const { publicRoutes } =
        await import("./modules/public/public.routes.js");
      const { openApiRoutes } =
        await import("./modules/openapi/openapi.routes.js");

      await app.register(healthRoutes, { prefix: "/health" });
      await app.register(authRoutes, { prefix: "/auth" });
      await app.register(creatorRoutes, { prefix: "/creators" });
      await app.register(qrRoutes, { prefix: "/qr" });
      await app.register(resolverRoutes, { prefix: "/resolve" });
      await app.register(analyticsRoutes, { prefix: "/analytics" });
      await app.register(webhookRoutes, { prefix: "/webhooks" });
      await app.register(notificationRoutes, { prefix: "/notifications" });
      await app.register(publicRoutes, { prefix: "/public" });
      await app.register(openApiRoutes);
    },
    { prefix: "/api/v1" },
  );

  // ── Global error handler ──────────────────────────────────────────────────
  server.setErrorHandler((error, request, reply) => {
    server.log.error({ err: error, url: request.url }, "Unhandled error");

    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: {
        code: error.code ?? "INTERNAL_SERVER_ERROR",
        message:
          config.nodeEnv === "production" && statusCode === 500
            ? "An unexpected error occurred."
            : error.message,
      },
    });
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  server.addHook("onClose", async () => {
    await Promise.all([disconnectDb(), disconnectRedis()]);
  });

  return server;
}
