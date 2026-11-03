#!/usr/bin/env bash
# Proof of concept for docs/adr/0001-worker-os-isolation.md.
#
# On a disposable Linux host, as root, it creates three users and the layout the ADR proposes, then checks that a process
# running as the worker user cannot read the host user's DeepSeek Harness credentials, startup log, cookie jar, database or
# the operator's home, but can read and write its Ticket directory, run git there and use the command shims. With sshd
# installed it also opens the connection the DeepSeek Harness SSH provider opens (a multiplexed master, then a forwarded
# Unix socket) to the worker user over 127.0.0.1, and repeats the checks through it. It changes the system: run it in a
# container or a throwaway VM, never on a host people use.
#
# Usage: sudo scripts/isolation-poc.sh [all|setup|check|ssh|network|cleanup]
#   all (default)  setup, check, ssh (when sshd exists), network, then cleanup unless POC_KEEP=1
# Environment: POC_PREFIX (default dshpoc) names the users and /srv/<prefix>; POC_SSH_PORT (default 2222).
set -u

PREFIX=${POC_PREFIX:-dshpoc}
OPERATOR=$PREFIX-op       # stands in for the operator's own account and home
HOST=$PREFIX-host         # step 1: the dedicated user that runs the whole DeepSeek Harness profile
WORKER=$PREFIX-worker     # step 2: the user that worker Sessions run as, reached over SSH
ROOT=/srv/$PREFIX
STATE=$ROOT/state         # dsh-superagent stateDir: database, worker-bin, worker-gitconfig
WORK=$ROOT/work           # Ticket directories (Execution settings, directory)
TICKET=$WORK/T-1
BIN=$ROOT/bin             # shared programs, such as the agent's gh wrapper
SSHDIR=$ROOT/sshd
PORT=${POC_SSH_PORT:-2222}
OP_HOME=/home/$OPERATOR
HOST_HOME=/home/$HOST
WORKER_HOME=/home/$WORKER
DSH_HOME=$HOST_HOME/.dsh
CTL=                      # the SSH control directory of the ssh leg
JAR=$HOST_HOME/dsh-superagent/.artifacts/control/profiles/superagent/cookies.txt

failures=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; failures=$((failures + 1)); }
note() { printf '      %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }

# Run a command as a user with a clean environment, the way a service manager would start it.
as() {
  local user=$1; shift
  runuser -u "$user" -- env -i HOME="/home/$user" USER="$user" LOGNAME="$user" PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 "$@"
}
# The environment dsh-superagent gives worker processes (src/infra/environment.ts, agentVariables and applyEnvironment).
as_worker() {
  as "$WORKER" PATH="$STATE/worker-bin:/usr/local/bin:/usr/bin:/bin" GIT_CONFIG_GLOBAL="$STATE/worker-gitconfig" \
    GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= "$@"
}
# Expect a command to succeed or to fail, printing the first line of its output.
expect_ok() {
  local label=$1; shift
  local out; if out=$("$@" 2>&1); then pass "$label"; else fail "$label"; fi
  [ -n "$out" ] && note "$(printf '%s' "$out" | head -n 3 | tr '\n' ' ' | cut -c1-160)"
  return 0
}
expect_denied() {
  local label=$1; shift
  local out; if out=$("$@" 2>&1); then fail "$label (it succeeded)"; else pass "$label"; fi
  [ -n "$out" ] && note "$(printf '%s' "$out" | head -n 1 | cut -c1-160)"
  return 0
}
# A denial only means something when the target exists and its owner can read it.
must_exist() { [ -e "$1" ] || { fail "control: $1 does not exist"; return 1; }; }

require_root() { [ "$(id -u)" = 0 ] || { echo 'Run as root (sudo) on a disposable Linux host.' >&2; exit 2; }; }

setup() {
  section "setup: users and layout"
  for tool in useradd runuser setfacl git python3; do
    command -v "$tool" >/dev/null || { echo "Missing $tool (Debian/Ubuntu: apt-get install acl git python3)." >&2; exit 2; }
  done
  for user in "$OPERATOR" "$HOST" "$WORKER"; do
    id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --user-group "$user"
    chmod 700 "/home/$user"
  done
  # No password, but not locked: sshd refuses even key logins to a locked account.
  usermod -p '*' "$WORKER"
  # The operator's private files.
  install -d -m 700 -o "$OPERATOR" -g "$OPERATOR" "$OP_HOME/.ssh" "$OP_HOME/.config/gh"
  printf 'github.com:\n  oauth_token: ghp_OPERATOR_PERSONAL_TOKEN\n' | install -m 600 -o "$OPERATOR" -g "$OPERATOR" /dev/stdin "$OP_HOME/.config/gh/hosts.yml"
  printf 'operator private key\n' | install -m 600 -o "$OPERATOR" -g "$OPERATOR" /dev/stdin "$OP_HOME/.ssh/id_ed25519"
  # The host user's DeepSeek Harness home: model credentials, a startup log with the launch token, the panel cookie jar.
  install -d -m 700 -o "$HOST" -g "$HOST" "$DSH_HOME" "$DSH_HOME/logs" "$DSH_HOME/profiles/superagent" "$(dirname "$JAR")"
  printf 'deepseek:\n  apiKey: sk-MODEL_PROVIDER_KEY\n' | install -m 600 -o "$HOST" -g "$HOST" /dev/stdin "$DSH_HOME/.credentials.yaml"
  # Deliberately world-readable: the host home's mode 700 must stop it on its own.
  printf 'dsh web: http://127.0.0.1:3082/?token=LAUNCH_TOKEN\n' | install -m 644 -o "$HOST" -g "$HOST" /dev/stdin "$DSH_HOME/logs/startup.log"
  printf '127.0.0.1\tFALSE\t/\tFALSE\t0\tdsh_session\tSESSION_COOKIE\n' | install -m 600 -o "$HOST" -g "$HOST" /dev/stdin "$JAR"
  printf 'merge account token\n' | install -m 600 -o "$HOST" -g "$HOST" /dev/stdin "$HOST_HOME/.config-gh-merge"
  # Agent GitHub CLI wrapper in a shared path; it selects the calling user's own gh-agent configuration (006, Accounts).
  install -d -m 755 "$BIN"
  cat > "$BIN/gh-agent" <<'EOF'
#!/bin/sh
# Stand-in for: GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
GH_CONFIG_DIR="$HOME/.config/gh-agent"
echo "gh-agent as $(id -un), config $GH_CONFIG_DIR, token $(cat "$GH_CONFIG_DIR/hosts.yml" 2>/dev/null | sed -n 's/.*oauth_token: //p')"
EOF
  chmod 755 "$BIN/gh-agent"
  for user in "$HOST" "$WORKER"; do
    install -d -m 700 -o "$user" -g "$user" "/home/$user/.config" "/home/$user/.config/gh-agent"
    printf 'github.com:\n  oauth_token: ghp_AGENT_TOKEN_for_%s\n' "$user" | install -m 600 -o "$user" -g "$user" /dev/stdin "/home/$user/.config/gh-agent/hosts.yml"
  done
  # stateDir, owned by the host user. The worker may only pass through it (x), so it reaches worker-bin and
  # worker-gitconfig by name but cannot list the directory or open orchestrator.sqlite (0600, as src/app/store.ts sets it).
  install -d -m 755 "$ROOT"
  install -d -m 700 -o "$HOST" -g "$HOST" "$STATE"
  setfacl -m "u:$WORKER:--x" "$STATE"
  printf 'SQLite format 3 (stand-in): triggers, settings, message previews\n' | install -m 600 -o "$HOST" -g "$HOST" /dev/stdin "$STATE/orchestrator.sqlite"
  # What writeEnvironment writes on every start: shims (0755) and the agent's git configuration (0644).
  install -d -m 755 -o "$HOST" -g "$HOST" "$STATE/worker-bin"
  runuser -u "$HOST" -- sh -c "cat > '$STATE/worker-bin/gh' && chmod 755 '$STATE/worker-bin/gh'" <<EOF
#!/bin/sh
# Written by dsh-superagent on every start; edits are lost.
exec '$BIN/gh-agent' "\$@"
EOF
  runuser -u "$HOST" -- sh -c "umask 022; cat > '$STATE/worker-gitconfig'" <<EOF
# Written by dsh-superagent on every start; edits are lost.
[user]
	useConfigOnly = true
[credential]
	helper =
[credential "https://github.com"]
	helper = "!'$BIN/gh-agent' auth git-credential"
EOF
  # Ticket root, shared by the host user (creates directories, removes them) and the worker user (works in them).
  # Default ACLs give both users rwx on everything created below, whatever either process's umask is.
  install -d -m 770 -o "$HOST" -g "$HOST" "$WORK"
  setfacl -m "u:$WORKER:rwx,u:$HOST:rwx" -m "d:u:$WORKER:rwx,d:u:$HOST:rwx,d:m::rwx" "$WORK"
  # A repository both may read, standing in for the clone the prepare command adds worktrees from.
  # It belongs to the host user, as the operator's clone would.
  if [ ! -d "$ROOT/origin.git" ]; then
    local seed; seed=$(mktemp -d)
    git -C "$seed" init -q -b main && printf 'hello\n' > "$seed/README" && git -C "$seed" add README &&
      git -C "$seed" -c user.name=seed -c user.email=seed@example.com commit -q -m seed &&
      git clone -q --bare "$seed" "$ROOT/origin.git"
    rm -rf "$seed"
    chown -R "$HOST:$HOST" "$ROOT/origin.git"
    chmod -R a+rX "$ROOT/origin.git"
  fi
  # The host user creates the Ticket directory (DshExecutor.prepareDirectory makes its parent with node:fs).
  runuser -u "$HOST" -- mkdir -p "$TICKET"
  pass "users $OPERATOR, $HOST, $WORKER and $ROOT ready"
  note "$(getfacl -p --omit-header "$STATE" 2>/dev/null | tr '\n' ' ')"
}

check_reads() {
  local runner=$1 who=$2
  section "check: what $WORKER cannot read ($who)"
  for file in "$DSH_HOME/.credentials.yaml" "$DSH_HOME/logs/startup.log" "$JAR" "$STATE/orchestrator.sqlite" \
              "$HOST_HOME/.config-gh-merge" "$HOST_HOME/.config/gh-agent/hosts.yml" "$OP_HOME/.config/gh/hosts.yml" "$OP_HOME/.ssh/id_ed25519"; do
    must_exist "$file" && expect_denied "cannot read $file" $runner cat "$file"
  done
  expect_denied "cannot list the operator's home $OP_HOME" $runner ls "$OP_HOME"
  expect_denied "cannot list the host user's home $HOST_HOME" $runner ls "$HOST_HOME"
  expect_denied "cannot list stateDir $STATE" $runner ls "$STATE"
  expect_denied "cannot replace a shim in $STATE/worker-bin" $runner sh -c "echo x > '$STATE/worker-bin/gh'"
  expect_denied "cannot rewrite $STATE/worker-gitconfig" $runner sh -c "echo x >> '$STATE/worker-gitconfig'"
}

check_work() {
  local runner=$1 who=$2
  section "check: what $WORKER can do ($who)"
  expect_ok "runs as $WORKER" $runner id
  expect_ok "reads the gh shim and the agent's own credentials" $runner gh auth status
  expect_ok "reads worker-gitconfig" $runner git config --global --get credential.https://github.com.helper
  local dir=$TICKET/$who
  # git refuses a repository another user owns unless safe.directory names it; worker-gitconfig names none.
  expect_denied "finding: git refuses the host user's repository by default" $runner git clone -q "$ROOT/origin.git" "$dir"
  $runner rm -rf "$dir" 2>/dev/null
  expect_denied "finding: a worktree of the host user's clone fails, since its git data is not the worker's to write" \
    $runner git -c "safe.directory=$ROOT/origin.git" -C "$ROOT/origin.git" worktree add -q "$dir-worktree"
  # A local clone ignores -c safe.directory (git clears it for the source side), so name it for upload-pack instead.
  expect_ok "clones into its Ticket directory (--no-local, safe.directory for upload-pack)" \
    $runner git clone -q --no-local -u "git -c safe.directory=$ROOT/origin.git upload-pack" "$ROOT/origin.git" "$dir"
  expect_ok "writes and commits there" $runner sh -c "cd '$dir' && printf 'change by %s\n' \"\$(id -un)\" >> README && git add README &&
    git -c user.name=agent -c user.email=agent@example.com commit -q -m 'worker change' && git log --oneline -1"
  expect_ok "the host user can read and delete what the worker wrote" runuser -u "$HOST" -- sh -c "cat '$dir/README' >/dev/null && rm -rf '$dir' && echo removed"
}

check() {
  section "check: process separation"
  runuser -u "$HOST" -- env -i SECRET_IN_ENV=cookie-value sleep 60 >/dev/null 2>&1 &
  disown
  sleep 1
  local child; child=$(pgrep -u "$HOST" -f 'sleep 60' | head -n 1)
  expect_ok "control: the host user reads its own process environment" as "$HOST" sh -c "tr '\\0' ' ' < /proc/$child/environ"
  expect_denied "cannot read the environment of a host-user process (/proc/$child/environ)" as "$WORKER" cat "/proc/$child/environ"
  kill "$child" 2>/dev/null
  check_reads as_worker local
  check_work as_worker local
  section "check: step 1 alone (workers still run as the host user)"
  expect_ok "the host user reads its own credentials, so its workers could too" as "$HOST" cat "$DSH_HOME/.credentials.yaml"
  expect_denied "the host user cannot read the operator's home" as "$HOST" ls "$OP_HOME"
  expect_denied "the host user cannot read the operator's personal gh token" as "$HOST" cat "$OP_HOME/.config/gh/hosts.yml"
}

ssh_leg() {
  section "ssh: the DeepSeek Harness SSH provider's connection to $WORKER@127.0.0.1"
  if ! command -v sshd >/dev/null && [ ! -x /usr/sbin/sshd ]; then
    note "sshd is not installed (Debian/Ubuntu: apt-get install openssh-server); skipping"; return 0
  fi
  install -d -m 755 /run/sshd
  install -d -m 700 "$SSHDIR"
  [ -f "$SSHDIR/host_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -f "$SSHDIR/host_ed25519"
  # sshd_config for a localhost-only daemon that admits only the worker user by key, permits the Unix-socket
  # forwarding the provider needs and nothing else, and sets the worker environment that the host's process.env no
  # longer carries across the SSH boundary.
  cat > "$SSHDIR/sshd_config" <<EOF
Port $PORT
ListenAddress 127.0.0.1
HostKey $SSHDIR/host_ed25519
PidFile $SSHDIR/sshd.pid
AllowUsers $WORKER
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
AllowAgentForwarding no
AllowTcpForwarding no
X11Forwarding no
PermitTunnel no
PermitTTY no
AllowStreamLocalForwarding local
StreamLocalBindUnlink yes
Match User $WORKER
  SetEnv PATH=$STATE/worker-bin:/usr/local/bin:/usr/bin:/bin GIT_CONFIG_GLOBAL=$STATE/worker-gitconfig GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
EOF
  /usr/sbin/sshd -t -f "$SSHDIR/sshd_config" || { fail "sshd_config does not validate"; return 0; }
  [ -f "$SSHDIR/sshd.pid" ] && kill "$(cat "$SSHDIR/sshd.pid")" 2>/dev/null && sleep 1
  /usr/sbin/sshd -f "$SSHDIR/sshd_config" -E "$SSHDIR/sshd.log" || { fail "sshd did not start"; return 0; }
  # The host user's key, its known_hosts entry and the OpenSSH alias the provider's `host` field names.
  install -d -m 700 -o "$HOST" -g "$HOST" "$HOST_HOME/.ssh"
  [ -f "$HOST_HOME/.ssh/id_ed25519" ] || runuser -u "$HOST" -- ssh-keygen -q -t ed25519 -N '' -f "$HOST_HOME/.ssh/id_ed25519"
  printf '[127.0.0.1]:%s %s\n' "$PORT" "$(cut -d' ' -f1,2 "$SSHDIR/host_ed25519.pub")" | install -m 600 -o "$HOST" -g "$HOST" /dev/stdin "$HOST_HOME/.ssh/known_hosts"
  cat <<EOF | install -m 600 -o "$HOST" -g "$HOST" /dev/stdin "$HOST_HOME/.ssh/config"
Host dsh-worker
  HostName 127.0.0.1
  Port $PORT
  User $WORKER
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
EOF
  install -d -m 700 -o "$WORKER" -g "$WORKER" "$WORKER_HOME/.ssh"
  # restrict: no pty, no agent or X11 forwarding; port-forwarding re-allows the stream-local forward the provider uses.
  printf 'restrict,port-forwarding %s\n' "$(cat "$HOST_HOME/.ssh/id_ed25519.pub")" | install -m 600 -o "$WORKER" -g "$WORKER" /dev/stdin "$WORKER_HOME/.ssh/authorized_keys"

  CTL=$(runuser -u "$HOST" -- mktemp -d /tmp/dsh-ssh-XXXXXX)
  # Stand-in for the remote helper: a Unix socket in a private directory of the worker, answering who serves it.
  local helper="$WORKER_HOME/.dsh-helper.py"
  cat > "$helper" <<'EOF'
import os, socket, sys, getpass
root = os.path.expanduser('~/.dsh-helper'); os.makedirs(root, mode=0o700, exist_ok=True)
path = os.path.join(root, 's0')
if os.path.exists(path): os.unlink(path)
server = socket.socket(socket.AF_UNIX); server.bind(path); os.chmod(path, 0o600); server.listen(1)
print(path, flush=True)
conn, _ = server.accept()
conn.sendall(f'stream served by uid={os.getuid()} ({getpass.getuser()})\n'.encode()); conn.close()
sys.stdin.read()  # stay up until the master closes, like the helper's lease
EOF
  chown "$WORKER:$WORKER" "$helper"
  # The master connection, with the options SshConnection.start passes (packages/ssh/ssh/src/index.ts). Its stdin and
  # stdout stay open pipes, as the provider keeps them for its RPC.
  runuser -u "$HOST" -- mkfifo "$CTL/in" "$CTL/out"
  exec 8<>"$CTL/out" 9<>"$CTL/in"
  runuser -u "$HOST" -- env -i HOME="$HOST_HOME" PATH=/usr/bin:/bin GIT_CONFIG_GLOBAL=/host/value/not/forwarded \
    ssh -T -M -S "$CTL/control" -o ControlPersist=no -o BatchMode=yes -o StrictHostKeyChecking=yes -o ForwardAgent=no \
    -o ClearAllForwardings=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3 dsh-worker "python3 $helper" \
    <"$CTL/in" >"$CTL/out" 2>"$SSHDIR/master.err" &
  local master=$!
  local remote=; read -r -t 15 remote <&8
  if [ -z "$remote" ]; then fail "master connection did not come up"; note "$(head -n 3 "$SSHDIR/master.err" | tr '\n' ' ')"; kill "$master" 2>/dev/null; return 0; fi
  pass "master connection up, opened as the provider opens it; remote helper socket $remote"
  local local_sock="$CTL/s0"
  expect_ok "ssh -O forward -L <local socket>:<remote socket> through the master" \
    runuser -u "$HOST" -- env -i HOME="$HOST_HOME" PATH=/usr/bin:/bin ssh -S "$CTL/control" -O forward -o ExitOnForwardFailure=yes -L "$local_sock:$remote" dsh-worker
  expect_ok "the forwarded stream reaches the worker-side socket" runuser -u "$HOST" -- python3 -c "
import socket; s = socket.socket(socket.AF_UNIX); s.connect('$local_sock'); print(s.recv(200).decode().strip())"
  # Commands over the same master, as the subprocess provider's requests would run.
  # shellcheck disable=SC2016 # expanded by the remote shell
  expect_ok "the remote environment comes from sshd SetEnv, not from the host process" \
    over_ssh sh -c 'echo "GIT_CONFIG_GLOBAL=$GIT_CONFIG_GLOBAL PATH=$PATH"'
  check_reads over_ssh ssh
  check_work over_ssh ssh
  runuser -u "$HOST" -- env -i HOME="$HOST_HOME" PATH=/usr/bin:/bin ssh -S "$CTL/control" -O exit dsh-worker 2>/dev/null
  exec 8>&- 9>&-
  wait "$master" 2>/dev/null
  rm -rf "$CTL"
}
# Run one command as the worker over the master connection, quoting each argument for the remote shell.
over_ssh() {
  runuser -u "$HOST" -- env -i HOME="$HOST_HOME" PATH=/usr/bin:/bin ssh -S "$CTL/control" dsh-worker "$(printf '%q ' "$@")"
}

network() {
  section "network: user separation alone does not limit it"
  local url=http://archive.ubuntu.com/ubuntu/
  expect_ok "$WORKER reaches $url" as "$WORKER" curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url"
  if command -v iptables >/dev/null && iptables -L OUTPUT -n >/dev/null 2>&1; then
    # One way to govern it per user: an owner match on the worker's uid (keep loopback for the SSH helper's sockets).
    iptables -I OUTPUT 1 -m owner --uid-owner "$WORKER" ! -o lo -j REJECT
    expect_denied "with an iptables owner rule, $WORKER cannot reach $url" as "$WORKER" curl -sS -o /dev/null --max-time 10 "$url"
    expect_ok "while $HOST still can" as "$HOST" curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url"
    iptables -D OUTPUT -m owner --uid-owner "$WORKER" ! -o lo -j REJECT
  else
    note "iptables is unavailable here; skipping the owner-match demonstration"
  fi
}

cleanup() {
  section "cleanup"
  [ -f "$SSHDIR/sshd.pid" ] && kill "$(cat "$SSHDIR/sshd.pid")" 2>/dev/null
  pkill -u "$WORKER" 2>/dev/null; pkill -u "$HOST" 2>/dev/null; sleep 1
  for user in "$OPERATOR" "$HOST" "$WORKER"; do id "$user" >/dev/null 2>&1 && userdel -r "$user" 2>/dev/null; done
  rm -rf "$ROOT"
  pass "removed the users and $ROOT"
}

require_root
case "${1:-all}" in
  setup) setup ;;
  check) check ;;
  ssh) ssh_leg ;;
  network) network ;;
  cleanup) cleanup ;;
  all) setup; check; ssh_leg; network; [ "${POC_KEEP:-0}" = 1 ] || cleanup ;;
  *) echo "usage: $0 [all|setup|check|ssh|network|cleanup]" >&2; exit 2 ;;
esac
printf '\n%s\n' "$([ "$failures" = 0 ] && echo 'All checks passed.' || echo "$failures check(s) failed.")"
[ "$failures" = 0 ]
