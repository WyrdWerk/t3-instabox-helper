// Shell scripts run on a box through InstaBox's exec API (`bash -lc`, as the
// machine user, passwordless sudo). Secrets only ever arrive on stdin; scripts
// print names, counts and booleans, never values.

/** T3 Code's port on the box (the `t3` template's t3-instabox.service). */
export const BOX_T3_PORT = 3774;
export const T3_UNIT = "t3-instabox.service";
const DROPIN_DIR = `/etc/systemd/system/${T3_UNIT}.d`;
const DROPIN = `${DROPIN_DIR}/20-t3-instabox-helper.conf`;
/** tmpfs, root-only: never on a disk, so never in a snapshot. */
export const BOX_ENV_FILE = "/run/t3-instabox-helper/agent.env";
/** Secret-free OpenCode config, loaded through OPENCODE_CONFIG. */
export const BOX_OPENCODE_CONFIG = "/data/home/.config/t3-instabox-helper/opencode.json";

/**
 * The drop-in that makes the template's T3 server listen on loopback only (the
 * template runs `t3 serve --host 0.0.0.0`; a CLI flag beats T3CODE_HOST, so
 * ExecStart is replaced) and gives it the agent env file. Same base dir as the
 * template, so threads and the environment id are kept. `$$` is a literal `$`
 * for systemd.
 */
export function serveDropIn(): string {
  return `# Written by t3-instabox-helper. T3 Code on loopback only; the hub reaches it over ssh -L.
[Service]
EnvironmentFile=-${BOX_ENV_FILE}
ExecStart=
ExecStart=/bin/sh -c 'export PATH="$$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"; id=$$(cat /etc/machine-id); exec t3 serve --host 127.0.0.1 --port ${BOX_T3_PORT} --base-dir "$$HOME/.t3-instabox/$$id" /data/workspace'
`;
}

/**
 * Box setup, idempotent. stdin: JSON {env, opencode, pi} (env = EnvironmentFile
 * text with keys; opencode/pi = secret-free config files, "" to leave alone).
 * Restarts T3 only when the drop-in or env changed (a restart interrupts
 * running turns). Last line: `setup=ok changed=yes|no vars=<n> opencode=… pi=…`.
 */
export function setupScript(): string {
  return `set -euo pipefail
umask 077
work=$(mktemp -d "\${XDG_RUNTIME_DIR:-/tmp}/t3ih.XXXXXX"); trap 'rm -rf "$work"' EXIT
installed=no
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
if ! sudo -n systemctl cat ${T3_UNIT} >/dev/null 2>&1; then
  # A box without the t3 template's unit (e.g. a plain login-free snapshot): install
  # T3 stable with the official installer if needed and create the base unit.
  command -v t3 >/dev/null 2>&1 || { curl -fsSL https://t3.codes/install.sh | sh >/dev/null 2>&1 || { echo "setup=failed reason=t3-install"; exit 1; }; }
  command -v t3 >/dev/null 2>&1 || { echo "setup=failed reason=t3-not-on-path"; exit 1; }
  sudo -n mkdir -p /data/workspace && sudo -n chown "$(id -u):$(id -g)" /data/workspace
  printf '%s\\n' '# Written by t3-instabox-helper (base unit; the 20-t3-instabox-helper drop-in sets ExecStart).' \
    '[Unit]' 'Description=T3 Code (t3-instabox-helper)' 'After=network-online.target' \
    '[Service]' "User=$(id -u)" "Environment=HOME=$HOME" "Environment=XDG_RUNTIME_DIR=/run/user/$(id -u)" \
    'WorkingDirectory=/data/workspace' 'ExecStart=/bin/false' 'Restart=on-failure' 'RestartSec=3' \
    '[Install]' 'WantedBy=multi-user.target' > "$work/unit"
  sudo -n install -m 644 -o root -g root "$work/unit" /etc/systemd/system/${T3_UNIT}
  sudo -n systemctl daemon-reload
  installed=yes
fi
cat > "$work/in.json"
node -e '
const fs = require("fs"), d = process.argv[1], j = JSON.parse(fs.readFileSync(d + "/in.json", "utf8"));
for (const k of ["env", "opencode", "pi"]) fs.writeFileSync(d + "/" + k, j[k] || "", { mode: 0o600 });
' "$work"
rm -f "$work/in.json"
changed=$installed
# 1. loopback-only drop-in
want=$(cat <<'DROPIN'
${serveDropIn().trimEnd()}
DROPIN
)
if [ "$(sudo -n cat ${DROPIN} 2>/dev/null)" != "$want" ]; then
  sudo -n mkdir -p ${DROPIN_DIR}
  printf '%s\\n' "$want" > "$work/dropin"
  sudo -n install -m 644 -o root -g root "$work/dropin" ${DROPIN}
  sudo -n systemctl daemon-reload
  changed=yes
fi
# 2. agent env on tmpfs, root 0600
sudo -n install -d -m 700 -o root -g root /run/t3-instabox-helper
if ! sudo -n cmp -s "$work/env" ${BOX_ENV_FILE}; then
  sudo -n install -m 600 -o root -g root "$work/env" ${BOX_ENV_FILE}
  changed=yes
fi
vars=$(grep -c '=' "$work/env" || true)
# 3. OpenCode config (helper-owned path, no keys)
oc=skipped
if [ -s "$work/opencode" ]; then
  mkdir -p "$(dirname ${BOX_OPENCODE_CONFIG})"
  if cmp -s "$work/opencode" ${BOX_OPENCODE_CONFIG}; then oc=unchanged; else install -m 644 "$work/opencode" ${BOX_OPENCODE_CONFIG}; oc=written; fi
fi
# 4. Pi models.json: only a missing file or one this helper wrote (sha256 kept beside it)
pi=skipped
if [ -s "$work/pi" ]; then
  f="$HOME/.pi/agent/models.json"; own="$HOME/.config/t3-instabox-helper/pi-models.sha256"
  mkdir -p "$HOME/.pi/agent" "$(dirname "$own")"
  if [ -e "$f" ] && [ "$(sha256sum < "$f" | cut -d' ' -f1)" != "$(cat "$own" 2>/dev/null)" ]; then pi=kept-user-file
  elif cmp -s "$work/pi" "$f"; then pi=unchanged
  else install -m 644 "$work/pi" "$f"; sha256sum < "$f" | cut -d' ' -f1 > "$own"; pi=written; fi
fi
# 5. (re)start T3 and require loopback-only
sudo -n systemctl enable ${T3_UNIT} >/dev/null 2>&1 || true
if [ "$changed" = yes ]; then sudo -n systemctl restart ${T3_UNIT}; else sudo -n systemctl start ${T3_UNIT}; fi
for i in $(seq 1 60); do
  addrs=$(ss -Hltn "sport = :${BOX_T3_PORT}" 2>/dev/null | awk '{print $4}' | sort -u | tr '\\n' ' ')
  case "$addrs" in
    "") ;;
    "127.0.0.1:${BOX_T3_PORT} ")
      if curl -fsS -m 3 -o /dev/null http://127.0.0.1:${BOX_T3_PORT}/.well-known/t3/environment; then
        echo "setup=ok changed=$changed t3-installed=$installed vars=$vars opencode=$oc pi=$pi"; exit 0
      fi ;;
    *) echo "setup=failed reason=not-loopback-only listen=[$addrs]"; exit 1 ;;
  esac
  sleep 1
done
echo "setup=failed reason=t3-not-listening"; exit 1
`;
}

/**
 * After a pause, outbound TCP connections that were open are dead, but agents
 * reuse them (bb-plugin-instabox saw claude-code hang on a stale keep-alive
 * socket to the model API). Close outbound HTTP(S) connections so clients
 * reconnect. Last line: `stale-conns closed=<n>`.
 */
export function staleConnectionsScript(): string {
  return `count() { ss -Htn state established '( dport = :443 or dport = :80 )' 2>/dev/null | wc -l; }
before=$(count); sudo -n ss -K state established '( dport = :443 or dport = :80 )' >/dev/null 2>&1; echo "stale-conns closed=$((before - $(count)))"
`;
}

/** POSIX single-quote one argument. */
export function sq(a: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/**
 * Mint a one-time pairing link on the box whose URL is the hub's address. Prints
 * one JSON line {pairUrl, expiresAt}; nothing else (the raw credential is
 * dropped on the box). `t3 pair` has no --base-url, `t3 auth pairing create` does.
 */
export function pairScript(opts: { ttl: string; label: string; baseUrl: string }): string {
  if (!/^[0-9]+\s*[a-z ]+$/i.test(opts.ttl)) throw new Error("ttl: e.g. 10m, 1h");
  return `set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
d="$HOME/.t3-instabox/$(cat /etc/machine-id)"
t3 auth pairing create --base-dir "$d" --ttl ${sq(opts.ttl)} --label ${sq(opts.label)} --base-url ${sq(opts.baseUrl)} --json 2>/dev/null \\
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.pairUrl)process.exit(3);process.stdout.write(JSON.stringify({pairUrl:j.pairUrl,expiresAt:j.expiresAt})+"\\n")})'
`;
}

/** Agents whose own login can run on a box. Flags checked with each CLI's --help (codex-cli 0.160.0, Claude Code 2.1.288). */
export const LOGINS: Record<string, { cmd: string; consoleCmd?: string; status: string }> = {
  codex: { cmd: "codex login --device-auth", status: "codex login status" },
  claude: { cmd: "claude auth login --claudeai", consoleCmd: "claude auth login --console", status: "claude auth status" },
};

const LOGIN_DIR = '"$XDG_RUNTIME_DIR/t3-instabox-helper"';

function loginAgent(agent: string) {
  const l = LOGINS[agent];
  if (!l) throw new Error(`login: one of ${Object.keys(LOGINS).join(", ")}`);
  return l;
}

/**
 * Start the CLI's own login as a transient user unit, under a pseudo-terminal
 * (`script`), with stdin from a FIFO so a code can be pasted later. Output goes
 * to a 0600 file on tmpfs. Nothing from another box is copied.
 */
export function loginStartScript(agent: string, useConsole = false): string {
  const l = loginAgent(agent);
  const cmd = useConsole && l.consoleCmd ? l.consoleCmd : l.cmd;
  return `set -euo pipefail
umask 077
export XDG_RUNTIME_DIR=\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
dir=${LOGIN_DIR}; mkdir -p "$dir"
unit=t3ih-login-${agent}
systemctl --user stop "$unit" >/dev/null 2>&1 || true
systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
rm -f "$dir/${agent}.in" "$dir/${agent}.log"; mkfifo -m 600 "$dir/${agent}.in"; : > "$dir/${agent}.log"
systemd-run --user --quiet --unit "$unit" --collect -E BROWSER=false -E HOME="$HOME" -E PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \\
  bash -c 'exec 3<>"$1/${agent}.in"; exec script -qfec "$2" "$1/${agent}.log" <&3 >/dev/null 2>&1' _ "$dir" ${sq(cmd)}
sleep 6
echo "login=started"
`;
}

/** What the login printed (URL, code, prompt), cleaned of terminal codes. Removes the log once the login has ended. */
export function loginStatusScript(agent: string): string {
  const l = loginAgent(agent);
  return `set -uo pipefail
export XDG_RUNTIME_DIR=\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
dir=${LOGIN_DIR}; unit=t3ih-login-${agent}
if [ -f "$dir/${agent}.log" ]; then
  sed -E 's/\\x1b\\]8;;([^\\x07\\x1b]*)(\\x07|\\x1b\\\\)/\\1 /g; s/\\x1b\\[[0-9;?]*[A-Za-z]//g; s/\\x1b[()][A-Z0-9]//g' "$dir/${agent}.log" | tr -d '\\r' | grep -v -e '^Script started' -e '^Script done' -e '^[[:space:]]*$' | tail -n 25
fi
if systemctl --user is-active --quiet "$unit"; then echo "login=running"; exit 0; fi
rm -f "$dir/${agent}.log" "$dir/${agent}.in"
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
if ${l.status} >/dev/null 2>&1; then echo "login=done signed-in=yes"; else echo "login=ended signed-in=no"; fi
`;
}

/** Pass a code (stdin, one line) to a waiting login, e.g. Claude Code's "Paste code here". */
export function loginCodeScript(agent: string): string {
  loginAgent(agent);
  return `set -euo pipefail
export XDG_RUNTIME_DIR=\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
dir=${LOGIN_DIR}
systemctl --user is-active --quiet t3ih-login-${agent} || { echo "login=not-running"; exit 1; }
IFS= read -r code
printf '%s\\r' "$code" > "$dir/${agent}.in"
sleep 5
echo "login=code-sent"
`;
}

export function loginCancelScript(agent: string): string {
  loginAgent(agent);
  return `export XDG_RUNTIME_DIR=\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
systemctl --user stop t3ih-login-${agent} >/dev/null 2>&1; rm -f ${LOGIN_DIR}/${agent}.log ${LOGIN_DIR}/${agent}.in; echo "login=cancelled"
`;
}

/** Install Pi and OpenCode system-wide (root disk). For building a base snapshot; signs nothing in. */
export function installAgentsScript(): string {
  return `set -euo pipefail
sudo -n env HOME=/root npm --prefix /usr/local install -g --silent @earendil-works/pi-coding-agent@latest >/dev/null
curl -fsSL https://opencode.ai/v2/install | bash -s -- --no-modify-path >/dev/null
sudo -n ln -sf "$HOME/.opencode/bin/opencode" /usr/local/bin/opencode
for b in t3 pi opencode claude codex; do printf '%s: ' "$b"; "$b" --version 2>/dev/null | head -1 || echo missing; done
`;
}
