import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { randomToken, sha256 } from "./lib/crypto";

const enrollmentKindValidator = v.union(v.literal("publisher"), v.literal("device"));

export const storeEnrollmentCode = internalMutation({
  args: {
    codeHash: v.string(),
    kind: enrollmentKindValidator,
    publisherId: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("enrollmentCodes", args);
    return null;
  },
});

export const createEnrollmentCode = internalAction({
  args: {
    kind: enrollmentKindValidator,
    publisherId: v.optional(v.string()),
    expiresInSeconds: v.optional(v.number()),
  },
  returns: v.object({ code: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const code = randomToken(24);
    const createdAt = Date.now();
    const expiresAt = createdAt + Math.max(60, args.expiresInSeconds ?? 15 * 60) * 1_000;
    await ctx.runMutation(internal.admin.storeEnrollmentCode, {
      codeHash: await sha256(code),
      kind: args.kind,
      publisherId: args.publisherId,
      expiresAt,
      createdAt,
    });
    return { code, expiresAt };
  },
});
