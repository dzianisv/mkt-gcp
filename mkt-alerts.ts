#!/usr/bin/env bun
/**
 * mkt-alerts — manage alerts on the remote mkt daemon
 *
 * Usage:
 *   bun mkt-alerts.ts subscribe                         print ntfy subscribe URL
 *   bun mkt-alerts.ts add --symbol BTC-USD \
 *                         --condition below --value 90000 \
 *                         --reason "support break" \
 *                         [--link <url>] [--cooldown <sec>]
 *   bun mkt-alerts.ts list
 *   bun mkt-alerts.ts remove --id <id>
 *
 * Config: ~/.config/mkt-gcp.json  (written by deploy.sh)
 *   { "vm": "mkt-daemon", "zone": "us-central1-a", "project": "mkt-daemon-alerts",
 *     "gcloudConfig": "bisonte", "ntfyTopic": "mkt-xxxx", "apiUrl": "https://mkt.agentlabs.cc" }
 */

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".config", "mkt-gcp.json");

type Config = {
  vm: string;
  zone: string;
  project: string;
  gcloudConfig: string;
  ntfyTopic: string;
  apiUrl: string;
};

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    die(`Config not found: ${CONFIG_PATH}\nRun 'bash deploy.sh' first.`);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
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

function ssh(cfg: Config, command: string): string {
  const cmd = [
    "gcloud", `--configuration=${cfg.gcloudConfig}`,
    "compute", "ssh", cfg.vm,
    `--zone=${cfg.zone}`, `--project=${cfg.project}`,
    "--ssh-flag=-o StrictHostKeyChecking=no",
    `--command=${command}`,
  ].join(" ");
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
  } catch (e: any) {
    die(`SSH failed: ${e.stderr || e.message}`);
  }
}

const SCRIPTS = "~/.agents/skills/mkt/scripts";

// ── Commands ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const sub = args[0];

if (!sub || sub === "--help" || sub === "-h") {
  console.log(`mkt-alerts — manage alerts on the remote mkt daemon

commands:
  subscribe                          print ntfy subscribe URL
  add     --symbol <SYM>             add an alert
          --condition <cond>         condition (below, above, rsi_below, …)
          --value <num>              threshold value
          --reason <text>            why you set this alert
          [--link <url>]             optional analysis URL attached to notification
          [--cooldown <sec>]         re-alert after N seconds (default: one-shot)
          [--desk crypto|stocks]     default: crypto
  list                               list active alerts
  remove  --id <id>                  remove alert by ID

valid conditions:
  above, below, pct_up, pct_down,
  rsi_above, rsi_below, sma_cross_above, sma_cross_below,
  macd_cross, volume_above, stddev_above

config: ${CONFIG_PATH}
  (written by deploy.sh — run that first)`);
  process.exit(0);
}

const cfg = loadConfig();

// ── subscribe ─────────────────────────────────────────────────────────────────

if (sub === "subscribe") {
  console.log(`\n📲  Subscribe to alerts in the ntfy app:\n`);
  console.log(`    https://ntfy.sh/${cfg.ntfyTopic}`);
  console.log(`\n    iOS / Android: https://ntfy.sh/#download`);
  console.log(`    Browser:        https://ntfy.sh/${cfg.ntfyTopic}\n`);
  process.exit(0);
}

// ── list ──────────────────────────────────────────────────────────────────────

if (sub === "list") {
  const out = ssh(cfg, `cd ${SCRIPTS} && bun mkt-alert.ts list`);
  console.log(out);
  process.exit(0);
}

// ── remove ────────────────────────────────────────────────────────────────────

if (sub === "remove") {
  const id = flag(args, "id") ?? die("--id required");
  const out = ssh(cfg, `cd ${SCRIPTS} && bun mkt-alert.ts remove --id ${id}`);
  console.log(out);
  process.exit(0);
}

// ── add ───────────────────────────────────────────────────────────────────────

if (sub === "add") {
  const symbol    = flag(args, "symbol")    ?? die("--symbol required");
  const reason    = flag(args, "reason")    ?? die("--reason required");
  const conditions = flagAll(args, "condition");
  const values     = flagAll(args, "value");
  const desk      = flag(args, "desk")      ?? "crypto";
  const link      = flag(args, "link");
  const cooldown  = flag(args, "cooldown");

  if (!conditions.length) die("--condition required");
  if (conditions.length !== values.length) die("each --condition needs a --value");

  // Use the configured ntfy topic as default channel
  const channel = flag(args, "channel") ?? `ntfy:${cfg.ntfyTopic}`;

  const condParts = conditions
    .map((c, i) => `--condition ${c} --value ${values[i]}`)
    .join(" ");

  const extraParts = [
    link      ? `--link ${JSON.stringify(link)}`         : "",
    cooldown  ? `--cooldown ${cooldown}`                  : "",
  ].filter(Boolean).join(" ");

  const remote = [
    `cd ${SCRIPTS}`,
    `&& bun mkt-alert.ts add`,
    `--symbol ${symbol.toUpperCase()}`,
    condParts,
    `--reason ${JSON.stringify(reason)}`,
    `--channel ${channel}`,
    `--desk ${desk}`,
    extraParts,
  ].join(" ");

  const out = ssh(cfg, remote);
  console.log(out);
  process.exit(0);
}

die(`unknown command: ${sub}. Run with --help.`);
