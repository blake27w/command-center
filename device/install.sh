#!/bin/bash
# ===========================================================================
# Command Center daemon — installer for the Mac mini
#
#   cd ~/code/command-center/device
#   cp config.example.env .env          # fill it in
#   cp workloads.example.json workloads.json   # fix the paths
#   ./install.sh
#
# Installs a launchd LaunchAgent so the daemon starts at login and restarts
# if it dies. launchd, not cron: cron won't restart a crashed process and
# has no concept of keeping something alive.
# ===========================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.blakewallace.commandcenter"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node || true)"

echo "==> Command Center daemon installer"

# --- preflight -------------------------------------------------------------
[ -n "$NODE" ] || { echo "!! node not found. brew install node"; exit 1; }
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 22 ] || { echo "!! node $MAJOR found, need 22+ (supabase-js needs native WebSocket)"; exit 1; }
echo "   node $("$NODE" -v) at $NODE"

[ -f "$HERE/.env" ] || { echo "!! $HERE/.env missing — cp config.example.env .env and fill it in"; exit 1; }
[ -f "$HERE/workloads.json" ] || echo "   (no workloads.json — only device.ping and recurrence.spawn will run)"

grep -q '^SUPABASE_SERVICE_KEY=.\+' "$HERE/.env" || { echo "!! SUPABASE_SERVICE_KEY is empty in .env"; exit 1; }

# --- deps ------------------------------------------------------------------
echo "==> installing dependencies"
cd "$HERE" && npm install --silent

mkdir -p "$HERE/logs"

# --- keep the mini awake ---------------------------------------------------
# A sleeping mini is a mini that silently stops working. These need sudo, so
# they are printed rather than run — read them before you paste them.
cat <<'EOS'

==> Recommended power settings (run these yourself, they need sudo):

    sudo pmset -a sleep 0 disksleep 0        # never sleep, never spin down the disk
    sudo pmset -a autorestart 1              # come back after a power cut
    sudo pmset -a womp 1                     # wake for network

    Also: System Settings -> Users & Groups -> Login Options -> enable
    automatic login, or the daemon won't start until someone logs in.

EOS

# --- launchd ---------------------------------------------------------------
echo "==> writing $PLIST"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--env-file=$HERE/.env</string>
    <string>$HERE/daemon.mjs</string>
  </array>

  <key>WorkingDirectory</key><string>$HERE</string>

  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>NetworkState</key><true/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>

  <key>StandardOutPath</key><string>$HERE/logs/stdout.log</string>
  <key>StandardErrorPath</key><string>$HERE/logs/stderr.log</string>

  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><false/>
</dict>
</plist>
PLISTEOF

echo "==> loading the agent"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load  "$PLIST"
sleep 3

if launchctl list | grep -q "$LABEL"; then
  echo "   running: $(launchctl list | grep "$LABEL")"
else
  echo "!! did not start — check $HERE/logs/stderr.log"; exit 1
fi

cat <<EOS

==> Done.

    Logs:     tail -f $HERE/logs/daemon.log
    Stop:     launchctl unload $PLIST
    Start:    launchctl load $PLIST

    Now prove the loop works. In the Supabase SQL editor:

        insert into jobs (kind) values ('device.ping');

    then, a second or two later:

        select status, result from jobs order by created_at desc limit 1;

    You should see status 'done' and a result containing this machine's
    hostname. If it stays 'queued', the daemon isn't reaching Supabase —
    check daemon.log.

EOS
