// One skill running in a simulated hub: its runner process, and its state.
import * as path from "node:path";
import * as vscode from "vscode";
import { GoldenVerdict, Hello, RunnerError, RunnerProcess, SkillInfo, TurnResult } from "./core/runner";
import { SkillModel } from "./core/skill";
import { probePython, resolvePython } from "./python";

export type SessionState = "stopped" | "starting" | "ready" | "failed";

export interface Failure {
  message: string;
  detail?: string;
  /** What would fix it, offered as a button. */
  fix?: "setup" | "python" | "trust" | "check";
}

export interface SayOptions {
  lang?: string;
  location?: Record<string, unknown> | null;
  session?: string;
  fresh?: boolean;
}

export class SkillSession implements vscode.Disposable {
  private runner?: RunnerProcess;
  private starting?: Promise<void>;
  private generation = 0;
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly unsolicited = new vscode.EventEmitter<{ event: string; payload: Record<string, unknown> }>();
  /** State, info or failure changed. */
  readonly onDidChange = this.changed.event;
  /** Speech and bus traffic outside a turn: a timer firing, a skill talking by itself. */
  readonly onDidEmit = this.unsolicited.event;

  state: SessionState = "stopped";
  info?: SkillInfo;
  hello?: Hello;
  failure?: Failure;
  python?: string;
  /** Why the last restart happened, for the simulator to show. */
  lastReason?: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly model: () => SkillModel,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  get root(): string {
    return this.model().root;
  }

  get languages(): string[] {
    const configured = vscode.workspace.getConfiguration("thalovant.simulator", vscode.Uri.file(this.root)).get<string[]>("languages") ?? [];
    const locales = configured.length ? configured : this.model().locales;
    return locales.length ? locales : ["en-US"];
  }

  /** Start if not running; resolves when ready or failed (never rejects). */
  ensureStarted(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    return this.starting ?? this.restart("start");
  }

  restart(reason = "restart"): Promise<void> {
    const generation = ++this.generation;
    this.lastReason = reason;
    const run = (async () => {
      await this.stopRunner();
      if (generation !== this.generation) return;
      this.setState("starting");
      try {
        await this.boot(generation);
      } catch (error) {
        if (generation !== this.generation) return;
        const e = error as RunnerError;
        // A package the skill imports is missing: its environment is not set up.
        this.fail({ message: e.message, detail: e.detail, fix: e.kind === "import" ? "setup" : e.kind === "load" ? "check" : undefined });
      }
    })();
    this.starting = run.finally(() => {
      if (this.generation === generation) this.starting = undefined;
    });
    return this.starting;
  }

  private async boot(generation: number): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      this.fail({ message: "Running a skill runs its code; trust this workspace first.", fix: "trust" });
      return;
    }
    const model = this.model();
    const choice = await resolvePython(model.root);
    this.python = choice.path;
    const probe = await probePython(choice.path, model.root);
    if (generation !== this.generation) return;
    if (!probe) {
      this.fail({ message: `No working Python at ${choice.path}.`, fix: "python" });
      return;
    }
    if (!probe.ok) {
      this.fail({ message: `${choice.path} is Python ${probe.version}; SkillKit needs 3.11 or newer.`, fix: "python" });
      return;
    }
    if (!probe.skillkit || !probe.ovoscope) {
      const missing = [!probe.skillkit && "thalovant-skillkit", !probe.ovoscope && "ovoscope"].filter(Boolean).join(" and ");
      this.fail({ message: `${missing} ${missing.includes(" and ") ? "are" : "is"} not installed for ${choice.path}.`, fix: "setup" });
      return;
    }
    const script = this.context.asAbsolutePath(path.join("python", "thalovant_dev_runner.py"));
    this.log.info(`starting ${path.basename(model.root)} with ${choice.path} (${choice.source}, Python ${probe.version}, SkillKit ${probe.skillkit})`);
    const runner = new RunnerProcess(choice.path, script, model.root, (line) => this.log.trace(line));
    this.runner = runner;
    runner.on("event", (event: string, payload: Record<string, unknown>) => this.unsolicited.fire({ event, payload }));
    runner.on("exit", (code: number, tail: string) => {
      if (this.runner !== runner) return;
      this.runner = undefined;
      if (this.state === "ready" || this.state === "starting") {
        this.fail({ message: `The skill's Python stopped (exit ${code}).`, detail: tail });
      }
    });
    await runner.whenReady();
    this.hello = await runner.request<Hello>("hello");
    const config = vscode.workspace.getConfiguration("thalovant.simulator", vscode.Uri.file(model.root));
    this.info = await runner.request<SkillInfo>("start", {
      root: model.root,
      langs: this.languages,
      pipeline: config.get<string>("pipeline") ?? "local",
      settings: config.get<Record<string, unknown>>("skillSettings") ?? {},
    }, 300_000);
    if (generation !== this.generation) return;
    this.failure = undefined;
    this.log.info(`${this.info.skill_id} is running (${this.info.base}, booted in ${this.info.boot_seconds} s)`);
    this.setState("ready");
  }

  async say(text: string, options: SayOptions = {}): Promise<TurnResult> {
    const runner = await this.ready();
    return runner.request<TurnResult>("utter", { text, ...this.turnOptions(options) }, 60_000);
  }

  async tap(card: string, action: string, skill: string | undefined, options: SayOptions = {}): Promise<TurnResult> {
    const runner = await this.ready();
    return runner.request<TurnResult>("tap", { card, action, skill, ...this.turnOptions(options) }, 30_000);
  }

  async emit(type: string, data: Record<string, unknown>, options: SayOptions = {}): Promise<TurnResult> {
    const runner = await this.ready();
    return runner.request<TurnResult>("emit", { type, data, ...this.turnOptions(options) }, 30_000);
  }

  async golden(rows: Record<string, unknown>[]): Promise<GoldenVerdict[]> {
    const runner = await this.ready();
    const result = await runner.request<{ results: GoldenVerdict[] }>("golden", { rows }, 60_000 + rows.length * 20_000);
    return result.results;
  }

  private turnOptions(options: SayOptions): Record<string, unknown> {
    const configured = vscode.workspace.getConfiguration("thalovant.simulator", vscode.Uri.file(this.root)).get<Record<string, unknown> | null>("location");
    return {
      lang: options.lang ?? this.info?.lang,
      session: options.session ?? "vscode",
      fresh: options.fresh ?? false,
      location: options.location === undefined ? configured ?? undefined : options.location ?? undefined,
    };
  }

  private async ready(): Promise<RunnerProcess> {
    await this.ensureStarted();
    if (this.state !== "ready" || !this.runner) {
      throw new RunnerError(this.failure?.message ?? "the skill is not running", this.failure?.detail);
    }
    return this.runner;
  }

  private fail(failure: Failure): void {
    this.failure = failure;
    this.log.error(failure.message + (failure.detail ? `\n${failure.detail}` : ""));
    this.setState("failed");
  }

  private setState(state: SessionState): void {
    this.state = state;
    this.changed.fire();
  }

  private async stopRunner(): Promise<void> {
    const runner = this.runner;
    this.runner = undefined;
    this.info = undefined;
    if (runner) await runner.stop();
  }

  async stop(): Promise<void> {
    this.generation++;
    await this.stopRunner();
    this.setState("stopped");
  }

  dispose(): void {
    this.generation++;
    this.runner?.kill();
    this.runner = undefined;
    this.changed.dispose();
    this.unsolicited.dispose();
  }
}
