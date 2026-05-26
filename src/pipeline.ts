/** Glue: extract → build evidence → claude -p → parse → return report. */

import { createHash } from "node:crypto";

import { buildEvidenceBlob, loadProjects, type Project } from "./extract.js";
import { claudePrompt, extractJSON, haveClaudeCli } from "./llm.js";
import { renderMatchPrompt } from "./prompt.js";
import type { Role } from "./roles.js";

export type MatchReport = {
  version: "0.1.0";
  generated_at: string;
  role: { id: string; title: string; score_label: string };
  window: {
    n_projects: number;
    n_sessions: number;
    n_turns: number;
    first_seen: string;
    last_seen: string;
    truncated_projects: number;
  };
  evidence_root: string;
  evidence_used_projects: string[];
  report: unknown; // shape matches the prompt's JSON contract
};

export type RunMatchArgs = {
  role: Role;
  jd: string;
  root?: string;
  since?: Date | null;
  maxProjects?: number;
  model?: string;
  timeoutMs?: number;
};

export async function runMatch(args: RunMatchArgs): Promise<MatchReport> {
  if (!(await haveClaudeCli())) {
    throw new Error(
      "`claude` CLI not found on PATH. Install Claude Code first: https://docs.claude.com/en/docs/claude-code"
    );
  }

  const projects = await loadProjects({
    root: args.root,
    since: args.since ?? null,
    maxProjects: args.maxProjects ?? 14,
  });
  if (!projects.length) {
    throw new Error("No Claude Code transcripts found. Use a different --root or check ~/.claude/projects.");
  }

  const window = {
    n_projects: projects.length,
    n_sessions: projects.reduce((acc, p) => acc + p.sessions, 0),
    n_turns: projects.reduce((acc, p) => acc + p.userTurns, 0),
    first_seen: projects.reduce<string>(
      (acc, p) => (acc && acc < p.firstSeen ? acc : p.firstSeen),
      ""
    ),
    last_seen: projects.reduce<string>((acc, p) => (acc && acc > p.lastSeen ? acc : p.lastSeen), ""),
  };

  const evidence = buildEvidenceBlob(projects, {
    totalCharCap: 120_000,
  });

  const prompt = renderMatchPrompt({
    role: args.role,
    jd: args.jd,
    evidence: evidence.text,
    window: {
      ...window,
      // The model only sees the projects we actually included.
      nProjects: evidence.usedProjects,
      nSessions: window.n_sessions,
      nTurns: window.n_turns,
      firstSeen: window.first_seen,
      lastSeen: window.last_seen,
    },
  });

  const result = await claudePrompt({
    prompt,
    model: args.model,
    timeoutMs: args.timeoutMs ?? 300_000,
  });
  if (!result.ok) {
    throw new Error(`Synthesis failed: ${result.error}`);
  }
  const parsed = extractJSON(result.text);
  if (!parsed) {
    throw new Error("Claude returned no parseable JSON. Try again or shorten the JD.");
  }

  const usedProjects = projects.slice(0, evidence.usedProjects);
  const evidenceRoot = computeEvidenceRoot(usedProjects, args.role, args.jd);

  return {
    version: "0.1.0",
    generated_at: new Date().toISOString(),
    role: { id: args.role.id, title: args.role.title, score_label: args.role.scoreLabel },
    window: {
      ...window,
      truncated_projects: evidence.truncatedProjects,
    },
    evidence_root: evidenceRoot,
    evidence_used_projects: usedProjects.map((p) => p.displayName),
    report: parsed,
  };
}

function computeEvidenceRoot(projects: Project[], role: Role, jd: string): string {
  const blob = JSON.stringify(
    {
      role_id: role.id,
      jd_hash: createHash("sha256").update(jd).digest("hex"),
      projects: projects.map((p) => ({
        key: p.projectKey,
        first_seen: p.firstSeen,
        last_seen: p.lastSeen,
        sessions: p.sessions,
        user_turns: p.userTurns,
      })),
    },
    null,
    0
  );
  return "sha256:" + createHash("sha256").update(blob).digest("hex");
}
