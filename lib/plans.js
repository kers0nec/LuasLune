/**
 * LuaLune usage.
 *
 * LuaLune is free and unlimited: every account can create as many scripts, keys,
 * whitelist entries, shares and builds as it wants. The limit helper still exists
 * so the rest of the codebase (and any older client) can ask about a limit and be
 * told "no limit", and `-1` keeps meaning unlimited, matching the previous tiers.
 */

export const UNLIMITED = -1;

/** The single, unlimited plan every account is on. */
export const PLAN = {
  id: "unlimited",
  name: "Unlimited",
  price: 0,
  blurb: "Every feature, no caps, no billing.",
  limits: { scripts: UNLIMITED, obfuscationsPerMonth: UNLIMITED, keys: UNLIMITED, whitelistPerScript: UNLIMITED, shares: UNLIMITED },
  features: [
    "Prometheus obfuscator (Minify, Weak, Medium, Strong)",
    "Unlimited scripts and rebuilds",
    "Unlimited keys and HWID whitelist entries",
    "Execution logs",
    "Workspace sharing",
  ],
};

/** Kept for compatibility with rows written before plans were removed. */
const LEGACY_PLAN_IDS = ["free", "pro", "premium"];

export const PLANS = { [PLAN.id]: PLAN, ...Object.fromEntries(LEGACY_PLAN_IDS.map((id) => [id, PLAN])) };

export const PLAN_ORDER = [PLAN.id];

/** Every account resolves to the same unlimited plan. */
export function planFor() {
  return PLAN;
}

/** Always unlimited, whatever field is asked about. */
export function limit() {
  return UNLIMITED;
}

export function isUnlimited() {
  return true;
}

/** No account is ever blocked by a usage limit. */
export function checkLimit() {
  return { allowed: true };
}

/** Monthly usage window key, e.g. "2026-09". Used for reporting only. */
export function monthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function publicPlans() {
  return [{ id: PLAN.id, name: PLAN.name, price: PLAN.price, blurb: PLAN.blurb, limits: PLAN.limits, features: PLAN.features }];
}
