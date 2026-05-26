/**
 * Walks ~/.claude/projects/*.jsonl and groups turns into Projects.
 * Direct TS port of the Python prototype's extractor.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export const DEFAULT_ROOT = path.join(os.homedir(), ".claude", "projects");

export const TURN_CHAR_CAP = 1600;

export type Turn = {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  sessionId: string;
  projectKey: string;
  projectPath: string | null;
  title: string | null;
  gitBranch: string | null;
  charCount: number;
};

export type Project = {
  projectKey: string;
  projectPath: string | null;
  displayName: string;
  firstSeen: string;
  lastSeen: string;
  userTurns: number;
  sessions: number;
  turns: Turn[];
};

function decodeProjectKey(key: string): string | null {
  if (!key.startsWith("-")) return null;
  return "/" + key.slice(1).replace(/-/g, "/");
}

function extractText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as { content?: unknown };
  const content = m.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; thinking?: string };
    if (b.type === "text" && b.text) parts.push(b.text);
    else if (b.type === "thinking" && b.thinking) parts.push(b.thinking.slice(0, 1500));
  }
  return parts.join("\n").trim();
}

async function* walkDir(root: string): AsyncGenerator<{ file: string; projectKey: string }> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      let subEntries: import("node:fs").Dirent[];
      try {
        subEntries = await fs.readdir(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        if (sub.isFile() && sub.name.endsWith(".jsonl")) {
          yield { file: path.join(full, sub.name), projectKey: entry.name };
        }
      }
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      yield { file: full, projectKey: path.basename(root) };
    }
  }
}

async function parseJsonl(
  filePath: string,
  projectKey: string
): Promise<{ turns: Turn[]; sessions: Set<string> }> {
  const raw = await fs.readFile(filePath, "utf-8");
  const turns: Turn[] = [];
  const sessions = new Set<string>();
  let currentTitle: string | null = null;

  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const otype = obj.type as string | undefined;
    if (otype === "ai-title") {
      const at = obj.aiTitle as string | undefined;
      if (at) currentTitle = at;
      continue;
    }
    if (otype !== "user" && otype !== "assistant") continue;
    const msg = obj.message;
    if (!msg || typeof msg !== "object") continue;
    const body = extractText(msg);
    if (!body) continue;
    const ts = obj.timestamp as string | undefined;
    if (!ts) continue;
    const sid = (obj.sessionId as string | undefined) ?? path.basename(filePath);
    sessions.add(sid);
    turns.push({
      role: otype,
      text: body,
      timestamp: ts,
      sessionId: sid,
      projectKey,
      projectPath: (obj.cwd as string | undefined) ?? null,
      title: currentTitle,
      gitBranch: (obj.gitBranch as string | undefined) ?? null,
      charCount: body.length,
    });
  }
  return { turns, sessions };
}

export type LoadOptions = {
  root?: string;
  since?: Date | null;
  maxProjects?: number;
};

export async function loadProjects(opts: LoadOptions = {}): Promise<Project[]> {
  const root = opts.root ?? DEFAULT_ROOT;
  const sinceMs = opts.since ? opts.since.getTime() : null;

  const byProject = new Map<
    string,
    {
      projectKey: string;
      projectPath: string | null;
      sessions: Set<string>;
      turns: Turn[];
    }
  >();

  for await (const { file, projectKey } of walkDir(root)) {
    let result: { turns: Turn[]; sessions: Set<string> };
    try {
      result = await parseJsonl(file, projectKey);
    } catch {
      continue;
    }
    let proj = byProject.get(projectKey);
    if (!proj) {
      proj = {
        projectKey,
        projectPath: result.turns.find((t) => t.projectPath)?.projectPath ?? null,
        sessions: new Set<string>(),
        turns: [],
      };
      byProject.set(projectKey, proj);
    }
    for (const s of result.sessions) proj.sessions.add(s);
    for (const turn of result.turns) {
      if (sinceMs && new Date(turn.timestamp).getTime() < sinceMs) continue;
      proj.turns.push(turn);
    }
    if (!proj.projectPath) {
      proj.projectPath = result.turns.find((t) => t.projectPath)?.projectPath ?? null;
    }
  }

  const projects: Project[] = [];
  for (const p of byProject.values()) {
    if (!p.turns.length) continue;
    p.turns.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    const first = p.turns[0].timestamp;
    const last = p.turns[p.turns.length - 1].timestamp;
    const userTurns = p.turns.filter((t) => t.role === "user").length;
    const projectPath = p.projectPath ?? decodeProjectKey(p.projectKey) ?? null;
    const displayName =
      projectPath?.split("/").pop() ??
      p.projectKey.replace(/^-/, "").split("-").pop() ??
      p.projectKey;
    projects.push({
      projectKey: p.projectKey,
      projectPath,
      displayName,
      firstSeen: first,
      lastSeen: last,
      userTurns,
      sessions: p.sessions.size,
      turns: p.turns,
    });
  }

  projects.sort((a, b) => (a.lastSeen > b.lastSeen ? -1 : 1));
  return opts.maxProjects ? projects.slice(0, opts.maxProjects) : projects;
}

export function shortText(text: string, cap = TURN_CHAR_CAP): string {
  if (text.length <= cap) return text;
  const headLen = Math.floor((cap * 2) / 3);
  const tailLen = Math.floor(cap / 3);
  return `${text.slice(0, headLen)}\n\n[…truncated ${text.length - cap} chars…]\n\n${text.slice(-tailLen)}`;
}

export function buildEvidenceBlob(
  projects: Project[],
  opts: {
    perProjectUserTurns?: number;
    perProjectAssistantTurns?: number;
    perTurnCap?: number;
    totalCharCap?: number;
  } = {}
): { text: string; usedProjects: number; truncatedProjects: number } {
  const perProjectUserTurns = opts.perProjectUserTurns ?? 12;
  const perProjectAssistantTurns = opts.perProjectAssistantTurns ?? 4;
  const perTurnCap = opts.perTurnCap ?? 1200;
  const totalCharCap = opts.totalCharCap ?? 120_000;

  const parts: string[] = [];
  let total = 0;
  let usedProjects = 0;
  let truncatedProjects = 0;

  for (const proj of projects) {
    const userTurns = proj.turns.filter((t) => t.role === "user");
    const asstTurns = proj.turns.filter((t) => t.role === "assistant");

    const userSlice =
      userTurns.length > perProjectUserTurns * 2
        ? [...userTurns.slice(0, perProjectUserTurns), ...userTurns.slice(-perProjectUserTurns)]
        : userTurns;
    const asstSlice =
      asstTurns.length > perProjectAssistantTurns * 2
        ? [...asstTurns.slice(0, perProjectAssistantTurns), ...asstTurns.slice(-perProjectAssistantTurns)]
        : asstTurns;

    const lines: string[] = [
      ``,
      `===== PROJECT: ${proj.displayName} =====`,
      `dates: ${proj.firstSeen.slice(0, 10)} → ${proj.lastSeen.slice(0, 10)}`,
      `sessions: ${proj.sessions} · user turns: ${proj.userTurns}`,
      ``,
    ];
    for (const t of userSlice) {
      lines.push(`[${t.timestamp.slice(0, 10)}] USER: ${shortText(t.text, perTurnCap)}`);
      lines.push("");
    }
    for (const t of asstSlice) {
      lines.push(`[${t.timestamp.slice(0, 10)}] ASSISTANT: ${shortText(t.text, perTurnCap)}`);
      lines.push("");
    }
    const block = lines.join("\n");
    if (total + block.length > totalCharCap) {
      truncatedProjects = projects.length - usedProjects;
      break;
    }
    parts.push(block);
    total += block.length;
    usedProjects += 1;
  }
  return { text: parts.join("\n"), usedProjects, truncatedProjects };
}
