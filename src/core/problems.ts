// Where a `thalovant-skillkit check` problem points, in the skill's files.
//
// Problems are sentences written for people: "locale/fr-FR/dialog/x.dialog is
// missing (en-US has it)". The paths in them are relative to the package
// directory; a line number, when there is one, follows the path after a colon.
import * as fs from "node:fs";
import * as path from "node:path";
import type { SkillModel } from "./skill";

export interface Placed {
  file: string;
  /** Zero-based. */
  line: number;
  message: string;
  severity: "error" | "warning";
}

export function placeProblem(problem: string, model: SkillModel): Placed {
  const pkg = model.packageDir ?? model.root;
  const fallbackFile = model.entry?.file ?? model.classFile ?? path.join(model.root, "pyproject.toml");
  const m = /(?:^|[\s(])(locale\/[^\s:;,()]+?)(?::(\d+))?(?=[\s:;,)]|$)/.exec(problem);
  if (m) {
    const relative = m[1].replace(/[.]$/, "");
    const line = m[2] ? Math.max(0, Number(m[2]) - 1) : 0;
    const file = path.join(pkg, relative);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return { file, line, message: problem, severity: "error" };
    // "locale/fr-FR/dialog/x.dialog is missing (en-US has it)": show it on the source file.
    const parts = relative.split("/");
    if (parts.length >= 3) {
      const source = path.join(pkg, "locale", model.sourceLocale, ...parts.slice(2));
      if (fs.existsSync(source)) return { file: source, line: 0, message: problem, severity: "error" };
    }
    const supported = path.join(pkg, "locale", "supported.json");
    if (fs.existsSync(supported)) return { file: supported, line: 0, message: problem, severity: "error" };
  }
  if (/__init__\.py/.test(problem) || /FALLBACK_PRIORITY/.test(problem)) {
    const file = model.classFile ?? fallbackFile;
    return { file, line: lineMatching(file, /FALLBACK_PRIORITY|^class /), message: problem, severity: "error" };
  }
  if (/entry point|package data|package-data|wheel/i.test(problem)) {
    return { file: fallbackFile, line: model.entry?.line ?? 0, message: problem, severity: "error" };
  }
  return { file: fallbackFile, line: 0, message: problem, severity: "error" };
}

function lineMatching(file: string, pattern: RegExp): number {
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const index = lines.findIndex((l) => pattern.test(l.trim()));
    return index < 0 ? 0 : index;
  } catch {
    return 0;
  }
}

/** `thalovant-skillkit check` prints "N problem(s) in X:" then "  - problem" lines. */
export function parseCheckOutput(stdout: string): { problems: string[]; ok: boolean; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  let current: string | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    if (raw.startsWith("  - ")) {
      if (current) problems.push(current);
      current = raw.slice(4);
    } else if (current && raw.startsWith("    ")) {
      current += " " + raw.trim();
    } else {
      if (current) problems.push(current);
      current = undefined;
      if (raw.trim()) notes.push(raw.trim());
    }
  }
  if (current) problems.push(current);
  return { problems, ok: problems.length === 0, notes };
}

/** The deepest traceback frame inside the skill, to put an error on its line. */
export function frameInSkill(traceback: string, root: string): { file: string; line: number } | undefined {
  const frames = [...traceback.matchAll(/File "([^"]+)", line (\d+)/g)];
  for (let i = frames.length - 1; i >= 0; i--) {
    const file = frames[i][1];
    const relative = path.relative(root, file);
    if (!relative.startsWith("..") && !path.isAbsolute(relative) && !relative.includes("site-packages")) {
      return { file, line: Number(frames[i][2]) - 1 };
    }
  }
  return undefined;
}
