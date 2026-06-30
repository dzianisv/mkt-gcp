#!/usr/bin/env bun
/**
 * mkt-alerts — manage alerts on the remote mkt daemon via HTTP API
 *
 * Config: ~/.config/mkt-watch/auth.json
 *   { "apiUrl": "https://mkt.agentlabs.cc", "token": "<API_TOKEN>" }
 *   (written by deploy.sh — run that first)
 *
 * Usage:
 *   bun mkt-alerts.ts subscribe
 *   bun mkt-alerts.ts add --symbol BTC-USD --condition below --value 90000 --reason "..." [--link <url>] [--cooldown <sec>]
 *   bun mkt-alerts.ts list
 *   bun mkt-alerts.ts remove --id <id>
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ── Config ────────────────────────────────────────────────────────────────────

const AUTH_PATH = join(homedir(), ".config", "mkt-watch", "auth.json");

type Auth = { apiUrl: string; token: string };

function loadAuth(): Auth {
  if (!existsSync(AUTH_PATH))
    die(`Config not found: ${AUTH_PATH}\nRun 'bash deploy.sh' first.`);
  return JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Auth;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

function flagAll(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++)
    if (args[i] === `--${name}` && i + 1 < args.length) out.push(args[i + 1]);
  return out;
}

async function api(auth: Auth, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${auth.apiUrl}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) die(`API error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// ── Commands ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const sub = args[0];

if (!sub || sub === "--help" || sub === "-h") {
  console.log(`mkt-alerts — manage alerts on the remote mkt daemon

commands:
  subscribe                     print ntfy subscribe URL
  add     --symbol <SYM>        add an alert
          --condition <cond>    condition (below, above, rsi_below, …); repeat for compound
          --value <num>         threshold; one per --condition
          --reason <text>       why you set this alert
          [--link <url>]        optional analysis URL in the notification
          [--cooldown <sec>]    re-alert after N seconds (default: one-shot)
          [--desk crypto|stocks]
  list                          list active alerts
  remove  --id <id>             remove alert by ID

valid conditions:
  above, below, pct_up, pct_down,
  rsi_above, rsi_below, sma_cross_above, sma_cross_below,
  macd_cross, volume_above, stddev_above

config: ${AUTH_PATH}`);
  process.exit(0);
}

const auth = loadAuth();

if (sub === "subscribe") {
  const data = await api(auth, "GET", "/subscribe") as { subscribe_url: string };
  console.log(`\n📲  Subscribe to alerts in the ntfy app:\n`);
  console.log(`    ${data.subscribe_url}`);
  console.log(`\n    iOS / Android: https://ntfy.sh/#download`);
  console.log(`    Browser:        ${data.subscribe_url}\n`);

} else if (sub === "list") {
  const jobs = await api(auth, "GET", "/alerts") as any[];
  if (!jobs.length) { console.log("no alerts"); process.exit(0); }
  console.log("ID".padEnd(36) + " SYMBOL".padEnd(10) + " CONDITIONS".padEnd(30) + " STATUS   REASON");
  console.log("─".repeat(110));
  const now = new Date();
  for (const j of jobs) {
    const conds = j.conditions.map((c: any) => `${c.condition}@${c.value}`).join(",");
    const expired = j.expiry && new Date(j.expiry) < now;
    const status = j.fired ? "fired" : expired ? "expired" : "active";
    const reason = (j.reasoning ?? "").slice(0, 40);
    console.log(`${j.id.padEnd(36)} ${j.symbol.padEnd(9)} ${conds.padEnd(29)} ${status.padEnd(9)} ${reason}`);
    if (j.analysisLink) console.log(" ".repeat(37) + "📊 " + j.analysisLink);
  }

} else if (sub === "remove") {
  const id = flag(args, "id") ?? die("--id required");
  await api(auth, "DELETE", `/alerts/${id}`);
  console.log(`removed ${id}`);

} else if (sub === "add") {
  const symbol     = flag(args, "symbol")    ?? die("--symbol required");
  const reasoning  = flag(args, "reason")    ?? die("--reason required");
  const conditions = flagAll(args, "condition");
  const values     = flagAll(args, "value");
  const desk       = flag(args, "desk")      ?? "crypto";
  const link       = flag(args, "link");
  const cooldown   = flag(args, "cooldown");

  if (!conditions.length) die("--condition required");
  if (conditions.length !== values.length) die("each --condition needs a --value");

  const body: any = {
    symbol: symbol.toUpperCase(),
    reasoning,
    desk,
    conditions: conditions.map((c, i) => ({ condition: c, value: parseFloat(values[i]) })),
    ...(link     ? { analysisLink: link }              : {}),
    ...(cooldown ? { cooldownSec: parseInt(cooldown) } : {}),
  };

  const job = await api(auth, "POST", "/alerts", body) as any;
  console.log(`\nadded alert:`);
  console.log(`  id:        ${job.id}`);
  console.log(`  symbol:    ${job.symbol}`);
  console.log(`  condition: ${job.conditions.map((c: any) => `${c.condition} @ ${c.value}`).join(", ")}`);
  console.log(`  reason:    ${job.reasoning}`);
  if (job.analysisLink) console.log(`  link:      ${job.analysisLink}`);
  console.log(`\nNotification → see bun mkt-alerts.ts subscribe for your ntfy URL`);

} else {
  die(`unknown command: ${sub}. Run with --help.`);
}
