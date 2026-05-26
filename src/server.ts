/**
 * Tiny HTTP daemon bound to 127.0.0.1.
 *
 *   GET  /health        -> { ok, version, claude_cli, transcripts_root }
 *   POST /match         -> runs the pipeline, returns MatchReport
 *   GET  /projects      -> lists local projects with stats
 *
 * CORS allows the production marketing site and the localhost dev server.
 * Adjust ALLOWED_ORIGINS if you fork.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import { DEFAULT_ROOT, loadProjects } from "./extract.js";
import { haveClaudeCli } from "./llm.js";
import { runMatch } from "./pipeline.js";
import { getRole, ROLES } from "./roles.js";

const VERSION = "0.1.0";
const ALLOWED_ORIGINS = new Set<string>([
  "https://provenanthq.com",
  "https://www.provenanthq.com",
  "https://provenant.onrender.com",
]);
// Any localhost / 127.0.0.1 origin is also allowed regardless of port —
// the caller can only reach us if they're on the same machine anyway.
const LOOPBACK_HOST_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

export type ServeOptions = {
  port?: number;
  host?: string;
  root?: string;
  /** Bearer token required on every non-health request. If unset, no auth. */
  token?: string | null;
  /** Optional extra origin to allow (e.g. a staging preview). */
  extraOrigin?: string | null;
};

export function startServer(opts: ServeOptions = {}): { stop: () => Promise<void>; url: string } {
  const port = opts.port ?? 7765;
  const host = opts.host ?? "127.0.0.1";
  const allowed = new Set(ALLOWED_ORIGINS);
  if (opts.extraOrigin) allowed.add(opts.extraOrigin);

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    setCors(res, origin, allowed);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    try {
      if (url.pathname === "/health" && req.method === "GET") {
        await handleHealth(res, opts);
        return;
      }
      if (url.pathname === "/projects" && req.method === "GET") {
        if (!checkAuth(req, res, opts.token)) return;
        await handleProjects(req, res, url, opts);
        return;
      }
      if (url.pathname === "/match" && req.method === "POST") {
        if (!checkAuth(req, res, opts.token)) return;
        await handleMatch(req, res, opts);
        return;
      }
      writeJson(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeJson(res, 500, { ok: false, error: message });
    }
  });

  server.listen(port, host);

  return {
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    url: `http://${host}:${port}`,
  };
}

function setCors(res: ServerResponse, origin: string | undefined, allowed: Set<string>) {
  // Browser sends Origin on cross-origin requests; we mirror it back only if
  // it's on the allowlist (or any loopback origin, regardless of port).
  if (origin && (allowed.has(origin) || LOOPBACK_HOST_RE.test(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
}

function checkAuth(req: IncomingMessage, res: ServerResponse, token: string | null | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? "";
  if (header === `Bearer ${token}`) return true;
  writeJson(res, 401, { ok: false, error: "unauthorized" });
  return false;
}

async function handleHealth(res: ServerResponse, opts: ServeOptions): Promise<void> {
  writeJson(res, 200, {
    ok: true,
    service: "provenant-bridge",
    version: VERSION,
    claude_cli: await haveClaudeCli(),
    transcripts_root: opts.root ?? DEFAULT_ROOT,
    home: os.homedir(),
    auth_required: !!opts.token,
    roles: Object.keys(ROLES),
  });
}

async function handleProjects(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: ServeOptions
): Promise<void> {
  const since = parseSince(url.searchParams.get("since"));
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 500);
  const projects = await loadProjects({
    root: opts.root ?? DEFAULT_ROOT,
    since,
    maxProjects: limit,
  });
  writeJson(res, 200, {
    ok: true,
    projects: projects.map((p) => ({
      display_name: p.displayName,
      project_path: p.projectPath,
      sessions: p.sessions,
      user_turns: p.userTurns,
      first_seen: p.firstSeen,
      last_seen: p.lastSeen,
    })),
  });
}

async function handleMatch(req: IncomingMessage, res: ServerResponse, opts: ServeOptions): Promise<void> {
  const body = await readJson(req);
  if (!body || typeof body !== "object") {
    writeJson(res, 400, { ok: false, error: "expected JSON body" });
    return;
  }
  const b = body as {
    role_id?: string;
    role?: { id?: string; title?: string; score_label?: string; competencies?: unknown };
    jd?: string;
    since?: string;
    max_projects?: number;
    model?: string;
  };

  const role = b.role_id
    ? getRole(b.role_id)
    : b.role && b.role.id
    ? {
        id: String(b.role.id),
        title: String(b.role.title ?? b.role.id),
        scoreLabel: String(b.role.score_label ?? "reasoning depth"),
        competencies: Array.isArray(b.role.competencies)
          ? (b.role.competencies as { label: string; weight: "core" | "important" | "supporting" }[])
          : [],
      }
    : null;
  if (!role) {
    writeJson(res, 400, {
      ok: false,
      error: `unknown role. provide role_id (one of: ${Object.keys(ROLES).join(", ")}) or a full role object`,
    });
    return;
  }
  const jd = (b.jd ?? "").trim();
  if (!jd) {
    writeJson(res, 400, { ok: false, error: "missing jd" });
    return;
  }

  try {
    const report = await runMatch({
      role,
      jd,
      root: opts.root ?? DEFAULT_ROOT,
      since: parseSince(b.since),
      maxProjects: typeof b.max_projects === "number" ? b.max_projects : undefined,
      model: b.model,
    });
    writeJson(res, 200, { ok: true, ...report });
  } catch (err) {
    writeJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 5 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        if (!chunks.length) return resolve(null);
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function parseSince(s: string | null | undefined): Date | null {
  if (!s) return null;
  const v = String(s).trim().toLowerCase();
  if (/^\d+d$/.test(v)) return offsetDate(parseInt(v, 10) * 86_400_000);
  if (/^\d+m$/.test(v)) return offsetDate(parseInt(v, 10) * 86_400_000 * 30);
  if (/^\d+y$/.test(v)) return offsetDate(parseInt(v, 10) * 86_400_000 * 365);
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

function offsetDate(deltaMs: number): Date {
  return new Date(Date.now() - deltaMs);
}

function clampInt(s: string | null, fallback: number, lo: number, hi: number): number {
  if (!s) return fallback;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
