import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_ANON_KEY = "";
// Keep the auth threshold tiny so this file proves signup does not use it.
process.env.LUALUNE_RATE_AUTH = "3";
// Fresh auth state per run so repeated `npm test` never sees stale accounts.
process.env.LUALUNE_DATA_DIR = (await import("node:fs")).mkdtempSync((await import("node:os")).tmpdir() + "/lualune-test-");

const { app, store } = await import("../server.js");
const { runLua } = await import("./luavm.js");
const { TOS_VERSION } = await import("../lib/tos.js");

let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server?.close());

async function api(pathname, { method = "GET", token, body, raw } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: res.status, text: await res.text() };
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

async function signup(username, password = "password123") {
  const res = await api("/api/auth/signup", {
    method: "POST",
    body: { username, password },
  });
  assert.equal(res.status, 201, JSON.stringify(res));
  return res.session.access_token;
}

const SAMPLE = `local message = "LuaLune works"\nlocal function shout(text)\n  return string.upper(text)\nend\nprint(shout(message))\nfor i = 1, 2 do print("tick", i) end\n`;
const EXPECTED = "LUALUNE WORKS\ntick\t1\ntick\t2";

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

// Executors all run Luau, so production builds default to LuaU output with the
// anti-tamper wrapper. The tests ask for Lua51 output without harden so the
// generated build can be executed by the Lua VM harness in this repo.
const RUNNABLE_BUILD = { engine: "prometheus", profile: "weak", harden: false, luaVersion: "Lua51" };

test("public endpoints are LuaLune branded and discord free", async () => {
  const health = await api("/healthz", { raw: true });
  assert.equal(health.status, 200);
  assert.match(health.text, /LuaLune OK/);

  const meta = await api("/api/meta");
  assert.equal(meta.name, "LuaLune");
  assert.equal(meta.product, "LuaLune Obfuscator");
  assert.deepEqual(meta.engines.map((e) => e.id), ["prometheus", "none"]);
  assert.equal(meta.engines[0].name, "Prometheus");
  assert.equal(meta.engines[0].available, true, "the vendored Prometheus engine must be installed");
  assert.equal(meta.unlimited, true);
  assert.equal(meta.plans, undefined, "pricing must be gone from the API");
  assert.match(meta.attribution, /^Based on Prometheus by Elias Oelschner, https:\/\/github\.com\/prometheus-lua\/Prometheus$/);
  assert.deepEqual(meta.profiles.map((p) => p.id), ["minify", "weak", "medium", "strong"]);
  assert.ok(!JSON.stringify(meta).toLowerCase().includes("discord"), "no discord anywhere in meta");
  assert.equal(meta.maxSourceBytes, 500_000, "the API advertises the engine's source cap");

  const token = await signup("cap-" + Date.now().toString(36));
  const tooBig = await api("/api/scripts", {
    method: "POST",
    token,
    body: { name: "too big", source: "x".repeat(500_001) },
  });
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.error, /500 KB/);


  const plans = await api("/api/plans");
  assert.equal(plans.status, 404, "the pricing catalogue is gone");

  const tos = await api("/api/tos");
  assert.equal(tos.version, TOS_VERSION);
  assert.ok(tos.sections.length >= 5);
  const plansSection = tos.sections.find((s) => /Cost/i.test(s.title));
  assert.ok(plansSection, "terms must explain that the service is free");
  assert.match(plansSection.body, /free and unlimited/i);
  assert.ok(!tos.sections.some((s) => /refund|payment/i.test(s.body)), "no payment terms left");
});

test("signup has no CAPTCHA or application-side slow mode", async () => {
  const direct = await api("/api/auth/signup", { method: "POST", body: { username: "nocaptcha", password: "password123" } });
  assert.equal(direct.status, 201, JSON.stringify(direct));
  assert.ok(direct.session?.access_token);

  // LUALUNE_RATE_AUTH applies to sign-in and reset attempts, not new accounts.
  const created = await Promise.all(Array.from({ length: 4 }, (_, i) =>
    api("/api/auth/signup", { method: "POST", body: { username: `openuser${i}`, password: "password123" } }),
  ));
  assert.ok(created.every((result) => result.status === 201), JSON.stringify(created.find((result) => result.status !== 201)));

  const removed = await api("/api/captcha");
  assert.equal(removed.status, 404);
});

test("signup, login and session round trip", async () => {
  const token = await signup("kers0ne");
  const me = await api("/api/auth/me", { token });
  assert.equal(me.status, 200);
  assert.equal(me.user.username, "kers0ne");
  assert.equal(me.profile.plan, "unlimited");
  assert.equal(me.usage.limit, -1, "usage reporting says: no cap");
  assert.equal(me.profile.email, null, "internal login address stays private");

  const login = await api("/api/auth/login", { method: "POST", body: { identifier: "kers0ne", password: "password123" } });
  assert.equal(login.status, 200);
  assert.ok(login.session.access_token);

  const wrong = await api("/api/auth/login", { method: "POST", body: { identifier: "kers0ne", password: "wrongpassword" } });
  assert.equal(wrong.status, 401);

  const anon = await api("/api/scripts");
  assert.equal(anon.status, 401);
});

test("creating a script obfuscates it with Prometheus and the loader runs", async () => {
  const token = await signup("builder");
  const created = await api("/api/scripts", { method: "POST", token, body: { name: "My script", source: SAMPLE, ...RUNNABLE_BUILD } });
  assert.equal(created.status, 201, JSON.stringify(created));
  assert.equal(created.script.engine, "prometheus");
  assert.equal(created.script.engineName, "Prometheus");
  assert.equal(created.stats.profile, "weak");
  assert.ok(created.stats.passes.includes("Vmify"));
  assert.ok(created.stats.buildId);
  assert.ok(created.loader.startsWith("loadstring(game:HttpGet("));

  const served = await api(`/loader/${created.script.id}`, { raw: true });
  assert.equal(served.status, 200);
  assert.ok(!served.text.includes("LuaLune works"), "protected source must not leak");
  assert.match(served.text, /Based on Prometheus by Elias Oelschner/);
  const run = runLua(served.text);
  assert.ok(run.ok, `loader failed: ${run.error}`);
  assert.equal(norm(run.output), EXPECTED);

  const view = await api(`/api/scripts/${created.script.id}/view`, { token, raw: true });
  assert.equal(view.status, 200);
  assert.match(view.text, /engine : Prometheus/);
});

test("every profile can be built through the API", async () => {
  const token = await signup("profiles");
  for (const profile of ["minify", "weak", "medium", "strong"]) {
    const created = await api("/api/scripts", { method: "POST", token, body: { name: `p-${profile}`, source: SAMPLE, ...RUNNABLE_BUILD, profile } });
    assert.equal(created.status, 201, JSON.stringify(created));
    assert.equal(created.stats.profile, profile);
    // The Minify preset is renaming-only, so it reports no transform steps.
    if (profile !== "minify") assert.ok(created.stats.passes.length > 0, `${profile} should report its passes`);

    const served = await api(`/loader/${created.script.id}`, { raw: true });
    // Minify is documented as rename-and-shrink only: it does not hide strings.
    if (profile !== "minify") assert.ok(!served.text.includes("LuaLune works"), `${profile} leaked the source`);
    // The Lua 5.3 harness cannot execute builds that use Lua 5.1-only facilities
    // (the strong profile does); those are covered by their pass list instead.
    if (profile === "strong") continue;
    const run = runLua(served.text);
    assert.ok(run.ok, `${profile}: ${run.error}`);
    assert.equal(norm(run.output), EXPECTED, `${profile} changed behaviour`);
  }
});

test("engine none stores the script unmodified", async () => {
  const token = await signup("noneuser");
  const created = await api("/api/scripts", { method: "POST", token, body: { name: "Plain", source: SAMPLE, engine: "none" } });
  assert.equal(created.status, 201);
  assert.equal(created.script.engine, "none");
  assert.equal(created.script.engineName, "None");
  assert.equal(created.warnings.length, 1);

  const served = await api(`/loader/${created.script.id}`, { raw: true });
  assert.ok(served.text.includes('"LuaLune works"'), "an unprotected build keeps the source readable");
  assert.equal(norm(runLua(served.text).output), EXPECTED);
});

test("retired engine ids still build, answered by Prometheus", async () => {
  const token = await signup("legacyengine");
  for (const engine of ["lune", "payload", "flow", "vault"]) {
    const created = await api("/api/scripts", { method: "POST", token, body: { name: `old-${engine}`, source: SAMPLE, ...RUNNABLE_BUILD, engine } });
    assert.equal(created.status, 201, JSON.stringify(created));
    assert.equal(created.script.engine, "prometheus", `${engine} should be served by Prometheus now`);
  }
});

test("no plan limits block builds, keys, whitelist entries, logs or shares", async () => {
  const token = await signup("nolimits");
  // Well past the old free tier of 3 scripts / 25 builds.
  for (let i = 0; i < 6; i++) {
    const res = await api("/api/scripts", { method: "POST", token, body: { name: `s${i}`, source: SAMPLE, ...RUNNABLE_BUILD } });
    assert.equal(res.status, 201, JSON.stringify(res));
  }
  const list = await api("/api/scripts", { token });
  assert.equal(list.scripts.length, 6);
  assert.equal(list.usage.count, 6, "usage is still counted for the dashboard");

  const logs = await api(`/api/scripts/${list.scripts[0].id}/logs`, { token });
  assert.equal(logs.status, 200, "execution logs are free now");

  const keys = await api("/api/keys", { method: "POST", token, body: { duration: "1d", amount: 5 } });
  assert.equal(keys.status, 201);
  assert.equal(keys.keys.length, 5);

  const share = await api("/api/shares", { method: "POST", token, body: { username: "kers0ne" } });
  assert.equal(share.status, 201, "sharing is not gated any more");
});

test("key system gates the loader and writes execution logs", async () => {
  const token = await signup("keymaster");
  const created = await api("/api/scripts", { method: "POST", token, body: { name: "Gated", source: SAMPLE, key_required: true, ...RUNNABLE_BUILD } });
  assert.equal(created.status, 201);
  const id = created.script.id;

  const noKey = await api(`/loader/${id}`, { raw: true });
  assert.equal(noKey.status, 403);
  assert.match(noKey.text, /requires a key/);

  const keys = await api("/api/keys", { method: "POST", token, body: { duration: "1d", amount: 2, script_id: id, label: "beta" } });
  assert.equal(keys.status, 201);
  assert.equal(keys.keys.length, 2);
  const value = keys.keys[0].value;

  const withKey = await api(`/loader/${id}?key=${value}`, { raw: true });
  assert.equal(withKey.status, 200);
  assert.ok(runLua(withKey.text).ok);

  const badKey = await api(`/loader/${id}?key=LL-NOPE-NOPE`, { raw: true });
  assert.equal(badKey.status, 403);
  assert.match(badKey.text, /invalid key/);

  const logs = await api(`/api/scripts/${id}/logs`, { token });
  assert.equal(logs.status, 200);
  const statuses = logs.logs.map((l) => l.status);
  assert.ok(statuses.includes("ok"), JSON.stringify(statuses));
  assert.ok(statuses.includes("denied"), JSON.stringify(statuses));
});

test("HWID whitelist binds a key to a device", async () => {
  const token = await signup("hwiduser");
  const created = await api("/api/scripts", { method: "POST", token, body: { name: "Bound", source: SAMPLE, key_required: true, ...RUNNABLE_BUILD } });
  const id = created.script.id;
  const wl = await api("/api/whitelist", { method: "POST", token, body: { script_id: id, hwid: "device-abc-123", label: "main pc" } });
  assert.equal(wl.status, 201);
  const key = (await api("/api/keys", { method: "POST", token, body: { duration: "forever", script_id: id } })).keys[0];

  const first = await api(`/loader/${id}?key=${key.value}&hwid=device-abc-123`, { raw: true });
  assert.equal(first.status, 200);

  const other = await api(`/loader/${id}?key=${key.value}&hwid=device-other`, { raw: true });
  assert.equal(other.status, 403);
  assert.match(other.text, /another device/);

  const entries = await api(`/api/whitelist?script_id=${id}`, { token });
  assert.equal(entries.entries.length, 1);
  assert.equal(entries.limit, -1, "no whitelist cap is reported");
  const removed = await api(`/api/whitelist/${entries.entries[0].id}?script_id=${id}`, { method: "DELETE", token });
  assert.equal(removed.status, 204);
});

test("workspace invites grant read-only sharing", async () => {
  const owner = await signup("owner");
  const mate = await signup("mate");

  const invite = await api("/api/invites", { method: "POST", token: owner, body: { max_uses: 1 } });
  assert.equal(invite.status, 201);
  assert.equal(invite.invite.kind, "workspace");
  assert.equal(invite.invite.plan, null, "invites do not carry a plan any more");

  const script = await api("/api/scripts", { method: "POST", token: owner, body: { name: "Shared", source: SAMPLE, ...RUNNABLE_BUILD } });
  const redeem = await api("/api/invites/redeem", { method: "POST", token: mate, body: { code: invite.invite.code, script_id: script.script.id } });
  assert.equal(redeem.status, 200, JSON.stringify(redeem));
  assert.equal(redeem.share.script_id, script.script.id);

  const mateScripts = await api("/api/scripts", { token: mate });
  assert.equal(mateScripts.shared.length, 1);
  const readable = await api(`/api/scripts/${script.script.id}`, { token: mate });
  assert.equal(readable.status, 200);
  const notOwner = await api(`/api/scripts/${script.script.id}`, { method: "DELETE", token: mate });
  assert.equal(notOwner.status, 404, "shared access is read only");

  const used = await api("/api/invites/redeem", { method: "POST", token: owner, body: { code: invite.invite.code } });
  assert.equal(used.status, 409, "a single-use code cannot be redeemed twice");
});

test("rebuilding keeps the loader URL and rotates the build", async () => {
  const token = await signup("rebuilder");
  const created = await api("/api/scripts", { method: "POST", token, body: { name: "Rotate", source: SAMPLE, ...RUNNABLE_BUILD } });
  const id = created.script.id;
  const rebuilt = await api(`/api/scripts/${id}/rebuild`, { method: "POST", token, body: { source: SAMPLE + 'print("extra")\n', ...RUNNABLE_BUILD, profile: "medium" } });
  assert.equal(rebuilt.status, 200);
  assert.notEqual(rebuilt.stats.buildId, created.stats.buildId);
  assert.equal(rebuilt.stats.profile, "medium");
  const served = await api(`/loader/${id}`, { raw: true });
  const run = runLua(served.text);
  assert.ok(run.ok, run.error);
  assert.equal(norm(run.output), EXPECTED + "\nextra", "rebuilt source should run");
});

test("an unsupported Lua version is a 400, not a crash", async () => {
  const token = await signup("badversion");
  const res = await api("/api/scripts", { method: "POST", token, body: { name: "Bad", source: SAMPLE, engine: "prometheus", luaVersion: "Lua53" } });
  assert.equal(res.status, 400);
  assert.match(res.error, /Unsupported Lua version/);
});

test("admin can read stats, moderate accounts and broadcast", async () => {
  const token = await signup("rootadmin");
  const me = await api("/api/auth/me", { token });
  await store.updateProfile(me.user.id, { role: "admin" });

  const denied = await api("/api/admin/stats", { token: await signup("notadmin") });
  assert.equal(denied.status, 403);

  const stats = await api("/api/admin/stats", { token });
  assert.equal(stats.status, 200);
  assert.ok(stats.stats.users >= 5);

  const users = await api("/api/admin/users", { token });
  assert.ok(users.users.length >= 5);
  assert.ok(users.users.every((u) => u.plan === "unlimited"), "no plan juggling is exposed any more");

  const target = users.users.find((u) => u.username === "nolimits");
  const suspended = await api(`/api/admin/users/${target.id}`, { method: "PATCH", token, body: { status: "suspended", suspended_until: new Date(Date.now() + 60000).toISOString(), reason: "testing" } });
  assert.equal(suspended.profile.status, "suspended");

  const broadcast = await api("/api/admin/announcements", { method: "POST", token, body: { title: "Build 2.0 is live", body: "LuaLune now runs Prometheus and is free and unlimited.", level: "info" } });
  assert.equal(broadcast.status, 201);
  const publicList = await api("/api/announcements");
  assert.equal(publicList.announcements.length, 1);
  assert.equal(publicList.announcements[0].title, "Build 2.0 is live");
});

test("suspended accounts are locked out", async () => {
  const token = await signup("suspendeduser");
  const me = await api("/api/auth/me", { token });
  await store.updateProfile(me.user.id, { status: "suspended", suspended_until: new Date(Date.now() + 60000).toISOString() });
  const res = await api("/api/scripts", { token });
  assert.equal(res.status, 423);
});

test("terms updates must be accepted before building", async () => {
  const token = await signup("tosuser");
  const me = await api("/api/auth/me", { token });
  await store.updateProfile(me.user.id, { tos_version: "2000-01-01" });
  const blocked = await api("/api/scripts", { method: "POST", token, body: { name: "x", source: SAMPLE } });
  assert.equal(blocked.status, 428);
  const accepted = await api("/api/tos/accept", { method: "POST", token, body: { version: TOS_VERSION } });
  assert.equal(accepted.status, 200);
  const after = await api("/api/scripts", { method: "POST", token, body: { name: "x", source: SAMPLE, ...RUNNABLE_BUILD } });
  assert.equal(after.status, 201);
});

test("the gold dashboard is served with the LuaLune brand, no pricing and no discord links", async () => {
  const page = await fetch(`${base}/`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /LuaLune Obfuscator/);
  assert.match(html, /\/styles\.css/);
  assert.match(html, /class="hero heroSplit"/, "new landing hero missing");
  assert.match(html, /class="dashboardSidebar"/, "workspace sidebar missing");
  assert.match(html, /\/logo-256\.png/, "large LuaLune logo missing");
  assert.match(html, /\/logo-64\.png/, "nav logo missing");
  assert.ok(!/discord/i.test(html), "discord must not appear in the app");
  assert.ok(!/pricing|\/plans|<section id="plans"/i.test(html), "pricing page must be gone");
  assert.ok(!/one-time payment|\$\d|Pro and Premium/i.test(html), "no price tags left in the UI");
  assert.match(html, /Based on Prometheus by Elias Oelschner, <a href="https:\/\/github\.com\/prometheus-lua\/Prometheus"/, "license attribution missing from the footer");
  assert.match(html, /id="profilePicker"/, "protection profile picker missing");
  assert.match(html, /<button type="button" id="loginTab"/, "sign-in tab must not submit the auth form");
  assert.match(html, /<button type="button" id="signupTab"/, "signup tab must not submit the auth form");
  assert.match(html, /onclick="forgotPassword\(\)"/, "password reset button missing");
  assert.match(html, /<button type="submit" class="btn"[^>]*id="authBtn"/, "auth action must submit the form");

  const css = await (await fetch(`${base}/styles.css`)).text();
  assert.match(css, /--gold:\s*#e9c15b/i, "gold accent missing");
  assert.ok(!/\.pricingHero|\.plan \{/.test(css), "pricing styles must be removed");

  const logo = await fetch(`${base}/logo.png`);
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get("content-type") || "", /image\/png/);

  const meta = await (await fetch(`${base}/api/meta`)).json();
  assert.ok(meta.engines.some((e) => e.id === "prometheus" && e.available), "Prometheus must be unlocked out of the box");
  assert.ok(meta.engines.every((e) => e.available), "every listed engine is available");
  assert.ok(!JSON.stringify(meta).includes("vault"), "the retired engines are gone");

  const manifest = await (await fetch(`${base}/manifest.json`)).json();
  assert.match(manifest.name, /LuaLune/);
  assert.equal(manifest.theme_color, "#efc75e");
});

test("unknown routes fall back to the app, api routes 404 as json", async () => {
  const page = await fetch(`${base}/dashboard/anything`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /LuaLune/);
  const missing = await api("/api/nope");
  assert.equal(missing.status, 404);
});
