# t3-instabox-helper (experimental)

> **Status: experimental, v0.1.0.** The InstaBox side, the hub tunnel and the
> pairing exchange passed a live test on 2026-10-28. The tailnet leg
> (`tailscale serve` on a real hub, phone pairing) is not tested yet; see
> [Live test status](#live-test-status).

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
hub: ssh -N -L 127.0.0.1:<localPort>:127.0.0.1:3774 <box>@<InstaBox gateway>   (cert: POST /connections)
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
  (bb saw agents hang on them after a pause) and re-runs setup. The
  `tailscale serve` route stays in place and returns 502 while the box sleeps.
  The watcher never wakes a box on its own, because waking costs money. Wake one
  with `t3ih resume <box>`. `t3ih pair` and `t3ih login` resume the box first.
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

An `INSTABOX_API_KEY` in the process environment overrides the one in
`secrets.env`. Every other entry in `secrets.env` is passed to the T3 server on
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
every box script; and the API client's idempotency keys, which are absent on
`exec` and `wake`, with retries only for retryable errors.
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
| `tailscale serve` route on a real hub, pairing from a phone over the tailnet | **Not tested**: needs the hub |
| Completing a Codex or Claude subscription login; `install-agents` and a base snapshot; OpenCode/Pi threads | Not tested |

### Steps for the hub test

On the hub (as the user that will run the service), with this repo cloned and
`secrets.env` written:

```bash
tailscale serve status                    # note ports in use; 443 is usually the hub's own T3
t3ih create t3ih-hub-test                 # assigns e.g. hub 47301 / tailnet 8301
systemctl --user enable --now t3ih-watch  # or: t3ih watch (foreground)
t3ih list                                 # tunnel=up
tailscale serve status                    # :8301 → http://127.0.0.1:47301, and nothing else changed
curl -s https://<hub>.<tailnet>.ts.net:8301/.well-known/t3/environment | jq .label
t3ih pair t3ih-hub-test                   # open the link on the phone (on the tailnet); add the environment
# start a thread on the box from the phone, then:
t3ih suspend t3ih-hub-test; t3ih resume t3ih-hub-test   # phone reconnects after the next poll
t3ih delete t3ih-hub-test --yes           # route removed: tailscale serve status no longer lists :8301
```

## Known limits

- The watcher does not wake a box when a client connects. A paused box's route
  returns 502 until you run `t3ih resume`.
- Tunnels are children of `t3ih watch`; if it restarts, it reopens them on
  the first poll.
- Snapshot and template drift: setup depends on the template's
  `t3-instabox.service` and port 3774. If InstaBox changes them, setup fails
  with a clear reason instead of exposing T3.
- One pairing per box per device. Revoke sessions on a box with
  `t3 auth session list|revoke --base-dir ~/.t3-instabox/$(cat /etc/machine-id)`.
- Never commit `secrets.env`, `state.json`, pairing links, tailnet names or
  machine and snapshot IDs; `.gitignore` covers the first two.
