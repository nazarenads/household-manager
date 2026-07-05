/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as bot from "../bot.js";
import type * as carts from "../carts.js";
import type * as config from "../config.js";
import type * as crons from "../crons.js";
import type * as items from "../items.js";
import type * as jobs from "../jobs.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_state from "../lib/state.js";
import type * as parser from "../parser.js";
import type * as reorder from "../reorder.js";
import type * as seed from "../seed.js";
import type * as stock from "../stock.js";
import type * as stores from "../stores.js";
import type * as trajectories from "../trajectories.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  bot: typeof bot;
  carts: typeof carts;
  config: typeof config;
  crons: typeof crons;
  items: typeof items;
  jobs: typeof jobs;
  "lib/auth": typeof lib_auth;
  "lib/state": typeof lib_state;
  parser: typeof parser;
  reorder: typeof reorder;
  seed: typeof seed;
  stock: typeof stock;
  stores: typeof stores;
  trajectories: typeof trajectories;
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

export declare const components: {};
