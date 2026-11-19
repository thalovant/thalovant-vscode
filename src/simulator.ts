// The simulator: a satellite next to the code.
//
// Type what someone would say; see what the skill says (and its SSML), what
// an app shows (the written form), what the screen shows (the card, with
// buttons that tap back into the skill), which intent and handler took it,
// its log lines and every bus message. The conversation stays on screen when
// a save restarts the skill.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { frameInSkill } from "./core/problems";
import { RunnerError, TurnResult } from "./core/runner";
import { SkillModel } from "./core/skill";
import { sayable } from "./core/templates";
import { SkillRegistry } from "./registry";
import { SkillSession } from "./session";

interface TurnRecord {
  id: string;
  kind: "say" | "tap" | "event" | "notice";
  text: string;
  lang?: string;
  at: number;
  pending: boolean;
  result?: TurnResult;
  error?: { message: string; detail?: string };
  /** For an error with a frame in the skill: where to open it. */
  where?: { file: string; line: number; label: string };
}

interface Conversation {
  turns: TurnRecord[];
  sessionId: string;
  lang?: string;
  location?: string;
}

export const LOCATIONS: Record<string, Record<string, unknown>> = {
  Montreal: { name: "Montreal", coordinate: { latitude: 45.5017, longitude: -73.5673 }, timezone: { code: "America/Toronto" }, country_code: "CA", city: { name: "Montreal", state: { name: "Quebec", country: { code: "CA", name: "Canada" } } } },
  Paris: { name: "Paris", coordinate: { latitude: 48.8566, longitude: 2.3522 }, timezone: { code: "Europe/Paris" }, country_code: "FR", city: { name: "Paris", state: { name: "Île-de-France", country: { code: "FR", name: "France" } } } },
  London: { name: "London", coordinate: { latitude: 51.5072, longitude: -0.1276 }, timezone: { code: "Europe/London" }, country_code: "GB", city: { name: "London", state: { name: "England", country: { code: "GB", name: "United Kingdom" } } } },
  "New York": { name: "New York", coordinate: { latitude: 40.7128, longitude: -74.006 }, timezone: { code: "America/New_York" }, country_code: "US", city: { name: "New York", state: { name: "New York", country: { code: "US", name: "United States" } } } },
  Berlin: { name: "Berlin", coordinate: { latitude: 52.52, longitude: 13.405 }, timezone: { code: "Europe/Berlin" }, country_code: "DE", city: { name: "Berlin", state: { name: "Berlin", country: { code: "DE", name: "Germany" } } } },
  Tokyo: { name: "Tokyo", coordinate: { latitude: 35.6764, longitude: 139.65 }, timezone: { code: "Asia/Tokyo" }, country_code: "JP", city: { name: "Tokyo", state: { name: "Tokyo", country: { code: "JP", name: "Japan" } } } },
};

export class Simulator implements vscode.Disposable {
  private static current?: Simulator;
  private readonly conversations = new Map<string, Conversation>();
  private readonly disposables: vscode.Disposable[] = [];
  private sessionListeners: vscode.Disposable[] = [];
  private session?: SkillSession;
  private model?: SkillModel;
  private reloadTimer?: NodeJS.Timeout;

  static show(context: vscode.ExtensionContext, registry: SkillRegistry, model?: SkillModel): Simulator {
    if (Simulator.current) {
      if (model) Simulator.current.bind(model);
      Simulator.current.panel.reveal(undefined, true);
      return Simulator.current;
    }
    const panel = vscode.window.createWebviewPanel("thalovant.simulator", "Thalovant", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    Simulator.current = new Simulator(context, registry, panel);
    const target = model ?? registry.active;
    if (target) Simulator.current.bind(target);
    return Simulator.current;
  }

  static get instance(): Simulator | undefined {
    return Simulator.current;
  }

  /** The current conversation, for tests and the outline. */
  turns(): readonly TurnRecord[] {
    return this.conversation().turns;
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: SkillRegistry,
    readonly panel: vscode.WebviewPanel,
  ) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "activity.svg");
    panel.webview.html = this.html();
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    panel.webview.onDidReceiveMessage((message) => this.onMessage(message), undefined, this.disposables);
    registry.onDidChangeSkill((model) => {
      if (model && this.model && model.root === this.model.root) {
        this.model = model;
        this.post({ type: "skill", skill: this.skillState() });
      }
    }, undefined, this.disposables);
    registry.onDidChangeActive((model) => {
      // Follow the editor between skills only while nothing is in flight.
      if (model && this.model && model.root !== this.model.root && !this.conversation().turns.some((t) => t.pending)) this.bind(model);
    }, undefined, this.disposables);
    vscode.workspace.onDidSaveTextDocument((doc) => this.onSaved(doc), undefined, this.disposables);
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("thalovant.simulator") || e.affectsConfiguration("thalovant.python")) {
        if (this.session && this.session.state !== "stopped") void this.session.restart("settings changed");
        this.post({ type: "settings", settings: this.settings() });
      }
    }, undefined, this.disposables);
  }

  bind(model: SkillModel): void {
    this.model = model;
    this.registry.setActive(model.root);
    for (const d of this.sessionListeners) d.dispose();
    const session = this.registry.session(model);
    this.session = session;
    this.sessionListeners = [
      session.onDidChange(() => this.post({ type: "skill", skill: this.skillState() })),
      session.onDidEmit(({ event, payload }) => this.onUnsolicited(event, payload)),
    ];
    this.panel.title = `Thalovant · ${model.title}`;
    this.postAll();
    void session.ensureStarted();
  }

  async say(text: string, lang?: string): Promise<void> {
    if (!this.session || !this.model) return;
    const conversation = this.conversation();
    const turn: TurnRecord = { id: crypto.randomUUID(), kind: "say", text, lang: lang ?? conversation.lang, at: Date.now(), pending: true };
    conversation.turns.push(turn);
    this.post({ type: "turn", turn });
    try {
      turn.result = await this.session.say(text, { lang: turn.lang, session: conversation.sessionId, location: this.location() });
      turn.lang = turn.lang ?? this.session.info?.lang;
      this.locate(turn);
    } catch (error) {
      const e = error as RunnerError;
      turn.error = { message: e.message, detail: e.detail };
    }
    turn.pending = false;
    this.post({ type: "turn", turn });
    this.speakAloud(turn);
  }

  private async tap(card: string, action: string, skill: string | undefined, label: string): Promise<void> {
    if (!this.session) return;
    const conversation = this.conversation();
    const turn: TurnRecord = { id: crypto.randomUUID(), kind: "tap", text: label || action, at: Date.now(), pending: true, lang: conversation.lang };
    conversation.turns.push(turn);
    this.post({ type: "turn", turn });
    try {
      turn.result = await this.session.tap(card, action, skill, { lang: conversation.lang, session: conversation.sessionId, location: this.location() });
      this.locate(turn);
    } catch (error) {
      const e = error as RunnerError;
      turn.error = { message: e.message, detail: e.detail };
    }
    turn.pending = false;
    this.post({ type: "turn", turn });
    this.speakAloud(turn);
  }

  private async stopSkill(): Promise<void> {
    if (!this.session) return;
    const conversation = this.conversation();
    const turn: TurnRecord = { id: crypto.randomUUID(), kind: "tap", text: "Stop", at: Date.now(), pending: true };
    conversation.turns.push(turn);
    this.post({ type: "turn", turn });
    try {
      turn.result = await this.session.say("stop", { lang: conversation.lang, session: conversation.sessionId });
    } catch (error) {
      turn.error = { message: (error as Error).message };
    }
    turn.pending = false;
    this.post({ type: "turn", turn });
  }

  /** Put a skill error on the line that raised it. */
  private locate(turn: TurnRecord): void {
    const traceback = turn.result?.errors.find((e) => e.traceback)?.traceback;
    if (!traceback || !this.model) return;
    const frame = frameInSkill(traceback, this.model.root);
    if (frame) turn.where = { ...frame, label: `${path.relative(this.model.root, frame.file)}:${frame.line + 1}` };
  }

  private onUnsolicited(event: string, payload: Record<string, unknown>): void {
    if (event === "speak") {
      const reply = payload.reply as TurnResult["replies"][number];
      const conversation = this.conversation();
      const turn: TurnRecord = {
        id: crypto.randomUUID(), kind: "event", text: "", at: Date.now(), pending: false,
        result: { ended: "quiet", ms: 0, route: { matched: false }, replies: [reply], sounds: [], errors: [], logs: [], waiting_for_answer: reply.expect_response, messages: [] },
      };
      conversation.turns.push(turn);
      this.post({ type: "turn", turn });
      this.speakAloud(turn);
    } else if (event === "bus") {
      this.post({ type: "bus", message: payload.message });
    }
  }

  private onSaved(doc: vscode.TextDocument): void {
    if (!this.model || !this.session || doc.uri.scheme !== "file") return;
    const relative = path.relative(this.model.root, doc.uri.fsPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return;
    if (/^(\.venv|venv|build|dist|\.git)[\\/]/.test(relative) || relative.startsWith("test" + path.sep)) return;
    const config = vscode.workspace.getConfiguration("thalovant.simulator", doc.uri);
    if (!config.get<boolean>("reloadOnSave", true)) return;
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      const conversation = this.conversation();
      conversation.turns.push({ id: crypto.randomUUID(), kind: "notice", text: `Reloaded after saving ${relative}`, at: Date.now(), pending: false });
      // A new process has no memory of the old sessions; the next turn starts fresh.
      conversation.sessionId = `vscode-${crypto.randomUUID().slice(0, 8)}`;
      this.postAll();
      void this.session?.restart(`saved ${relative}`);
    }, 250);
  }

  private async onMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
    const conversation = this.conversation();
    switch (message.type) {
      case "ready":
        this.postAll();
        break;
      case "say":
        if (typeof message.text === "string" && message.text.trim()) await this.say(message.text.trim(), message.lang as string | undefined);
        break;
      case "tap":
        await this.tap(String(message.card ?? ""), String(message.action ?? ""), message.skill as string | undefined, String(message.label ?? ""));
        break;
      case "stop":
        await this.stopSkill();
        break;
      case "restart":
        conversation.sessionId = `vscode-${crypto.randomUUID().slice(0, 8)}`;
        await this.session?.restart("restarted from the simulator");
        break;
      case "clear":
        conversation.turns = [];
        conversation.sessionId = `vscode-${crypto.randomUUID().slice(0, 8)}`;
        this.postAll();
        break;
      case "lang":
        conversation.lang = typeof message.lang === "string" ? message.lang : undefined;
        break;
      case "location":
        conversation.location = typeof message.location === "string" && message.location ? message.location : undefined;
        break;
      case "switch": {
        const model = this.registry.all.find((m) => m.root === message.root);
        if (model) this.bind(model);
        break;
      }
      case "open":
        if (typeof message.file === "string") await openAt(message.file, Number(message.line ?? 0));
        break;
      case "golden": {
        const turn = conversation.turns.find((t) => t.id === message.id);
        if (turn) await this.saveGolden(turn, message.negative === true);
        break;
      }
      case "fix":
        await this.fix(String(message.fix));
        break;
      case "log":
        await vscode.commands.executeCommand("thalovant.showRunnerLog");
        break;
      case "settings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "thalovant.simulator");
        break;
    }
  }

  private async fix(kind: string): Promise<void> {
    if (kind === "setup") await vscode.commands.executeCommand("thalovant.setupEnvironment", this.model?.root);
    else if (kind === "python") await vscode.commands.executeCommand("thalovant.selectPython");
    else if (kind === "trust") await vscode.commands.executeCommand("workbench.trust.manage");
    else if (kind === "check") await vscode.commands.executeCommand("thalovant.check", this.model?.root);
  }

  /** Append the turn as a golden utterance row, the fleet's format. */
  private async saveGolden(turn: TurnRecord, negative: boolean): Promise<void> {
    if (!this.model || !turn.result) return;
    const route = turn.result.route;
    const skillId = this.session?.info?.skill_id ?? this.model.entry?.skillId;
    const lang = turn.lang ?? this.session?.info?.lang ?? this.model.sourceLocale;
    const row: Record<string, unknown> = { skill_id: skillId, utterance: turn.text, lang };
    if (negative) {
      row.negative = true;
    } else if (route.own && route.label && route.label !== "fallback") {
      const file = `${route.label}.intent`;
      row.intent_label = this.model.resources.some((r) => r.kind === "intent" && r.name === file) ? file : route.label;
    }
    if (!negative && turn.result.replies.length) row.expected_messages = ["speak"];
    const dir = path.join(this.model.root, "test", "end2end");
    const perLang = path.join(dir, `golden_utterances_${lang}.jsonl`);
    const file = fs.existsSync(perLang) ? perLang : path.join(dir, "golden_utterances.jsonl");
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const line = JSON.stringify(row);
    fs.writeFileSync(file, existing + (existing && !existing.endsWith("\n") ? "\n" : "") + line + "\n");
    this.registry.reload(this.model.root);
    const lineNumber = (existing.match(/\n/g)?.length ?? 0) + (existing && !existing.endsWith("\n") ? 1 : 0);
    const choice = await vscode.window.showInformationMessage(
      negative ? `Saved “${turn.text}” as a sentence ${this.model.title} must leave alone.` : `Saved “${turn.text}” as a golden utterance.`,
      "Open",
    );
    if (choice === "Open") await openAt(file, lineNumber);
  }

  private speakAloud(turn: TurnRecord): void {
    const mode = vscode.workspace.getConfiguration("thalovant.simulator").get<string>("speech");
    if (mode !== "system" || !turn.result) return;
    for (const reply of turn.result.replies) this.post({ type: "speak", text: reply.utterance, lang: reply.lang ?? turn.lang });
  }

  private conversation(): Conversation {
    const root = this.model?.root ?? "";
    let conversation = this.conversations.get(root);
    if (!conversation) {
      conversation = { turns: [], sessionId: `vscode-${crypto.randomUUID().slice(0, 8)}` };
      this.conversations.set(root, conversation);
    }
    return conversation;
  }

  private location(): Record<string, unknown> | null | undefined {
    const name = this.conversation().location;
    return name ? LOCATIONS[name] : undefined;
  }

  private skillState(): Record<string, unknown> {
    const model = this.model;
    const session = this.session;
    return {
      root: model?.root,
      title: model?.title,
      skillId: session?.info?.skill_id ?? model?.entry?.skillId,
      state: session?.state ?? "stopped",
      info: session?.info,
      hello: session?.hello && { python: session.hello.python, packages: session.hello.packages },
      python: session?.python,
      failure: session?.failure,
      reason: session?.lastReason,
      langs: session?.languages ?? model?.locales ?? [],
      suggestions: model ? suggestions(model) : {},
      skills: this.registry.all.map((m) => ({ root: m.root, title: m.title })),
    };
  }

  private settings(): Record<string, unknown> {
    const config = vscode.workspace.getConfiguration("thalovant.simulator");
    return { speech: config.get("speech"), pipeline: config.get("pipeline"), locations: Object.keys(LOCATIONS) };
  }

  private postAll(): void {
    const conversation = this.conversation();
    this.post({ type: "all", skill: this.skillState(), turns: conversation.turns, lang: conversation.lang, location: conversation.location, settings: this.settings() });
  }

  private post(message: Record<string, unknown>): void {
    void this.panel.webview.postMessage(message);
  }

  private html(): string {
    const webview = this.panel.webview;
    const media = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", name));
    const nonce = crypto.randomBytes(16).toString("base64");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media("simulator.css")}">
<title>Thalovant simulator</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${media("simulator.js")}"></script>
</body>
</html>`;
  }

  dispose(): void {
    clearTimeout(this.reloadTimer);
    Simulator.current = undefined;
    for (const d of this.sessionListeners) d.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** Sentences to offer, per language: one per intent file, then golden rows. */
export function suggestions(model: SkillModel): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (lang: string, text: string | undefined) => {
    if (!text) return;
    const list = (out[lang] ??= []);
    if (!list.includes(text) && list.length < 10) list.push(text);
  };
  for (const r of model.resources) {
    if (r.kind === "intent" && r.lines[0]) add(r.lang, sayable(r.lines[0]));
  }
  for (const g of model.goldens) add(g.lang ?? model.sourceLocale, g.negative ? undefined : g.utterance);
  // A fallback skill has no intents: a question about its first keyword.
  for (const r of model.resources) {
    if (r.kind === "vocab" && r.lines[0] && !(out[r.lang]?.length)) {
      const term = r.lines[0].split("|")[0].trim();
      add(r.lang, r.lang.startsWith("fr") ? `que sais-tu sur ${term}` : r.lang.startsWith("de") ? `was weißt du über ${term}` : `what is ${term}`);
    }
  }
  return out;
}

export async function openAt(file: string, line: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const position = new vscode.Position(Math.max(0, Math.min(line, doc.lineCount - 1)), 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(position, position), viewColumn: vscode.ViewColumn.One });
}
