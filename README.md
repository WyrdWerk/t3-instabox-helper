# t3-instabox-helper (experimental)

> **Status: experimental, v0.1.0.** The InstaBox side, the hub tunnel and the
> pairing exchange passed a live test on 2026-10-28. Wake on use passed live too. The tailnet leg
> (`tailscale serve` on a real hub, phone pairing) is tested on the hub
> separately; see [Live test status](#live-test-status).

`t3ih` lets [T3 Code](https://github.com/pingdotgg/t3code) use
[InstaBox](https://instabox.sh) machines ("boxes") as remote environments,
with an always-on Linux **hub** in the middle. Boxes do not run Tailscale and
have no inbound ports. Every client (web, desktop, phone) reaches a box only
through the hub, over the hub's tailnet.

It works like [bb-plugin-instabox](https://github.com/WyrdWerk/bb-plugin-instabox),
but T3 Code has no machine-provider plugins. So this is a small CLI plus a
supervisor on the hub, not a plugin.

## Architecture

```text
phone / laptop (on the tailnet)
   │  https://<hub>.<tailnet>.ts.net:<servePort>/      one route per box, tailnet only
   ▼
hub: tailscale serve --bg --https=<servePort> http://127.0.0.1:<localPort>
hub: t3ih watch: wake proxy on 127.0.0.1:<localPort> (always listening)
       ├─ box running: pipe every connection to the tunnel below
       └─ box paused/stopped: answer route probes from cache; wake the box for a session
hub: ssh -N -L 127.0.0.1:<ephemeral>:127.0.0.1:3774 <box>@<InstaBox gateway>   (cert: POST /connections)
   │  InstaBox's authenticated SSH gateway (local forwarding only)
   ▼
box: t3 serve --host 127.0.0.1 --port 3774   (template unit + this helper's drop-in)
     agent keys: root-only file on tmpfs (/run), loaded as the T3 server's env
```

- **Direction.** The hub connects to the box, so plain `ssh -L` is enough.
  bb needed chisel because its box had to reach the hub, and InstaBox's
  gateway refuses `-R`. Here there is no chisel and no extra binary.
- **One route per box.** Each box gets its own hub loopback port (default
  47301-47399) and its own tailnet HTTPS port (default 8301-8399). Before it
  uses a port, `t3ih` checks `tailscale serve status` and what is listening on
  the hub. It never takes a port that already serves something else, such as
  the hub's own T3 on 443. Routes are `tailscale serve` only, never Funnel.
- **Loopback only on the box.** The InstaBox `t3` template runs
  `t3 serve --host 0.0.0.0 --port 3774` as `t3-instabox.service`. A drop-in
  replaces `ExecStart` with `--host 127.0.0.1`. A flag, because a CLI flag
  beats `T3CODE_HOST`, and T3 0.1.3's service now defaults to `0.0.0.0`.
  The data directory stays the same, so threads and the environment id are
  kept. After each setup, `t3ih` checks that 3774 listens on `127.0.0.1` only
  and fails otherwise.
- **Pairing points at the hub.** `t3ih pair <box>` runs
  `t3 auth pairing create --base-url <hub route> --ttl <ttl> --json` on the box
  through InstaBox exec. That is the documented way to mint a link for another
  address; `t3 pair` has no `--base-url`. The box prints only `{pairUrl,
  expiresAt}`, and `t3ih` writes the link to stdout, never to a log. Tokens are
  one-time and expire (default 10 min), so make links on demand.
- **Idle pause.** InstaBox pauses an idle box (`autoSuspendAfterSeconds`). The
  gateway then closes SSH. `t3ih watch` polls the API (default every 30 s),
  closes the tunnel of a paused or stopped box, and reopens it when the box
  runs again. Before reopening, it closes stale outbound HTTP(S) connections
  (bb saw agents hang on them after a pause), and it re-runs setup when the box
  was stopped (a stop wipes the tmpfs key file).
- **Wake on use.** See [Wake on use](#wake-on-use). A paused or stopped box
  wakes when a client opens a session on its route, not when a client only
  checks the route.
- **Polling, not webhooks.** InstaBox org webhooks (`sandbox.started`,
  `.suspended`, …) only deliver to a public HTTPS URL, and the hub has none.
  Polling is cheap: one `GET /v1/machines/{id}` per box per interval, which
  does not wake the box. Webhooks could be added later as an optional trigger
  through a Tailscale Funnel or another public endpoint; nothing depends on them.

## Why TypeScript on plain Node, with no runtime dependencies

It matches bb-plugin-instabox, whose InstaBox client and SSH-certificate
handling are reused here. T3 Code itself needs Node, so the hub already has
it. Node ≥ 22.18 runs `.ts` files directly (type stripping), so there is no
build step and **no runtime dependencies** (`npm ci` installs only TypeScript
and `@types/node`, for `npm run typecheck`). Hub cost measured in the live
test: the watcher uses about 96 MB RSS, plus about 8 MB per box `ssh`.

## Setup

### 1. The hub

An always-on Linux machine on your tailnet with `node` ≥ 22.18, `ssh`,
`ssh-keygen` and `tailscale`. HTTPS certificates and MagicDNS must be enabled
for the tailnet, the same requirement `t3 serve --tailscale-serve` has. The
user that runs `t3ih` must be allowed to run `tailscale serve`; if not, run
`sudo tailscale set --operator=$USER` once.

```bash
git clone https://github.com/WyrdWerk/t3-instabox-helper ~/t3-instabox-helper
cd ~/t3-instabox-helper && npm ci && npm test
ln -s "$PWD/bin/t3ih" ~/.local/bin/t3ih
```

### 2. Keys and config

Everything lives in `$T3IH_HOME`, default `~/.config/t3-instabox-helper/`:

```bash
mkdir -p ~/.config/t3-instabox-helper && cd ~/.config/t3-instabox-helper
umask 077; cat > secrets.env    # then chmod 600; t3ih refuses a readable file
INSTABOX_API_KEY=ibk_...
ZAI_API_KEY=...
ZRO_API_KEY=...
CORALBRICKS_API_KEY=...
NEURALWATT_API_KEY=...
MINIMAX_API_KEY=...
^D
```

The InstaBox key is chosen in this order: `T3IH_INSTABOX_API_KEY` in the
environment (a variable only this helper reads), then `INSTABOX_API_KEY` in
`secrets.env`, then `INSTABOX_API_KEY` in the environment, but only when
`secrets.env` has none. A shell-wide `INSTABOX_API_KEY` that differs from the
chosen key is ignored, with a warning on stderr, so another account's key in
your shell can't silently redirect `t3ih`. Every other entry in `secrets.env` is passed to the T3 server on
every box, except the InstaBox keys, which never leave the hub. Leave out
providers you don't use.

`config.json` holds optional, non-secret settings:

| Key | Default | Notes |
|---|---|---|
| `template` | `t3` | InstaBox template with T3 Code, Claude Code and Codex |
| `snapshotId` | none | Create boxes from a login-free base snapshot instead (below) |
| `vcpus`, `memMiB` | template default (4/8192) | One of the account's `allowedSpecs` |
| `autoSuspendAfterSeconds` | 1800 | InstaBox snaps it to 300-1800 |
| `localPortRange` | `[47301, 47399]` | Hub loopback ports for `ssh -L`; must not cover the hub's own T3 port |
| `servePortRange` | `[8301, 8399]` | Tailnet HTTPS ports; keep 443 for the hub's own T3 |
| `tailscaleServe` | `true` | `false`: no tailnet route; links point at `http://127.0.0.1:<localPort>/` (testing) |
| `hubHost` | from `tailscale status --json` | The hub's MagicDNS name |
| `pairTtl` | `10m` | Pairing link lifetime (`5m`, `1h`) |
| `claudeVia` | `none` | Provider id whose Anthropic endpoint Claude Code uses: `zai` or `minimax`. `none` leaves Claude Code to its own login |
| `providers` | Z.ai coding plan, Zro, Coral Bricks, Neuralwatt, MiniMax | `[{id, name, baseURL, keyEnv, anthropicBaseURL?}]`, OpenAI-compatible |
| `pollSeconds` | 30 | Watcher interval |
| `wakeOnUse` | `true` | Wake a paused or stopped box when a client opens a session on its route |

### 3. Run the supervisor

```bash
cp contrib/t3ih-watch.service ~/.config/systemd/user/   # adjust the path in ExecStart
systemctl --user daemon-reload && systemctl --user enable --now t3ih-watch
journalctl --user -u t3ih-watch -f
```

### 4. Use it

```bash
t3ih create box1             # t3 template (or --snapshot <id>); set up, port and route assigned
t3ih list                    # state, tunnel, hub/tailnet ports
t3ih pair box1               # prints a one-time https://<hub>.<tailnet>.ts.net:8301/pair#token=… link
t3ih resume box1             # after an idle pause; the watcher reopens the tunnel
t3ih delete box1 --yes       # VM, route, certificate files and state
t3ih adopt <name|id>         # manage a box created elsewhere from the t3 template
```

Open the link on a device on the tailnet, or paste it into T3 Code's **Add
environment**. Pair each box once per device; reconnecting needs no new link.
With two or more boxes added, T3's **Load balancing** setting can spread new
threads across them.

## Agent credentials

### API keys (default)

At setup, and again whenever a box comes back from a pause or stop, `t3ih`:

1. writes the key env to `/run/t3-instabox-helper/agent.env` on the box
   (tmpfs, `root:root 0600`, delivered over exec **stdin**). The T3 unit loads
   it through `EnvironmentFile=`. It is not on disk, so it is never in a
   snapshot, and a stop wipes it until the watcher writes it again;
2. calls each provider's `GET <baseURL>/models` from the hub and writes the
   live model lists for **OpenCode** (`OPENCODE_CONFIG` →
   `~/.config/t3-instabox-helper/opencode.json`, `apiKey: "{env:NAME}"`) and
   **Pi** (`~/.pi/agent/models.json`, `apiKey: "$NAME"`; a file you edited is
   left alone). Neither file holds a key value;
3. sets `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` for **Claude Code**
   when `claudeVia` names a provider with an Anthropic endpoint (Z.ai, MiniMax).

Keys never appear in argv, logs or files on disk. The `t3` template ships Claude
Code and Codex but not OpenCode or Pi; install those into a base snapshot with
`t3ih install-agents` (below).

### Per-box subscription login (opt-in)

Each box can sign in to Codex or Claude Code with its **own fresh login**,
started by the CLI's own device-code or browser flow on that box. Auth files are
never copied between boxes or into snapshots. Every box therefore has its own
session, which avoids the problem of copied auth files signing each other out.

```bash
t3ih login box1 codex          # runs `codex login --device-auth`; shows the URL and one-time code
t3ih login box1 claude         # runs `claude auth login --claudeai`; shows the sign-in URL
t3ih login-code box1 claude    # paste the code the Claude page shows (read from stdin)
t3ih login-status box1 codex   # login=running | done signed-in=yes | ended signed-in=no
t3ih login-cancel box1 claude
```

`--console` uses `claude auth login --console` (Anthropic Console billing).
The flags were checked against `--help` of codex-cli 0.160.0 and Claude Code
2.1.288 on the template. The login runs as a transient user unit under a
pseudo-terminal. Its output (URL and code) goes to a 0600 file on the box's
tmpfs, which is printed to your terminal and deleted when the login ends.
Don't combine a Claude subscription login with `claudeVia` on the same box:
`ANTHROPIC_AUTH_TOKEN` in T3's env would override the login.

**A snapshot taken after a login carries its credentials**, because
`/data/home` is in the snapshot. Keep base snapshots login-free.

## Boxes without T3: what setup needs

Setup works on any box with `sudo -n`, `curl`, `node`, `ss` and systemd:
the `t3` template, a snapshot of it, or a plain login-free snapshot. When the
box has no `t3-instabox.service`, setup installs T3 stable with the official
installer (`curl -fsSL https://t3.codes/install.sh | sh`, into `~/.local/bin`)
if `t3` is missing. It then writes a base `/etc/systemd/system/t3-instabox.service`
(runs as the box user from `/data/workspace`) and adds the usual
loopback-only drop-in. In the live test this took about 7 s and installed T3
0.1.3. The data directory is `~/.t3-instabox/<machine-id>`, the same as the
template's, so a box moved between the two keeps its threads.

## A login-free base snapshot

```bash
t3ih create t3-base-build
t3ih install-agents t3-base-build     # Pi (npm, /usr/local) and OpenCode (/usr/local/bin)
# do NOT pair, log in, or create projects on it
```

Then snapshot it through the InstaBox API. Stop it first for a clean copy:
`POST /v1/machines/{id}/stop`, then `POST /v1/machines/{id}/snapshots` with
`{"name":"t3-base-v1"}`. Set `snapshotId` in `config.json` and run
`t3ih delete t3-base-build --yes`. The snapshot contains the build box's
`~/.t3-instabox` data: no logins or keys, but its T3 database. New boxes get a
different `/etc/machine-id`, so T3 starts a new data directory and a new
environment id. The helper's own key file is on tmpfs, so it is never
included. Snapshotting a box that already has a login or pairings is exactly
what to avoid.

## Wake on use

The goal: a paused box wakes when you actually use it, for example by sending
a message in one of its threads, with no `t3ih resume`, while clients that are
only checking routes don't keep waking it.

**What T3 clients send** (read from `packages/client-runtime/src/connection/`
`driver.ts` and `supervisor.ts`, T3 Code main, October 2026):

- *Route checks* (`checkRoute`, `checkHost`, `preflight`) fetch the public
  descriptor `GET /.well-known/t3/environment` (2.5 s timeout, `no-store`).
  They run before connecting when a box has several routes, as the
  silent-socket check after the app returns, and as the better-route check:
  every 60 s, on network change and on app focus, but only for routes *earlier*
  in the list than the one in use. `preflight` then also prepares
  authorization, which does not contact the box for a paired route.
- *Sessions* use `POST /api/auth/websocket-ticket[/rpc]`, then a WebSocket to
  `/ws`. A connected client sends an RPC `Ping` every 5 s and drops the socket
  after 15 s with no frame.
- *Reconnects*: a failed connection is retried with exponential backoff
  (1 s doubling to a 5-minute ceiling, with jitter); app focus and network
  changes reset it. Each retry is a session attempt.

**What the hub does.** `t3ih watch` keeps a small TCP proxy on each box's
stable hub port (`tailscale serve` points at it). The `ssh -L` tunnel runs on
an ephemeral port behind it while the box runs. When the tunnel is up,
connections are piped through untouched. When it is down, the proxy reads the
first request head:

- `GET`/`HEAD /.well-known/t3/environment` without `Upgrade` → answered from
  the hub's cached copy of that box's descriptor (refreshed each time the
  tunnel opens; 503 if never seen). This is safe: the descriptor is public,
  contains no secrets, and only identifies the environment. T3 still requires
  the real box to authorize a session, so a cached answer cannot grant access.
- anything else → resume (paused) or start (stopped) the box, wait for it to
  be ready, re-run setup if it was stopped, open the tunnel, then pipe the
  buffered request through. If waking fails, the client gets a 503 and retries.

**Measured cost** (live, 2 vCPU box, hub in an Amp orb):

| From | First request answered | Then |
|---|---|---|
| paused (suspend) | 1.6 s | ~30 ms per request |
| stopped | 9.5 s (start, key file rewritten, setup, tunnel) | ~30 ms |
| paused, route probe | ~1 ms from the hub cache; box stayed paused | — |

T3 allows 15 s for a connection to establish, so both cases connect on the
first try. If a wake is slower than that, the client fails that attempt and the
proxy keeps waking the box, so the next retry connects.

**What this cannot do.** The hub sees TCP and HTTP heads, not T3 RPC calls,
so it cannot tell "sent a message" apart from "opened the app". A session
attempt counts as use:

- Opening or focusing a client that has the box's environment switched on
  wakes the box, because the client reconnects. Turn a box's environment off
  in **Settings → Environments** on a device that should leave it asleep.
- A client still in its reconnect backoff wakes the box on its next retry.
- **A connected client keeps the box awake.** Its 5-second pings travel
  through the SSH gateway, and InstaBox counts that traffic as activity: in
  the live test a box with a 5-minute idle pause stayed running for 9+ minutes
  with one client connected, while an open but unused tunnel let it pause.
  So idle pause only happens once no client holds a session, for example
  after the app is closed or backgrounded long enough for its socket to drop
  (phones drop it quickly; a desktop app or a browser tab left open keeps it).
  The hub cannot change that without breaking live sessions.
- `wakeOnUse` also wakes a box you paused or stopped by hand. Set
  `"wakeOnUse": false` to require `t3ih resume`.

## Box status in a UI (design note, not built)

T3 has no UI plugins. Its **Settings → Environments** already shows each
environment's connection state (connected, connecting, retrying), which
reflects waking as a slow connect. Options for a fuller view of paused,
waking, running and error states:

1. **Tailnet-only status page from `t3ih watch`.** A small HTTP page on a
   hub loopback port, published with one more `tailscale serve` route. It
   lists boxes with state, last transition, wake latency and the last error,
   plus a Resume button. Cheap: the data is already in the supervisor. Works on
   the phone through the tailnet.
2. **MCP server on the hub with an MCP Apps panel.** Tools like
   `list_boxes`/`resume_box`, and a status panel rendered in a thread. T3
   renders MCP Apps in threads, but today only for Codex, so this reaches only
   Codex threads on the hub. Higher effort; useful if agents should manage
   boxes.
3. **InstaBox org webhooks** (`sandbox.started/stopped/suspended/error/…`) to
   replace polling latency (up to `pollSeconds`). They need a public HTTPS
   receiver, for example a Cloudflare Tunnel exposing a single webhook path on
   the hub that verifies the signature and feeds the supervisor. Polling stays as
   the fallback. This improves 1 and 2; it is not a UI by itself.

Recommended order: 1, then 3 if poll latency matters, then 2.

## Alternative: one route only, through peer links

Instead of a route per box, you can connect only to the hub's own T3 and let
the hub's agents drive the boxes through T3's **Linked environments** beta
(`linkedEnvironmentsEnabled`, on both sides). For each box, run
`t3 environment link http://127.0.0.1:<localPort> --pairing-code <code>
--access <mode>` on the hub, with a pairing code minted on that box (for
example with `t3 auth pairing create` through `t3ih`'s exec path; untested). Agents then use `delegate_task` to run work on a box.
No tailnet ports, no per-device pairing. But you only see the boxes' threads
through the hub's agents, links last 30 days, and it is a beta. Not built
here; the route-per-box mode is the supported one.

## Tests

`npm test` covers, offline: the secrets file parser and the
EnvironmentFile writer (quote escaping, newline injection refused); that
InstaBox keys never reach a box; that OpenCode and Pi configs name env vars
and never contain key values; model list fetches with the key in a header only;
port allocation around busy `tailscale serve` and hub ports; `tailscale serve
status` parsing, refusing to take over or remove a route that is not ours, and
no Funnel; `ssh` argv (only `-L`, to the box's loopback, strict host CA); the
watcher's open/close/forget decisions; the loopback-only drop-in; pairing
script quoting and TTL validation; the verified login commands; `bash -n` on
every box script; the API client's idempotency keys, which are absent on
`exec` and `wake`, with retries only for retryable errors; the InstaBox key
precedence and its warning; create keys that stay stable across retries but
change for a new attempt; setup installing T3 only when the unit is missing.
`test/wake-proxy.test.ts` runs the wake proxy against a local HTTP server:
only an exact descriptor GET/HEAD counts as a probe; probes are answered from
the cache (or 503) without waking; a session request split across packets
wakes the box once and arrives intact; a running box is piped without waking;
a failed wake answers 503 instead of hanging.
`npm run typecheck` runs `tsc`.

## Live test status

On 2026-10-28: one InstaBox Pro machine from the `t3` template (2 vCPU,
5-minute idle pause), with this orb as the hub, `tailscaleServe: false`
(the orb is not on the tailnet), and T3 Code 0.1.2 on the box. The machine was
deleted afterwards.

| Path | Result |
|---|---|
| `adopt` → `setup`: drop-in applied, T3 listens on `127.0.0.1:3774` only | Passed |
| Agent env on tmpfs (`root 600`), loaded by T3 (7 vars); OpenCode/Pi lists from live `/models` (Z.ai 11, Zro 18, Neuralwatt 31, MiniMax 9 models); no key value in either file | Passed |
| `watch`: tunnel up on the hub port, descriptor answers through it | Passed |
| `pair`: link on the hub-side URL → token exchanged for a session through the tunnel (HTTP 200); same token again refused (401) | Passed |
| Claude Code via Z.ai using only the injected env: `claude -p` and a T3 thread (`t3 thread start --provider claudeAgent --wait`) answered 17×23 and 29×31 correctly | Passed |
| `suspend` → watcher closes the tunnel → `resume` → stale connections closed, setup unchanged, tunnel back within one poll | Passed |
| `stop` → `start`: key file gone with tmpfs → rewritten (`changed=yes`), T3 restarted on loopback, tunnel back | Passed |
| `login codex` / `login claude`: device URL and code, and the Claude sign-in URL shown; cancelled without signing in | Passed (start and cancel only) |
| Idle auto-pause with the tunnel open but unused: InstaBox still paused the box (about 7 min after the last activity, with a 5-min setting); the watcher closed the tunnel | Passed (an idle tunnel does not keep a box awake) |
| `delete`: VM gone (API 404), tunnel, certificate files and state removed | Passed |
| Wake on use (second run, same day, T3 0.1.2 → 0.1.3): suspended box, 6 route probes → answered from the hub cache in ~1 ms, box stayed `suspended` | Passed |
| Suspended box, `GET /api/auth/session` → box resumed, tunnel up, request answered in 1.6 s | Passed |
| Stopped box, WebSocket upgrade to `/ws` → started, key file rewritten, setup, tunnel, request delivered to T3 in 9.5 s | Passed |
| Connected client (paired session, RPC ticket, WebSocket, `Ping` every 5 s) against the 5-min idle pause | Box stayed `running` 9+ min past its last exec with a 5-min idle setting (an unused open tunnel had let it pause after ~7 min) |
| Box without T3 or `t3-instabox.service` (template unit and `t3` binary removed): setup installed T3 0.1.3 and the base unit, loopback only, in ~7 s | Passed |
| Hub key left at mode 644 with its directory at 755 (as default ACLs did on the hub) → fixed to 600/700 and the tunnel opened | Passed |
| Different `INSTABOX_API_KEY` in the shell → ignored with a warning; the `secrets.env` key was used | Passed |
| `tailscale serve` route on a real hub, pairing from a phone over the tailnet | Run on the hub by Yash (separate report) |
| Completing a Codex or Claude subscription login; `install-agents` and a base snapshot; OpenCode/Pi threads | Not tested |

### Steps for the hub test

On the hub (as the user that will run the service), with this repo cloned and
`secrets.env` written:

```bash
tailscale serve status                    # note ports in use; 443 is usually the hub's own T3
t3ih create t3ih-hub-test                 # assigns e.g. hub 47301 / tailnet 8301
systemctl --user enable --now t3ih-watch  # or: t3ih watch (foreground)
t3ih list                                 # watch=listening
tailscale serve status                    # :8301 → http://127.0.0.1:47301, and nothing else changed
curl -s https://<hub>.<tailnet>.ts.net:8301/.well-known/t3/environment | jq .label
t3ih pair t3ih-hub-test                   # open the link on the phone (on the tailnet); add the environment
# start a thread on the box from the phone, then:
t3ih suspend t3ih-hub-test               # then send a message on the phone: the box wakes (wake on use)
t3ih delete t3ih-hub-test --yes           # route removed: tailscale serve status no longer lists :8301
```

## Known limits

- Wake on use cannot tell opening the app from sending a message; see
  [Wake on use](#wake-on-use).
- Tunnels and wake proxies are part of `t3ih watch`; if it restarts, it
  reopens them on the first poll.
- Snapshot and template drift: setup depends on the template's
  `t3-instabox.service` and port 3774. If InstaBox changes them, setup fails
  with a clear reason instead of exposing T3.
- One pairing per box per device. Revoke sessions on a box with
  `t3 auth session list|revoke --base-dir ~/.t3-instabox/$(cat /etc/machine-id)`.
- Never commit `secrets.env`, `state.json`, pairing links, tailnet names or
  machine and snapshot IDs; `.gitignore` covers the first two.
