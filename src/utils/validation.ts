/**
 * utils/validation.ts
 *
 * Shared Zod refinements and schema primitives used across route validators.
 */

import { z } from "zod";
import type { FastifyReply } from "fastify";

export const CREATOR_SLUG_REGEX = /^[a-z0-9_-]{3,32}$/;

const SlugParams = z.object({
  slug: z
    .string()
    .regex(
      CREATOR_SLUG_REGEX,
      "Slug must be 3–32 lowercase letters, numbers, underscores, or hyphens.",
    ),
});

/**
 * Validate a slug route parameter before any cache or database access.
 * Returns null after sending the shared 400 response for malformed slugs.
 */
export function validateSlugParam(
  params: unknown,
  reply: FastifyReply,
): string | null {
  const parsed = SlugParams.safeParse(params);
  if (!parsed.success) {
    reply.status(400).send({ error: parsed.error.flatten() });
    return null;
  }

  return parsed.data.slug;
}

/**
 * Validates a URL that:
 *   - Is a well-formed URL (Zod's built-in .url() check)
 *   - Uses the `https:` scheme exclusively
 *
 * Rejects `http:`, `javascript:`, `data:`, `file:`, and any other scheme.
 *
 * Host allowlisting is intentionally left to the frontend (next.config.mjs
 * `remotePatterns`) so the backend doesn't need to be updated when new
 * image CDNs are added. The `https:` requirement is the security boundary.
 *
 * @example
 * // Accepted
 * "https://cdn.example.com/avatar.png"
 * "https://api.dicebear.com/7.x/identicon/svg?seed=alice"
 *
 * // Rejected
 * "http://cdn.example.com/avatar.png"   // non-https
 * "javascript:alert(1)"                 // XSS vector
 * "data:image/png;base64,..."           // data URI
 * "file:///etc/passwd"                  // local file
 */
export const httpsUrl = (fieldName: string) =>
  z
    .string()
    .url({ message: "Must be a valid URL." })
    .refine(
      (val) => {
        try {
          return new URL(val).protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: `${fieldName} must use the https: scheme.` },
    );

/**
 * Trims a string field and, if that leaves it empty, treats it as absent.
 * Shared by nullableText and nullableHttpsUrl below so "clear this field"
 * has exactly one meaning everywhere a PATCH body accepts it: omit the key
 * (leave unchanged), send `null` (clear it), or send `""`/whitespace
 * (clear it too — a form that merely erased the field shouldn't have to
 * know to send `null` instead of an empty input).
 */
function trimToNull(val: string | null | undefined): string | null | undefined {
  if (val === undefined || val === null) return val;
  const trimmed = val.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A nullable, clearable text field, trimmed with empty treated as null.
 *   - Key omitted: schema caller adds `.optional()` — leaves the stored
 *     value unchanged.
 *   - `null` or `""`/whitespace: stored as `null`.
 *   - Otherwise: the trimmed string, at most `maxLength` characters.
 */
export const nullableText = (maxLength: number, fieldName: string) =>
  z
    .string()
    .nullable()
    .transform(trimToNull)
    .pipe(
      z.union([
        z.null(),
        z
          .string()
          .max(maxLength, {
            message: `${fieldName} must be at most ${maxLength} characters.`,
          }),
      ]),
    );

/**
 * httpsUrl, but nullable and clearable the same way nullableText is: `null`
 * or an empty/whitespace string clears the stored value, and anything else
 * must still pass httpsUrl's https-only check.
 */
export const nullableHttpsUrl = (fieldName: string) =>
  z
    .string()
    .nullable()
    .transform(trimToNull)
    .pipe(z.union([z.null(), httpsUrl(fieldName)]));

/**
 * A creator's contact email.
 *
 * Trimmed and lowercased before validation so the stored value is canonical —
 * addresses arrive from a form field and " Alice@Example.com " and
 * "alice@example.com" are the same mailbox.
 *
 * 254 is the maximum length of an address that can actually be delivered
 * (RFC 5321's limit on the SMTP reverse/forward path).
 *
 * @example
 * // Accepted
 * "alice@example.com"
 * " Alice@Example.COM "   // stored as "alice@example.com"
 *
 * // Rejected
 * "not-an-address"
 * "alice@"
 */
export const creatorEmail = z
  .string()
  .trim()
  .toLowerCase()
  .email({ message: "Must be a valid email address." })
  .max(254, { message: "Email address is too long." });
