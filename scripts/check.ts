#!/usr/bin/env bun
import { loadJobs, markFired, isActive, type AlertJob, type Cond } from "./store.ts";
import { rsi, macd, sma } from "./indicators.ts";

const MKT_BIN = `${process.env.HOME}/.local/bin/mkt`;

export type JobData = {
  price: number;
  changePct?: number; // e.g. -2.30 for -2.30%
  closes?: number[];
};

/** Evaluate a single condition against provided data. Returns true if condition fires. */
function evalCond(cond: Cond, data: JobData): boolean {
  const { condition, value, period } = cond;
  const { price, changePct, closes } = data;

  switch (condition) {
    case "above": return price > value;
    case "below": return price < value;
    case "pct_up": return (changePct ?? 0) >= value;
    case "pct_down": return (changePct ?? 0) <= -Math.abs(value);
    case "volume_above": return false; // volume not available in current data path
    case "stddev_above": return false; // requires additional computation

    case "rsi_above": {
      if (!closes) return false;
      const r = rsi(closes, period ?? 14);
      return r > value;
    }
    case "rsi_below": {
      if (!closes) return false;
      const r = rsi(closes, period ?? 14);
      return r < value;
    }
    case "sma_cross_above": {
      if (!closes || closes.length < (period ?? 20) + 1) return false;
      const p = period ?? 20;
      const currentSma = sma(closes, p);
      const prevSma = sma(closes.slice(0, -1), p);
      const currentPrice = closes[closes.length - 1];
      const prevPrice = closes[closes.length - 2];
      return prevPrice <= prevSma && currentPrice > currentSma;
    }
    case "sma_cross_below": {
      if (!closes || closes.length < (period ?? 20) + 1) return false;
      const p = period ?? 20;
      const currentSma = sma(closes, p);
      const prevSma = sma(closes.slice(0, -1), p);
      const currentPrice = closes[closes.length - 1];
      const prevPrice = closes[closes.length - 2];
      return prevPrice >= prevSma && currentPrice < currentSma;
    }
    case "macd_cross": {
      if (!closes) return false;
      const m = macd(closes);
      // fires when histogram flips sign (any direction)
      return (m.prevHist < 0 && m.hist > 0) || (m.prevHist > 0 && m.hist < 0);
    }
    default:
      return false;
  }
}

/** Pure: evaluate a job given pre-fetched data. Returns { fires, reason }. */
export function evaluateJob(job: AlertJob, data: JobData): { fires: boolean; detail: string } {
  const results = job.conditions.map(c => ({
    cond: c,
    fires: evalCond(c, data),
  }));

  const mode = job.match ?? (job.conditions.length > 1 ? "all" : "all");
  let fires: boolean;

  if (mode === "any") {
    fires = results.some(r => r.fires);
  } else if (mode === "sequence") {
    // TODO: v1 treats sequence like "all"; proper ordering requires state across runs
    fires = results.every(r => r.fires);
  } else {
    // "all" (default)
    fires = results.every(r => r.fires);
  }

  const detail = results
    .map(r => `${r.cond.condition}:${r.cond.value}=${r.fires ? "✓" : "✗"}(price=${data.price})`)
    .join(", ");

  return { fires, detail };
}

/** Fetch current price and change% via mkt mcp get_quote. */
async function fetchPrice(symbol: string): Promise<{ price: number; changePct?: number }> {
  const mcpLines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "0" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_quote", arguments: { symbol } } }),
  ].join("\n") + "\n";

  const proc = Bun.spawn([MKT_BIN, "mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
  });

  proc.stdin.write(mcpLines);
  proc.stdin.end();

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  // Parse newline-delimited JSON; find the tools/call response (id=2)
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.id === 2 && obj.result?.content?.[0]?.text) {
        // "BTC-USD: $60184.2800 (as of ...)"
        const m = obj.result.content[0].text.match(/\$([0-9,.]+)/);
        if (m) return { price: parseFloat(m[1].replace(/,/g, "")) };
      }
    } catch {}
  }
  throw new Error(`could not parse price for ${symbol}`);
}

/**
 * Fetch OHLCV closes via mkt mcp query_history.
 * Uses `limit` bars (default 60 to give enough data for MACD 26+9=35 bars minimum).
 */
async function fetchCloses(symbol: string, limit = 60): Promise<number[]> {
  const mcpLines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "0" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "query_history", arguments: { symbol, limit } } }),
  ].join("\n") + "\n";

  const proc = Bun.spawn([MKT_BIN, "mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
  });

  proc.stdin.write(mcpLines);
  proc.stdin.end();

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.id === 2 && obj.result?.content?.[0]?.text) {
        // Parse lines like "  2026-06-21 O=... H=... L=... C=60178.02 V=..."
        const text: string = obj.result.content[0].text;
        const closes: number[] = [];
        for (const row of text.split("\n")) {
          const m = row.match(/C=([0-9.]+)/);
          if (m) closes.push(parseFloat(m[1]));
        }
        return closes;
      }
    } catch {}
  }
  throw new Error(`could not fetch closes for ${symbol}`);
}

/** Send notification over the configured channel. */
async function notify(channel: string, message: string): Promise<void> {
  if (channel === "stdout") {
    console.log(message);
    return;
  }
  if (channel.startsWith("telegram:")) {
    const target = channel.slice("telegram:".length);
    const proc = Bun.spawn(
      ["python3", `${process.env.HOME}/.agents/skills/telegram-cli/telegram-cli.py`, "send", target, message],
      { stdout: "inherit", stderr: "inherit" }
    );
    await proc.exited;
    return;
  }
  if (channel.startsWith("ntfy:")) {
    const topic = channel.slice("ntfy:".length);
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      body: message,
      headers: { "Content-Type": "text/plain" },
    });
    return;
  }
  // telegram-bot: uses the Bot API directly (no Telethon session required).
  // Needs TELEGRAM_BOT_TOKEN env var. Works from any server.
  if (channel.startsWith("telegram-bot:")) {
    const chatId = channel.slice("telegram-bot:".length);
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.error("telegram-bot: TELEGRAM_BOT_TOKEN not set, falling back to stdout");
      console.log(message);
      return;
    }
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });
    return;
  }
  if (channel.startsWith("email:")) {
    const to = channel.slice("email:".length);
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn("⚠️  RESEND_API_KEY not set — falling back to stdout");
      console.log(message);
      return;
    }
    const from = process.env.EMAIL_FROM ?? "alerts@resend.dev";
    const subjectMatch = message.match(/^🔔 mkt alert — (\S+)/);
    const subject = subjectMatch ? `🔔 mkt alert — ${subjectMatch[1]}` : "🔔 mkt alert";
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text: message }),
    });
    return;
  }
  console.log(`[channel:${channel}] ${message}`);
}

/** True when the condition needs historical closes (indicators). */
function needsCloses(cond: Cond): boolean {
  return ["rsi_above", "rsi_below", "sma_cross_above", "sma_cross_below", "macd_cross"].includes(
    cond.condition
  );
}

async function main() {
  // Check mkt is accessible
  const which = Bun.spawnSync(["which", "mkt"], {
    env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
  });
  if (which.exitCode !== 0) {
    console.error("⚠️  mkt not found on PATH — install mkt and ensure ~/.local/bin is on PATH");
    process.exit(1);
  }

  const dryRun = process.argv.includes("--dry-run");
  const idFilter = (() => {
    const i = process.argv.indexOf("--id");
    return i !== -1 ? process.argv[i + 1] : undefined;
  })();

  const jobs = loadJobs();
  const now = new Date();

  for (const job of jobs) {
    if (idFilter && job.id !== idFilter) continue;

    if (!isActive(job, now)) {
      const reason = job.fired ? "one-shot already fired" : job.expiry && new Date(job.expiry) < now ? "expired" : "cooldown";
      console.log(`[${job.id}] skipped (${reason})`);
      continue;
    }

    let data: JobData;
    try {
      const { price, changePct } = await fetchPrice(job.symbol);
      let closes: number[] | undefined;
      if (job.conditions.some(needsCloses)) {
        closes = await fetchCloses(job.symbol);
      }
      data = { price, changePct, closes };
    } catch (e) {
      console.error(`[${job.id}] error fetching data: ${e}`);
      continue;
    }

    const { fires, detail } = evaluateJob(job, data);

    if (fires) {
      const ts = now.toISOString();
      const msg =
        `🔔 mkt alert — ${job.symbol} fired @ ${data.price} (${ts})\n` +
        `Conditions: ${detail}\n` +
        `WHY: ${job.reasoning}` +
        (job.analysisLink ? `\n📊 Analysis: ${job.analysisLink}` : "");

      console.log(`[${job.id}] FIRED — ${detail}`);

      if (!dryRun) {
        await notify(job.channel, msg);
        markFired(job.id, ts);
      } else {
        console.log(`  [dry-run] would notify ${job.channel}:`);
        console.log(`  ${msg.replace(/\n/g, "\n  ")}`);
      }
    } else {
      console.log(`[${job.id}] no-fire (${detail})`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
