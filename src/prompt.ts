/**
 * Single-call matching prompt. One LLM round-trip from the daemon.
 *
 * In: role spec + JD + evidence blob (the candidate's recent transcripts).
 * Out: structured JSON the website can render as Step 4.
 */

import type { Role } from "./roles.js";

export type MatchInput = {
  role: Role;
  jd: string;
  evidence: string;
  window: {
    nProjects: number;
    nSessions: number;
    nTurns: number;
    firstSeen: string;
    lastSeen: string;
  };
};

export function renderMatchPrompt(input: MatchInput): string {
  const { role, jd, evidence, window } = input;
  const competencyJson = JSON.stringify(role.competencies);

  return `You are scoring a candidate against a specific job description, using their AI conversation history as the evidence base.

Be evidence-grounded and calibrated. Prefer "emerging" or "moderate" confidence over "high" when the evidence is thin. Cite project names in the sources arrays — do NOT invent sources that aren't in the input below. Do not produce personality scores or culture-fit judgements. Only signals visible in the transcripts.

ROLE
----
id: ${role.id}
title: ${role.title}
score_label: ${role.scoreLabel}
competencies: ${competencyJson}

JOB DESCRIPTION
---------------
${jd}

EVIDENCE WINDOW
---------------
${window.nProjects} project(s) · ${window.nSessions} session(s) · ${window.nTurns} user turn(s)
range: ${window.firstSeen} → ${window.lastSeen}

EVIDENCE (the candidate's verified history; USER lines are the candidate's prompts, ASSISTANT lines are the model's replies)
-----------------------------------------------------------------------------------------------------
${evidence}

-----------------------------------------------------------------------------------------------------

Produce ONE fenced JSON object in this exact shape. All scores are 0–100 integers. Be terse and specific.

\`\`\`json
{
  "headline_score": 0,
  "confidence_counts": {"high": 0, "moderate": 0, "emerging": 0},
  "work_patterns": [
    "3–5 short specific observations on how the candidate reasons across these transcripts — concrete, evidence-rooted, not abstract"
  ],
  "strengths": [
    {
      "title": "one specific evidence-backed claim",
      "detail": "one or two sentences on the actual basis from the transcripts",
      "evidence_count": 0,
      "span": "e.g. '14 mo' or '6 mo'",
      "confidence": "high|moderate|emerging",
      "sources": ["project-name-1", "project-name-2"]
    }
  ],
  "gaps": [
    {
      "title": "specific gap visible in the evidence",
      "note": "neutral one-line on what's missing or thin",
      "confidence": "high|moderate|emerging"
    }
  ],
  "role_map": [
    {"req": "competency label from the role spec", "coverage": 0}
  ],
  "summary": {
    "verdict": "e.g. 'Strong fit · advance to onsite' | 'Moderate fit · technical screen' | 'Limited fit · evidence too thin'",
    "headline": "one paragraph of nuanced recommendation, evidence-anchored, no exaggeration"
  }
}
\`\`\`

Rules:
- role_map MUST cover every competency in the role spec; coverage is your honest estimate from the evidence
- confidence_counts MUST equal the actual counts across strengths + gaps
- Reply with the fenced JSON only, no prose before or after`;
}
