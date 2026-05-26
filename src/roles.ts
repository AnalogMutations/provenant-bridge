/** Mirrors components/demo/roles.ts on the marketing site. */

export type Competency = {
  label: string;
  weight: "core" | "important" | "supporting";
};

export type Role = {
  id: string;
  title: string;
  scoreLabel: string;
  competencies: Competency[];
};

export const ROLES: Record<string, Role> = {
  "privacy-eng": {
    id: "privacy-eng",
    title: "Senior Privacy Infrastructure Engineer",
    scoreLabel: "reasoning depth",
    competencies: [
      { label: "cryptography", weight: "core" },
      { label: "distributed systems", weight: "core" },
      { label: "end-to-end encryption", weight: "core" },
      { label: "threat modeling", weight: "core" },
      { label: "key management", weight: "core" },
      { label: "secure messaging", weight: "core" },
      { label: "post-quantum migration", weight: "important" },
      { label: "engineering leadership", weight: "important" },
      { label: "incident response", weight: "supporting" },
    ],
  },
  "security-analyst": {
    id: "security-analyst",
    title: "Senior Security & Risk Analyst",
    scoreLabel: "investigative depth",
    competencies: [
      { label: "threat modeling", weight: "core" },
      { label: "incident response", weight: "core" },
      { label: "adversarial reasoning", weight: "core" },
      { label: "cloud security", weight: "core" },
      { label: "infrastructure hardening", weight: "core" },
      { label: "SOC workflows", weight: "core" },
      { label: "vulnerability triage", weight: "important" },
      { label: "communication under pressure", weight: "important" },
      { label: "risk calibration", weight: "supporting" },
    ],
  },
  "product-manager": {
    id: "product-manager",
    title: "Senior Product Manager — AI Infrastructure",
    scoreLabel: "product judgment",
    competencies: [
      { label: "roadmap strategy", weight: "core" },
      { label: "prioritization", weight: "core" },
      { label: "systems thinking", weight: "core" },
      { label: "stakeholder management", weight: "core" },
      { label: "technical fluency", weight: "core" },
      { label: "ambiguity handling", weight: "core" },
      { label: "user empathy", weight: "important" },
      { label: "analytical decision-making", weight: "important" },
      { label: "platform thinking", weight: "supporting" },
    ],
  },
  "legal-researcher": {
    id: "legal-researcher",
    title: "Senior Legal Researcher — Technology & Privacy Law",
    scoreLabel: "analytical rigor",
    competencies: [
      { label: "legal analysis", weight: "core" },
      { label: "structured reasoning", weight: "core" },
      { label: "precedent interpretation", weight: "core" },
      { label: "regulatory research", weight: "core" },
      { label: "argument construction", weight: "core" },
      { label: "ambiguity handling", weight: "core" },
      { label: "written communication", weight: "important" },
      { label: "intellectual rigor", weight: "important" },
      { label: "jurisdictional conflict", weight: "supporting" },
    ],
  },
  "engineering-generalist": {
    id: "engineering-generalist",
    title: "Senior Engineering Generalist",
    scoreLabel: "engineering judgment",
    competencies: [
      { label: "systems thinking", weight: "core" },
      { label: "debugging persistence", weight: "core" },
      { label: "architectural tradeoffs", weight: "core" },
      { label: "code quality", weight: "core" },
      { label: "communication", weight: "core" },
      { label: "learning trajectory", weight: "important" },
      { label: "cross-domain fluency", weight: "important" },
      { label: "security awareness", weight: "supporting" },
    ],
  },
};

export function getRole(id: string): Role | null {
  return ROLES[id] ?? null;
}
