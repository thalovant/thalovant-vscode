// Golden utterances in the Testing view: does each sentence reach this skill?
//
// Rows come from test/end2end/golden_utterances*.jsonl (the fleet's format:
// skill_id, utterance, intent_label, lang) or a JSON array named *golden*.json.
// Each run boots its own hub, so a sentence that leaves a question pending
// cannot change what the simulator's conversation sees.
import * as path from "node:path";
import * as vscode from "vscode";
import { Golden, SkillModel } from "./core/skill";
import { SkillRegistry } from "./registry";
import { SkillSession } from "./session";

export class GoldenTests implements vscode.Disposable {
  private readonly controller = vscode.tests.createTestController("thalovant.golden", "Thalovant golden utterances");
  private readonly rows = new WeakMap<vscode.TestItem, { model: SkillModel; golden: Golden }>();
  private readonly disposables: vscode.Disposable[] = [this.controller];

  constructor(private readonly context: vscode.ExtensionContext, private readonly registry: SkillRegistry, private readonly log: vscode.LogOutputChannel) {
    this.controller.resolveHandler = async () => this.refresh();
    this.controller.refreshHandler = async () => this.refresh();
    this.controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, (request, token) => this.run(request, token), true);
    registry.onDidChangeSkill(() => this.refresh(), undefined, this.disposables);
  }

  refresh(): void {
    const skills: vscode.TestItem[] = [];
    for (const model of this.registry.all) {
      if (!model.goldens.length) continue;
      const skillItem = this.controller.createTestItem(model.root, model.title, vscode.Uri.file(model.root));
      const files = new Map<string, Golden[]>();
      for (const g of model.goldens) files.set(g.file, [...(files.get(g.file) ?? []), g]);
      for (const [file, goldens] of files) {
        const fileItem = this.controller.createTestItem(file, path.relative(model.root, file), vscode.Uri.file(file));
        for (const golden of goldens) {
          const item = this.controller.createTestItem(`${file}#${golden.line}`, golden.utterance, vscode.Uri.file(file));
          item.range = new vscode.Range(golden.line, 0, golden.line, 0);
          item.description = [golden.negative ? "must not match" : golden.intent ?? "reaches the skill", golden.lang].filter(Boolean).join(" · ");
          this.rows.set(item, { model, golden });
          fileItem.children.add(item);
        }
        skillItem.children.add(fileItem);
      }
      skills.push(skillItem);
    }
    this.controller.items.replace(skills);
  }

  private leaves(items: readonly vscode.TestItem[] | undefined): vscode.TestItem[] {
    const out: vscode.TestItem[] = [];
    const visit = (item: vscode.TestItem) => {
      if (this.rows.has(item)) out.push(item);
      item.children.forEach(visit);
    };
    if (items) items.forEach(visit);
    else this.controller.items.forEach(visit);
    return out;
  }

  private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const run = this.controller.createTestRun(request);
    const excluded = new Set(request.exclude ?? []);
    const items = this.leaves(request.include).filter((i) => !excluded.has(i));
    const bySkill = new Map<string, vscode.TestItem[]>();
    for (const item of items) {
      const { model } = this.rows.get(item)!;
      bySkill.set(model.root, [...(bySkill.get(model.root) ?? []), item]);
    }
    for (const [root, skillItems] of bySkill) {
      if (token.isCancellationRequested) break;
      const model = this.registry.all.find((m) => m.root === root);
      if (!model) continue;
      skillItems.forEach((i) => run.enqueued(i));
      const session = new SkillSession(this.context, () => model, this.log);
      try {
        await session.ensureStarted();
        if (session.state !== "ready") {
          const message = new vscode.TestMessage(session.failure?.message ?? "the skill did not start");
          skillItems.forEach((i) => run.errored(i, message));
          continue;
        }
        const langs = new Set(session.info?.langs ?? []);
        const runnable: vscode.TestItem[] = [];
        for (const item of skillItems) {
          const { golden } = this.rows.get(item)!;
          if (golden.raw.invalid) run.errored(item, new vscode.TestMessage("this line is not JSON"));
          else if (golden.lang && !langs.has(golden.lang)) run.skipped(item);
          else runnable.push(item);
        }
        runnable.forEach((i) => run.started(i));
        const rows = runnable.map((i) => this.rows.get(i)!.golden.raw);
        const verdicts = rows.length ? await session.golden(rows) : [];
        verdicts.forEach((verdict, index) => {
          const item = runnable[verdict.index ?? index];
          if (!item) return;
          if (verdict.passed) {
            run.passed(item, verdict.ms);
            return;
          }
          const { golden } = this.rows.get(item)!;
          const message = new vscode.TestMessage(verdict.reason || "did not reach the skill");
          message.location = new vscode.Location(vscode.Uri.file(golden.file), new vscode.Position(golden.line, 0));
          if (golden.intent && verdict.route?.label) {
            message.expectedOutput = golden.intent;
            message.actualOutput = `${verdict.route.skill_id === session.info?.skill_id ? "" : `${verdict.route.skill_id}: `}${verdict.route.label}`;
          }
          if (verdict.spoken?.length) run.appendOutput(`“${golden.utterance}” → ${verdict.spoken.join(" / ")}\r\n`, undefined, item);
          run.failed(item, message, verdict.ms);
        });
      } catch (error) {
        const message = new vscode.TestMessage((error as Error).message);
        skillItems.forEach((i) => run.errored(i, message));
      } finally {
        await session.stop();
        session.dispose();
      }
    }
    run.end();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
