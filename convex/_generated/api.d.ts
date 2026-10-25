/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agent from "../agent.js";
import type * as areas from "../areas.js";
import type * as assistant from "../assistant.js";
import type * as cameraSelection from "../cameraSelection.js";
import type * as cameras from "../cameras.js";
import type * as crons from "../crons.js";
import type * as geo from "../geo.js";
import type * as geometry from "../geometry.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as nycCameras from "../nycCameras.js";
import type * as occupancy from "../occupancy.js";
import type * as parking from "../parking.js";
import type * as rules from "../rules.js";
import type * as seed from "../seed.js";
import type * as sfCameras from "../sfCameras.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  areas: typeof areas;
  assistant: typeof assistant;
  cameraSelection: typeof cameraSelection;
  cameras: typeof cameras;
  crons: typeof crons;
  geo: typeof geo;
  geometry: typeof geometry;
  http: typeof http;
  ingest: typeof ingest;
  nycCameras: typeof nycCameras;
  occupancy: typeof occupancy;
  parking: typeof parking;
  rules: typeof rules;
  seed: typeof seed;
  sfCameras: typeof sfCameras;
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
