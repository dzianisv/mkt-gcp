# mkt-gcp

Deploys [mkt](https://github.com/stxkxs/mkt) as a headless alert daemon on a **free GCP e2-micro VM** behind a **Cloudflare Tunnel**.

Public API at `https://mkt.agentlabs.cc`. No open firewall ports.

---

## Quick start

**Prerequisites (local):**
- `gcloud` CLI with a `bisonte` named config authenticated to `bisonte.amigable@gmail.com`
- Bitwarden CLI (`bw`) unlocked — `source ~/.env.d/bitwarden.env`
- `curl`, `python3`

**Deploy:**
```bash
git clone https://github.com/dzianisv/mkt-gcp
cd mkt-gcp
bash deploy.sh
```

That's it. The script:
1. Creates the GCP VM (or starts it if stopped)
2. Upserts the Cloudflare DNS CNAME
3. Installs Go, Bun, mkt binary, systemd services on the VM
4. Verifies `https://mkt.agentlabs.cc/metrics` responds

Re-run any time to redeploy — idempotent.

---

## Setting alerts

SSH into the VM, then use `mkt-alert.ts`:

```bash
gcloud --configuration=bisonte compute ssh mkt-daemon \
  --zone=us-central1-a --project=mkt-daemon-alerts

# once on the VM:
cd ~/.agents/skills/mkt/scripts
```

**Add an alert:**
```bash
bun mkt-alert.ts add \
  --symbol BTC-USD \
  --condition below \
  --threshold 90000 \
  --channel telegram-bot:@CryptoAiInvestor \
  --reasoning "Support break — exit signal" \
  --link "https://your-analysis-url"
```

**List active alerts:**
```bash
bun mkt-alert.ts list
```

**Remove an alert:**
```bash
bun mkt-alert.ts remove <id>
```

Alerts are checked every 15 minutes by a systemd timer. When a condition fires, you get a notification with the reasoning and analysis link you attached.

---

## Alert conditions

| Condition | Meaning |
|---|---|
| `above` / `below` | price crosses threshold |
| `pct_up` / `pct_down` | price moves X% from current |
| `rsi_above` / `rsi_below` | RSI crosses value |
| `sma_cross_above` / `sma_cross_below` | price crosses SMA |
| `macd_cross` | MACD line crosses signal |

Supports stocks (`AAPL`, `CRM`) and crypto (`BTC-USD`, `ETH-USD`, `AAVE-USD`).

---

## Delivery channels

### Telegram (default)
Notifications go to `@CryptoAiInvestor` channel via the bot token in Bitwarden.

```bash
--channel telegram-bot:@CryptoAiInvestor
# or a private chat:
--channel telegram-bot:@yourusername
```

Message format:
```
🔔 BTC-USD crossed below 90000
Support break — exit signal
📊 https://your-analysis-url
```

**To use your own bot:** create one via [@BotFather](https://t.me/BotFather), add the token to Bitwarden as `mkt-daemon/telegram-bot-token`, redeploy.

### Email
Not yet wired. To add: set `RESEND_API_KEY` in Bitwarden as `mkt-daemon/resend-api-key`, then use:
```bash
--channel email:you@example.com
```
Requires a free [Resend](https://resend.com) account (3,000 emails/month free).

### ntfy (no account needed)
```bash
--channel ntfy:your-topic-name
# subscribe on phone: https://ntfy.sh/your-topic-name
```

---

## API

| Endpoint | Description |
|---|---|
| `GET /metrics` | Uptime, symbol count, alert count |
| `GET /quotes` | All cached prices |
| `GET /quotes/BTC-USD` | Single symbol |
| `GET /alerts` | Active mkt-native alert rules |

```bash
curl https://mkt.agentlabs.cc/quotes/BTC-USD
```

---

## Logs

```bash
gcloud --configuration=bisonte compute ssh mkt-daemon \
  --zone=us-central1-a --project=mkt-daemon-alerts \
  --command="sudo journalctl -u mkt-daemon -f"
```
