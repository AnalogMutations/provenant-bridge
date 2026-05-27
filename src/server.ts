/**
 * Tiny HTTP daemon bound to 127.0.0.1.
 *
 *   GET  /health        -> { ok, version, claude_cli, transcripts_root }
 *   POST /match         -> runs the pipeline, returns MatchReport
 *   GET  /projects      -> lists local projects with stats
 *
 * Security posture:
 *   - Loopback bind (127.0.0.1) by default
 *   - Origin allowlist (default: provenanthq.com only; --dev adds loopback)
 *   - Non-allowed Origins are rejected with 403 (not just CORS-suppressed)
 *   - POST endpoints require Content-Type: application/json
 *   - Optional bearer token via --token
 *   - /health is intentionally open so the website can detect us
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";

import { DEFAULT_ROOT, loadProjects } from "./extract.js";
import { haveClaudeCli } from "./llm.js";
import { runMatch } from "./pipeline.js";
import { getRole, ROLES } from "./roles.js";

const VERSION = "0.1.1";

// Production origins. Default-on, always allowed.
const PRODUCTION_ORIGINS = new Set<string>([
  "https://provenanthq.com",
  "https://www.provenanthq.com",
]);

// http://localhost:* and http://127.0.0.1:* (any port). Only allowed when
// the daemon is started with --dev. We never include them by default so
// a random Electron app, sketchy local web server, or installed CLI tool
// can't reach the bridge from a browser context on the same machine.
const LOOPBACK_HOST_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

export type ServeOptions = {
  port?: number;
  host?: string;
  root?: string;
  /** Bearer token required on /match and /projects. /health stays open. */
  token?: string | null;
  /** Additional allowed origin (e.g. a Render preview URL or a staging host). */
  extraOrigin?: string | null;
  /** When true, also allow http://localhost:* and http://127.0.0.1:* origins. */
  dev?: boolean;
};

export function startServer(opts: ServeOptions = {}): { stop: () => Promise<void>; url: string } {
  const port = opts.port ?? 7765;
  const host = opts.host ?? "127.0.0.1";
  const allowed = new Set(PRODUCTION_ORIGINS);
  if (opts.extraOrigin) allowed.add(opts.extraOrigin);

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;

    // Always set CORS headers so allowed origins can read responses. Origin
    // rejection (for cross-origin authorization, not just CORS-display) is
    // enforced separately per endpoint.
    setCors(res, origin, allowed, opts.dev === true);

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
        if (!checkOrigin(req, res, allowed, opts.dev === true)) return;
        if (!checkAuth(req, res, opts.token)) return;
        await handleProjects(req, res, url, opts);
        return;
      }
      if (url.pathname === "/match" && req.method === "POST") {
        if (!checkOrigin(req, res, allowed, opts.dev === true)) return;
        if (!checkContentType(req, res)) return;
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

function isAllowedOrigin(origin: string, allowed: Set<string>, dev: boolean): boolean {
  if (allowed.has(origin)) return true;
  if (dev && LOOPBACK_HOST_RE.test(origin)) return true;
  return false;
}

function setCors(
  res: ServerResponse,
  origin: string | undefined,
  allowed: Set<string>,
  dev: boolean
) {
  if (origin && isAllowedOrigin(origin, allowed, dev)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
}

/**
 * Server-side origin authorization. The Origin header is set by the browser
 * (not the page), so a malicious site cannot claim Origin: provenanthq.com.
 * Non-browser callers (curl, scripts, Claude Code itself) omit Origin and
 * are allowed — they're already on the candidate's machine and the daemon
 * is loopback-only.
 */
function checkOrigin(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: Set<string>,
  dev: boolean
): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // no browser context
  if (isAllowedOrigin(origin, allowed, dev)) return true;
  writeJson(res, 403, {
    ok: false,
    error: `origin not allowed: ${origin}`,
  });
  return false;
}

function checkContentType(req: IncomingMessage, res: ServerResponse): boolean {
  const raw = req.headers["content-type"] ?? "";
  const mime = String(raw).toLowerCase().split(";")[0].trim();
  if (mime === "application/json") return true;
  writeJson(res, 415, {
    ok: false,
    error: "Content-Type must be application/json",
  });
  return false;
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
    dev: opts.dev === true,
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
