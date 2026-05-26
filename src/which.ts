/**
 * Minimal cross-platform "which" — locate a command on PATH.
 * Zero-dep replacement for the npm `which` package.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export default async function which(cmd: string): Promise<string | null> {
  const PATH = process.env.PATH ?? "";
  const PATHEXT =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of PATHEXT) {
      const candidate = path.join(dir, cmd + ext);
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}
