// t3ih: InstaBox machines as T3 Code environments, reached through the hub.
import { createServer } from "node:net";
import {
  BOX_OPENCODE_CONFIG,
  installAgentsScript,
  LOGINS,
  loginCancelScript,
  loginCodeScript,
  loginStartScript,
  loginStatusScript,
  pairScript,
  setupScript,
  staleConnectionsScript,
} from "./box-scripts.ts";
import { InstaboxApi, isRunning, type Machine, OWNER_LABEL } from "./instabox-api.ts";
import { buildAgentEnv, fetchModelIds, opencodeConfig, piModels, renderEnvFile } from "./providers.ts";
import { allocatePorts, type BoxRecord, type Config, ensureHome, findBox, loadConfig, loadSecrets, loadState, saveState } from "./state.ts";
import { ensureServe, hubBaseUrl, hubDnsName, removeServe, serveStatus } from "./tailscale.ts";
import { portOpen, TunnelManager } from "./tunnel.ts";

const USAGE = `t3ih: T3 Code on InstaBox machines, reached through this hub

  t3ih create <name> [--snapshot <id>]   new box (t3 template or a login-free snapshot), set up, routed
  t3ih adopt <name|id>                   manage an existing box (one created from the t3 template)
  t3ih list                              boxes, their state and hub routes
  t3ih setup <name>                      re-push loopback-only serve config and agent keys
  t3ih pair <name> [--ttl 10m]           one-time pairing link that points at the hub's route
  t3ih wake|resume|suspend|stop <name>   lifecycle (wake: an idle-paused box only)
  t3ih delete <name> --yes               delete the box and its hub route
  t3ih login <name> <codex|claude> [--console]   start the CLI's own login on that box
  t3ih login-code <name> <agent>         paste a code the login asks for (read from stdin)
  t3ih login-status|login-cancel <name> <agent>
  t3ih install-agents <name>             add Pi and OpenCode (for building a base snapshot)
  t3ih watch                             hub supervisor: tunnels and routes follow box state

Config: ${"$"}T3IH_HOME (default ~/.config/t3-instabox-helper): config.json, secrets.env (chmod 600).`;

const err = (m: string) => process.stderr.write(`${m}\n`);

export function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** What `watch` does for one box: open the forward, close it, or leave it. Pure, for tests. */
export function plan(m: Machine | null, tunnelHealthy: boolean): "forget" | "open" | "close" | "keep" {
  if (!m || m.state === "deleted") return "forget";
  if (isRunning(m)) return tunnelHealthy ? "keep" : "open";
  return "close";
}

interface Ctx {
  dir: string;
  cfg: Config;
  secrets: Record<string, string>;
  api: InstaboxApi;
}

function ctx(): Ctx {
  const dir = ensureHome();
  const cfg = loadConfig(dir);
  const secrets = loadSecrets(dir);
  return { dir, cfg, secrets, api: new InstaboxApi(secrets.INSTABOX_API_KEY ?? "") };
}

function box(c: Ctx, ref: string | undefined): BoxRecord {
  if (!ref) throw new Error("name required");
  const b = findBox(loadState(c.dir), ref);
  if (!b) throw new Error(`${ref}: not managed by this hub (t3ih list; t3ih adopt ${ref})`);
  return b;
}

/** Run a box script; throws with the last lines on a non-zero exit. */
async function run(c: Ctx, id: string, cmd: string, opts: { stdin?: string; timeoutSeconds?: number; what: string }): Promise<string> {
  const r = await c.api.exec(id, { cmd, stdin: opts.stdin, timeoutSeconds: opts.timeoutSeconds ?? 180 });
  if (r.exitCode !== 0 || r.timedOut) {
    throw new Error(`${opts.what} failed (exit ${r.timedOut ? "timeout" : r.exitCode}): ${`${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
  }
  return r.stdout;
}

const lastLine = (s: string) => s.trim().split("\n").pop() ?? "";

/** Loopback-only T3, agent env (keys on tmpfs) and secret-free OpenCode/Pi model lists. */
async function setup(c: Ctx, id: string): Promise<string> {
  const models: { provider: Config["providers"][number]; ids: string[] }[] = [];
  const skipped: string[] = [];
  for (const p of c.cfg.providers) {
    const key = c.secrets[p.keyEnv];
    if (!key) continue;
    try {
      models.push({ provider: p, ids: await fetchModelIds(p, key) });
    } catch (e) {
      skipped.push(`${p.id}(${(e as Error).message.replace(/^[^:]*: /, "")})`);
    }
  }
  const env = renderEnvFile(buildAgentEnv(c.secrets, c.cfg.providers, c.cfg.claudeVia, BOX_OPENCODE_CONFIG));
  const stdin = JSON.stringify({ env, opencode: models.length ? opencodeConfig(models) : "", pi: models.length ? piModels(models) : "" });
  const out = lastLine(await run(c, id, setupScript(), { stdin, what: "box setup" }));
  return `${out} providers=${models.map((m) => `${m.provider.id}:${m.ids.length}`).join(",") || "none"}${skipped.length ? ` skipped=${skipped.join(",")}` : ""}`;
}

function listeningLocal(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(true));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(false)));
  });
}

async function register(c: Ctx, m: Machine): Promise<BoxRecord> {
  const state = loadState(c.dir);
  const existing = state.boxes[m.id];
  if (existing) return existing;
  const busyServe = c.cfg.tailscaleServe ? new Set(serveStatus().keys()) : new Set<number>();
  const busyLocal = new Set<number>();
  for (let p = c.cfg.localPortRange[0]; p <= c.cfg.localPortRange[1]; p++) if (await listeningLocal(p)) busyLocal.add(p);
  const ports = allocatePorts(state, c.cfg, busyServe, busyLocal);
  const rec: BoxRecord = { id: m.id, name: m.name, ...ports };
  state.boxes[m.id] = rec;
  saveState(state, c.dir);
  return rec;
}

function route(c: Ctx, b: BoxRecord): string {
  if (!c.cfg.tailscaleServe) return `http://127.0.0.1:${b.localPort}/`;
  ensureServe(b.servePort, b.localPort);
  return hubBaseUrl(hubDnsName(undefined, c.cfg.hubHost), b.servePort);
}

async function cmdCreate(c: Ctx, args: string[]) {
  const name = args[0];
  if (!name || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error("name: 1-63 of a-z, 0-9 and -");
  const snapshotId = argValue(args, "--snapshot") ?? c.cfg.snapshotId;
  const op = await c.api.createMachine(
    {
      name,
      ...(snapshotId ? { snapshotId } : { templateId: c.cfg.template }),
      ...(c.cfg.vcpus ? { vcpus: c.cfg.vcpus } : {}),
      ...(c.cfg.memMiB ? { memMiB: c.cfg.memMiB } : {}),
      autoSuspendAfterSeconds: c.cfg.autoSuspendAfterSeconds,
      metadata: { [OWNER_LABEL]: "1" },
    },
    `t3ih-create-${name}`,
  );
  if (!op.machineId) throw new Error("create returned no machine id");
  err(`creating ${name}…`);
  await c.api.waitOperation(op.id);
  const m = await c.api.waitRunning(op.machineId);
  const b = await register(c, m);
  err(lastLine(await setup(c, m.id)));
  err(`route: ${route(c, b)} (forwarded by \`t3ih watch\`); pair with: t3ih pair ${name}`);
}

async function cmdAdopt(c: Ctx, args: string[]) {
  const m = await c.api.getMachine(args[0] ?? "");
  const b = await register(c, m);
  if (m.metadata?.[OWNER_LABEL] !== "1") err("note: box lacks the t3-instabox-helper label; it is managed from this hub's state only");
  if (isRunning(m)) err(await setup(c, m.id));
  err(`adopted ${b.name}: hub port ${b.localPort}${c.cfg.tailscaleServe ? `, tailnet port ${b.servePort}` : ""}`);
}

async function cmdList(c: Ctx) {
  const state = loadState(c.dir);
  const rows: string[] = [];
  for (const b of Object.values(state.boxes)) {
    const m = await c.api.findMachine(b.id);
    const tunnel = (await portOpen(b.localPort)) ? "up" : "down";
    rows.push(`${b.name.padEnd(24)} ${(m?.state ?? "gone").padEnd(10)} tunnel=${tunnel} hub=127.0.0.1:${b.localPort}${c.cfg.tailscaleServe ? ` tailnet=:${b.servePort}` : ""}`);
  }
  process.stdout.write(rows.length ? `${rows.join("\n")}\n` : "no boxes (t3ih create <name>)\n");
}

/** Make sure the box runs: resume a paused one (the user asked for it), wait until ready. */
async function ensureAwake(c: Ctx, b: BoxRecord): Promise<Machine> {
  const m = await c.api.getMachine(b.id);
  if (isRunning(m)) return m;
  if (m.state === "suspended" || m.state === "stopped") {
    err(`${b.name} is ${m.state}; ${m.state === "stopped" ? "starting" : "resuming"}…`);
    await c.api.waitOperation((await c.api.lifecycle(b.id, m.state === "stopped" ? "start" : "resume")).id);
  }
  return c.api.waitRunning(b.id);
}

async function cmdPair(c: Ctx, args: string[]) {
  const b = box(c, args[0]);
  await ensureAwake(c, b);
  const baseUrl = route(c, b);
  if (!(await portOpen(b.localPort))) err(`warning: no tunnel on hub port ${b.localPort} yet; is \`t3ih watch\` running? The link works once it is.`);
  const ttl = argValue(args, "--ttl") ?? c.cfg.pairTtl;
  const out = await run(c, b.id, pairScript({ ttl, label: `t3ih ${b.name}`, baseUrl }), { what: "t3 pairing", timeoutSeconds: 60 });
  const { pairUrl, expiresAt } = JSON.parse(lastLine(out)) as { pairUrl: string; expiresAt: string };
  // The link is a password: stdout only (the user's terminal), never a log line.
  err(`one-time pairing link for ${b.name} (expires ${expiresAt}); paste it into T3 Code → Add environment:`);
  process.stdout.write(`${pairUrl}\n`);
}

async function cmdLifecycle(c: Ctx, action: string, args: string[]) {
  const b = box(c, args[0]);
  if (action === "wake") {
    const m = await c.api.wake(b.id);
    err(`${b.name}: ${m.state}${m.state !== "running" ? " (wake never undoes a manual pause: use t3ih resume)" : ""}`);
    return;
  }
  if (action === "resume") {
    await ensureAwake(c, b);
    err(`${b.name}: running`);
    return;
  }
  await c.api.waitOperation((await c.api.lifecycle(b.id, action as "suspend" | "stop")).id);
  err(`${b.name}: ${action === "stop" ? "stopped" : "suspended"}`);
}

async function cmdDelete(c: Ctx, args: string[]) {
  const b = box(c, args[0]);
  if (!args.includes("--yes")) throw new Error(`deleting ${b.name} removes its disk; add --yes`);
  if (c.cfg.tailscaleServe) removeServe(b.servePort, b.localPort);
  new TunnelManager(c.dir, err).forget(b.id);
  const m = await c.api.findMachine(b.id);
  if (m) {
    const op = await c.api.deleteMachine(b.id);
    if (op?.id) await c.api.waitOperation(op.id);
  }
  const state = loadState(c.dir);
  delete state.boxes[b.id];
  saveState(state, c.dir);
  err(`${b.name}: deleted`);
}

async function cmdLogin(c: Ctx, sub: string, args: string[]) {
  const b = box(c, args[0]);
  const agent = args[1] ?? "";
  if (!LOGINS[agent]) throw new Error(`agent: one of ${Object.keys(LOGINS).join(", ")}`);
  if (sub === "login-cancel") return err(lastLine(await run(c, b.id, loginCancelScript(agent), { what: "login cancel" })));
  if (sub === "login-code") {
    const code = (await readStdin()).trim();
    if (!code) throw new Error("pipe or type the code on stdin");
    err(lastLine(await run(c, b.id, loginCodeScript(agent), { stdin: `${code}\n`, what: "login code" })));
  } else if (sub === "login") {
    await ensureAwake(c, b);
    await run(c, b.id, loginStartScript(agent, args.includes("--console")), { what: "login start" });
  }
  // URL and one-time code go to the user's terminal only.
  const out = await run(c, b.id, loginStatusScript(agent), { what: "login status" });
  process.stdout.write(out);
  if (lastLine(out) === "login=running") {
    err(agent === "claude"
      ? `open the link, sign in, then: t3ih login-code ${b.name} claude  (paste the code shown); check with t3ih login-status ${b.name} claude`
      : `open the link and enter the code; check with t3ih login-status ${b.name} ${agent}`);
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) err("code: ");
  let s = "";
  for await (const chunk of process.stdin) {
    s += chunk;
    if (s.includes("\n")) break;
  }
  return s;
}

async function cmdWatch(c: Ctx) {
  const log = (m: string) => process.stdout.write(`${new Date().toISOString()} ${m}\n`);
  const tunnels = new TunnelManager(c.dir, log);
  const stop = () => (tunnels.stopAll(), process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  log(`watching ${Object.keys(loadState(c.dir).boxes).length} box(es), every ${c.cfg.pollSeconds} s`);
  for (;;) {
    for (const b of Object.values(loadState(c.dir).boxes)) {
      try {
        const m = await c.api.findMachine(b.id);
        const action = plan(m, tunnels.healthy(b.id));
        if (action === "forget") {
          tunnels.forget(b.id);
          if (c.cfg.tailscaleServe) removeServe(b.servePort, b.localPort);
          const s = loadState(c.dir);
          delete s.boxes[b.id];
          saveState(s, c.dir);
          log(`${b.name}: gone from InstaBox; route removed`);
        } else if (action === "close" && tunnels.ids().includes(b.id)) {
          tunnels.stop(b.id);
          log(`${b.name}: ${m?.state}; tunnel closed`);
        } else if (action === "open") {
          const reopened = tunnels.ids().includes(b.id);
          if (!reopened) {
            // Coming back from a pause or stop (or first sight): fresh connections, env, loopback check.
            log(`${b.name}: ${lastLine(await run(c, b.id, staleConnectionsScript(), { what: "stale connections" }))}`);
            log(`${b.name}: ${await setup(c, b.id)}`);
          }
          await tunnels.open(c.api, b.id, b.localPort);
          if (c.cfg.tailscaleServe) ensureServe(b.servePort, b.localPort);
          log(`${b.name}: tunnel up on hub port ${b.localPort}${reopened ? " (renewed)" : ""}`);
        }
      } catch (e) {
        log(`${b.name}: ${(e as Error).message}`);
      }
    }
    await new Promise((r) => setTimeout(r, c.cfg.pollSeconds * 1000));
  }
}

export async function main(argv: string[]) {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return void process.stdout.write(`${USAGE}\n`);
  const c = ctx();
  switch (cmd) {
    case "create": return cmdCreate(c, args);
    case "adopt": return cmdAdopt(c, args);
    case "list": return cmdList(c);
    case "setup": return void err(await setup(c, (await ensureAwake(c, box(c, args[0]))).id));
    case "pair": return cmdPair(c, args);
    case "wake": case "resume": case "suspend": case "stop": return cmdLifecycle(c, cmd, args);
    case "delete": return cmdDelete(c, args);
    case "login": case "login-code": case "login-status": case "login-cancel": return cmdLogin(c, cmd, args);
    case "install-agents": return void process.stdout.write(await run(c, box(c, args[0]).id, installAgentsScript(), { what: "install agents", timeoutSeconds: 600 }));
    case "watch": return cmdWatch(c);
    default: throw new Error(`unknown command ${cmd}\n\n${USAGE}`);
  }
}
