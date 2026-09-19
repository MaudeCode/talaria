import { Workpool } from "@convex-dev/workpool";

import { components } from "./_generated/api";

export const apnsPool = new Workpool(components.apnsWorkpool, {
  maxParallelism: 1,
  retryActionsByDefault: true,
  defaultRetryBehavior: { maxAttempts: 5, initialBackoffMs: 30_000, base: 2 },
});
