#!/usr/bin/env bash
# deploy.sh — redeploy mkt daemon on GCP e2-micro behind Cloudflare Tunnel
#
# Usage:
#   bash infra/mkt-daemon/deploy.sh
#
# Prereqs (local):
#   - gcloud with 'bisonte' named config authenticated
#   - bitwarden CLI (bw) unlocked: source ~/.env.d/bitwarden.env
#   - curl, python3, openssl
#
# Idempotent — safe to re-run. Skips already-done steps.
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
GCP_CONFIG="bisonte"
GCP_PROJECT="mkt-daemon-alerts"
GCP_ZONE="us-central1-a"
VM_NAME="mkt-daemon"
VM_TYPE="e2-micro"

CF_ACCOUNT_ID="c52033a95d560a9a183b016ceb1c107a"
CF_ZONE_ID="5fbeec0aa0dca842ab3b62fafb948fe9"
TUNNEL_NAME="mkt-daemon"
TUNNEL_HOST="mkt.agentlabs.cc"
MKT_LISTEN="127.0.0.1:9999"
MKT_COMMIT="0207dda"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SKILLS_DIR="$REPO_ROOT/.agents/skills/mkt/scripts"

# ── Helpers ───────────────────────────────────────────────────────────────────
log()  { echo "▶ $*"; }
ok()   { echo "  ✓ $*"; }
die()  { echo "  ✗ $*" >&2; exit 1; }

G()      { gcloud --configuration="$GCP_CONFIG" "$@"; }
SSH()    { G compute ssh "$VM_NAME" --zone="$GCP_ZONE" --project="$GCP_PROJECT" \
             --ssh-flag="-o ConnectTimeout=30 -o StrictHostKeyChecking=no" \
             --command="$1" 2>&1; }
SCP()    { G compute scp "$1" "$VM_NAME:$2" --zone="$GCP_ZONE" --project="$GCP_PROJECT" 2>&1; }
CF_API() { local m="$1" p="$2"; shift 2
           curl -sf -X "$m" "https://api.cloudflare.com/client/v4$p" \
             -H "Authorization: Bearer $CF_TOKEN" \
             -H "Content-Type: application/json" "$@"; }

# ── Phase 0: Secrets (from Bitwarden) ─────────────────────────────────────────
log "Phase 0: secrets"

source ~/.env.d/bitwarden.env 2>/dev/null || true
[[ "$(bw status 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])')" == "unlocked" ]] \
  || die "Bitwarden locked — run: source ~/.env.d/bitwarden.env"

source ~/.env.d/cloudflare.env 2>/dev/null || true
[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || die "CLOUDFLARE_API_TOKEN not set"
CF_TOKEN="$CLOUDFLARE_API_TOKEN"

TELEGRAM_BOT_TOKEN=$(bw get password "mkt-daemon/telegram-bot-token" 2>/dev/null) \
  || die "mkt-daemon/telegram-bot-token not found in Bitwarden"
CF_TUNNEL_TOKEN=$(bw get password "mkt-daemon/cf-tunnel-token" 2>/dev/null) \
  || die "mkt-daemon/cf-tunnel-token not found in Bitwarden"

# ntfy topic — generate once, save to Bitwarden; reuse on redeploy
NTFY_TOPIC=$(bw get password "mkt-daemon/ntfy-topic" 2>/dev/null || true)
if [[ -z "$NTFY_TOPIC" ]]; then
  NTFY_TOPIC="mkt-$(python3 -c 'import uuid; print(uuid.uuid4().hex[:16])')"
  bw get template item | python3 -c "
import sys,json,os
t=json.load(sys.stdin)
t['name']='mkt-daemon/ntfy-topic'
t['collectionIds']=['0a1e6ed2-6366-41d6-b0be-b457016ecf0a']
t['login']={'password':os.environ['NTFY_TOPIC']}
t['notes']='ntfy.sh topic for mkt alert notifications. Subscribe: https://ntfy.sh/'+os.environ['NTFY_TOPIC']
print(json.dumps(t))
" NTFY_TOPIC="$NTFY_TOPIC" | bw encode | bw create item > /dev/null
  ok "ntfy topic generated and saved to Bitwarden: $NTFY_TOPIC"
else
  ok "ntfy topic loaded from Bitwarden: $NTFY_TOPIC"
fi

ok "secrets loaded from Bitwarden"

# ── Phase 1: GCP VM ───────────────────────────────────────────────────────────
log "Phase 1: VM ($VM_NAME, $VM_TYPE, $GCP_ZONE)"

STATUS=$(G compute instances describe "$VM_NAME" \
  --zone="$GCP_ZONE" --project="$GCP_PROJECT" \
  --format="value(status)" 2>/dev/null || echo "ABSENT")

case "$STATUS" in
  RUNNING)   ok "VM running" ;;
  TERMINATED|STOPPED)
    G compute instances start "$VM_NAME" --zone="$GCP_ZONE" --project="$GCP_PROJECT"
    sleep 20; ok "VM started (was $STATUS)" ;;
  ABSENT)
    G compute instances create "$VM_NAME" \
      --project="$GCP_PROJECT" --zone="$GCP_ZONE" \
      --machine-type="$VM_TYPE" \
      --image-family=debian-12 --image-project=debian-cloud \
      --boot-disk-size=20GB --boot-disk-type=pd-standard
    sleep 30; ok "VM created" ;;
esac

# ── Phase 2: Cloudflare DNS ───────────────────────────────────────────────────
log "Phase 2: DNS ($TUNNEL_HOST)"

# Decode tunnel ID from token
TUNNEL_ID=$(echo "$CF_TUNNEL_TOKEN" | base64 -d 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['t'])")
ok "Tunnel ID: $TUNNEL_ID"

# Upsert CNAME
EXISTING=$(CF_API GET "/zones/$CF_ZONE_ID/dns_records?type=CNAME&name=$TUNNEL_HOST" \
  | python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(r[0]['id'] if r else '')" 2>/dev/null || true)
DNS_BODY="{\"type\":\"CNAME\",\"name\":\"mkt\",\"content\":\"$TUNNEL_ID.cfargotunnel.com\",\"proxied\":true,\"ttl\":1}"
if [[ -z "$EXISTING" ]]; then
  CF_API POST "/zones/$CF_ZONE_ID/dns_records" -d "$DNS_BODY" > /dev/null
  ok "DNS created"
else
  CF_API PUT "/zones/$CF_ZONE_ID/dns_records/$EXISTING" -d "$DNS_BODY" > /dev/null
  ok "DNS updated"
fi

# ── Phase 3: Remote setup ─────────────────────────────────────────────────────
log "Phase 3: remote setup (Go, Bun, mkt, systemd)"

# Write tmp env file (never committed)
TMP_ENV=$(mktemp)
cat > "$TMP_ENV" <<EOF
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
TELEGRAM_CHAT_ID=@CryptoAiInvestor
NTFY_TOPIC=${NTFY_TOPIC}
EOF

SCP "$TMP_ENV" "/tmp/mkt-daemon.env"
rm -f "$TMP_ENV"

# Upload skill scripts
for f in check.ts store.ts indicators.ts mkt-alert.ts; do
  SCP "$SKILLS_DIR/$f" "/tmp/$f"
done

SSH "$(cat << REMOTE
set -euo pipefail
export PATH=\$PATH:/usr/local/go/bin:\$HOME/.local/bin:\$HOME/.bun/bin

# ── apt deps ─────────────────────────────────────────────────────────────────
sudo apt-get install -y -qq unzip git curl 2>/dev/null

# ── Go ────────────────────────────────────────────────────────────────────────
if ! command -v go &>/dev/null; then
  curl -fsSL https://go.dev/dl/go1.22.4.linux-amd64.tar.gz | sudo tar -C /usr/local -xz
  echo 'export PATH=\$PATH:/usr/local/go/bin' | sudo tee /etc/profile.d/go.sh > /dev/null
fi
export PATH=\$PATH:/usr/local/go/bin

# ── mkt binary ────────────────────────────────────────────────────────────────
mkdir -p \$HOME/.local/bin \$HOME/.local/src
if [[ ! -f \$HOME/.local/bin/mkt ]]; then
  git clone --quiet https://github.com/stxkxs/mkt \$HOME/.local/src/mkt
  cd \$HOME/.local/src/mkt && git checkout ${MKT_COMMIT} -q
  go build -o \$HOME/.local/bin/mkt .
fi
echo "  mkt: \$(\$HOME/.local/bin/mkt version)"

# ── Bun ───────────────────────────────────────────────────────────────────────
if [[ ! -f \$HOME/.bun/bin/bun ]]; then
  curl -fsSL https://bun.sh/install | bash -s -- --no-modify-path 2>/dev/null
fi
export PATH=\$PATH:\$HOME/.bun/bin
echo "  bun: \$(bun --version)"

# ── skill scripts ─────────────────────────────────────────────────────────────
MKT_SCRIPTS=\$HOME/.agents/skills/mkt/scripts
mkdir -p "\$MKT_SCRIPTS"
cp /tmp/check.ts /tmp/store.ts /tmp/indicators.ts /tmp/mkt-alert.ts "\$MKT_SCRIPTS/"

# ── env / secrets ─────────────────────────────────────────────────────────────
sudo cp /tmp/mkt-daemon.env /etc/mkt-daemon.env
sudo chmod 600 /etc/mkt-daemon.env

# ── systemd: mkt-daemon ───────────────────────────────────────────────────────
U=\$(whoami)
sudo tee /etc/systemd/system/mkt-daemon.service > /dev/null << SVC
[Unit]
Description=mkt price daemon
After=network-online.target

[Service]
Type=simple
User=\$U
EnvironmentFile=/etc/mkt-daemon.env
Environment=HOME=/home/\$U
Environment=PATH=/usr/local/go/bin:/home/\$U/.local/bin:/home/\$U/.bun/bin:/usr/bin:/bin
ExecStart=/home/\$U/.local/bin/mkt daemon --listen ${MKT_LISTEN}
Restart=on-failure
RestartSec=15

[Install]
WantedBy=multi-user.target
SVC

# ── systemd: mkt-check timer (every 15 min) ───────────────────────────────────
sudo tee /etc/systemd/system/mkt-check.service > /dev/null << SVC
[Unit]
Description=mkt alert check

[Service]
Type=oneshot
User=\$U
EnvironmentFile=/etc/mkt-daemon.env
Environment=HOME=/home/\$U
Environment=PATH=/usr/local/go/bin:/home/\$U/.local/bin:/home/\$U/.bun/bin:/usr/bin:/bin
WorkingDirectory=/home/\$U/.agents/skills/mkt/scripts
ExecStart=/home/\$U/.bun/bin/bun check.ts
SVC

sudo tee /etc/systemd/system/mkt-check.timer > /dev/null << SVC
[Unit]
Description=mkt alert check every 15 min

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
Unit=mkt-check.service

[Install]
WantedBy=timers.target
SVC

sudo systemctl daemon-reload
sudo systemctl enable --now mkt-daemon mkt-check.timer
sudo systemctl restart mkt-daemon
sleep 3
sudo systemctl is-active mkt-daemon && echo "  ✓ mkt-daemon active"

# ── cloudflared ───────────────────────────────────────────────────────────────
if ! command -v cloudflared &>/dev/null; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bookworm main' \
    | sudo tee /etc/apt/sources.list.d/cloudflared.list
  sudo apt-get update -qq && sudo apt-get install -y -qq cloudflared
fi

# Reinstall service with current token (idempotent)
sudo cloudflared service install ${CF_TUNNEL_TOKEN} 2>/dev/null || true
sudo systemctl restart cloudflared
sleep 3
sudo systemctl is-active cloudflared && echo "  ✓ cloudflared active"
echo "=== done ==="
REMOTE
)"

ok "remote setup complete"

# ── Phase 4: Verify ───────────────────────────────────────────────────────────
log "Phase 4: verify"
sleep 5
if curl -sf "https://$TUNNEL_HOST/metrics" | grep -q "mkt_uptime"; then
  ok "https://$TUNNEL_HOST/metrics — OK"
else
  echo "  ⚠ tunnel not yet reachable — check: sudo journalctl -u cloudflared -n 20"
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅  https://$TUNNEL_HOST"
echo ""
echo "  📲 Subscribe to alerts (ntfy app):"
echo "     https://ntfy.sh/$NTFY_TOPIC"
echo ""
echo "  SSH: gcloud --configuration=bisonte compute ssh $VM_NAME --zone=$GCP_ZONE --project=$GCP_PROJECT"
echo "  Logs: sudo journalctl -u mkt-http -f"
echo "  Add alert: bun mkt-alert.ts add --symbol BTC-USD --condition below --threshold 90000 --channel ntfy:$NTFY_TOPIC --reasoning '...'"
echo "═══════════════════════════════════════════════════════"
