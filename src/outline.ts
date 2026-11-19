// The Skill view: what the skill is made of, and what each locale lacks.
import * as path from "node:path";
import * as vscode from "vscode";
import { coverage, Resource, ResourceKind, resourceNames, SkillModel } from "./core/skill";
import { SkillRegistry } from "./registry";

type Node =
  | { type: "skill"; model: SkillModel }
  | { type: "fact"; label: string; description?: string; icon: string; tooltip?: string; command?: vscode.Command }
  | { type: "group"; model: SkillModel; kind: "intent" | "dialog" | "vocab" | "layout" | "locale"; label: string; icon: string }
  | { type: "resource"; model: SkillModel; kind: ResourceKind; name: string; list: Resource[] }
  | { type: "file"; file: string; label: string; description?: string }
  | { type: "locale"; model: SkillModel; lang: string };

const GROUPS: { kind: "intent" | "dialog" | "vocab" | "layout" | "locale"; label: string; icon: string }[] = [
  { kind: "locale", label: "Locales", icon: "globe" },
  { kind: "intent", label: "Intents", icon: "symbol-event" },
  { kind: "dialog", label: "Dialogs", icon: "comment" },
  { kind: "vocab", label: "Vocabulary", icon: "symbol-keyword" },
  { kind: "layout", label: "Screen layouts", icon: "layout" },
];

export class Outline implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly registry: SkillRegistry) {
    registry.onDidChangeSkill(() => this.changed.fire(undefined));
    registry.onDidChangeActive(() => this.changed.fire(undefined));
  }

  refresh(): void {
    this.registry.discover();
  }

  /** Refresh state shown from a session (running, failed) without re-reading files. */
  touch(): void {
    this.changed.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const all = this.registry.all;
      if (all.length === 1) return this.skillChildren(all[0]);
      return all.map((model) => ({ type: "skill", model }));
    }
    switch (node.type) {
      case "skill":
        return this.skillChildren(node.model);
      case "group":
        return this.groupChildren(node.model, node.kind);
      case "resource":
        return node.list
          .sort((a, b) => node.model.locales.indexOf(a.lang) - node.model.locales.indexOf(b.lang))
          .map((r) => ({ type: "file", file: r.file, label: r.lang, description: `${r.lines.length} line${r.lines.length === 1 ? "" : "s"}${r.kind === "ssml" ? " · SSML" : ""}` }));
      case "locale": {
        const gaps = this.gaps(node.model, node.lang);
        return gaps.map((g) => ({ type: "fact", label: g, icon: "warning", description: "missing" }));
      }
      default:
        return [];
    }
  }

  private skillChildren(model: SkillModel): Node[] {
    const session = this.registry.existingSession(model.root);
    const state = session?.state ?? "stopped";
    const facts: Node[] = [];
    facts.push({
      type: "fact",
      label: model.title,
      description: { ready: "running", starting: "starting…", failed: "not running", stopped: "" }[state],
      icon: { ready: "pass-filled", starting: "loading~spin", failed: "error", stopped: "circle-large-outline" }[state],
      tooltip: session?.failure?.message ?? (session?.info ? `${session.info.class} · ${session.info.base} · ${session.python}` : "Open the simulator to run it"),
      command: { command: "thalovant.openSimulator", title: "Open the simulator", arguments: [model.root] },
    });
    if (model.entry) {
      facts.push({ type: "fact", label: model.entry.skillId, description: `${model.entry.module}:${model.entry.className}`, icon: "symbol-class", command: model.classFile ? openCommand(model.classFile) : undefined });
    } else {
      facts.push({ type: "fact", label: "No skill entry point", description: "pyproject.toml", icon: "warning", tooltip: "The hub finds a skill by its opm.skill entry point." });
    }
    if (session?.info?.fallback_priority) {
      facts.push({ type: "fact", label: `Fallback priority ${session.info.fallback_priority}`, description: priorityHint(session.info.fallback_priority), icon: "list-ordered" });
    }
    const groups: Node[] = GROUPS.filter((g) => g.kind === "locale" || g.kind === "layout" ? true : model.resources.some((r) => r.kind === g.kind))
      .filter((g) => g.kind !== "layout" || model.layouts.length)
      .map((g) => ({ type: "group", model, ...g }));
    if (model.goldens.length) {
      facts.push({ type: "fact", label: `${model.goldens.length} golden utterance${model.goldens.length === 1 ? "" : "s"}`, icon: "beaker", command: { command: "workbench.view.testing.focus", title: "Testing" } });
    }
    return [...facts, ...groups];
  }

  private groupChildren(model: SkillModel, kind: "intent" | "dialog" | "vocab" | "layout" | "locale"): Node[] {
    if (kind === "locale") return model.locales.map((lang) => ({ type: "locale", model, lang }));
    if (kind === "layout") return model.layouts.map((l) => ({ type: "file", file: l.file, label: l.name, description: "gui/thalovant" }));
    const kinds: ResourceKind[] = kind === "dialog" ? ["dialog", "ssml"] : [kind];
    const names = resourceNames(model, kinds);
    return [...names.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => ({ type: "resource", model, kind, name, list }));
  }

  /** What `lang` lacks that the source locale has. */
  private gaps(model: SkillModel, lang: string): string[] {
    if (lang === model.sourceLocale) return [];
    const source = model.resources.filter((r) => r.lang === model.sourceLocale);
    const here = new Set(model.resources.filter((r) => r.lang === lang).map((r) => `${r.kind}:${r.name}`));
    return source.filter((r) => !here.has(`${r.kind}:${r.name}`)).map((r) => path.relative(path.join(model.packageDir ?? model.root, "locale", model.sourceLocale), r.file));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.type) {
      case "skill": {
        const item = new vscode.TreeItem(node.model.title, vscode.TreeItemCollapsibleState.Expanded);
        item.description = path.basename(node.model.root);
        item.iconPath = new vscode.ThemeIcon(this.registry.active?.root === node.model.root ? "play-circle" : "package");
        return item;
      }
      case "fact": {
        const item = new vscode.TreeItem(node.label);
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.tooltip = node.tooltip;
        item.command = node.command;
        return item;
      }
      case "group": {
        const item = new vscode.TreeItem(node.label, node.kind === "locale" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        if (node.kind === "locale") item.description = `${node.model.locales.length}`;
        else if (node.kind === "layout") item.description = `${node.model.layouts.length}`;
        else item.description = `${resourceNames(node.model, node.kind === "dialog" ? ["dialog"] : [node.kind]).size}`;
        return item;
      }
      case "resource": {
        const kinds: ResourceKind[] = node.kind === "dialog" ? ["dialog"] : [node.kind];
        const { missing } = coverage(node.model, kinds, node.name);
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
        const ssml = node.kind === "dialog" && node.list.some((r) => r.kind === "ssml");
        item.description = [missing.length ? `missing ${missing.join(", ")}` : "", ssml ? "SSML" : ""].filter(Boolean).join(" · ");
        item.iconPath = new vscode.ThemeIcon(missing.length ? "warning" : node.kind === "intent" ? "symbol-event" : node.kind === "vocab" ? "symbol-keyword" : "comment");
        const source = node.list.find((r) => r.lang === node.model.sourceLocale) ?? node.list[0];
        item.tooltip = new vscode.MarkdownString().appendCodeblock(source.lines.slice(0, 6).join("\n"), "text");
        if (node.kind === "intent" && source.lines[0]) item.contextValue = "intent";
        return item;
      }
      case "file": {
        const item = new vscode.TreeItem(node.label);
        item.description = node.description;
        item.resourceUri = vscode.Uri.file(node.file);
        item.command = openCommand(node.file);
        return item;
      }
      case "locale": {
        const gaps = this.gaps(node.model, node.lang);
        const item = new vscode.TreeItem(node.lang, gaps.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.description = node.lang === node.model.sourceLocale ? "source" : gaps.length ? `${gaps.length} missing` : "complete";
        item.iconPath = new vscode.ThemeIcon(gaps.length ? "warning" : "check");
        return item;
      }
    }
  }
}

function openCommand(file: string): vscode.Command {
  return { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(file)] };
}

function priorityHint(priority: number): string {
  if (priority <= 95) return "answers one specific thing";
  if (priority <= 98) return "answers a topic";
  return "answers almost anything";
}
