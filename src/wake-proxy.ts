// The box's stable hub port (what `tailscale serve` points at) is owned by this
// proxy, not by ssh. While the box's tunnel is up, connections are piped to the
// tunnel untouched. While it is down (box paused or stopped), the proxy reads
// the first HTTP request head and:
//   - a route probe (GET /.well-known/t3/environment, the public descriptor T3
//     clients fetch to check a route) is answered from the hub's cached copy,
//     without waking the box;
//   - anything else (WebSocket upgrade, auth, any other request: a client that
//     wants a session) wakes the box, waits for the tunnel, and is piped through.
import { connect, createServer, type Server, type Socket } from "node:net";

export const DESCRIPTOR_PATH = "/.well-known/t3/environment";
const MAX_HEAD_BYTES = 16 * 1024;

export type Classification = "probe" | "use";

/** Classify one HTTP request head. Only an exact descriptor GET/HEAD is a probe. */
export function classify(head: string): Classification {
  const [method, target] = head.split("\r\n", 1)[0].split(" ");
  const path = (target ?? "").split("?", 1)[0];
  if ((method === "GET" || method === "HEAD") && path === DESCRIPTOR_PATH && !/^upgrade:/im.test(head)) return "probe";
  return "use";
}

/** The probe answer: the cached descriptor, or 503 when the hub has none yet. */
export function probeResponse(head: string, descriptor: string | null): string {
  const isHead = head.startsWith("HEAD ");
  if (!descriptor) return response(503, "text/plain; charset=utf-8", "box is not running\n", isHead);
  return response(200, "application/json", descriptor, isHead);
}

export function response(status: number, type: string, body: string, headOnly = false): string {
  const reason: Record<number, string> = { 200: "OK", 400: "Bad Request", 503: "Service Unavailable" };
  return [
    `HTTP/1.1 ${status} ${reason[status] ?? ""}`,
    `Content-Type: ${type}`,
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Cache-Control: no-store",
    "Access-Control-Allow-Origin: *",
    "Connection: close",
    "",
    headOnly ? "" : body,
  ].join("\r\n");
}

export interface WakeProxyOptions {
  /** Stable hub loopback port for this box. */
  port: number;
  /** The tunnel's port when it is up, else null. */
  upstream: () => number | null;
  /** Wake the box and bring the tunnel up; resolves to the tunnel's port. Shared by concurrent callers. */
  wake: () => Promise<number>;
  /** Cached descriptor JSON, or null. */
  descriptor: () => string | null;
  log: (m: string) => void;
  /** How long a session attempt may wait for the box (the T3 client gives up on its own after ~15 s and retries). */
  wakeTimeoutMs?: number;
  headTimeoutMs?: number;
}

export class WakeProxy {
  private readonly o: WakeProxyOptions;
  private server: Server | null = null;

  constructor(o: WakeProxyOptions) {
    this.o = o;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = createServer((c) => this.handle(c));
      s.once("error", reject);
      s.listen(this.o.port, "127.0.0.1", () => {
        s.off("error", reject);
        s.on("error", (e) => this.o.log(`proxy :${this.o.port}: ${e.message}`));
        this.server = s;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private handle(client: Socket) {
    client.on("error", () => client.destroy());
    const up = this.o.upstream();
    if (up !== null) return pipe(client, up, Buffer.alloc(0));
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => client.destroy(), this.o.headTimeoutMs ?? 10_000);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0 && buf.length < MAX_HEAD_BYTES) return;
      client.off("data", onData);
      client.pause();
      clearTimeout(timer);
      if (end < 0) return void client.end(response(400, "text/plain", "request head too large\n"));
      const head = buf.subarray(0, end + 4).toString("latin1");
      if (classify(head) === "probe") return void client.end(probeResponse(head, this.o.descriptor()));
      void this.wakeThenPipe(client, buf);
    };
    client.on("data", onData);
  }

  private async wakeThenPipe(client: Socket, buffered: Buffer) {
    const started = Date.now();
    try {
      const port = await withTimeout(this.o.wake(), this.o.wakeTimeoutMs ?? 60_000);
      if (client.destroyed) return;
      this.o.log(`proxy :${this.o.port}: woke box for a session in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      pipe(client, port, buffered);
    } catch (e) {
      this.o.log(`proxy :${this.o.port}: wake failed: ${(e as Error).message}`);
      if (!client.destroyed) client.end(response(503, "text/plain; charset=utf-8", "box is waking or unavailable; retry\n"));
    }
  }
}

function pipe(client: Socket, port: number, buffered: Buffer) {
  const up = connect(port, "127.0.0.1");
  const done = () => (client.destroy(), up.destroy());
  up.on("error", done);
  client.on("error", done);
  up.on("connect", () => {
    if (buffered.length) up.write(buffered);
    client.pipe(up).pipe(client);
    client.resume();
  });
  up.on("close", () => client.destroy());
  client.on("close", () => up.destroy());
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`box not ready within ${ms / 1000} s`)), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}
