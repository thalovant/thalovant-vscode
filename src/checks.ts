// `thalovant-skillkit check`, in the Problems panel.
import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { parseCheckOutput, placeProblem } from "./core/problems";
import { SkillModel } from "./core/skill";
import { resolvePython } from "./python";
import { SkillRegistry } from "./registry";

export class Checks implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("thalovant-check");
  private readonly running = new Map<string, Promise<number>>();
  private readonly disposables: vscode.Disposable[] = [this.diagnostics];
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(registry: SkillRegistry, private readonly log: vscode.LogOutputChannel, private readonly output: vscode.OutputChannel) {
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const model = registry.modelFor(doc.uri);
      if (!model || !vscode.workspace.isTrusted) return;
      if (!vscode.workspace.getConfiguration("thalovant.check", doc.uri).get<boolean>("onSave", true)) return;
      clearTimeout(this.timers.get(model.root));
      this.timers.set(model.root, setTimeout(() => void this.run(model, { quiet: true }), 400));
    }, undefined, this.disposables);
  }

  /** Run the check; returns how many problems it found (-1 when it could not run). */
  run(model: SkillModel, options: { quiet?: boolean; fleet?: boolean } = {}): Promise<number> {
    const key = `${model.root}:${options.fleet ? "fleet" : "local"}`;
    const existing = this.running.get(key);
    if (existing) return existing;
    const job = this.execute(model, options).finally(() => this.running.delete(key));
    this.running.set(key, job);
    return job;
  }

  private async execute(model: SkillModel, options: { quiet?: boolean; fleet?: boolean }): Promise<number> {
    const python = (await resolvePython(model.root)).path;
    const args = ["-m", "thalovant_skillkit.cli", "check", model.root, options.fleet ? "--fleet-only" : "--no-fleet"];
    const { stdout, stderr, code } = await run(python, args, model.root, options.fleet ? 600_000 : 120_000);
    if (options.fleet) {
      this.output.appendLine(`$ ${python} ${args.join(" ")}`);
      this.output.appendLine(stdout + stderr);
      this.output.show(true);
      return code === 0 ? 0 : 1;
    }
    if (/No module named thalovant_skillkit/.test(stderr)) {
      this.log.warn(`skillkit check: thalovant-skillkit is not installed for ${python}`);
      if (!options.quiet) {
        const choice = await vscode.window.showWarningMessage(`thalovant-skillkit is not installed for ${python}.`, "Set Up the Environment", "Choose a Python");
        if (choice === "Set Up the Environment") await vscode.commands.executeCommand("thalovant.setupEnvironment", model.root);
        if (choice === "Choose a Python") await vscode.commands.executeCommand("thalovant.selectPython");
      }
      return -1;
    }
    const { problems } = parseCheckOutput(stdout);
    if (code !== 0 && !problems.length) {
      this.log.error(`skillkit check failed (${code}):\n${stdout}${stderr}`);
      if (!options.quiet) void vscode.window.showErrorMessage("thalovant-skillkit check did not run; see the log.", "Open the Log").then((c) => c && this.log.show());
      return -1;
    }
    this.publish(model, problems);
    if (!options.quiet) {
      if (problems.length) void vscode.commands.executeCommand("workbench.actions.view.problems");
      else void vscode.window.setStatusBarMessage(`$(check) ${model.title} keeps its contracts`, 4000);
    }
    return problems.length;
  }

  publish(model: SkillModel, problems: string[]): void {
    // Clear this skill's earlier problems, wherever they were.
    this.diagnostics.forEach((uri) => {
      if (uri.fsPath.startsWith(model.root)) this.diagnostics.delete(uri);
    });
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const problem of problems) {
      const placed = placeProblem(problem, model);
      const d = new vscode.Diagnostic(new vscode.Range(placed.line, 0, placed.line, 1000), placed.message, vscode.DiagnosticSeverity.Error);
      d.source = "skillkit check";
      const list = byFile.get(placed.file) ?? [];
      list.push(d);
      byFile.set(placed.file, list);
    }
    for (const [file, list] of byFile) this.diagnostics.set(vscode.Uri.file(file), list);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const d of this.disposables) d.dispose();
  }
}

export function run(command: string, args: string[], cwd: string, timeout: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException).code === "number" ? Number((error as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr) + (error && !stdout && !stderr ? error.message : ""), code });
    });
  });
}

/** For the fleet check and the locale writer, which print for people. */
export function runIn(registry: SkillRegistry, output: vscode.OutputChannel, args: (model: SkillModel) => string[], title: string): (root?: unknown) => Promise<void> {
  return async (root?: unknown) => {
    const model = (typeof root === "string" && registry.all.find((m) => m.root === root)) || registry.active;
    if (!model) return;
    const python = (await resolvePython(model.root)).path;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => {
      const argv = args(model);
      const result = await run(python, argv, model.root, 600_000);
      output.appendLine(`$ ${python} ${argv.join(" ")}`);
      output.appendLine((result.stdout + result.stderr).trimEnd());
      output.appendLine("");
      output.show(true);
      registry.reload(model.root);
    });
  };
}
