// What a Thalovant skill is made of, read from its files alone.
//
// Everything here is synchronous file reading with no Python: completion,
// hover, the outline and the locale diagnostics all work before (and without)
// an interpreter, and in an untrusted workspace.
import * as fs from "node:fs";
import * as path from "node:path";

export type ResourceKind = "dialog" | "ssml" | "vocab" | "intent" | "entity" | "regex";

export const RESOURCE_SUFFIX: Record<string, ResourceKind> = {
  ".dialog": "dialog",
  ".ssml": "ssml",
  ".voc": "vocab",
  ".intent": "intent",
  ".entity": "entity",
  ".rx": "regex",
};

export interface Resource {
  kind: ResourceKind;
  /** The name code uses: `water.fern` for a dialog, `water.plants.intent` for an intent. */
  name: string;
  lang: string;
  file: string;
  /** The file's lines without comments and blanks, as OVOS reads them. */
  lines: string[];
}

export interface EntryPoint {
  skillId: string;
  module: string;
  className: string;
  /** pyproject.toml or setup.py, and the line the entry point is declared on. */
  file: string;
  line: number;
}

export interface Golden {
  file: string;
  /** Zero-based line in a .jsonl file, or the row's index in a JSON array. */
  line: number;
  utterance: string;
  lang?: string;
  intent?: string;
  skillId?: string;
  negative: boolean;
  raw: Record<string, unknown>;
}

export interface Layout {
  name: string;
  file: string;
}

export interface SkillModel {
  root: string;
  /** The thalovant_skill_* package directory (absent for a skill without one). */
  packageDir?: string;
  entry?: EntryPoint;
  /** From locale/supported.json; else every locale directory, source locale first. */
  locales: string[];
  /** en-US, which skillkit checks every other locale against, when the skill has it. */
  sourceLocale: string;
  resources: Resource[];
  layouts: Layout[];
  goldens: Golden[];
  /** The source file that defines the skill class, if found. */
  classFile?: string;
  title: string;
}

export const SOURCE_LOCALE = "en-US";

const IGNORED_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "build", "dist", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", "site-packages"]);

/** Every skill root at or under `folder`, two levels deep (a workspace of skills). */
export function findSkillRoots(folder: string, depth = 2): string[] {
  const found: string[] = [];
  const visit = (dir: string, level: number) => {
    if (isSkillRoot(dir)) {
      found.push(dir);
      return;
    }
    if (level >= depth) return;
    for (const entry of safeReaddir(dir)) {
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        visit(path.join(dir, entry.name), level + 1);
      }
    }
  };
  visit(folder, 0);
  return found;
}

export function isSkillRoot(dir: string): boolean {
  if (findPackage(dir)) return true;
  const pyproject = readText(path.join(dir, "pyproject.toml"));
  return !!pyproject && /entry-points\."?(opm\.skill|ovos\.plugin\.skill)"?\]/.test(pyproject);
}

/** The skill root a file belongs to, walking up from it. */
export function skillRootOf(file: string, roots: string[]): string | undefined {
  let best: string | undefined;
  for (const root of roots) {
    const relative = path.relative(root, file);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  return best;
}

export function findPackage(root: string): string | undefined {
  const names = safeReaddir(root)
    .filter((e) => e.isDirectory() && e.name.startsWith("thalovant_skill_"))
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    if (fs.existsSync(path.join(root, name, "__init__.py"))) return path.join(root, name);
  }
  return undefined;
}

export function loadSkill(root: string): SkillModel {
  const entry = readEntryPoint(root);
  let packageDir = findPackage(root);
  if (!packageDir && entry) {
    const candidate = path.join(root, ...entry.module.split("."));
    if (fs.existsSync(path.join(candidate, "__init__.py"))) packageDir = candidate;
  }
  const localeDir = packageDir ? path.join(packageDir, "locale") : path.join(root, "locale");
  const resources = readResources(localeDir);
  const directories = safeReaddir(localeDir).filter((e) => e.isDirectory()).map((e) => e.name);
  const supported = readSupported(path.join(localeDir, "supported.json"));
  let locales = supported ?? directories.sort();
  if (!supported && locales.includes(SOURCE_LOCALE)) {
    locales = [SOURCE_LOCALE, ...locales.filter((l) => l !== SOURCE_LOCALE)];
  }
  const sourceLocale = locales.includes(SOURCE_LOCALE) ? SOURCE_LOCALE : locales[0] ?? SOURCE_LOCALE;
  const layouts = packageDir ? readLayouts(path.join(packageDir, "gui", "thalovant")) : [];
  const goldens = readGoldens(root);
  const classFile = packageDir ? path.join(packageDir, "__init__.py") : undefined;
  const title = titleOf(root, entry, localeDir, sourceLocale);
  return { root, packageDir, entry, locales, sourceLocale, resources, layouts, goldens, classFile, title };
}

function titleOf(root: string, entry: EntryPoint | undefined, localeDir: string, lang: string): string {
  const json = readJson(path.join(localeDir, lang, "skill.json"));
  if (json && typeof json.name === "string" && json.name.trim()) return json.name.trim();
  const slug = (entry?.skillId ?? path.basename(root)).replace(/\.thalovant$/, "").replace(/^thalovant-skill-/, "");
  return slug.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// -- entry points -------------------------------------------------------------

const ENTRY_GROUPS = ["opm.skill", "ovos.plugin.skill", "mycroft.plugin.skill"];

export function readEntryPoint(root: string): EntryPoint | undefined {
  const pyprojectFile = path.join(root, "pyproject.toml");
  const pyproject = readText(pyprojectFile);
  if (pyproject) {
    const found = entryFromPyproject(pyproject);
    if (found) return { ...found, file: pyprojectFile };
  }
  const setupFile = path.join(root, "setup.py");
  const setup = readText(setupFile);
  if (setup) {
    const lines = setup.split(/\r?\n/);
    const pattern = /["']\s*([A-Za-z0-9_.-]+)\s*=\s*([A-Za-z0-9_.]+)\s*:\s*([A-Za-z0-9_]+)\s*["']/;
    for (let i = 0; i < lines.length; i++) {
      const m = pattern.exec(lines[i]);
      if (m) return { skillId: m[1], module: m[2], className: m[3], file: setupFile, line: i };
    }
    // The fleet's older setup.py spells it from variables: SKILL_NAME.SKILL_AUTHOR=PKG:CLAZZ.
    const variable = (name: string) => new RegExp(`^${name}\\s*=\\s*["']([^"']+)["']`, "m").exec(setup)?.[1];
    const [name, author, pkg, clazz] = ["SKILL_NAME", "SKILL_AUTHOR", "SKILL_PKG", "SKILL_CLAZZ"].map(variable);
    if (name && author && pkg && clazz) {
      const line = Math.max(0, lines.findIndex((l) => l.includes("SKILL_CLAZZ")));
      return { skillId: `${name}.${author}`, module: pkg, className: clazz, file: setupFile, line };
    }
  }
  return undefined;
}

/** The first skill entry point in a pyproject.toml, read without a TOML library. */
export function entryFromPyproject(text: string): Omit<EntryPoint, "file"> | undefined {
  const lines = text.split(/\r?\n/);
  let inGroup = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const header = /^\[project\.entry-points\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\]$/.exec(line);
    if (header) {
      inGroup = ENTRY_GROUPS.includes(header[1] ?? header[2] ?? header[3]);
      continue;
    }
    if (line.startsWith("[")) {
      inGroup = false;
      continue;
    }
    if (!inGroup) continue;
    const m = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=\s*["']([A-Za-z0-9_.]+)\s*:\s*([A-Za-z0-9_]+)["']/.exec(line);
    if (m) return { skillId: m[1] ?? m[2] ?? m[3], module: m[4], className: m[5], line: i };
  }
  return undefined;
}

// -- locale resources ---------------------------------------------------------

export function readResources(localeDir: string): Resource[] {
  const out: Resource[] = [];
  for (const langEntry of safeReaddir(localeDir)) {
    if (!langEntry.isDirectory()) continue;
    const lang = langEntry.name;
    walk(path.join(localeDir, lang), (file) => {
      const base = path.basename(file);
      // `name.ssml.dialog` is a misnamed twin; skillkit reports it, we index it as SSML.
      const suffix = base.endsWith(".ssml.dialog") ? ".ssml" : path.extname(base);
      const kind = RESOURCE_SUFFIX[suffix];
      if (!kind) return;
      let name = base.slice(0, base.length - (base.endsWith(".ssml.dialog") ? ".ssml.dialog".length : suffix.length));
      if (kind === "intent" || kind === "entity") name = base;
      out.push({ kind, name, lang, file, lines: resourceLines(readText(file) ?? "") });
    });
  }
  return out;
}

export function resourceLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function readSupported(file: string): string[] | undefined {
  const json = readJson(file);
  const locales = json?.locales;
  return Array.isArray(locales) && locales.every((l) => typeof l === "string") ? (locales as string[]) : undefined;
}

function readLayouts(dir: string): Layout[] {
  return safeReaddir(dir)
    .filter((e) => e.isFile() && e.name.endsWith(".rfwtxt"))
    .map((e) => ({ name: e.name.slice(0, -".rfwtxt".length), file: path.join(dir, e.name) }));
}

// -- golden utterances ------------------------------------------------------

/** test/**\/golden_utterances*.jsonl, and *golden*.json arrays (the weather skill's form). */
export function readGoldens(root: string): Golden[] {
  const out: Golden[] = [];
  walk(path.join(root, "test"), (file) => {
    const base = path.basename(file);
    if (/^golden_utterances.*\.jsonl$/.test(base)) {
      const text = readText(file) ?? "";
      text.split(/\r?\n/).forEach((line, index) => {
        if (!line.trim()) return;
        try {
          const row = JSON.parse(line);
          const golden = goldenFrom(row, file, index);
          if (golden) out.push(golden);
        } catch {
          // A broken line is reported by the test run, where its line is shown.
          out.push({ file, line: index, utterance: line.trim().slice(0, 60), negative: false, raw: { invalid: true } });
        }
      });
    } else if (/golden.*\.json$/.test(base)) {
      const json = readJsonAny(file);
      if (Array.isArray(json)) {
        const text = readText(file) ?? "";
        json.forEach((row, index) => {
          const golden = goldenFrom(row, file, lineOfUtterance(text, row, index));
          if (golden) out.push(golden);
        });
      }
    }
  }, 3);
  return out;
}

function lineOfUtterance(text: string, row: unknown, fallback: number): number {
  const utterance = (row as { utterance?: unknown })?.utterance;
  if (typeof utterance !== "string") return fallback;
  const index = text.indexOf(JSON.stringify(utterance));
  return index < 0 ? fallback : text.slice(0, index).split("\n").length - 1;
}

export function goldenFrom(row: unknown, file: string, line: number): Golden | undefined {
  if (!row || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  if (typeof r.utterance !== "string") return undefined;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    file,
    line,
    utterance: r.utterance,
    lang: str(r.lang),
    intent: str(r.intent_label) ?? str(r.intent),
    skillId: str(r.skill_id),
    negative: r.negative === true || r.expected === "unmatched",
    raw: r,
  };
}

// -- questions the editor asks --------------------------------------------------

export function resourcesNamed(model: SkillModel, kinds: ResourceKind[], name: string): Resource[] {
  return model.resources.filter((r) => kinds.includes(r.kind) && r.name === name);
}

export function resourceNames(model: SkillModel, kinds: ResourceKind[]): Map<string, Resource[]> {
  const names = new Map<string, Resource[]>();
  for (const r of model.resources) {
    if (!kinds.includes(r.kind)) continue;
    const list = names.get(r.name) ?? [];
    list.push(r);
    names.set(r.name, list);
  }
  return names;
}

/** Locales that ship `name` and those that do not, in the skill's locale order. */
export function coverage(model: SkillModel, kinds: ResourceKind[], name: string): { have: string[]; missing: string[] } {
  const have = new Set(resourcesNamed(model, kinds, name).map((r) => r.lang));
  return {
    have: model.locales.filter((l) => have.has(l)),
    missing: model.locales.filter((l) => !have.has(l)),
  };
}

// -- small file helpers ------------------------------------------------------------

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function readJsonAny(file: string): unknown {
  const text = readText(file);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  const json = readJsonAny(file);
  return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
}

function walk(dir: string, visit: (file: string) => void, depth = 6): void {
  if (depth < 0) return;
  for (const entry of safeReaddir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) walk(full, visit, depth - 1);
    } else if (entry.isFile()) {
      visit(full);
    }
  }
}
