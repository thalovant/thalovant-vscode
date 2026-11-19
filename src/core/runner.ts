// The Python side: one process per running skill, talking JSON lines.
//
// The process is the skill's own interpreter running python/thalovant_dev_runner.py,
// so it sees exactly the packages the skill's tests see. Restarting is the
// reload: a MiniCroft boots in well under a second, and a fresh process never
// holds a stale import.
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export interface Reply {
  utterance: string;
  ssml?: string | null;
  written?: string | null;
  expect_response: boolean;
  lang?: string | null;
  dialog?: string | null;
  skill?: string | null;
  display?: Card | null;
  schedule?: unknown;
  meta?: Record<string, unknown>;
}

export interface Card {
  kind: "text" | "list" | "weather" | "media" | "layout" | "clear";
  id?: string;
  title?: string;
  subtitle?: string;
  body?: string;
  icon?: string;
  lang?: string;
  items?: { label: string; value?: string; icon?: string; id?: string }[];
  figures?: Record<string, string>;
  actions?: { id: string; label: string }[];
  image?: { mime: string; data: string };
  layout?: { name: string; sha256: string; rfw: string };
  data?: Record<string, unknown>;
  ttl?: number | null;
  fullscreen?: boolean;
  skill?: string;
}

export interface Route {
  matched: boolean;
  unmatched?: boolean;
  skill_id?: string;
  intent?: string;
  label?: string;
  own?: boolean;
  handler?: string;
  pipeline?: string | null;
}

export interface LogEntry {
  level: string;
  logger: string;
  text: string;
  own: boolean;
  file?: string;
  line?: number;
  traceback?: string;
}

export interface BusEntry {
  type: string;
  data: Record<string, unknown>;
  session?: string | null;
  context?: Record<string, unknown>;
}

export interface TurnResult {
  ended: "handled" | "asked" | "quiet" | "timeout";
  ms: number;
  route: Route;
  replies: Reply[];
  sounds: { uri?: string | null; bytes?: number | null; type: string }[];
  errors: { handler?: string; exception?: string; traceback?: string }[];
  logs: LogEntry[];
  waiting_for_answer: boolean;
  messages: BusEntry[];
}

export interface SkillInfo {
  skill_id: string;
  module: string;
  class: string;
  base: string;
  fallback_priority: number | null;
  file?: string;
  line?: number;
  lang: string;
  langs: string[];
  pipeline: string[];
  boot_seconds: number;
}

export interface Hello {
  protocol: number;
  python: string;
  executable: string;
  shared_dialogs: string[];
  packages: Record<string, string | null>;
}

export interface GoldenVerdict {
  index: number;
  passed: boolean;
  reason: string;
  route?: Route;
  spoken?: string[];
  ms?: number;
}

export interface StartOptions {
  root: string;
  langs: string[];
  pipeline: string;
  settings?: Record<string, unknown>;
}

export class RunnerError extends Error {
  constructor(message: string, readonly detail?: string, readonly kind?: "load" | "import" | "error") {
    super(message);
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/**
 * One runner process. Events: "event" (name, payload) for unsolicited
 * messages, "exit" (code, stderrTail) when the process ends.
 */
export class RunnerProcess extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderrTail: string[] = [];
  private exited = false;
  private readonly ready: Promise<void>;

  constructor(
    readonly python: string,
    readonly script: string,
    readonly cwd: string,
    private readonly log: (line: string) => void,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    super();
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const child = spawn(python, ["-u", script], {
      cwd,
      env: { ...env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", OVOS_DEFAULT_LOG_LEVEL: env.OVOS_DEFAULT_LOG_LEVEL ?? "INFO" },
      stdio: "pipe",
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk, resolveReady));
    let errBuffer = "";
    child.stderr.on("data", (chunk: string) => {
      errBuffer += chunk;
      const lines = errBuffer.split("\n");
      errBuffer = lines.pop() ?? "";
      for (const line of lines) {
        this.log(line);
        this.stderrTail.push(line);
        if (this.stderrTail.length > 80) this.stderrTail.shift();
      }
    });
    child.on("error", (error) => {
      rejectReady(new RunnerError(`could not start ${python}: ${error.message}`));
      this.finish(-1);
    });
    child.on("exit", (code) => {
      if (errBuffer) this.log(errBuffer);
      rejectReady(new RunnerError(`the skill's Python exited (${code}) before it was ready`, this.stderrTail.join("\n")));
      this.finish(code ?? -1);
    });
  }

  get alive(): boolean {
    return !this.exited;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  async request<T>(op: string, payload: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    await this.ready;
    if (this.exited || !this.child) throw new RunnerError("the skill is not running");
    const id = this.nextId++;
    const line = JSON.stringify({ id, op, ...payload }) + "\n";
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RunnerError(`${op} took longer than ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child!.stdin.write(line);
    });
  }

  /** Ask the runner to stop; kill it if it does not within `graceMs`. */
  async stop(graceMs = 3000): Promise<void> {
    if (this.exited || !this.child) return;
    const child = this.child;
    const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      child.stdin.write(JSON.stringify({ op: "exit" }) + "\n");
      child.stdin.end();
    } catch {
      // The pipe is already closed: the process is on its way out.
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    await gone;
    clearTimeout(timer);
  }

  kill(): void {
    this.child?.kill("SIGKILL");
  }

  private onStdout(chunk: string, resolveReady: () => void): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: { id?: number; ok?: boolean; result?: unknown; error?: string; detail?: string; event?: string; kind?: "load" | "import" | "error" };
      try {
        message = JSON.parse(line);
      } catch {
        this.log(`[runner] ${line}`);
        continue;
      }
      if (message.event) {
        if (message.event === "ready") resolveReady();
        this.emit("event", message.event, message);
        continue;
      }
      const pending = message.id !== undefined ? this.pending.get(message.id) : undefined;
      if (!pending) continue;
      this.pending.delete(message.id!);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new RunnerError(message.error ?? "the runner failed", message.detail, message.kind));
    }
  }

  private finish(code: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.pending.values()) {
      pending.reject(new RunnerError(`the skill's Python exited (${code})`, this.stderrTail.join("\n")));
    }
    this.pending.clear();
    this.emit("exit", code, this.stderrTail.join("\n"));
  }
}
