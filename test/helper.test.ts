import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { loginStartScript, loginStatusScript, pairScript, serveDropIn, setupScript, sq, staleConnectionsScript } from "../src/box-scripts.ts";
import { argValue, plan } from "../src/cli.ts";
import { InstaboxApi, type Machine } from "../src/instabox-api.ts";
import { buildAgentEnv, DEFAULT_PROVIDERS, fetchModelIds, opencodeConfig, parseEnvFile, parseProviders, piModels, renderEnvFile } from "../src/providers.ts";
import { allocatePorts, DEFAULTS, type State } from "../src/state.ts";
import { ensureServe, hubBaseUrl, parseServeStatus, removeServe, type Run } from "../src/tailscale.ts";
import { knownHostsLine, sshArgs } from "../src/tunnel.ts";

const KEY = "sk-very-secret-value-123";

test("secrets.env parsing: comments, export, quotes, literal values", () => {
  const env = parseEnvFile(`# c\nexport ZAI_API_KEY="a b#c"\nMINIMAX_API_KEY='x$HOME'\n\nRAW=1=2\n`);
  assert.deepEqual(env, { ZAI_API_KEY: "a b#c", MINIMAX_API_KEY: "x$HOME", RAW: "1=2" });
  assert.throws(() => parseEnvFile("not a line"), /line 1/);
});

test("rendered EnvironmentFile escapes quotes and refuses newline injection", () => {
  assert.equal(renderEnvFile({ B: 'q"\\', A: "x" }), 'A="x"\nB="q\\"\\\\"\n');
  assert.throws(() => renderEnvFile({ A: "x\nINJECTED=1" }), /newline/);
});

test("agent env: hub's InstaBox keys never reach a box; claudeVia sets Anthropic endpoint", () => {
  const secrets = { INSTABOX_API_KEY: "ibk_hub", INSTABOX_API_KEY_WYRD1: "ibk_hub2", MINIMAX_API_KEY: KEY };
  const env = buildAgentEnv(secrets, DEFAULT_PROVIDERS, "minimax", "/oc.json");
  assert.equal(env.INSTABOX_API_KEY, undefined);
  assert.equal(env.INSTABOX_API_KEY_WYRD1, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.minimax.io/anthropic");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(env.OPENCODE_CONFIG, "/oc.json");
  assert.equal(buildAgentEnv(secrets, DEFAULT_PROVIDERS, "none", "/x").ANTHROPIC_AUTH_TOKEN, undefined);
  assert.throws(() => buildAgentEnv(secrets, DEFAULT_PROVIDERS, "zai", "/x"), /ZAI_API_KEY is not in secrets/);
  assert.throws(() => buildAgentEnv(secrets, DEFAULT_PROVIDERS, "zro", "/x"), /anthropicBaseURL/);
});

test("OpenCode and Pi configs name the env var, never the key", () => {
  const m = [{ provider: DEFAULT_PROVIDERS[4], ids: ["MiniMax-M3"] }];
  const oc = JSON.parse(opencodeConfig(m));
  assert.equal(oc.provider.minimax.options.apiKey, "{env:MINIMAX_API_KEY}");
  assert.deepEqual(Object.keys(oc.provider.minimax.models), ["MiniMax-M3"]);
  const pi = JSON.parse(piModels(m));
  assert.equal(pi.providers.minimax.apiKey, "$MINIMAX_API_KEY");
  assert.ok(!opencodeConfig(m).includes(KEY) && !piModels(m).includes(KEY));
});

test("provider list validation rejects http, credentials in URLs and bad env names", () => {
  assert.throws(() => parseProviders([{ id: "x", baseURL: "http://a/v1", keyEnv: "K" }]), /https/);
  assert.throws(() => parseProviders([{ id: "x", baseURL: "https://u:p@a/v1", keyEnv: "K" }]), /credentials/);
  assert.throws(() => parseProviders([{ id: "x", baseURL: "https://a/v1", keyEnv: "K;rm" }]), /env var/);
  assert.equal(parseProviders([{ id: "x", baseURL: "https://a/v1/", keyEnv: "K" }])[0].baseURL, "https://a/v1");
});

test("model list fetch sends the key only as a header and dedupes", async () => {
  let seen: { url: string; auth: string } | undefined;
  const f = (async (url: string, init: RequestInit) => {
    seen = { url, auth: (init.headers as Record<string, string>).Authorization };
    return Response.json({ data: [{ id: "b" }, { id: "a" }, { id: "b" }, { id: 7 }] });
  }) as typeof fetch;
  assert.deepEqual(await fetchModelIds(DEFAULT_PROVIDERS[1], KEY, f), ["a", "b"]);
  assert.equal(seen?.url, "https://zro.moonmath.ai/v1/models");
  assert.equal(seen?.auth, `Bearer ${KEY}`);
  const empty = (async () => Response.json({ data: [] })) as typeof fetch;
  await assert.rejects(fetchModelIds(DEFAULT_PROVIDERS[1], KEY, empty), /no models/);
});

test("port allocation skips other boxes, busy tailscale serve ports and busy hub ports", () => {
  const state: State = { boxes: { m1: { id: "m1", name: "a", localPort: 47301, servePort: 8301 } } };
  const cfg = { ...DEFAULTS, localPortRange: [47301, 47303] as [number, number], servePortRange: [8301, 8303] as [number, number] };
  assert.deepEqual(allocatePorts(state, cfg, new Set([8302]), new Set([47302])), { localPort: 47303, servePort: 8303 });
  assert.throws(() => allocatePorts(state, cfg, new Set([8302, 8303]), new Set()), /servePortRange/);
});

const serveJson = (web: Record<string, string>) =>
  JSON.stringify({ TCP: Object.fromEntries(Object.keys(web).map((h) => [h.split(":")[1], { HTTPS: true }])), Web: Object.fromEntries(Object.entries(web).map(([h, p]) => [h, { Handlers: { "/": { Proxy: p } } }])) });

test("tailscale serve: parse status, add only free ports, never take over another route", () => {
  const status = serveJson({ "hub.example.ts.net:443": "http://127.0.0.1:3773", "hub.example.ts.net:8301": "http://127.0.0.1:47301" });
  assert.deepEqual([...parseServeStatus(status)], [[443, "http://127.0.0.1:3773"], [8301, "http://127.0.0.1:47301"]]);
  const calls: string[][] = [];
  const run: Run = (a) => (calls.push(a), { status: 0, stdout: a[1] === "status" ? status : "", stderr: "" });
  assert.equal(ensureServe(8301, 47301, run), "present");
  assert.throws(() => ensureServe(443, 47302, run), /already serves http:\/\/127\.0\.0\.1:3773/);
  assert.equal(ensureServe(8302, 47302, run), "added");
  assert.deepEqual(calls.at(-1), ["serve", "--bg", "--https=8302", "http://127.0.0.1:47302"]);
  assert.ok(!calls.flat().some((a) => /funnel/i.test(a)));
  assert.equal(removeServe(443, 47301, run), false, "does not remove a route it does not own");
  assert.equal(hubBaseUrl("hub.example.ts.net", 8301), "https://hub.example.ts.net:8301/");
});

test("ssh forward is local (-L) to the box's loopback only, strict host CA", () => {
  const a = sshArgs({ keyPath: "/k", certPath: "/c", knownHostsPath: "/kh", port: 2222, localPort: 47301, destination: "u@gw" });
  assert.ok(!a.includes("-R"));
  assert.equal(a[a.indexOf("-L") + 1], "127.0.0.1:47301:127.0.0.1:3774");
  assert.ok(a.includes("StrictHostKeyChecking=yes") && a.includes("ExitOnForwardFailure=yes"));
  assert.equal(knownHostsLine({ host: "gw", port: 2222, hostTrust: { type: "ca", publicKey: "ssh-ed25519 AAA \n" } }), "@cert-authority [gw]:2222 ssh-ed25519 AAA\n");
});

test("watch plan: open when running, close when paused, forget when deleted", () => {
  const m = (state: string, ready = true) => ({ id: "m", name: "n", state, operationId: null, runtime: { ready } }) as Machine;
  assert.equal(plan(null, false), "forget");
  assert.equal(plan(m("running"), false), "open");
  assert.equal(plan(m("running"), true), "keep");
  assert.equal(plan(m("running", false), true), "close");
  assert.equal(plan(m("suspended"), true), "close");
  assert.equal(plan(m("stopped"), false), "close");
});

test("box T3 binds loopback only; template's 0.0.0.0 ExecStart is replaced", () => {
  const d = serveDropIn();
  assert.match(d, /^ExecStart=$/m);
  assert.match(d, /t3 serve --host 127\.0\.0\.1 --port 3774/);
  assert.ok(!d.includes("0.0.0.0"));
  assert.match(setupScript(), /not-loopback-only/);
});

test("pair script uses the hub URL, quotes inputs, validates ttl, prints no raw token", () => {
  const s = pairScript({ ttl: "10m", label: "t3ih it's", baseUrl: "https://hub.example.ts.net:8301/" });
  assert.match(s, /--base-url https:\/\/hub\.example\.ts\.net:8301\//);
  assert.match(s, /--label 't3ih it'\\''s'/);
  assert.match(s, /JSON\.stringify\(\{pairUrl:j\.pairUrl,expiresAt:j\.expiresAt\}\)/);
  assert.throws(() => pairScript({ ttl: "10m; rm -rf /", label: "x", baseUrl: "https://h/" }), /ttl/);
  assert.equal(sq("a b"), "'a b'");
});

test("login commands are the CLIs' verified device/browser flows", () => {
  assert.match(loginStartScript("codex"), /'codex login --device-auth'/);
  assert.match(loginStartScript("claude"), /'claude auth login --claudeai'/);
  assert.match(loginStartScript("claude", true), /'claude auth login --console'/);
  assert.throws(() => loginStartScript("gemini"), /one of/);
  assert.match(loginStatusScript("codex"), /codex login status/);
});

test("every box script is valid bash", () => {
  for (const s of [setupScript(), pairScript({ ttl: "5m", label: "x", baseUrl: "https://h/" }), loginStartScript("codex"), loginStatusScript("claude"), staleConnectionsScript()]) {
    const r = spawnSync("bash", ["-n"], { input: s, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
});

test("API client: idempotency keys on mutations, none on exec/wake, retries only retryable errors", async () => {
  const seen: { method: string; url: string; ik?: string }[] = [];
  let fail = 1;
  const f = async (url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    seen.push({ method: String(init.method), url, ik: h["Idempotency-Key"] });
    assert.equal(h["X-API-Key"], "ibk_test");
    if (url.endsWith("/resume") && fail-- > 0) return Response.json({ error: { code: "busy", retryable: true } }, { status: 503 });
    if (url.endsWith("/stop")) return Response.json({ error: { code: "operation_conflict", message: "no" } }, { status: 409 });
    return Response.json({ id: "op_1", stdout: "", exitCode: 0 });
  };
  const api = new InstaboxApi("ibk_test", f, "https://api.test", async () => {});
  await api.createMachine({ name: "a", metadata: {} }, "t3ih-create-a");
  await api.exec("m 1", { cmd: "true", timeoutSeconds: 5 });
  await api.wake("m1");
  await api.lifecycle("m1", "resume");
  await assert.rejects(api.lifecycle("m1", "stop"), /409 operation_conflict/);
  assert.equal(seen[0].ik, "t3ih-create-a");
  assert.equal(seen[1].url, "https://api.test/v1/machines/m%201/exec");
  assert.equal(seen[1].ik, undefined);
  assert.equal(seen[2].ik, undefined);
  assert.equal(seen[3].ik, seen[4].ik, "a retried mutation replays the same key");
  assert.equal(seen.filter((s) => s.url.endsWith("/stop")).length, 1, "non-retryable errors are not retried");
  assert.equal(argValue(["x", "--ttl", "1h"], "--ttl"), "1h");
});

test("InstaBox key precedence: dedicated var, then secrets.env, then shell; differing shell key warned", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { loadSecrets } = await import("../src/state.ts");
  const dir = mkdtempSync(`${tmpdir()}/t3ih-`);
  writeFileSync(`${dir}/secrets.env`, "INSTABOX_API_KEY=dummy-file\nZAI_API_KEY=z\n", { mode: 0o600 });
  const warns: string[] = [];
  const w = (m: string) => warns.push(m);
  assert.equal(loadSecrets(dir, { INSTABOX_API_KEY: "dummy-shell" }, w).INSTABOX_API_KEY, "dummy-file");
  assert.equal(warns.length, 1);
  assert.ok(!warns[0].includes("dummy-"), "warning names sources, not keys");
  assert.equal(loadSecrets(dir, { T3IH_INSTABOX_API_KEY: "dummy-dedicated", INSTABOX_API_KEY: "dummy-dedicated" }, w).INSTABOX_API_KEY, "dummy-dedicated");
  assert.equal(warns.length, 1, "same key: no warning");
  writeFileSync(`${dir}/secrets.env`, "ZAI_API_KEY=z\n", { mode: 0o600 });
  assert.equal(loadSecrets(dir, { INSTABOX_API_KEY: "dummy-shell" }, w).INSTABOX_API_KEY, "dummy-shell");
  (await import("node:fs")).chmodSync(`${dir}/secrets.env`, 0o644);
  assert.throws(() => loadSecrets(dir, {}, w), /chmod 600/);
});

test("create idempotency key: stable across retries of one attempt, new after the attempt completes", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createKey } = await import("../src/cli.ts");
  const { loadState, saveState } = await import("../src/state.ts");
  const dir = mkdtempSync(`${tmpdir()}/t3ih-`);
  const k1 = createKey({ dir }, "box1");
  assert.equal(createKey({ dir }, "box1"), k1);
  assert.notEqual(createKey({ dir }, "box2"), k1);
  const st = loadState(dir);
  delete st.pendingCreates!.box1; // what a successful create does
  saveState(st, dir);
  assert.notEqual(createKey({ dir }, "box1"), k1);
});

test("setup installs T3 and a base unit only when the unit is missing", () => {
  const s = setupScript();
  assert.match(s, /if ! sudo -n systemctl cat t3-instabox\.service/);
  assert.match(s, /curl -fsSL https:\/\/t3\.codes\/install\.sh \| sh/);
  assert.match(s, /\/etc\/systemd\/system\/t3-instabox\.service/);
});
