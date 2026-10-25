import type { FastifyReply, FastifyRequest } from "fastify";
import { areCreatorTokensRevoked } from "../../redis.js";

function unauthorized(reply: FastifyReply) {
  return reply.status(401).send({
    error: {
      code: "UNAUTHORIZED",
      message: "Authentication required.",
    },
  });
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch (err) {
    request.log.warn({ err, url: request.url }, "authentication failed");
    unauthorized(reply);
    return;
  }

  if (request.user.purpose !== undefined) {
    unauthorized(reply);
    return;
  }

  if (await areCreatorTokensRevoked(request.user.sub)) {
    request.log.warn(
      { creatorId: request.user.sub, url: request.url },
      "authentication rejected for deleted creator",
    );
    unauthorized(reply);
  }
}
