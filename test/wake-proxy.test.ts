import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import { connect, createServer } from "node:net";
import { test } from "node:test";
import { classify, WakeProxy } from "../src/wake-proxy.ts";

const DESCRIPTOR = JSON.stringify({ environmentId: "env-1", label: "box" });

test("classify: only a plain descriptor GET/HEAD is a probe", () => {
  assert.equal(classify("GET /.well-known/t3/environment HTTP/1.1\r\nHost: h\r\n\r\n"), "probe");
  assert.equal(classify("HEAD /.well-known/t3/environment?x=1 HTTP/1.1\r\n\r\n"), "probe");
  assert.equal(classify("GET /ws?ticket=t HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"), "use");
  assert.equal(classify("GET /.well-known/t3/environment HTTP/1.1\r\nUpgrade: websocket\r\n\r\n"), "use");
  assert.equal(classify("POST /.well-known/t3/environment HTTP/1.1\r\n\r\n"), "use");
  assert.equal(classify("POST /api/auth/websocket-ticket HTTP/1.1\r\n\r\n"), "use");
  assert.equal(classify("GET /.well-known/t3/environment/../x HTTP/1.1\r\n\r\n"), "use");
  assert.equal(classify("GET / HTTP/1.1\r\n\r\n"), "use");
});

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });

/** Raw request over TCP; resolves to the whole response once the server closes. */
function raw(port: number, req: string, endAfterMs = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = connect(port, "127.0.0.1", () => c.write(req));
    let out = "";
    c.on("data", (d) => {
      out += d;
      if (endAfterMs) setTimeout(() => c.destroy(), endAfterMs);
    });
    c.on("close", () => resolve(out));
    c.on("error", reject);
  });
}

async function setup(opts: { upstreamUp?: boolean; descriptor?: string | null; wakeFails?: boolean } = {}) {
  const seen: string[] = [];
  const upstream = createHttpServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader("Connection", "close");
    res.end(req.url === "/.well-known/t3/environment" ? DESCRIPTOR : "from-box");
  });
  const upPort = await listen(upstream);
  let up = opts.upstreamUp ? upPort : null;
  let wakes = 0;
  const port = await freePort();
  const proxy = new WakeProxy({
    port,
    upstream: () => up,
    wake: async () => {
      wakes++;
      await new Promise((r) => setTimeout(r, 50));
      if (opts.wakeFails) throw new Error("resume failed");
      up = upPort;
      return upPort;
    },
    descriptor: () => (opts.descriptor === undefined ? DESCRIPTOR : opts.descriptor),
    log: () => {},
    wakeTimeoutMs: 2000,
  });
  await proxy.listen();
  return {
    port,
    seen,
    wakes: () => wakes,
    close: async () => {
      await proxy.close();
      upstream.closeAllConnections();
      upstream.close();
    },
  };
}

test("paused box: route probes are answered from the cache without waking it", async () => {
  const t = await setup();
  const res = await raw(t.port, "GET /.well-known/t3/environment HTTP/1.1\r\nHost: h\r\n\r\n");
  assert.match(res, /^HTTP\/1\.1 200 /);
  assert.ok(res.endsWith(DESCRIPTOR));
  assert.match(res, /Cache-Control: no-store/);
  assert.equal(t.wakes(), 0);
  assert.deepEqual(t.seen, []);
  await t.close();
});

test("paused box with no cached descriptor: probe gets 503, still no wake", async () => {
  const t = await setup({ descriptor: null });
  assert.match(await raw(t.port, "GET /.well-known/t3/environment HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 503 /);
  assert.equal(t.wakes(), 0);
  await t.close();
});

test("paused box: a session request wakes it and is delivered intact, split across packets", async () => {
  const t = await setup();
  const res = await new Promise<string>((resolve) => {
    const c = connect(t.port, "127.0.0.1", () => {
      c.write("POST /api/auth/websocket-ticket HTTP/1.1\r\nHost: h\r\n");
      setTimeout(() => c.write("Content-Length: 2\r\n\r\n{}"), 30);
    });
    let out = "";
    c.on("data", (d) => (out += d));
    c.on("close", () => resolve(out));
  });
  assert.match(res, /^HTTP\/1\.1 200 /);
  assert.ok(res.endsWith("from-box"));
  assert.equal(t.wakes(), 1);
  assert.deepEqual(t.seen, ["POST /api/auth/websocket-ticket"]);
  await t.close();
});

test("running box: connections are piped without waking", async () => {
  const t = await setup({ upstreamUp: true });
  assert.ok((await raw(t.port, "GET /anything HTTP/1.1\r\nHost: h\r\n\r\n")).endsWith("from-box"));
  assert.equal(t.wakes(), 0);
  await t.close();
});

test("wake failure answers 503 instead of hanging", async () => {
  const t = await setup({ wakeFails: true });
  assert.match(await raw(t.port, "GET /ws HTTP/1.1\r\nUpgrade: websocket\r\n\r\n"), /^HTTP\/1\.1 503 /);
  assert.equal(t.wakes(), 1);
  await t.close();
});
