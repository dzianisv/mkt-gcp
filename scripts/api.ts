#!/usr/bin/env bun
/**
 * api.ts — secure HTTP API wrapping mkt daemon
 *
 * Endpoints (all require Authorization: Bearer <API_TOKEN>):
 *   GET  /subscribe        → { subscribe_url }  (ntfy topic for this instance)
 *   GET  /alerts           → list alert jobs
 *   POST /alerts           → add alert job
 *   DELETE /alerts/:id     → remove alert job
 *   GET  /quotes[/:sym]    → proxy to mkt
 *   GET  /metrics          → proxy to mkt
 *
 * Env:
 *   API_TOKEN    — bearer token (required)
 *   NTFY_TOPIC   — ntfy topic name (required)
 *   MKT_ORIGIN   — mkt daemon base URL (default: http://127.0.0.1:8080)
 *   PORT         — listen port (default: 9000)
 */

import { loadJobs, addJob, removeJob, VALID_CONDITIONS, type AlertJob } from "./store.ts";

const API_TOKEN  = process.env.API_TOKEN   ?? "";
const NTFY_TOPIC = process.env.NTFY_TOPIC  ?? "";
const MKT_ORIGIN = process.env.MKT_ORIGIN  ?? "http://127.0.0.1:8080";
const PORT       = parseInt(process.env.PORT ?? "9000");

if (!API_TOKEN)  { console.error("API_TOKEN not set"); process.exit(1); }
if (!NTFY_TOPIC) { console.error("NTFY_TOPIC not set"); process.exit(1); }

// ── Auth ──────────────────────────────────────────────────────────────────────

function authorized(req: Request): boolean {
  const h = req.headers.get("authorization") ?? "";
  return h === `Bearer ${API_TOKEN}`;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Router ────────────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (!authorized(req)) return unauthorized();

    // GET /subscribe
    if (req.method === "GET" && path === "/subscribe") {
      return json({ subscribe_url: `https://ntfy.sh/${NTFY_TOPIC}` });
    }

    // GET /alerts
    if (req.method === "GET" && path === "/alerts") {
      return json(loadJobs());
    }

    // POST /alerts
    if (req.method === "POST" && path === "/alerts") {
      let body: Partial<AlertJob>;
      try { body = await req.json(); }
      catch { return json({ error: "invalid JSON" }, 400); }

      const { symbol, conditions, reasoning, match, desk, expiry, cooldownSec, analysisLink } = body;

      if (!symbol)            return json({ error: "symbol required" }, 400);
      if (!conditions?.length) return json({ error: "conditions required" }, 400);
      if (!reasoning?.trim()) return json({ error: "reasoning required" }, 400);

      for (const c of conditions) {
        if (!(VALID_CONDITIONS as readonly string[]).includes(c.condition))
          return json({ error: `invalid condition: ${c.condition}` }, 400);
      }

      const job = addJob({
        symbol,
        conditions,
        reasoning,
        desk: desk ?? "crypto",
        channel: `ntfy:${NTFY_TOPIC}`,   // always deliver to this instance's topic
        ...(match        ? { match }        : {}),
        ...(expiry       ? { expiry }       : {}),
        ...(cooldownSec  ? { cooldownSec }  : {}),
        ...(analysisLink ? { analysisLink } : {}),
      });
      return json(job, 201);
    }

    // DELETE /alerts/:id
    const deleteMatch = path.match(/^\/alerts\/(.+)$/);
    if (req.method === "DELETE" && deleteMatch) {
      const id = deleteMatch[1];
      const before = loadJobs().length;
      removeJob(id);
      const after = loadJobs().length;
      if (before === after) return json({ error: "not found" }, 404);
      return json({ removed: id });
    }

    // Proxy /quotes and /metrics to mkt daemon
    if (path.startsWith("/quotes") || path.startsWith("/metrics")) {
      const upstream = await fetch(`${MKT_ORIGIN}${path}${url.search}`);
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
      });
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`mkt-api listening on :${PORT}`);
