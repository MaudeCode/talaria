/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as apns from "../apns.js";
import type * as auth from "../auth.js";
import type * as cleanup from "../cleanup.js";
import type * as completions from "../completions.js";
import type * as crons from "../crons.js";
import type * as delivery from "../delivery.js";
import type * as devices from "../devices.js";
import type * as http from "../http.js";
import type * as lib_aggregate from "../lib/aggregate.js";
import type * as lib_apnsPayload from "../lib/apnsPayload.js";
import type * as lib_appleIdentity from "../lib/appleIdentity.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_model from "../lib/model.js";
import type * as lib_validators from "../lib/validators.js";
import type * as pairing from "../pairing.js";
import type * as publishers from "../publishers.js";
import type * as subscriptions from "../subscriptions.js";
import type * as workpool from "../workpool.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  apns: typeof apns;
  auth: typeof auth;
  cleanup: typeof cleanup;
  completions: typeof completions;
  crons: typeof crons;
  delivery: typeof delivery;
  devices: typeof devices;
  http: typeof http;
  "lib/aggregate": typeof lib_aggregate;
  "lib/apnsPayload": typeof lib_apnsPayload;
  "lib/appleIdentity": typeof lib_appleIdentity;
  "lib/crypto": typeof lib_crypto;
  "lib/model": typeof lib_model;
  "lib/validators": typeof lib_validators;
  pairing: typeof pairing;
  publishers: typeof publishers;
  subscriptions: typeof subscriptions;
  workpool: typeof workpool;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  apnsWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"apnsWorkpool">;
};
