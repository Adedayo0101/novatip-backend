/**
 * __tests__/creator/update-profile.test.ts
 *
 * PATCH /creators/me — covers the clear/leave-unchanged contract for
 * displayName, bio, avatarUrl and email:
 * - Omitting a key leaves the stored value unchanged (no write of that key)
 * - null clears every field
 * - An empty or whitespace-only string also clears displayName, bio and
 *   avatarUrl (unlike email, which has no such exception and still 400s)
 * - A non-empty value is trimmed before storing
 * - avatarUrl still rejects a non-https URL
 *
 * db is mocked; no PostgreSQL is required. config.ts validates required env
 * vars at module load, so those are set before the module graph is imported.
 */

import { jest } from "@jest/globals";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import jwtPlugin from "@fastify/jwt";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const CREATOR = "creator_update_profile";
const WALLET = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

interface FakeCreatorRow {
  id: string;
  slug: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  email: string | null;
}

function baseRow(): FakeCreatorRow {
  return {
    id: CREATOR,
    slug: "alice",
    displayName: "Alice",
    bio: "Hello there",
    avatarUrl: "https://cdn.example.com/alice.png",
    email: "alice@example.com",
  };
}

let stored: FakeCreatorRow = baseRow();

const updateMock = jest.fn(
  async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    stored = { ...stored, ...args.data } as FakeCreatorRow;
    return stored;
  },
);

jest.unstable_mockModule("../../db.js", () => ({
  db: { creator: { update: updateMock } },
  disconnectDb: async (): Promise<void> => undefined,
}));

jest.unstable_mockModule("../../redis.js", () => ({
  cacheInvalidate: jest.fn(async () => undefined),
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => undefined),
  disconnectRedis: async (): Promise<void> => undefined,
}));

const { creatorRoutes } = await import(
  "../../modules/creator/creator.routes.js"
);

let app: FastifyInstance;

function authHeaders(): { authorization: string } {
  const token = app.jwt.sign({ sub: CREATOR, wallet: WALLET, slug: "alice" });
  return { authorization: `Bearer ${token}` };
}

async function patchMe(body: unknown) {
  return app.inject({
    method: "PATCH",
    url: "/me",
    headers: authHeaders(),
    payload: body,
  });
}

beforeEach(async () => {
  jest.clearAllMocks();
  stored = baseRow();

  app = Fastify();
  await app.register(jwtPlugin, {
    secret: "test-secret-at-least-32-chars-long-123456",
  });
  app.decorate(
    "authenticate",
    async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        await request.jwtVerify();
      } catch {
        reply.status(401).send({
          error: { code: "UNAUTHORIZED", message: "Authentication required." },
        });
      }
    },
  );
  await app.register(creatorRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("PATCH /creators/me — leaving fields unchanged", () => {
  it("writes nothing when the body is empty", async () => {
    const res = await patchMe({});

    expect(res.statusCode).toBe(200);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: CREATOR },
      data: {},
    });
  });

  test.each(["displayName", "bio", "avatarUrl", "email"])(
    "omitting %s writes none of its keys",
    async (field) => {
      const fullBody: Record<string, string> = {
        displayName: "New name",
        bio: "New bio",
        avatarUrl: "https://cdn.example.com/new.png",
        email: "new@example.com",
      };
      delete fullBody[field];

      await patchMe(fullBody);

      const data = updateMock.mock.calls[0]![0].data;
      expect(data).not.toHaveProperty(field);
      // The other three fields, all present in this body, must still write.
      expect(Object.keys(data)).toHaveLength(3);
    },
  );
});

describe("PATCH /creators/me — clearing with null", () => {
  test.each(["displayName", "bio", "avatarUrl", "email"])(
    "null clears %s",
    async (field) => {
      const res = await patchMe({ [field]: null });

      expect(res.statusCode).toBe(200);
      expect(updateMock).toHaveBeenCalledWith({
        where: { id: CREATOR },
        data: { [field]: null },
      });
      expect(stored[field as keyof FakeCreatorRow]).toBeNull();
    },
  );
});

describe("PATCH /creators/me — clearing with an empty string", () => {
  test.each(["displayName", "bio", "avatarUrl"])(
    "an empty string clears %s",
    async (field) => {
      const res = await patchMe({ [field]: "" });

      expect(res.statusCode).toBe(200);
      expect(updateMock).toHaveBeenCalledWith({
        where: { id: CREATOR },
        data: { [field]: null },
      });
    },
  );

  test.each(["displayName", "bio", "avatarUrl"])(
    "a whitespace-only string clears %s",
    async (field) => {
      const res = await patchMe({ [field]: "   " });

      expect(res.statusCode).toBe(200);
      expect(updateMock).toHaveBeenCalledWith({
        where: { id: CREATOR },
        data: { [field]: null },
      });
    },
  );

  it("does not extend the empty-string exception to email", async () => {
    const res = await patchMe({ email: "" });

    expect(res.statusCode).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /creators/me — trimming", () => {
  it("trims displayName and bio before storing", async () => {
    await patchMe({ displayName: "  Alice  ", bio: "  Hello  " });

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: CREATOR },
      data: { displayName: "Alice", bio: "Hello" },
    });
  });

  it("trims avatarUrl before validating and storing", async () => {
    const res = await patchMe({
      avatarUrl: "  https://cdn.example.com/trimmed.png  ",
    });

    expect(res.statusCode).toBe(200);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: CREATOR },
      data: { avatarUrl: "https://cdn.example.com/trimmed.png" },
    });
  });
});

describe("PATCH /creators/me — avatarUrl validation", () => {
  it("still rejects a non-https URL", async () => {
    const res = await patchMe({
      avatarUrl: "http://cdn.example.com/avatar.png",
    });

    expect(res.statusCode).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("still rejects a non-URL string", async () => {
    const res = await patchMe({ avatarUrl: "not a url" });

    expect(res.statusCode).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
