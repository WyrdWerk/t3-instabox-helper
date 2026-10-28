// Hub-side config and state, under $T3IH_HOME (default ~/.config/t3-instabox-helper):
//   config.json   non-secret settings (template, snapshot, port ranges, providers)
//   secrets.env   0600, KEY=value: INSTABOX_API_KEY and provider keys
//   state.json    per box: InstaBox id, hub loopback port, tailscale serve port
//   ssh/          the hub's SSH key and per-box certificates
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Provider, parseEnvFile, parseProviders } from "./providers.ts";

export interface Config {
  /** InstaBox template; `t3` ships T3 Code, Claude Code and Codex. */
  template: string;
  /** Create boxes from this snapshot instead (build it login-free; see README). */
  snapshotId?: string;
  vcpus?: number;
  memMiB?: number;
  /** Idle pause, seconds (InstaBox snaps it to its allowed choices). */
  autoSuspendAfterSeconds: number;
  /** Hub loopback ports for ssh -L, [first, last]. Must not include the hub's own T3 port. */
  localPortRange: [number, number];
  /** Hub tailnet HTTPS ports for `tailscale serve`, [first, last]. Keep 443 for the hub's own T3. */
  servePortRange: [number, number];
  /** Publish each box on the tailnet with `tailscale serve`. false: loopback only (tests, or SSH-forward to the hub yourself). */
  tailscaleServe: boolean;
  /** Hub MagicDNS name; default: from `tailscale status --json`. */
  hubHost?: string;
  /** Pairing link lifetime (t3 syntax: 5m, 1h). */
  pairTtl: string;
  providers: Provider[];
  /** Provider id whose Anthropic endpoint Claude Code uses, or "none" (Claude's own login). */
  claudeVia: string;
  /** Seconds between API polls in `watch`. */
  pollSeconds: number;
}

export interface BoxRecord {
  id: string;
  name: string;
  localPort: number;
  servePort: number;
}

export interface State {
  boxes: Record<string, BoxRecord>;
}

export const DEFAULTS: Config = {
  template: "t3",
  autoSuspendAfterSeconds: 1800,
  localPortRange: [47301, 47399],
  servePortRange: [8301, 8399],
  tailscaleServe: true,
  pairTtl: "10m",
  providers: parseProviders(undefined),
  claudeVia: "none",
  pollSeconds: 30,
};

export const home = () => process.env.T3IH_HOME || join(homedir(), ".config", "t3-instabox-helper");

export function ensureHome(dir = home()): string {
  mkdirSync(join(dir, "ssh"), { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export function loadConfig(dir = home()): Config {
  const f = join(dir, "config.json");
  const raw = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Partial<Config> & { providers?: unknown }) : {};
  const c: Config = { ...DEFAULTS, ...raw, providers: parseProviders(raw.providers) };
  checkRange(c.localPortRange, "localPortRange");
  checkRange(c.servePortRange, "servePortRange");
  return c;
}

function checkRange(r: unknown, what: string) {
  if (!Array.isArray(r) || r.length !== 2 || !r.every((n) => Number.isInteger(n) && n > 0 && n < 65536) || r[0] > r[1]) throw new Error(`${what}: [first, last] ports`);
}

/** secrets.env merged under the process env for INSTABOX_API_KEY. Refuses a group/world-readable file. */
export function loadSecrets(dir = home()): Record<string, string> {
  const f = join(dir, "secrets.env");
  let secrets: Record<string, string> = {};
  if (existsSync(f)) {
    if ((statSync(f).mode & 0o077) !== 0) throw new Error(`${f} must be private: chmod 600 ${f}`);
    secrets = parseEnvFile(readFileSync(f, "utf8"));
  }
  if (process.env.INSTABOX_API_KEY) secrets.INSTABOX_API_KEY = process.env.INSTABOX_API_KEY;
  return secrets;
}

export function loadState(dir = home()): State {
  const f = join(dir, "state.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as State) : { boxes: {} };
}

export function saveState(s: State, dir = home()) {
  const f = join(dir, "state.json");
  writeFileSync(`${f}.tmp`, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${f}.tmp`, f);
}

/**
 * Lowest free pair of ports for a new box: not used by another box, not in
 * `busyServe` (ports `tailscale serve` already uses: the hub's own T3, other
 * apps) and not `busyLocal` (listening on the hub).
 */
export function allocatePorts(state: State, cfg: Config, busyServe: Set<number>, busyLocal: Set<number>): { localPort: number; servePort: number } {
  const usedLocal = new Set(Object.values(state.boxes).map((b) => b.localPort));
  const usedServe = new Set(Object.values(state.boxes).map((b) => b.servePort));
  const pick = (r: [number, number], used: Set<number>, busy: Set<number>, what: string) => {
    for (let p = r[0]; p <= r[1]; p++) if (!used.has(p) && !busy.has(p)) return p;
    throw new Error(`no free port left in ${what} [${r[0]}, ${r[1]}]`);
  };
  return { localPort: pick(cfg.localPortRange, usedLocal, busyLocal, "localPortRange"), servePort: pick(cfg.servePortRange, usedServe, busyServe, "servePortRange") };
}

/** A box by name or InstaBox id. */
export function findBox(state: State, ref: string): BoxRecord | undefined {
  return state.boxes[ref] ?? Object.values(state.boxes).find((b) => b.name === ref);
}
