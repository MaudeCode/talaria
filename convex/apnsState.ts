import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";

export const getProviderToken = internalQuery({
  args: { cacheKey: v.string() },
  returns: v.union(
    v.null(),
    v.object({ token: v.string(), issuedAt: v.number() }),
  ),
  handler: async (ctx, args) => {
    const cached = await ctx.db
      .query("apnsProviderTokens")
      .withIndex("by_cache_key", (query) => query.eq("cacheKey", args.cacheKey))
      .unique();
    return cached ? { token: cached.token, issuedAt: cached.issuedAt } : null;
  },
});

export const saveProviderToken = internalMutation({
  args: { cacheKey: v.string(), token: v.string(), issuedAt: v.number(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cached = await ctx.db
      .query("apnsProviderTokens")
      .withIndex("by_cache_key", (query) => query.eq("cacheKey", args.cacheKey))
      .unique();
    if (cached) {
      await ctx.db.patch(cached._id, {
        token: args.token,
        issuedAt: args.issuedAt,
        updatedAt: args.now,
      });
    } else {
      await ctx.db.insert("apnsProviderTokens", {
        cacheKey: args.cacheKey,
        token: args.token,
        issuedAt: args.issuedAt,
        updatedAt: args.now,
      });
    }
    return null;
  },
});
