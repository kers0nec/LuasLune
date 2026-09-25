/**
 * Engine registry and build pipeline.
 *
 * LuaLune has exactly one obfuscator: **Prometheus** (see lib/prometheus.js).
 * The `none` engine is a pass-through that stores the script untouched, which is
 * handy for diffing a build or hosting an open source script.
 *
 * Every build is synchronous from the caller's point of view (Prometheus runs in
 * a WASM VM in-process), and every build returns the same shape:
 *
 *   { code, engine, warnings, stats }
 */

import crypto from "node:crypto";
import * as prometheus from "./prometheus.js";

export const ENGINES = {
  prometheus: {
    id: "prometheus",
    name: "Prometheus",
    tagline: "AST-level obfuscation: VM wrapping, encrypted strings, control-flow work",
    attribution: prometheus.ATTRIBUTION,
  },
  none: {
    id: "none",
    name: "None",
    tagline: "Store the script exactly as written",
  },
};

export const DEFAULT_ENGINE = "prometheus";

/**
 * Engine ids retired in this release. They are accepted (and answered with a
 * Prometheus build) so bookmarked clients and older dashboards keep working;
 * scripts already stored with those ids keep their loader URLs either way.
 */
const RETIRED_ENGINES = new Set(["lune", "payload", "flow", "vault"]);

export function resolveEngine(id) {
  const key = String(id ?? "").trim().toLowerCase();
  if (ENGINES[key]) return key;
  if (RETIRED_ENGINES.has(key)) return DEFAULT_ENGINE;
  return DEFAULT_ENGINE;
}

/**
 * Display name for an engine id, including ids retired in earlier releases that
 * are still stored on existing scripts ("payload", "flow", "vault", "lune").
 */
export function engineName(id) {
  return ENGINES[id]?.name || String(id ?? "");
}

/** Engine list for `/api/meta` and the dashboard picker. */
export function listEngines() {
  return Object.values(ENGINES).map((engine) => ({
    ...engine,
    default: engine.id === DEFAULT_ENGINE,
    available: true,
  }));
}

const buildId = () => crypto.randomBytes(6).toString("hex");

const byteLength = (value) => Buffer.byteLength(String(value ?? ""), "utf8");

function statsFor(engine, source, code, passes) {
  const sourceBytes = byteLength(source);
  const outputBytes = byteLength(code);
  return {
    engine,
    engineName: engineName(engine),
    buildId: buildId(),
    sourceBytes,
    outputBytes,
    ratio: +(outputBytes / Math.max(1, sourceBytes)).toFixed(2),
    passes,
  };
}

/**
 * Protect a script.
 *
 * @param {string} source Lua/Luau source
 * @param {{engine?:string, profile?:string, preset?:string, harden?:boolean, luaVersion?:string}} options
 * @returns {Promise<{code:string, engine:string, warnings:string[], stats:object}>}
 */
export async function buildProtected(source, options = {}) {
  const text = String(source ?? "");
  const engine = resolveEngine(options.engine);
  const warnings = [];

  if (engine === "none") {
    warnings.push("Stored without protection: anyone holding the loader URL can read this script.");
    const code = [
      "-- LuaLune: stored unmodified (engine \"none\")",
      "-- The source below is exactly what was submitted.",
      text,
      "",
    ].join("\n");
    return { code, engine, warnings, stats: statsFor(engine, text, code, ["none"]) };
  }

  const build = await prometheus.obfuscate(text, {
    profile: options.profile ?? options.preset,
    antiTamper: options.harden !== false,
    luaVersion: options.luaVersion,
  });

  const stats = statsFor(engine, text, build.code, build.passes);
  stats.profile = build.profile;
  stats.luaVersion = build.luaVersion;
  return { code: build.code, engine, warnings, stats };
}

export default { ENGINES, DEFAULT_ENGINE, buildProtected, listEngines, resolveEngine, engineName };
