import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export function publisherForGrant(ctx: QueryCtx, grant: Doc<"publisherGrants">) {
  return ctx.db.query("publishers")
    .withIndex("by_version_and_owner_user_id_and_publisher_id", (query) =>
      query.eq("version", 2).eq("ownerUserId", grant.publisherOwnerUserId).eq("publisherId", grant.publisherId),
    ).unique();
}

export function isPublisherStateVisible(publisher: Doc<"publishers"> | null, receivedAt: number): boolean {
  return publisher?.enabled !== false && receivedAt > (publisher?.keysRevokedAt ?? -1);
}

export async function visiblePublisherStates<T extends { publisherId: string; receivedAt: number }>(
  ctx: QueryCtx, userId: string, states: T[],
): Promise<T[]> {
  const publisherIds = new Set(states.map((state) => state.publisherId));
  const publishers = new Map(await Promise.all([...publisherIds].map(async (publisherId) => {
    const grant = await ctx.db.query("publisherGrants")
      .withIndex("by_user_id_and_publisher_id", (query) =>
        query.eq("userId", userId).eq("publisherId", publisherId),
      ).unique();
    return [publisherId, grant ? await publisherForGrant(ctx, grant) : null] as const;
  })));
  return states.filter((state) => isPublisherStateVisible(publishers.get(state.publisherId) ?? null, state.receivedAt));
}
