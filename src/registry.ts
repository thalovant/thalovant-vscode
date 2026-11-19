// The skills in the workspace, and the one being worked on.
import * as path from "node:path";
import * as vscode from "vscode";
import { findSkillRoots, loadSkill, SkillModel, skillRootOf } from "./core/skill";
import { SkillSession } from "./session";

export class SkillRegistry implements vscode.Disposable {
  private models = new Map<string, SkillModel>();
  private sessions = new Map<string, SkillSession>();
  private activeRoot?: string;
  private readonly changed = new vscode.EventEmitter<SkillModel | undefined>();
  private readonly activeChanged = new vscode.EventEmitter<SkillModel | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private reloadTimers = new Map<string, NodeJS.Timeout>();

  /** A skill's files changed (its model was re-read). */
  readonly onDidChangeSkill = this.changed.event;
  /** The skill being worked on changed. */
  readonly onDidChangeActive = this.activeChanged.event;

  constructor(private readonly context: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel) {
    this.disposables.push(this.changed, this.activeChanged);
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.discover()));
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor((editor) => editor && this.follow(editor.document.uri)));
    const watcher = vscode.workspace.createFileSystemWatcher("**/{locale/**,gui/thalovant/*,test/**/*golden*,pyproject.toml,setup.py,thalovant_skill_*/__init__.py}");
    const touched = (uri: vscode.Uri) => this.touched(uri);
    watcher.onDidCreate(touched, undefined, this.disposables);
    watcher.onDidDelete(touched, undefined, this.disposables);
    watcher.onDidChange(touched, undefined, this.disposables);
    this.disposables.push(watcher);
  }

  discover(): void {
    const roots = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") continue;
      for (const root of findSkillRoots(folder.uri.fsPath)) roots.add(root);
    }
    for (const root of [...this.models.keys()]) {
      if (!roots.has(root)) {
        this.models.delete(root);
        this.sessions.get(root)?.dispose();
        this.sessions.delete(root);
      }
    }
    for (const root of roots) if (!this.models.has(root)) this.models.set(root, loadSkill(root));
    if (!this.activeRoot || !this.models.has(this.activeRoot)) this.activeRoot = [...this.models.keys()][0];
    const editor = vscode.window.activeTextEditor;
    if (editor) this.follow(editor.document.uri, false);
    void vscode.commands.executeCommand("setContext", "thalovant.isSkill", this.models.size > 0);
    this.log.info(`skills in the workspace: ${[...this.models.keys()].map((r) => path.basename(r)).join(", ") || "none"}`);
    this.changed.fire(undefined);
    this.activeChanged.fire(this.active);
  }

  get all(): SkillModel[] {
    return [...this.models.values()];
  }

  get active(): SkillModel | undefined {
    return this.activeRoot ? this.models.get(this.activeRoot) : undefined;
  }

  setActive(root: string): void {
    if (root !== this.activeRoot && this.models.has(root)) {
      this.activeRoot = root;
      this.activeChanged.fire(this.active);
    }
  }

  modelFor(uri: vscode.Uri): SkillModel | undefined {
    const root = skillRootOf(uri.fsPath, [...this.models.keys()]);
    return root ? this.models.get(root) : undefined;
  }

  session(model: SkillModel): SkillSession {
    let session = this.sessions.get(model.root);
    if (!session) {
      session = new SkillSession(this.context, () => this.models.get(model.root) ?? model, this.log);
      this.sessions.set(model.root, session);
    }
    return session;
  }

  existingSession(root: string): SkillSession | undefined {
    return this.sessions.get(root);
  }

  reload(root: string): SkillModel | undefined {
    if (!this.models.has(root)) return undefined;
    const model = loadSkill(root);
    this.models.set(root, model);
    this.changed.fire(model);
    if (root === this.activeRoot) this.activeChanged.fire(model);
    return model;
  }

  private follow(uri: vscode.Uri, fire = true): void {
    if (uri.scheme !== "file") return;
    const root = skillRootOf(uri.fsPath, [...this.models.keys()]);
    if (root && root !== this.activeRoot) {
      this.activeRoot = root;
      if (fire) this.activeChanged.fire(this.active);
    }
  }

  private touched(uri: vscode.Uri): void {
    const root = skillRootOf(uri.fsPath, [...this.models.keys()]);
    if (!root) {
      // A new skill appeared (for example from New Skill… into this folder).
      if (/pyproject\.toml$|__init__\.py$/.test(uri.fsPath)) this.discover();
      return;
    }
    clearTimeout(this.reloadTimers.get(root));
    this.reloadTimers.set(root, setTimeout(() => this.reload(root), 150));
  }

  dispose(): void {
    for (const timer of this.reloadTimers.values()) clearTimeout(timer);
    for (const session of this.sessions.values()) session.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
