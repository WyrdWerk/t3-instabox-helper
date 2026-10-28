// The hub's tailnet-only route per box: `tailscale serve` (never Funnel) maps
// https://<hub>.<tailnet>.ts.net:<servePort>/ to the box's ssh -L port on the
// hub's loopback. Boxes never run Tailscale.
import { spawnSync } from "node:child_process";

export type Run = (args: string[]) => { status: number | null; stdout: string; stderr: string };

export const runTailscale: Run = (args) => {
  const r = spawnSync("tailscale", args, { encoding: "utf8", timeout: 30_000 });
  if (r.error) throw new Error(`tailscale ${args[0]}: ${r.error.message} (is Tailscale installed on the hub?)`);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** HTTPS port → proxy target, from `tailscale serve status --json`. */
export function parseServeStatus(json: string): Map<number, string> {
  const out = new Map<number, string>();
  if (!json.trim()) return out;
  const s = JSON.parse(json) as { TCP?: Record<string, unknown>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
  for (const port of Object.keys(s.TCP ?? {})) out.set(Number(port), "");
  for (const [hostPort, web] of Object.entries(s.Web ?? {})) {
    const port = Number(hostPort.slice(hostPort.lastIndexOf(":") + 1));
    out.set(port, web.Handlers?.["/"]?.Proxy ?? "");
  }
  return out;
}

export function serveStatus(run: Run = runTailscale): Map<number, string> {
  const r = run(["serve", "status", "--json"]);
  if (r.status !== 0) throw new Error(`tailscale serve status failed: ${r.stderr.trim().slice(0, 200)}`);
  return parseServeStatus(r.stdout);
}

/** The hub's MagicDNS name (no trailing dot). `override` (config hubHost) wins. */
export function hubDnsName(run: Run = runTailscale, override?: string): string {
  if (override) return override.replace(/\.$/, "");
  const r = run(["status", "--json"]);
  if (r.status !== 0) throw new Error(`tailscale status failed: ${r.stderr.trim().slice(0, 200)}`);
  const name = (JSON.parse(r.stdout) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, "");
  if (!name) throw new Error("tailscale status has no MagicDNS name for this machine (enable MagicDNS and HTTPS certificates)");
  return name;
}

export const target = (localPort: number) => `http://127.0.0.1:${localPort}`;

/** Map servePort to the box's local port unless it already is. Refuses a port that serves something else. */
export function ensureServe(servePort: number, localPort: number, run: Run = runTailscale): "added" | "present" {
  const cur = serveStatus(run).get(servePort);
  if (cur === target(localPort)) return "present";
  if (cur !== undefined) throw new Error(`tailscale serve port ${servePort} already serves ${cur || "something else"}; pick another servePortRange`);
  const r = run(["serve", "--bg", `--https=${servePort}`, target(localPort)]);
  if (r.status !== 0) throw new Error(`tailscale serve --https=${servePort} failed: ${r.stderr.trim().slice(0, 300)}`);
  return "added";
}

/** Remove the route, only if it is ours (points at this box's local port). */
export function removeServe(servePort: number, localPort: number, run: Run = runTailscale): boolean {
  if (serveStatus(run).get(servePort) !== target(localPort)) return false;
  const r = run(["serve", `--https=${servePort}`, "off"]);
  if (r.status !== 0) throw new Error(`tailscale serve --https=${servePort} off failed: ${r.stderr.trim().slice(0, 200)}`);
  return true;
}

export const hubBaseUrl = (dnsName: string, servePort: number) => (servePort === 443 ? `https://${dnsName}/` : `https://${dnsName}:${servePort}/`);
