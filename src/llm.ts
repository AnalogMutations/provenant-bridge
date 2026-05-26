/**
 * Subprocess wrapper around the `claude` CLI.
 *
 * Auth is delegated to Claude Code's own keychain — the bridge never holds
 * credentials. Token cost is on the candidate's Pro/Max subscription.
 *
 * Mirrors the Python prototype's wrapper byte-for-byte.
 */

import { spawn } from "node:child_process";
import which from "./which.js";

const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_MAX_TURNS = 1;

export type LLMResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export type CallOptions = {
  prompt: string;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
  claudePath?: string;
};

export async function haveClaudeCli(): Promise<boolean> {
  return (await which("claude")) !== null;
}

export async function claudePrompt(opts: CallOptions): Promise<LLMResult> {
  const binary = opts.claudePath ?? (await which("claude")) ?? "claude";
  const args = ["-p", "--max-turns", String(opts.maxTurns ?? DEFAULT_MAX_TURNS)];
  if (opts.model) args.push("--model", opts.model);

  // Scrub CLAUDECODE so we can spawn the CLI from inside another Claude Code session.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.CLAUDECODE;

  return new Promise<LLMResult>((resolve) => {
    let resolved = false;
    const finish = (r: LLMResult) => {
      if (resolved) return;
      resolved = true;
      resolve(r);
    };

    let proc;
    try {
      proc = spawn(binary, args, { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      finish({
        ok: false,
        error: `Failed to spawn ${binary}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf-8");
    proc.stderr.setEncoding("utf-8");
    proc.stdout.on("data", (chunk: string) => (stdout += chunk));
    proc.stderr.on("data", (chunk: string) => (stderr += chunk));

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* noop */
      }
      finish({ ok: false, error: `claude timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` });
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    proc.on("error", (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        error:
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? `claude CLI not found on PATH. Install Claude Code first.`
            : err.message,
      });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish({
          ok: false,
          error: (stderr.trim() || `claude exited with code ${code}`).slice(0, 600),
        });
      } else {
        finish({ ok: true, text: stdout.trim() });
      }
    });

    try {
      proc.stdin.end(opts.prompt, "utf-8");
    } catch (err) {
      clearTimeout(timer);
      finish({
        ok: false,
        error: `Failed to write prompt to claude stdin: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  });
}

const FENCE_RE = /```(?:json)?\s*([\s\S]+?)\s*```/;
const FIRST_OBJ_RE = /\{[\s\S]*\}/;

export function extractJSON<T = unknown>(raw: string): T | null {
  if (!raw) return null;
  const fence = raw.match(FENCE_RE);
  const candidates = [fence?.[1] ?? null, raw, raw.match(FIRST_OBJ_RE)?.[0] ?? null];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c) as T;
    } catch {
      /* try next */
    }
  }
  return null;
}
