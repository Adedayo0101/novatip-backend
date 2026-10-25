import { jest } from "@jest/globals";
import Fastify, { type FastifyInstance } from "fastify";
import jwtPlugin from "@fastify/jwt";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["AUTH_VERIFY_RATE_LIMIT"] = "1";

const verifyChallengeMock = jest.fn(
  async (
    _walletAddress: string,
    _message: string,
    _signatureHex: string,
    signJwt: (payload: { sub: string; wallet: string; slug: string }) => string,
  ) => ({
    jwt: signJwt({ sub: "creator_1", wallet: "Gwallet", slug: "alice" }),
    isNewUser: false,
  }),
);

jest.unstable_mockModule("../../modules/auth/auth.service.js", () => ({
  generateChallenge: jest.fn(),
  verifyChallenge: verifyChallengeMock,
}));

const { authRoutes } = await import("../../modules/auth/auth.routes.js");

describe("POST /verify rate limit", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    app = Fastify();
    await app.register(jwtPlugin, {
      secret: "test-secret-at-least-32-chars-long-123456",
    });
    app.decorate("authenticate", async () => undefined);
    await app.register(authRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns the standard auth rate-limit envelope after the configured per-IP limit", async () => {
    const payload = {
      walletAddress: `G${"A".repeat(55)}`,
      message: "signed challenge",
      signatureHex: "0".repeat(128),
    };
    const first = await app.inject({
      method: "POST",
      url: "/verify",
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/verify",
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({
      error: {
        code: "AUTH_RATE_LIMITED",
        message: "Too many auth requests. Try again in a minute.",
      },
    });
    expect(verifyChallengeMock).toHaveBeenCalledTimes(1);
  });
});
