/**
 * Prometheus engine.
 *
 * LuaLune's only obfuscator. The vendored Prometheus Lua sources
 * (`vendor/prometheus/src`, pinned in `vendor/prometheus/README.md`) run inside a
 * WASM Lua VM (wasmoon) and transform the submitted script into a protected,
 * Luau-compatible build.
 *
 * Upstream: https://github.com/prometheus-lua/Prometheus by Elias Oelschner,
 * licensed under the Prometheus License (`vendor/prometheus/LICENSE`). That
 * license requires the attribution below to stay visible in the product, so the
 * exact sentence is exported as `ATTRIBUTION` and rendered in the dashboard
 * footer. See `vendor/prometheus/README.md`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "prometheus", "src");

/** Exact wording required by the Prometheus License. Do not reword. */
/** Largest source the engine accepts, in bytes (the loader/browser use the same cap). */
export const MAX_SOURCE_BYTES = 500_000;

export const ATTRIBUTION = "Based on Prometheus by Elias Oelschner, https://github.com/prometheus-lua/Prometheus";

export const UPSTREAM = "https://github.com/prometheus-lua/Prometheus";

/**
 * Build profiles. `preset` is the upstream Prometheus preset, `luaVersion` the
 * default target language. Luau is the default because every supported executor
 * runs Luau; `Lua51` is available for plain Lua 5.1 targets (and used by tests).
 */
export const PROFILES = {
  minify: {
    id: "minify",
    label: "Minify",
    preset: "Minify",
    blurb: "Rename and shrink only. No VM, no runtime cost.",
  },
  weak: {
    id: "weak",
    label: "Weak",
    preset: "Weak",
    blurb: "VM wrapping and an encrypted constant array. Light runtime cost.",
  },
  medium: {
    id: "medium",
    label: "Medium",
    preset: "Medium",
    blurb: "String encryption, VM wrapping, shuffled constants. Balanced default.",
  },
  strong: {
    id: "strong",
    label: "Strong",
    preset: "Strong",
    blurb: "Double VM pass, encrypted strings and mutated numbers. Highest cost.",
  },
};

/** Friendly aliases so older clients keep working (`heavy`, `maximum`, ...). */
const PROFILE_ALIASES = {
  light: "weak",
  balanced: "medium",
  heavy: "strong",
  maximum: "strong",
};

export const PROFILE_IDS = Object.keys(PROFILES);

/** Supported Prometheus output languages. */
const LUA_VERSIONS = { luau: "LuaU", lua51: "Lua51", "lua5.1": "Lua51", lua5_1: "Lua51" };

export const DEFAULT_PROFILE = "medium";
export const DEFAULT_LUA_VERSION = "LuaU";

/** Human readable profile list for `/api/meta` and the dashboard. */
export function profiles() {
  return PROFILE_IDS.map((id) => ({ id, label: PROFILES[id].label, blurb: PROFILES[id].blurb }));
}

export function resolveProfile(value) {
  const key = String(value ?? "").trim().toLowerCase();
  if (PROFILES[key]) return key;
  if (PROFILE_ALIASES[key]) return PROFILE_ALIASES[key];
  return DEFAULT_PROFILE;
}

export function resolveLuaVersion(value) {
  const key = String(value ?? "").trim().toLowerCase();
  if (!key) return DEFAULT_LUA_VERSION;
  const version = LUA_VERSIONS[key];
  if (!version) {
    throw new Error(`Unsupported Lua version "${value}". Prometheus can emit LuaU or Lua51 output.`);
  }
  return version;
}

let factoryPromise = null;
let lastError = null;

function luaFiles(dir) {
  const found = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) found.push(...luaFiles(file));
    else if (name.endsWith(".lua")) found.push(file);
  }
  return found;
}

/** Mount the vendored sources once and reuse the VM factory for every build. */
async function factory() {
  if (!factoryPromise) {
    factoryPromise = (async () => {
      if (!fs.existsSync(path.join(ROOT, "prometheus.lua"))) {
        throw new Error("Prometheus sources are missing from vendor/prometheus/src.");
      }
      let wasmoon;
      try {
        wasmoon = await import("wasmoon");
      } catch {
        throw new Error("The 'wasmoon' package is required to run the Prometheus engine (npm install wasmoon).");
      }
      const instance = new wasmoon.LuaFactory();
      for (const file of luaFiles(ROOT)) {
        const relative = path.relative(ROOT, file).split(path.sep).join("/");
        await instance.mountFile(`/prometheus/${relative}`, fs.readFileSync(file));
      }
      return instance;
    })().catch((error) => {
      lastError = error.message;
      factoryPromise = null; // allow a retry once the bundle is restored
      throw error;
    });
  }
  return factoryPromise;
}

/** True when the vendored sources and wasmoon are both present. */
export async function available() {
  try {
    await factory();
    return true;
  } catch {
    return false;
  }
}

export function unavailableReason() {
  return lastError || "Prometheus sources not installed";
}

/**
 * Lua driver executed inside the WASM VM.
 *
 * `arg` is defined because Prometheus' config module iterates it, and the 5.1
 * shims cover the few library calls the engine makes that wasmoon's Lua 5.4-ish
 * runtime spells differently.
 */
const DRIVER = `
  arg = {}
  math.log10 = math.log10 or function(value) return math.log(value, 10) end
  unpack = unpack or table.unpack
  loadstring = loadstring or load
  package.path = '/prometheus/?.lua;/prometheus/?/init.lua;' .. package.path
  local Prometheus = require('prometheus')
  Prometheus.Logger.logLevel = Prometheus.Logger.LogLevel.Error
  Prometheus.Logger.errorCallback = function(message) error(message, 0) end
  local config = Prometheus.Presets[LUALUNE_PROFILE]
  config.LuaVersion = LUALUNE_LUA_VERSION
  if LUALUNE_SEED and LUALUNE_SEED > 0 then
    config.Seed = LUALUNE_SEED
  else
    config.Seed = os.time() + math.random(1, 1000000)
  end
  local found = false
  for _, step in ipairs(config.Steps or {}) do if step.Name == 'AntiTamper' then found = true break end end
  if found ~= LUALUNE_ANTITAMPER then
    local steps = {}
    for _, step in ipairs(config.Steps or {}) do
      if LUALUNE_ANTITAMPER or step.Name ~= 'AntiTamper' then steps[#steps + 1] = step end
    end
    if LUALUNE_ANTITAMPER then table.insert(steps, 1, {Name = 'AntiTamper', Settings = {UseDebug = false}}) end
    config.Steps = steps
  end
  local names = {}
  for _, step in ipairs(config.Steps or {}) do names[#names + 1] = step.Name end
  LUALUNE_PASSES = table.concat(names, ',')
  local pipeline = Prometheus.Pipeline:fromConfig(config)
  return pipeline:apply(LUALUNE_SOURCE, 'LuaLune')
`;

/** Reads back the pass list the driver recorded for the build that just ran. */
const STEP_QUERY = `return LUALUNE_PASSES or ''`;

/**
 * Protect a script with Prometheus.
 *
 * @param {string} source Lua/Luau source
 * @param {{profile?:string, preset?:string, antiTamper?:boolean, luaVersion?:string, seed?:number}} options
 *        `seed` pins Prometheus' randomization; omit it for production builds so
 *        every build differs.
 * @returns {Promise<{code:string, profile:string, luaVersion:string, passes:string[]}>}
 */
export async function obfuscate(source, { profile, preset, antiTamper = true, luaVersion, seed } = {}) {
  const text = String(source ?? "");
  if (!text.trim()) throw new Error("Lua source cannot be empty.");
  if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) throw new Error("Source exceeds the 500 KB limit of the Prometheus engine.");

  const profileId = resolveProfile(profile ?? preset);
  const version = resolveLuaVersion(luaVersion);
  const pinnedSeed = Number.isFinite(Number(seed)) && Number(seed) > 0 ? Math.floor(Number(seed)) : 0;

  const lua = await (await factory()).createEngine();
  try {
    lua.global.set("LUALUNE_SOURCE", text);
    lua.global.set("LUALUNE_PROFILE", PROFILES[profileId].preset);
    lua.global.set("LUALUNE_LUA_VERSION", version);
    lua.global.set("LUALUNE_ANTITAMPER", !!antiTamper);
    lua.global.set("LUALUNE_SEED", pinnedSeed);

    // `antiTamper` toggles Prometheus' own AntiTamper step (reported below).
    // LuaLune used to wrap the source in a JS-authored runtime self-check; that
    // wrapper compared function identities through the generated VM and silently
    // broke a share of builds, so the upstream step is the only mechanism now.
    const result = await lua.doString(DRIVER);
    if (!result || !String(result).trim()) throw new Error("The engine returned an empty build.");

    let passes = [];
    try {
      const steps = await lua.doString(STEP_QUERY);
      passes = String(steps || "").split(",").map((step) => step.trim()).filter(Boolean);
    } catch {
      passes = []; // the build is good even if the report is not
    }

    return {
      code: [
        "-- Protected by LuaLune",
        `-- ${ATTRIBUTION}`,
        `-- profile: ${profileId}  |  lua: ${version}${pinnedSeed ? `  |  seed: ${pinnedSeed}` : ""}`,
        String(result),
        "",
      ].join("\n"),
      profile: profileId,
      luaVersion: version,
      passes,
    };
  } catch (error) {
    throw new Error("Prometheus failed: " + (error?.message || error));
  } finally {
    lua.global.close();
  }
}

export default { obfuscate, available, unavailableReason, profiles, resolveProfile, ATTRIBUTION, UPSTREAM };
