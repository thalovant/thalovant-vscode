// Code and locale files that know about each other.
//
// In Python: complete, hover and go to the dialog, vocabulary, intent and
// layout a call names, and flag a name no locale has. In locale files: a
// "Say this" lens on each intent line, and the other locales' version of the
// file one hover away.
import * as path from "node:path";
import * as vscode from "vscode";
import { BUILDER_CALLS, references, resourceKey, StringArg, stringArgAt } from "./core/references";
import { coverage, Resource, ResourceKind, resourceNames, resourcesNamed, SkillModel } from "./core/skill";
import { expand, sayable } from "./core/templates";
import { SkillRegistry } from "./registry";

const PYTHON: vscode.DocumentSelector = { language: "python", scheme: "file" };
const LOCALE_FILES: vscode.DocumentSelector = [
  { language: "thalovant-intent", scheme: "file" },
  { language: "thalovant-dialog", scheme: "file" },
  { language: "thalovant-vocab", scheme: "file" },
  { language: "thalovant-ssml", scheme: "file" },
];

export function registerLanguage(context: vscode.ExtensionContext, registry: SkillRegistry, sharedDialogs: () => Set<string>): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("thalovant-resources");
  context.subscriptions.push(diagnostics);

  const modelAt = (doc: vscode.TextDocument) => registry.modelFor(doc.uri);

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(PYTHON, {
    provideCompletionItems(doc, position) {
      const model = modelAt(doc);
      if (!model) return undefined;
      const text = doc.getText();
      const arg = stringArgAt(text, doc.offsetAt(position));
      if (!arg) return undefined;
      const range = new vscode.Range(doc.positionAt(arg.start), doc.positionAt(arg.closed ? arg.end : doc.offsetAt(position)));
      return candidates(model, arg, sharedDialogs()).map((c) => {
        const item = new vscode.CompletionItem(c.name, c.kind);
        item.range = range;
        item.detail = c.detail;
        item.documentation = c.documentation;
        item.sortText = c.sort + c.name;
        return item;
      });
    },
  }, '"', "'", "."));

  context.subscriptions.push(vscode.languages.registerHoverProvider(PYTHON, {
    provideHover(doc, position) {
      const model = modelAt(doc);
      if (!model) return undefined;
      const arg = stringArgAt(doc.getText(), doc.offsetAt(position));
      if (!arg || !arg.closed) return undefined;
      const markdown = describe(model, arg, sharedDialogs());
      return markdown ? new vscode.Hover(markdown, new vscode.Range(doc.positionAt(arg.start), doc.positionAt(arg.end))) : undefined;
    },
  }));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(PYTHON, {
    provideDefinition(doc, position) {
      const model = modelAt(doc);
      if (!model) return undefined;
      const arg = stringArgAt(doc.getText(), doc.offsetAt(position));
      if (!arg || !arg.closed) return undefined;
      return targets(model, arg).map((file) => new vscode.Location(vscode.Uri.file(file), new vscode.Position(0, 0)));
    },
  }));

  context.subscriptions.push(vscode.languages.registerCodeLensProvider(LOCALE_FILES, new LocaleLens(registry)));
  context.subscriptions.push(vscode.languages.registerCodeLensProvider(PYTHON, new HandlerLens(registry)));
  context.subscriptions.push(vscode.languages.registerHoverProvider(LOCALE_FILES, {
    provideHover(doc) {
      const model = modelAt(doc);
      if (!model) return undefined;
      const here = model.resources.find((r) => r.file === doc.uri.fsPath);
      if (!here) return undefined;
      const kinds: ResourceKind[] = [here.kind];
      return new vscode.Hover(localesTable(model, kinds, here.name, here.lang));
    },
  }));

  // -- diagnostics: names no locale has --
  const refresh = (doc: vscode.TextDocument) => {
    if (doc.languageId !== "python" || doc.uri.scheme !== "file") return;
    const model = modelAt(doc);
    if (!model || !model.packageDir || !doc.uri.fsPath.startsWith(model.packageDir)) {
      diagnostics.delete(doc.uri);
      return;
    }
    diagnostics.set(doc.uri, check(doc, model, sharedDialogs()));
  };
  const refreshAll = () => vscode.workspace.textDocuments.forEach(refresh);
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => refresh(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri)),
    registry.onDidChangeSkill(refreshAll),
  );
  refreshAll();
}

interface Candidate {
  name: string;
  kind: vscode.CompletionItemKind;
  detail: string;
  documentation?: vscode.MarkdownString;
  sort: string;
}

function kindsOf(arg: StringArg): ResourceKind[] {
  return arg.rule.kinds;
}

function candidates(model: SkillModel, arg: StringArg, shared: Set<string>): Candidate[] {
  if (arg.rule.label === "layout") {
    return model.layouts.map((l) => ({ name: l.name, kind: vscode.CompletionItemKind.File, detail: "layout · gui/thalovant", sort: "0" }));
  }
  const kinds = kindsOf(arg);
  const out: Candidate[] = [];
  for (const [name, list] of resourceNames(model, kinds)) {
    const { missing } = coverage(model, kinds, name);
    const shownName = arg.rule.kinds.includes("intent") && arg.call !== "intent_handler" && arg.call !== "register_intent" ? name.replace(/\.intent$/, "") : name;
    out.push({
      name: shownName,
      kind: kinds.includes("intent") ? vscode.CompletionItemKind.Event : kinds.includes("vocab") ? vscode.CompletionItemKind.Keyword : vscode.CompletionItemKind.Text,
      detail: `${arg.rule.label} · ${missing.length ? `missing in ${missing.join(", ")}` : `${list.length} locale${list.length === 1 ? "" : "s"}`}`,
      documentation: sampleLines(model, list),
      sort: missing.length ? "1" : "0",
    });
  }
  if (kinds.includes("dialog")) {
    for (const name of shared) {
      if (!out.some((c) => c.name === name)) out.push({ name, kind: vscode.CompletionItemKind.Reference, detail: "dialog · shared by SkillKit", sort: "2" });
    }
  }
  return out;
}

function sampleLines(model: SkillModel, list: Resource[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const byLang = [...list].sort((a, b) => model.locales.indexOf(a.lang) - model.locales.indexOf(b.lang));
  for (const r of byLang.slice(0, 4)) {
    md.appendMarkdown(`**${r.lang}**\n\n`);
    md.appendCodeblock(r.lines.slice(0, 3).join("\n") || "(empty)", "text");
  }
  return md;
}

function describe(model: SkillModel, arg: StringArg, shared: Set<string>): vscode.MarkdownString | undefined {
  if (arg.rule.label === "layout") {
    const layout = model.layouts.find((l) => l.name === arg.value);
    const md = new vscode.MarkdownString();
    md.appendMarkdown(layout ? `Layout \`${arg.value}\` · [gui/thalovant/${arg.value}.rfwtxt](${vscode.Uri.file(layout.file)})` : `No layout \`gui/thalovant/${arg.value}.rfwtxt\` in this skill.`);
    return md;
  }
  const key = resourceKey(arg);
  if (!key) return undefined;
  if (arg.rule.kinds.includes("dialog") && shared.has(key) && !resourcesNamed(model, ["dialog"], key).length) {
    return new vscode.MarkdownString(`Dialog \`${key}\`, shared by SkillKit for every skill.`);
  }
  return localesTable(model, arg.rule.kinds, key);
}

function localesTable(model: SkillModel, kinds: ResourceKind[], name: string, current?: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportHtml = false;
  const kindName = kinds.includes("intent") ? "Intent" : kinds.includes("vocab") ? "Vocabulary" : kinds.includes("entity") ? "Entity" : kinds.includes("ssml") ? "SSML twin" : "Dialog";
  md.appendMarkdown(`**${kindName} \`${name}\`**\n\n`);
  const found = resourcesNamed(model, kinds, name);
  for (const lang of model.locales) {
    if (lang === current) continue;
    const r = found.find((f) => f.lang === lang);
    if (!r) {
      md.appendMarkdown(`$(warning) **${lang}** — missing\n\n`);
      continue;
    }
    const twin = kinds.includes("dialog") && resourcesNamed(model, ["ssml"], name).some((s) => s.lang === lang) ? " · SSML twin" : "";
    md.appendMarkdown(`**${lang}** · [${path.basename(r.file)}](${vscode.Uri.file(r.file)}) · ${r.lines.length} line${r.lines.length === 1 ? "" : "s"}${twin}\n`);
    md.appendCodeblock(r.lines.slice(0, 4).join("\n") + (r.lines.length > 4 ? "\n…" : ""), "text");
  }
  if (kinds.includes("intent") && found[0]?.lines[0]) {
    const examples = expand(found[0].lines[0], 3);
    if (examples.length) md.appendMarkdown(`\nSays: ${examples.map((e) => `“${e}”`).join(", ")}`);
  }
  md.supportThemeIcons = true;
  return md;
}

function targets(model: SkillModel, arg: StringArg): string[] {
  if (arg.rule.label === "layout") return model.layouts.filter((l) => l.name === arg.value).map((l) => l.file);
  const key = resourceKey(arg);
  if (!key) return [];
  const kinds: ResourceKind[] = arg.rule.kinds.includes("dialog") ? ["dialog", "ssml"] : arg.rule.kinds;
  const found = resourcesNamed(model, kinds, key);
  // Source locale first: that is the file people mean.
  return found.sort((a, b) => model.locales.indexOf(a.lang) - model.locales.indexOf(b.lang) || a.kind.localeCompare(b.kind)).map((r) => r.file);
}

export function check(doc: vscode.TextDocument, model: SkillModel, shared: Set<string>): vscode.Diagnostic[] {
  const text = doc.getText();
  const usesBuilder = /IntentBuilder/.test(text);
  const out: vscode.Diagnostic[] = [];
  for (const arg of references(text)) {
    if (BUILDER_CALLS.has(arg.call) && !usesBuilder) continue;
    const range = new vscode.Range(doc.positionAt(arg.start), doc.positionAt(arg.end));
    if (arg.rule.label === "layout") {
      if (!model.layouts.some((l) => l.name === arg.value)) {
        out.push(diagnostic(range, `No layout gui/thalovant/${arg.value}.rfwtxt in this skill.`, vscode.DiagnosticSeverity.Error, "missing-layout"));
      }
      continue;
    }
    const key = resourceKey(arg);
    if (!key) continue;
    const kinds = arg.rule.kinds;
    if (kinds.includes("dialog") && shared.has(key)) continue;
    const { have, missing } = coverage(model, kinds, key);
    if (!have.length) {
      out.push(diagnostic(range, `No ${arg.rule.label} “${key}” in any locale: the skill ${kinds.includes("dialog") ? "will speak the name itself" : "cannot load it"}.`, vscode.DiagnosticSeverity.Warning, `missing-${arg.rule.label}`));
    } else if (missing.length) {
      out.push(diagnostic(range, `${arg.rule.label[0].toUpperCase()}${arg.rule.label.slice(1)} “${key}” is missing in ${missing.join(", ")}.`, vscode.DiagnosticSeverity.Information, `partial-${arg.rule.label}`));
    }
  }
  return out;
}

function diagnostic(range: vscode.Range, message: string, severity: vscode.DiagnosticSeverity, code: string): vscode.Diagnostic {
  const d = new vscode.Diagnostic(range, message, severity);
  d.source = "thalovant";
  d.code = code;
  return d;
}

/** "▷ Say" over every line of an intent file, and over a dialog's lines in nothing. */
class LocaleLens implements vscode.CodeLensProvider {
  constructor(private readonly registry: SkillRegistry) {}

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.languageId !== "thalovant-intent" && doc.languageId !== "thalovant-vocab") return [];
    const model = this.registry.modelFor(doc.uri);
    if (!model) return [];
    const lang = langOf(doc.uri.fsPath, model);
    const lenses: vscode.CodeLens[] = [];
    for (let i = 0; i < doc.lineCount && lenses.length < 60; i++) {
      const line = doc.lineAt(i).text.trim();
      if (!line || line.startsWith("#")) continue;
      const sentence = doc.languageId === "thalovant-vocab" ? undefined : sayable(line);
      if (!sentence) continue;
      lenses.push(new vscode.CodeLens(new vscode.Range(i, 0, i, 0), { title: `▷ Say “${sentence}”`, command: "thalovant.sayLine", arguments: [sentence, lang, model.root] }));
    }
    return lenses;
  }
}

/** "▷ Try" above an @intent_handler, with a sentence from its file. */
class HandlerLens implements vscode.CodeLensProvider {
  constructor(private readonly registry: SkillRegistry) {}

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const model = this.registry.modelFor(doc.uri);
    if (!model) return [];
    const lenses: vscode.CodeLens[] = [];
    const pattern = /@(?:intent_handler|intent_file_handler)\(\s*["']([^"']+)["']/g;
    const text = doc.getText();
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text))) {
      const name = m[1].endsWith(".intent") ? m[1] : `${m[1]}.intent`;
      const resource = resourcesNamed(model, ["intent"], name).sort((a, b) => model.locales.indexOf(a.lang) - model.locales.indexOf(b.lang))[0];
      const sentence = resource?.lines[0] ? sayable(resource.lines[0]) : undefined;
      if (!sentence || !resource) continue;
      const position = doc.positionAt(m.index);
      lenses.push(new vscode.CodeLens(new vscode.Range(position, position), { title: `▷ Try “${sentence}”`, command: "thalovant.sayLine", arguments: [sentence, resource.lang, model.root] }));
    }
    if (/class\s+\w+\(\s*Thalovant\w*Fallback\w*Skill/.test(text)) {
      const index = text.search(/def can_answer\(/);
      const vocab = model.resources.find((r) => r.kind === "vocab" && r.lang === model.sourceLocale && r.lines[0]);
      if (index >= 0 && vocab) {
        const term = vocab.lines[0].split("|")[0].trim();
        const position = doc.positionAt(index);
        lenses.push(new vscode.CodeLens(new vscode.Range(position, position), { title: `▷ Try “what is ${term}”`, command: "thalovant.sayLine", arguments: [`what is ${term}`, model.sourceLocale, model.root] }));
      }
    }
    return lenses;
  }
}

export function langOf(file: string, model: SkillModel): string | undefined {
  const parts = file.split(path.sep);
  const index = parts.lastIndexOf("locale");
  return index >= 0 && parts[index + 1] && model.locales.includes(parts[index + 1]) ? parts[index + 1] : undefined;
}
