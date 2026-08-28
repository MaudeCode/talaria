import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("prune expired relay state", { minutes: 5 }, internal.cleanup.prune, {});

export default crons;
