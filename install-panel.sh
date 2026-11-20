#!/usr/bin/env bash

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HOME/minecraft-panel"
SERVICE="minecraft-panel"
ENVFILE="/etc/minecraft-panel.env"
SYSTEMCTL=/usr/bin/systemctl

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run this as your normal user, not as root. It asks for your password when it needs it."
command -v apt-get >/dev/null 2>&1 || die "This script is for Ubuntu or Debian (it needs apt-get)."
[ -f "$HERE/panel/server.js" ] || die "I cannot find panel/server.js next to this script. Keep the whole unpacked folder together."
[ -x "$SYSTEMCTL" ] || die "$SYSTEMCTL does not exist on this system (the panel needs systemd)."

declare -A CFG=()
if sudo test -f "$ENVFILE"; then
  while IFS="=" read -r k v; do if [[ "$k" =~ ^[A-Z][A-Z0-9_]*$ ]]; then CFG[$k]="$v"; fi; done < <(sudo cat "$ENVFILE")
fi
PORT="${CFG[PORT]:-${PORT:-8790}}"

say "1/5  Node.js"
if ! command -v node >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y nodejs
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js is too old ($(node --version)); the panel needs version 18 or newer (20 or newer is better). Install a current LTS from https://nodejs.org/en/download and run this again."
echo "Node.js $(node --version) is ready."

say "2/5  Copying the panel to $TARGET"
mkdir -p "$TARGET"
cp -rf "$HERE"/panel/. "$TARGET"/
if ( cd "$TARGET" && node test.js >/tmp/minecraft-panel-test.log 2>&1 ); then
  echo "The panel's self-check passed."
else
  cat /tmp/minecraft-panel-test.log
  echo "WARNING: the panel's self-check failed on this computer (output above). Installing anyway; if something does not work, send that output to whoever you got this from."
fi
id -nG | grep -qwE 'adm|systemd-journal' || echo "NOTE: your user is not in the 'adm' group, so the panel's Console tab may not be able to read the log."

say "3/5  Settings"
CF="${CFG[CURSEFORGE_KEY]:-}"
unset 'CFG[PANEL_HASH]'
DATA="$HOME/.minecraft-panel"
if [ -n "${RESET_ACCESS:-}" ]; then rm -f "$DATA/access.json"; echo "Access was reset: the next device to open the panel with the setup code becomes the owner."; fi
if [ -z "${CFG[PORT]:-}" ] || [ -n "${SET_CURSEFORGE_KEY:-}" ]; then
  echo
  echo "Optional: to install mods from CurseForge the panel needs YOUR OWN free CurseForge API key"
  echo "(console.curseforge.com, API keys). Paste it (nothing is shown) or just press Enter to skip."
  echo "You can add it later with:  SET_CURSEFORGE_KEY=1 bash install-panel.sh"
  read -rs -p "CurseForge API key: " CF; echo
  KEY_RE='^[A-Za-z0-9$./_-]{20,200}$'
  if [ -n "$CF" ] && ! [[ "$CF" =~ $KEY_RE ]]; then echo "That does not look like a CurseForge API key, so I did not save it."; CF=""; fi
fi
if [ -z "${CFG[MC_DIR]:-}" ]; then
  if [ -f "$HOME/minecraft-server/server.properties" ]; then CFG[MC_DIR]="$HOME/minecraft-server"; else CFG[MC_DIR]="$HOME/.minecraft-panel/no-main-server"; fi
fi
if [ -z "${CFG[JAVA_HEAP_MB]:-}" ]; then
  HEAP_MB="$(sed -n 's/.*-Xmx\([0-9]*\)M.*/\1/p' /etc/systemd/system/minecraft.service 2>/dev/null | head -1)"
  if [ -z "$HEAP_MB" ]; then
    HEAP_MB="$(awk '/MemTotal/ { printf "%d", $2 / 1024 / 2 }' /proc/meminfo)"
    [ "$HEAP_MB" -ge 1024 ] || HEAP_MB=1024
    [ "$HEAP_MB" -le 4096 ] || HEAP_MB=4096
  fi
  CFG[JAVA_HEAP_MB]="$HEAP_MB"
fi
CFG[PORT]="$PORT"
CFG[MC_VERSION]="${CFG[MC_VERSION]:-${MC_VERSION:-26.3}}"
CFG[PANEL_MAX_RUNNING]="${CFG[PANEL_MAX_RUNNING]:-1}"
if [ -n "$CF" ]; then CFG[CURSEFORGE_KEY]="$CF"; fi
for k in "${!CFG[@]}"; do printf '%s=%s\n' "$k" "${CFG[$k]}"; done | sort | sudo tee "$ENVFILE" >/dev/null
MC_DIR="${CFG[MC_DIR]}"
sudo chown root:root "$ENVFILE"
sudo chmod 600 "$ENVFILE"

say "4/5  Letting the panel start and stop Minecraft servers (and nothing else), and the template for new servers"
sudo tee /usr/local/bin/mcctl >/dev/null <<'EOF'
#!/bin/bash
# Lets the Minecraft panel start, stop or restart a Minecraft server, and nothing else. Installed by install-panel.sh.
set -eu
action="${1:-}"
id="${2:-}"
case "$action" in start|stop|restart) ;; *) echo "usage: mcctl start|stop|restart <server>" >&2; exit 2 ;; esac
[[ "$id" =~ ^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$ ]] || { echo "bad server name" >&2; exit 2; }
if [ "$id" = main ]; then unit=minecraft; else unit="minecraft@$id"; fi
exec /usr/bin/systemctl "$action" "$unit"
EOF
sudo chown root:root /usr/local/bin/mcctl
sudo chmod 755 /usr/local/bin/mcctl
RULE="$(mktemp)"
printf '%s ALL=(root) NOPASSWD: /usr/local/bin/mcctl\n' "$(id -un)" > "$RULE"
sudo visudo -cf "$RULE" >/dev/null || { rm -f "$RULE"; die "The sudo rule did not pass the check, so I did not install it."; }
sudo install -m 440 -o root -g root "$RULE" /etc/sudoers.d/minecraft-panel
rm -f "$RULE"
RESTARTS="$SYSTEMCTL restart $SERVICE"
for u in ${EXTRA_RESTART_UNITS:-}; do [[ "$u" =~ ^[a-z0-9@._-]+$ ]] && RESTARTS="$RESTARTS, $SYSTEMCTL restart $u"; done
RULE2="$(mktemp)"
printf '%s ALL=(root) NOPASSWD: %s\n' "$(id -un)" "$RESTARTS" > "$RULE2"
sudo visudo -cf "$RULE2" >/dev/null || { rm -f "$RULE2"; die "The restart rule did not pass the check, so I did not install it."; }
sudo install -m 440 -o root -g root "$RULE2" /etc/sudoers.d/minecraft-panel-update
rm -f "$RULE2"
SERVERS_DIR="$HOME/minecraft-servers"
mkdir -p "$SERVERS_DIR" "$HOME/minecraft-java"
sudo tee /etc/systemd/system/minecraft@.socket >/dev/null <<EOF
[Unit]
Description=Minecraft server console (%i)
BindsTo=minecraft@%i.service

[Socket]
ListenFIFO=/run/minecraft-%i.stdin
SocketMode=0660
SocketUser=$(id -un)
RemoveOnStop=true
FlushPending=true
EOF
sudo tee /etc/systemd/system/minecraft@.service >/dev/null <<EOF
[Unit]
Description=Minecraft server %i
After=network-online.target minecraft@%i.socket
Wants=network-online.target
Requires=minecraft@%i.socket

[Service]
User=$(id -un)
WorkingDirectory=$SERVERS_DIR/%i
Sockets=minecraft@%i.socket
StandardInput=socket
StandardOutput=journal
StandardError=journal
ExecStart=/bin/sh $SERVERS_DIR/%i/launch.sh
SuccessExitStatus=143
Restart=on-failure
RestartSec=10
TimeoutStopSec=90
Nice=5
OOMScoreAdjust=300
EOF
sudo tee /etc/systemd/system/$SERVICE.service >/dev/null <<EOF
[Unit]
Description=Minecraft panel
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$TARGET
EnvironmentFile=$ENVFILE
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3
Nice=5
MemoryMax=300M

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE" >/dev/null 2>&1
sudo systemctl restart "$SERVICE"

say "5/5  Checking and firewall"
UP=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if node -e "fetch('http://127.0.0.1:$PORT/api/hello').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; then UP=1; break; fi
  sleep 1
done
if [ -z "$UP" ]; then
  sudo journalctl -u "$SERVICE" -n 20 --no-pager -o cat || true
  die "The panel did not start (log above)."
fi
echo "The panel answers."
if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q "Status: active"; then
  for net in 192.168.0.0/16 10.0.0.0/8 172.16.0.0/12 100.64.0.0/10; do
    sudo ufw allow from "$net" to any port "$PORT" proto tcp
    sudo ufw allow from "$net" to any port 8100 proto tcp
    sudo ufw allow from "$net" to any port 19132:19200 proto udp
    sudo ufw allow from "$net" to any port 19132:19200 proto tcp
  done
  echo "Opened port $PORT (and 8100 for the live map, UDP 19132-19200 for Bedrock players and Bedrock servers) for the home network and Tailscale only."
  sudo ufw allow 25565:25600/tcp
  echo "Opened ports 25565-25600 for Minecraft servers."
else
  echo "The firewall is off, so there is nothing to open."
fi

HAVE_PW=""
if [ -t 0 ] && PANEL_DATA="$DATA" node "$TARGET/set-password.js" --needed; then
  say "Password"
  echo "You can choose a password for the panel. Nothing shows while you type. Press Enter to skip it and use a one-time setup code instead."
  read -rs -p "Password (8 or more characters): " PW; echo
  if [ -n "$PW" ]; then
    if printf '%s' "$PW" | PANEL_DATA="$DATA" node "$TARGET/set-password.js" owner --stdin; then
      HAVE_PW=1
      curl -s -m 5 "http://127.0.0.1:$PORT/api/me" >/dev/null 2>&1 || true
    else
      echo "That password was not accepted, so none was set (the setup code below works)."
    fi
  fi
  unset PW
fi

say "All set"
CODE="$(cat "$DATA/setup-code.txt" 2>/dev/null || true)"
if [ -n "$HAVE_PW" ]; then
  echo "Open one of these on the phone or computer that should be the owner and sign in with the password you chose:"
  for ip in $(hostname -I 2>/dev/null); do
    case "$ip" in *:*) ;; *) echo "    http://$ip:$PORT" ;; esac
  done
  echo "(Change it later on the Access tab, or with:  node $TARGET/set-password.js owner)"
elif [ -n "$CODE" ]; then
  echo "Nobody owns the panel yet. On the phone or computer that should be the owner, open one of these (it fills in the setup code):"
  for ip in $(hostname -I 2>/dev/null); do
    case "$ip" in *:*) ;; *) echo "    http://$ip:$PORT/#claim=$CODE" ;; esac
  done
  echo "Or open the address without the part after the # and type the setup code:  $CODE"
  echo "(It is also in $DATA/setup-code.txt, and it is used up once somebody becomes the owner.)"
else
  echo "Open one of these in a browser. A device that is not let in yet asks for access, and the owner says yes on the Access tab:"
  for ip in $(hostname -I 2>/dev/null); do
    case "$ip" in *:*) ;; *) echo "    http://$ip:$PORT" ;; esac
  done
fi
echo
echo "It only answers on your home network and through Tailscale. Do NOT put it on Tailscale Funnel or forward it on the router."
echo "Useful commands:"
echo "    journalctl -u $SERVICE -f        who got in, what was done"
echo "    sudo systemctl restart $SERVICE  restart the panel"
echo "To remove it: sudo systemctl disable --now $SERVICE; sudo rm /etc/systemd/system/$SERVICE.service /etc/sudoers.d/minecraft-panel $ENVFILE; rm -r $TARGET"
