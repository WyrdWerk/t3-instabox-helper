// One supervised `ssh -N -L 127.0.0.1:<localPort>:127.0.0.1:3774` per running box,
// through InstaBox's SSH gateway with a certificate from POST /connections.
// Local forwarding only, so no chisel (bb-plugin-instabox needed it for -R).
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { BOX_T3_PORT } from "./box-scripts.ts";
import type { InstaboxApi, SshConnection } from "./instabox-api.ts";

/** The API allows certificates up to 24 h; renew when less than an hour is left. */
export const CERT_TTL_SECONDS = 24 * 3600;
export const RENEW_BEFORE_MS = 60 * 60_000;

/** ssh argv for one box. Secrets (cert, host) are in files or the destination, never logged. */
export function sshArgs(o: { keyPath: string; certPath: string; knownHostsPath: string; port: number; localPort: number; destination: string }): string[] {
  return [
    "-N",
    "-p", String(o.port),
    "-i", o.keyPath,
    "-o", `CertificateFile=${o.certPath}`,
    "-o", `UserKnownHostsFile=${o.knownHostsPath}`,
    "-o", "StrictHostKeyChecking=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-F", "/dev/null",
    "-L", `127.0.0.1:${o.localPort}:127.0.0.1:${BOX_T3_PORT}`,
    o.destination,
  ];
}

/** known_hosts line trusting the gateway's host CA. */
export const knownHostsLine = (c: Pick<SshConnection, "host" | "port" | "hostTrust">) => `@cert-authority [${c.host}]:${c.port} ${c.hostTrust.publicKey.trim()}\n`;

interface Tunnel {
  ssh: ChildProcess;
  certExpiresAt: number;
  localPort: number;
  stopping: boolean;
}

export class TunnelManager {
  private readonly dir: string;
  private readonly log: (m: string) => void;
  private readonly tunnels = new Map<string, Tunnel>();

  constructor(dir: string, log: (m: string) => void) {
    this.dir = dir;
    this.log = log;
  }

  healthy(id: string): boolean {
    const t = this.tunnels.get(id);
    return !!t && t.ssh.exitCode === null && t.ssh.signalCode === null && t.certExpiresAt - Date.now() > RENEW_BEFORE_MS;
  }

  ids(): string[] {
    return [...this.tunnels.keys()];
  }

  /** Open (or reopen) the forward for a running box. POST /connections would resume an idle-paused box, so only call this for running ones. */
  async open(api: InstaboxApi, id: string, localPort: number): Promise<void> {
    this.stop(id);
    const key = this.keyPair();
    const conn = await api.sshConnection(id, key.publicKey, CERT_TTL_SECONDS);
    const base = join(this.dir, "ssh", id.replace(/[^A-Za-z0-9_-]/g, "_"));
    writePrivate(`${base}-cert.pub`, `${conn.certificate.trim()}\n`);
    writePrivate(`${base}.known_hosts`, knownHostsLine(conn));
    const ssh = spawn("ssh", sshArgs({ keyPath: key.path, certPath: `${base}-cert.pub`, knownHostsPath: `${base}.known_hosts`, port: conn.port, localPort, destination: `${conn.username}@${conn.host}` }), {
      stdio: ["ignore", "ignore", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
    });
    const t: Tunnel = { ssh, certExpiresAt: Date.parse(conn.expiresAt) || Date.now() + CERT_TTL_SECONDS * 1000, localPort, stopping: false };
    this.tunnels.set(id, t);
    let tail = "";
    ssh.stderr?.on("data", (d: Buffer) => (tail = (tail + d.toString()).slice(-400)));
    ssh.on("exit", (code, sig) => {
      // Gateway host names and IPs stay out of the log.
      if (!t.stopping) this.log(`tunnel ${id}: ssh exited (${sig ?? code}): ${tail.trim().split("\n").pop()?.replace(/\d+\.\d+\.\d+\.\d+|\[[^\]]+\]|\S+\.\S+\.\S+/g, "<host>") ?? ""}`);
    });
    await waitForPort(localPort, 20_000);
  }

  stop(id: string): void {
    const t = this.tunnels.get(id);
    if (!t) return;
    t.stopping = true;
    t.ssh.kill("SIGTERM");
    this.tunnels.delete(id);
  }

  stopAll() {
    for (const id of this.ids()) this.stop(id);
  }

  forget(id: string) {
    this.stop(id);
    const base = join(this.dir, "ssh", id.replace(/[^A-Za-z0-9_-]/g, "_"));
    rmSync(`${base}-cert.pub`, { force: true });
    rmSync(`${base}.known_hosts`, { force: true });
  }

  /** One Ed25519 key for this hub; certificates are per box. */
  private keyPair(): { path: string; publicKey: string } {
    const path = join(this.dir, "ssh", "id_ed25519");
    if (!existsSync(path) || !existsSync(`${path}.pub`)) {
      rmSync(path, { force: true });
      rmSync(`${path}.pub`, { force: true });
      const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "t3-instabox-helper", "-f", path], { stdio: "ignore" });
      if (r.status !== 0) throw new Error("ssh-keygen failed (is OpenSSH installed on the hub?)");
    }
    return { path, publicKey: readFileSync(`${path}.pub`, "utf8").trim() };
  }
}

function writePrivate(path: string, content: string) {
  writeFileSync(`${path}.tmp`, content, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const c = connect(port, "127.0.0.1");
    c.once("connect", () => (c.destroy(), resolve(true)));
    c.once("error", () => resolve(false));
  });
}

async function waitForPort(port: number, maxMs: number): Promise<void> {
  const until = Date.now() + maxMs;
  while (!(await portOpen(port))) {
    if (Date.now() > until) throw new Error(`ssh forward on 127.0.0.1:${port} did not open within ${maxMs / 1000} s`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
