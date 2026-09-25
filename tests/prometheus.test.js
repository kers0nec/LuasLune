import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_ANON_KEY = "";
process.env.LUALUNE_DATA_DIR = (await import("node:fs")).mkdtempSync((await import("node:os")).tmpdir() + "/lualune-test-");

const prometheus = await import("../lib/prometheus.js");
const engines = await import("../lib/engines.js");
const { runLua, syntaxCheck } = await import("./luavm.js");

/**
 * Prometheus may rewrite number literals into equivalent expressions, and the
 * Lua 5.3 test VM prints those as `1.0` where Luau (and the original script)
 * prints `1`. Normalising whole printed fields keeps the comparison about
 * behaviour rather than about float formatting.
 */
const norm = (out) => String(out ?? "")
  .split("\n")
  .map((line) => line.split("\t").map((field) => field.replace(/^(-?\d+)\.0$/, "$1")).join("\t"))
  .join("\n");

const SAMPLE = `local secret = "prometheus engine string"
local function twice(n)
  return n * 2
end
print(secret)
print(twice(21))
for i = 1, 3 do print("line", i) end
`;

test("the vendored engine reports itself as installed", async () => {
  assert.equal(await prometheus.available(), true, "vendor/prometheus/src must ship with the repo");
  assert.match(prometheus.ATTRIBUTION, /^Based on Prometheus by Elias Oelschner, https:\/\/github\.com\/prometheus-lua\/Prometheus$/);
  assert.match(prometheus.UPSTREAM, /prometheus-lua\/Prometheus/);
});

test("profiles map onto the upstream presets", () => {
  assert.deepEqual(prometheus.profiles().map((p) => p.id), ["minify", "weak", "medium", "strong"]);
  assert.equal(prometheus.resolveProfile("strong"), "strong");
  assert.equal(prometheus.resolveProfile("HEAVY"), "strong", "aliases keep working");
  assert.equal(prometheus.resolveProfile("nonsense"), "medium", "unknown profiles fall back to medium");
});

test("a Medium build runs identically to the original script", async () => {
  const baseline = runLua(SAMPLE);
  assert.ok(baseline.ok, baseline.error);

  // luaVersion Lua51 + harden off keeps the build runnable outside Roblox, which
  // is how the test VM executes it.
  const built = await prometheus.obfuscate(SAMPLE, { profile: "medium", antiTamper: false, luaVersion: "Lua51" });
  assert.ok(!built.code.includes("prometheus engine string"), "the string literal must not survive in plain form");
  assert.equal(built.profile, "medium");
  assert.equal(built.luaVersion, "Lua51");
  assert.ok(built.passes.includes("Vmify"), "medium preset runs Vmify: " + built.passes.join(","));

  const run = runLua(built.code);
  assert.ok(run.ok, run.error);
  assert.equal(norm(run.output), norm(baseline.output));
});

// fengari is Lua 5.3, so builds that lean on Lua 5.1-only facilities
// (`newproxy`, `getfenv`) can be produced but not executed here. Executors run
// Luau, which has them, so only the runnable profiles are round-tripped.
const RUNNABLE_PROFILES = ["minify", "weak", "medium"];

test("every runnable profile produces output identical to the original", async () => {
  const expected = norm(runLua(SAMPLE).output);
  for (const profile of RUNNABLE_PROFILES) {
    const built = await prometheus.obfuscate(SAMPLE, { profile, antiTamper: false, luaVersion: "Lua51" });
    const run = runLua(built.code);
    assert.ok(run.ok, `${profile}: ${run.error}`);
    assert.equal(norm(run.output), expected, `${profile} changed the program output`);
    assert.match(built.code, /Based on Prometheus by Elias Oelschner/);
  }
});

test("the strong profile applies its full pass list and hides the source", async () => {
  const built = await prometheus.obfuscate(SAMPLE, { profile: "strong", antiTamper: false, luaVersion: "Lua51" });
  assert.equal(built.profile, "strong");
  assert.ok(built.passes.filter((p) => p === "Vmify").length >= 2, "strong runs Vmify twice: " + built.passes.join(","));
  for (const pass of ["EncryptStrings", "ConstantArray", "NumbersToExpressions", "WrapInFunction"]) {
    assert.ok(built.passes.includes(pass), `strong is missing ${pass}: ${built.passes.join(",")}`);
  }
  assert.ok(!built.code.includes("prometheus engine string"), "plaintext leaked into a strong build");
  assert.ok(built.code.length > 2000, "a strong build should be substantially larger than the source");
});

test("anti-tamper is included only when it is asked for", async () => {
  const hardened = await prometheus.obfuscate(SAMPLE, { profile: "weak", antiTamper: true, luaVersion: "Lua51" });
  assert.ok(hardened.passes.includes("AntiTamper"), "hardened build must run the AntiTamper step: " + hardened.passes.join(","));

  const plain = await prometheus.obfuscate(SAMPLE, { profile: "weak", antiTamper: false, luaVersion: "Lua51" });
  assert.ok(!plain.passes.includes("AntiTamper"), "AntiTamper must not run when harden is off: " + plain.passes.join(","));
  // The hardened build wraps the source in the runtime self-check, so the two
  // builds of the same script cannot match.
  assert.notEqual(hardened.code, plain.code);
});

test("a Luau build is valid LuaU-flavoured source", async () => {
  const built = await prometheus.obfuscate('local t = table.create(3, "x")\nprint(#t)\n', { profile: "medium", antiTamper: false });
  assert.equal(built.luaVersion, "LuaU");
  const parsed = syntaxCheck(built.code);
  assert.ok(parsed.ok, "Luau build is not parseable: " + parsed.error);
});

test("a hardened build is valid Lua and keeps the plaintext out of the file", async () => {
  const built = await prometheus.obfuscate(SAMPLE, { profile: "weak", antiTamper: true, luaVersion: "Lua51" });
  assert.ok(built.passes.includes("AntiTamper"), built.passes.join(","));
  assert.ok(!built.code.includes("prometheus engine string"), "a hardened build must not carry the plaintext");
  // Hardened builds only run inside Roblox, where the anti-tamper step looks for
  // the executor runtime; the test VM can only prove that the output parses.
  const parsed = syntaxCheck(built.code);
  assert.ok(parsed.ok, "hardened build is not valid Lua: " + parsed.error);
});

test("number rewriting keeps values exact for seeds that used to corrupt builds", async () => {
  const baseline = runLua(SAMPLE);
  assert.ok(baseline.ok, baseline.error);

  // These seeds used to make the engine rewrite the constants of its own string
  // decoder into expressions that only held in the build host's integers; the
  // generated script then printed garbage. They must stay correct forever.
  for (const seed of [1, 38, 999983]) {
    const built = await prometheus.obfuscate(SAMPLE, { profile: "medium", antiTamper: false, luaVersion: "Lua51", seed });
    const run = runLua(built.code);
    assert.ok(run.ok, "seed " + seed + ": " + run.error);
    assert.equal(norm(run.output), norm(baseline.output), "seed " + seed + " changed the script's behaviour");
  }
});

test("high precision literals survive a build unchanged", async () => {
  const source = "print(3.3333333333333335)\nprint(1234.5678901234567)\nprint(0.1 + 0.2)\n";
  const baseline = runLua(source);
  assert.ok(baseline.ok, baseline.error);

  const built = await prometheus.obfuscate(source, { profile: "medium", antiTamper: false, luaVersion: "Lua51" });
  const run = runLua(built.code);
  assert.ok(run.ok, run.error);
  assert.equal(norm(run.output), norm(baseline.output));
});

test("bad input is rejected with a clear message", async () => {
  await assert.rejects(() => prometheus.obfuscate("   "), /cannot be empty/);
  await assert.rejects(() => prometheus.obfuscate("print(1)", { luaVersion: "Lua53" }), /Unsupported Lua version/);
  await assert.rejects(() => prometheus.obfuscate("x".repeat(500_001)), /500 KB/);
});

test("the engine registry exposes Prometheus plus the pass-through", () => {
  assert.deepEqual(engines.listEngines().map((e) => e.id), ["prometheus", "none"]);
  assert.equal(engines.DEFAULT_ENGINE, "prometheus");
  assert.equal(engines.resolveEngine("lune"), "prometheus", "retired engine ids resolve to Prometheus");
  assert.equal(engines.resolveEngine("vault"), "prometheus");
  assert.equal(engines.resolveEngine("none"), "none");
  assert.equal(engines.engineName("payload"), "payload", "stored legacy ids still print their own name");
});

test("engine 'none' stores the source untouched", async () => {
  const built = await engines.buildProtected(SAMPLE, { engine: "none" });
  assert.equal(built.engine, "none");
  assert.ok(built.code.includes(SAMPLE));
  assert.equal(built.warnings.length, 1);
  assert.match(built.warnings[0], /without protection/);
});
