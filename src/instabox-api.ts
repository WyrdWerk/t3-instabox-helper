// Minimal InstaBox REST client (https://api.instabox.sh/v1/openapi.json), adapted
// from WyrdWerk/bb-plugin-instabox. Only the calls this helper needs. The API key
// goes in X-API-Key and is never logged.

export const DEFAULT_API_URL = "https://api.instabox.sh";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface Machine {
  id: string;
  name: string;
  state: string;
  operationId: string | null;
  runtime?: { ready?: boolean; processesPreserved?: boolean };
  metadata?: Record<string, string>;
  template?: { id?: string; version?: string };
  autoSuspendAfterSeconds?: number | null;
}

export interface Operation {
  id: string;
  machineId: string | null;
  type: string;
  state: string;
  error: { code?: string; message?: string } | null;
}

/** POST /connections answer: the gateway and a short-lived user certificate. All secret. */
export interface SshConnection {
  host: string;
  port: number;
  username: string;
  certificate: string;
  expiresAt: string;
  hostTrust: { type: string; publicKey: string };
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

export class InstaboxApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  constructor(status: number, code: string, message: string, retryable: boolean) {
    super(`InstaBox API ${status} ${code}: ${message}`);
    this.name = "InstaboxApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export const isNotFound = (err: unknown) => err instanceof InstaboxApiError && err.status === 404;
export const isRunning = (m: Machine) => m.state === "running" && m.runtime?.ready !== false;

/** Metadata label on every machine this helper creates; list and act only on these. */
export const OWNER_LABEL = "t3-instabox-helper";

export class InstaboxApi {
  private readonly apiKey: string;
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(apiKey: string, fetchImpl: FetchLike = fetch, baseUrl = DEFAULT_API_URL, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
    if (!apiKey) throw new Error("INSTABOX_API_KEY is not set");
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.sleep = sleep;
  }

  /**
   * One call. Only 429 / `retryable` errors are retried (bounded): InstaBox refuses
   * those before running them. Mutations that take an Idempotency-Key always carry
   * one, so a retry is a replay. `exec` and `wake` take none (`noIdempotencyKey`).
   */
  async request<T>(method: string, path: string, body?: unknown, opts: { idempotencyKey?: string; noIdempotencyKey?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const headers: Record<string, string> = { "X-API-Key": this.apiKey, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && !opts.noIdempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey ?? `t3ih-${crypto.randomUUID()}`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: opts.signal,
      });
      const text = await res.text();
      const json = text ? safeJson(text) : null;
      if (res.ok) return json as T;
      const e = (json as { error?: { code?: string; message?: string; retryable?: boolean } } | null)?.error;
      const err = new InstaboxApiError(res.status, e?.code ?? "http_error", e?.message ?? text.slice(0, 200), e?.retryable ?? res.status === 429);
      if (err.retryable && attempt < 5) {
        await this.sleep(2000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }

  getMachine(id: string, signal?: AbortSignal) {
    return this.request<Machine>("GET", `/v1/machines/${enc(id)}`, undefined, { signal });
  }

  /** null when the machine does not exist. */
  async findMachine(id: string, signal?: AbortSignal): Promise<Machine | null> {
    try {
      return await this.getMachine(id, signal);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Machines carrying every metadata pair (server filter, checked again locally). */
  async listMachines(metadata: Record<string, string>, signal?: AbortSignal): Promise<Machine[]> {
    const q = Object.entries(metadata).map(([k, v]) => `metadata=${encodeURIComponent(`${k}:${v}`)}`).join("&");
    const out: Machine[] = [];
    let cursor: string | null = null;
    do {
      const page: { machines: Machine[]; nextCursor: string | null } = await this.request("GET", `/v1/machines?limit=100&${q}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, { signal });
      out.push(...page.machines);
      cursor = page.nextCursor;
    } while (cursor);
    return out.filter((m) => Object.entries(metadata).every(([k, v]) => m.metadata?.[k] === v));
  }

  /** 202: an operation whose `machineId` is the new machine. */
  createMachine(
    body: { name: string; templateId?: string; snapshotId?: string; vcpus?: number; memMiB?: number; autoSuspendAfterSeconds?: number; metadata: Record<string, string> },
    idempotencyKey: string,
    signal?: AbortSignal,
  ) {
    return this.request<Operation>("POST", "/v1/machines", body, { idempotencyKey, signal });
  }

  lifecycle(id: string, action: "start" | "stop" | "suspend" | "resume", signal?: AbortSignal) {
    return this.request<Operation>("POST", `/v1/machines/${enc(id)}/${action}`, {}, { signal });
  }

  /** Records activity on a running machine; resumes an idle-paused one (waits ≤45 s). Never undoes a manual pause. */
  wake(id: string, signal?: AbortSignal) {
    return this.request<Machine>("POST", `/v1/machines/${enc(id)}/wake`, {}, { noIdempotencyKey: true, signal });
  }

  deleteMachine(id: string, signal?: AbortSignal) {
    return this.request<Operation | null>("DELETE", `/v1/machines/${enc(id)}`, undefined, { signal });
  }

  /** Long-polls (≤25 s per call) until the operation settles. */
  async waitOperation(opId: string, maxMs = 10 * 60_000, signal?: AbortSignal): Promise<Operation> {
    const until = Date.now() + maxMs;
    for (;;) {
      const op = await this.request<Operation>("GET", `/v1/operations/${enc(opId)}?wait=25s`, undefined, { signal });
      if (op.state === "succeeded") return op;
      if (op.state === "failed") throw new Error(`InstaBox ${op.type} failed: ${op.error?.code ?? ""} ${op.error?.message ?? ""}`.trim());
      if (Date.now() > until) throw new Error(`InstaBox ${op.type} did not finish in time`);
    }
  }

  /** Waits for state=running and runtime.ready. */
  async waitRunning(id: string, maxMs = 5 * 60_000, signal?: AbortSignal): Promise<Machine> {
    const until = Date.now() + maxMs;
    for (;;) {
      const m = await this.getMachine(id, signal);
      if (isRunning(m)) return m;
      if (m.state === "error" || m.state === "deleted") throw new Error(`machine is ${m.state}`);
      if (Date.now() > until) throw new Error(`machine did not become ready (state ${m.state})`);
      await this.sleep(3000);
    }
  }

  /** Runs `bash -lc <cmd>` as the machine user; output only at exit; ≤600 s; stdin ≤1 MiB. Wakes an idle-paused machine. Not idempotent. */
  exec(id: string, req: { cmd: string; stdin?: string; timeoutSeconds: number }, signal?: AbortSignal) {
    return this.request<ExecResult>("POST", `/v1/machines/${enc(id)}/exec`, req, { noIdempotencyKey: true, signal });
  }

  sshConnection(id: string, publicKey: string, ttlSeconds: number, signal?: AbortSignal) {
    return this.request<SshConnection>("POST", `/v1/machines/${enc(id)}/connections`, { publicKey, ttlSeconds }, { signal });
  }
}

function enc(s: string) {
  return encodeURIComponent(s);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: "bad_json", message: text.slice(0, 200) } };
  }
}
