#!/usr/bin/env node
/**
 * provenant — local bridge for provenanthq.com.
 *
 *   provenant serve              start the daemon (default 127.0.0.1:7765)
 *   provenant projects           list local Claude Code projects
 *   provenant match --role <id> --jd <path-or-text>
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";

import { DEFAULT_ROOT, loadProjects } from "./extract.js";
import { haveClaudeCli } from "./llm.js";
import { runMatch } from "./pipeline.js";
import { getRole, ROLES } from "./roles.js";
import { startServer } from "./server.js";

const VERSION = "0.1.1";

type Args = {
  command: string | null;
  flags: Record<string, string | boolean>;
  positional: string[];
};

function parseArgs(argv: string[]): Args {
  const out: Args = { command: argv[0] ?? null, flags: {}, positional: [] };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const eq = key.indexOf("=");
      if (eq >= 0) {
        out.flags[key.slice(0, eq)] = key.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          out.flags[key] = next;
          i += 1;
        } else {
          out.flags[key] = true;
        }
      }
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}

function usage(): string {
  return `provenant — local bridge for provenanthq.com (v${VERSION})

Usage:
  provenant serve [--port 7765] [--root ~/.claude/projects]
                  [--token | --token <value>] [--dev] [--extra-origin <url>]
  provenant projects [--since 30d] [--limit 50] [--root ~/.claude/projects]
  provenant match --role <role-id> --jd <path-or-text> [--since 30d] [--limit 12]
  provenant --help

Roles:
  ${Object.keys(ROLES).join(", ")}

Examples:
  provenant serve
  provenant serve --token                       # generate & print a token
  provenant serve --dev                         # also allow localhost origins
  provenant projects --since 30d --limit 20
  provenant match --role engineering-generalist --jd ./role.md --since 90d`;
}

async function cmdServe(args: Args): Promise<number> {
  const port = parseInt(String(args.flags.port ?? "7765"), 10);
  const host = String(args.flags.host ?? "127.0.0.1");
  const root = String(args.flags.root ?? DEFAULT_ROOT);
  const dev = args.flags.dev === true;
  const extraOriginRaw = args.flags["extra-origin"];
  const extraOrigin = typeof extraOriginRaw === "string" ? extraOriginRaw : null;

  // --token (no value)  →  generate a fresh token
  // --token <value>     →  use the provided token
  // (omitted)           →  no auth required
  const tokenFlag = args.flags.token;
  const token =
    tokenFlag === true
      ? "ptk_" + randomBytes(18).toString("base64url")
      : typeof tokenFlag === "string"
      ? tokenFlag
      : null;

  if (!(await haveClaudeCli())) {
    console.warn(
      "Warning: `claude` CLI not found on PATH. The /match endpoint will fail. " +
        "Install Claude Code first: https://docs.claude.com/en/docs/claude-code"
    );
  }

  const { url } = startServer({ port, host, root, token, dev, extraOrigin });

  // Pretty intro
  console.log("");
  console.log(`  provenant-bridge ${VERSION}  ·  listening on ${url}`);
  console.log(`  transcripts root: ${root}`);
  console.log(
    `  CORS:             ${
      dev
        ? "provenanthq.com + loopback (dev mode)"
        : "provenanthq.com only"
    }${extraOrigin ? ` + ${extraOrigin}` : ""}`
  );
  if (token) {
    console.log(`  auth:             Bearer ${token}`);
    console.log("");
    console.log(`  click to open with token saved:`);
    console.log(
      `    https://provenanthq.com/match/?bridge_token=${encodeURIComponent(token)}`
    );
  } else {
    console.log(`  auth:             none (loopback bind)`);
  }
  console.log("");
  console.log("  → Visit https://provenanthq.com/match/ to run a match.");
  console.log("  → Stop with Ctrl-C.");
  console.log("");

  // Keep alive
  await new Promise<void>(() => {});
  return 0;
}

async function cmdProjects(args: Args): Promise<number> {
  const since = parseSince(args.flags.since);
  const limit = args.flags.limit ? parseInt(String(args.flags.limit), 10) : 50;
  const root = args.flags.root ? String(args.flags.root) : DEFAULT_ROOT;
  const projects = await loadProjects({ root, since, maxProjects: limit });
  if (!projects.length) {
    console.log("(no transcripts found)");
    return 1;
  }
  for (const p of projects) {
    console.log(
      `${p.displayName.padEnd(28).slice(0, 28)}  sessions=${String(p.sessions).padStart(3)}` +
        `  turns=${String(p.userTurns).padStart(4)}` +
        `  ${p.firstSeen.slice(0, 10)} → ${p.lastSeen.slice(0, 10)}`
    );
  }
  console.log(`\n${projects.length} project(s)`);
  return 0;
}

async function cmdMatch(args: Args): Promise<number> {
  const roleId = String(args.flags.role ?? "");
  const role = getRole(roleId);
  if (!role) {
    console.error(`unknown role: ${roleId}\navailable: ${Object.keys(ROLES).join(", ")}`);
    return 2;
  }
  const jdFlag = args.flags.jd;
  if (!jdFlag) {
    console.error("--jd is required (a file path or literal text)");
    return 2;
  }
  let jd = String(jdFlag);
  try {
    const stat = await fs.stat(jd);
    if (stat.isFile()) {
      jd = await fs.readFile(jd, "utf-8");
    }
  } catch {
    /* treat as literal text */
  }
  const root = args.flags.root ? String(args.flags.root) : DEFAULT_ROOT;
  const since = parseSince(args.flags.since);
  const limit = args.flags.limit ? parseInt(String(args.flags.limit), 10) : 12;
  const report = await runMatch({ role, jd, root, since, maxProjects: limit });
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

function parseSince(s: string | boolean | undefined): Date | null {
  if (typeof s !== "string") return null;
  const v = s.trim().toLowerCase();
  if (/^\d+d$/.test(v)) return new Date(Date.now() - parseInt(v, 10) * 86_400_000);
  if (/^\d+m$/.test(v)) return new Date(Date.now() - parseInt(v, 10) * 86_400_000 * 30);
  if (/^\d+y$/.test(v)) return new Date(Date.now() - parseInt(v, 10) * 86_400_000 * 365);
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === "--help" || args.command === "-h" || args.command === "help") {
    console.log(usage());
    return 0;
  }
  if (args.command === "--version" || args.command === "-v" || args.command === "version") {
    console.log(VERSION);
    return 0;
  }
  switch (args.command) {
    case "serve":
      return cmdServe(args);
    case "projects":
      return cmdProjects(args);
    case "match":
      return cmdMatch(args);
    default:
      console.error(`unknown command: ${args.command}`);
      console.error(usage());
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
