---
description: Manage price and indicator alerts on mkt daemon. Use when the user wants to set, list, or remove a price alert for a stock or crypto asset, or when analysis concludes with a specific entry/exit condition worth monitoring.
---

# mkt-alerts

Set, list, and remove price/indicator alerts on a self-hosted mkt daemon. Alerts fire via ntfy push notification with the reasoning and analysis link attached.

## Prerequisites

`~/.config/mkt-watch/auth.json` must exist (written by `deploy.sh`):
```json
{ "apiUrl": "https://mkt.agentlabs.cc", "token": "<API_TOKEN>" }
```

If missing: `git clone https://github.com/dzianisv/mkt-alerts && cd mkt-alerts && bash deploy.sh`

## CLI

```bash
# Get your ntfy subscribe URL (open in ntfy app on phone)
npx @dzianisv/mkt-alerts subscribe

# Add an alert
npx @dzianisv/mkt-alerts add \
  --symbol BTC-USD \
  --condition below --value 90000 \
  --reason "Support break — invalidates bull thesis" \
  --link "https://..." \
  --desk crypto

# List active alerts
npx @dzianisv/mkt-alerts list

# Remove an alert
npx @dzianisv/mkt-alerts remove --id <id>
```

## Conditions

| Condition | Meaning |
|---|---|
| `above` / `below` | price crosses threshold |
| `pct_up` / `pct_down` | price moves X% from current |
| `rsi_above` / `rsi_below` | RSI crosses value |
| `sma_cross_above` / `sma_cross_below` | price crosses SMA |
| `macd_cross` | MACD line crosses signal |
| `volume_above` | volume exceeds threshold |

Supports: stocks (`AAPL`, `CRM`) and crypto (`BTC-USD`, `ETH-USD`, `AAVE-USD`, `SOL-USD`).
Compound: repeat `--condition`/`--value` pairs (ALL must be true).

## Agent workflow

When analysis produces an actionable entry/exit level:
1. Determine `--symbol`, `--condition`, `--value` from the analysis
2. Write a concise `--reason` (one sentence: what the condition means)
3. Pass `--link` to the analysis report/Notion page
4. Run the add command above

Example after a multi-lens quorum concludes BTC support at $92k:
```bash
npx @dzianisv/mkt-alerts add \
  --symbol BTC-USD \
  --condition below --value 92000 \
  --reason "Breaks key support — quorum says exit/reduce" \
  --link "https://notion.so/..." \
  --desk crypto
```

Notification delivered to ntfy → phone push within 15 minutes of condition being met.
