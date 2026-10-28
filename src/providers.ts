// API-key providers for the agents T3 Code runs on a box. Keys live only on the
// hub (secrets.env) and in a root-only tmpfs file on the box (/run). Config files
// written to the box name the env var, never the value.

/** An OpenAI-compatible endpoint OpenCode and Pi can use. */
export interface Provider {
  id: string;
  name: string;
  /** OpenAI-compatible base URL (GET <baseURL>/models lists the models). */
  baseURL: string;
  /** Env var holding the key, on the hub (secrets.env) and in T3's env on the box. */
  keyEnv: string;
  /** Anthropic-compatible base URL, when Claude Code can use this provider. */
  anthropicBaseURL?: string;
}

export const DEFAULT_PROVIDERS: Provider[] = [
  { id: "zai-coding-plan", name: "Z.AI Coding Plan", baseURL: "https://api.z.ai/api/coding/paas/v4", keyEnv: "ZAI_API_KEY", anthropicBaseURL: "https://api.z.ai/api/anthropic" },
  { id: "zro", name: "ZRO", baseURL: "https://zro.moonmath.ai/v1", keyEnv: "ZRO_API_KEY" },
  { id: "coralbricks", name: "Coral Bricks", baseURL: "https://inference.coralbricks.ai/v1", keyEnv: "CORALBRICKS_API_KEY" },
  { id: "neuralwatt", name: "Neuralwatt", baseURL: "https://api.neuralwatt.com/v1", keyEnv: "NEURALWATT_API_KEY" },
  { id: "minimax", name: "MiniMax", baseURL: "https://api.minimax.io/v1", keyEnv: "MINIMAX_API_KEY", anthropicBaseURL: "https://api.minimax.io/anthropic" },
];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Never forwarded to a box: the hub's own credentials. */
const HUB_ONLY = new Set(["INSTABOX_API_KEY", "INSTABOX_API_KEY_WYRD1", "T3IH_INSTABOX_API_KEY"]);

/** Parse and check a providers list from config.json. Missing: the defaults. */
export function parseProviders(v: unknown): Provider[] {
  if (v === undefined || v === null) return DEFAULT_PROVIDERS;
  if (!Array.isArray(v)) throw new Error("providers must be an array");
  return v.map((x, i) => {
    const p = x as Partial<Provider>;
    if (typeof p.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(p.id)) throw new Error(`providers[${i}].id: lowercase letters, digits, _ and -`);
    if (typeof p.keyEnv !== "string" || !ENV_NAME.test(p.keyEnv)) throw new Error(`providers[${i}].keyEnv must be an env var name`);
    return {
      id: p.id,
      name: typeof p.name === "string" ? p.name : p.id,
      baseURL: httpsUrl(p.baseURL, `providers[${i}].baseURL`),
      keyEnv: p.keyEnv,
      ...(p.anthropicBaseURL ? { anthropicBaseURL: httpsUrl(p.anthropicBaseURL, `providers[${i}].anthropicBaseURL`) } : {}),
    };
  });
}

function httpsUrl(raw: unknown, what: string): string {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error(`${what} is not a URL`);
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) throw new Error(`${what}: https, no credentials, query or fragment`);
  return u.toString().replace(/\/+$/, "");
}

/** Parse KEY=value lines (secrets.env). `#` comments and blank lines are skipped; values are literal. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [n, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    const k = (i > 0 ? line.slice(0, i) : line).replace(/^export\s+/, "").trim();
    if (i <= 0 || !ENV_NAME.test(k)) throw new Error(`secrets.env line ${n + 1}: expected NAME=value`);
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

/** How Claude Code on a box reaches a model: its own login (none) or a provider's Anthropic endpoint. */
export type ClaudeVia = "none" | string;

/**
 * The env T3 Code's server gets on a box: every secret except the hub's own,
 * OPENCODE_CONFIG pointing at the helper's (secret-free) OpenCode file, and,
 * when `claudeVia` names a provider whose key is present, Claude Code's
 * ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN.
 */
export function buildAgentEnv(secrets: Record<string, string>, providers: Provider[], claudeVia: ClaudeVia, opencodeConfigPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(secrets)) {
    if (HUB_ONLY.has(k) || !ENV_NAME.test(k)) continue;
    env[k] = v;
  }
  env.OPENCODE_CONFIG = opencodeConfigPath;
  if (claudeVia && claudeVia !== "none") {
    const p = providers.find((x) => x.id === claudeVia || x.id.startsWith(`${claudeVia}-`));
    if (!p?.anthropicBaseURL) throw new Error(`claudeVia: no provider "${claudeVia}" with an anthropicBaseURL`);
    const key = secrets[p.keyEnv];
    if (!key) throw new Error(`claudeVia ${claudeVia}: ${p.keyEnv} is not in secrets.env`);
    env.ANTHROPIC_BASE_URL = p.anthropicBaseURL;
    env.ANTHROPIC_AUTH_TOKEN = key;
  }
  return env;
}

/**
 * systemd EnvironmentFile text. Values are double-quoted with `\` and `"`
 * escaped (systemd does not expand variables in this file). A newline in a value
 * is refused rather than risk a second, injected assignment.
 */
export function renderEnvFile(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map((k) => {
      const v = env[k];
      if (!ENV_NAME.test(k)) throw new Error(`bad env name ${k}`);
      if (/[\r\n\0]/.test(v)) throw new Error(`${k}: value contains a newline`);
      return `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
    })
    .join("");
}

/** GET <baseURL>/models with the key; sorted model ids. The key goes only in the Authorization header. */
export async function fetchModelIds(p: Provider, key: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(`${p.baseURL}/models`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${p.id}: GET /models returned HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { id?: unknown }[] };
  const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0 && id.length < 200);
  if (ids.length === 0) throw new Error(`${p.id}: /models listed no models`);
  return [...new Set(ids)].sort();
}

/** OpenCode config (loaded through OPENCODE_CONFIG). apiKey is `{env:NAME}`. */
export function opencodeConfig(models: { provider: Provider; ids: string[] }[]): string {
  const provider: Record<string, unknown> = {};
  for (const { provider: p, ids } of models) {
    provider[p.id] = {
      npm: "@ai-sdk/openai-compatible",
      name: p.name,
      options: { baseURL: p.baseURL, apiKey: `{env:${p.keyEnv}}` },
      models: Object.fromEntries(ids.map((id) => [id, { name: id }])),
    };
  }
  return `${JSON.stringify({ $schema: "https://opencode.ai/config.json", provider }, null, 2)}\n`;
}

/** Pi `models.json`. apiKey is `$NAME`, which Pi reads from its environment. */
export function piModels(models: { provider: Provider; ids: string[] }[]): string {
  const providers: Record<string, unknown> = {};
  for (const { provider: p, ids } of models) {
    providers[p.id] = { baseUrl: p.baseURL, api: "openai-completions", apiKey: `$${p.keyEnv}`, models: ids.map((id) => ({ id })) };
  }
  return `${JSON.stringify({ providers }, null, 2)}\n`;
}
