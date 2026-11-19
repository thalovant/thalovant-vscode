// Runs inside VS Code with the fixture skill open as the workspace.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Api } from "../../src/extension";

const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let api: Api;
const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const main = () => path.join(root(), "thalovant_skill_plant_care", "__init__.py");

test("the extension finds the skill", async () => {
  const extension = vscode.extensions.getExtension("thalovant.thalovant-skills")!;
  api = await extension.activate();
  const model = await until("the skill", () => api.registry.active);
  assert.equal(model.entry?.skillId, "thalovant-skill-plant-care.thalovant");
  assert.equal(model.title, "Plant Care");
});

test("completion offers the skill's dialogs inside speak_dialog", async () => {
  const doc = await vscode.workspace.openTextDocument({ language: "python", content: "" });
  // Completion is for the skill's own files; use the real one, edited in memory.
  const real = await vscode.workspace.openTextDocument(main());
  const editor = await vscode.window.showTextDocument(real);
  const line = real.getText().split("\n").findIndex((l) => l.includes('self.speak_dialog("water.fern")'));
  const col = real.lineAt(line).text.indexOf("water.fern") + 2;
  const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", real.uri, new vscode.Position(line, col), '"');
  const labels = list.items.map((i) => (typeof i.label === "string" ? i.label : i.label.label));
  assert.ok(labels.includes("water.fern"), labels.join(", "));
  assert.ok(labels.includes("ask.name"));
  assert.ok(!labels.includes("water.plants.intent"), "intents are not dialogs");
  void doc;
  void editor;
});

test("hover shows each locale's lines and go-to-definition opens the dialog", async () => {
  const real = await vscode.workspace.openTextDocument(main());
  const line = real.getText().split("\n").findIndex((l) => l.includes('self.speak_dialog("water.fern")'));
  const position = new vscode.Position(line, real.lineAt(line).text.indexOf("water.fern") + 3);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", real.uri, position);
  const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : (c as vscode.MarkdownString).value))).join("\n");
  assert.match(text, /fr-FR/);
  assert.match(text, /La fougère/);
  const locations = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeDefinitionProvider", real.uri, position);
  assert.ok(locations.some((l) => l.uri.fsPath.endsWith(path.join("en-US", "dialog", "water.fern.dialog"))));
});

test("a dialog no locale has is flagged where code names it", async () => {
  const probe = path.join(root(), "thalovant_skill_plant_care", "_probe.py");
  fs.writeFileSync(probe, 'class X:\n    def f(self):\n        self.speak_dialog("no.such.dialog")\n        self.speak_dialog("water.fern")\n        self.speak_dialog("ask.name")\n');
  try {
    const doc = await vscode.workspace.openTextDocument(probe);
    const diagnostics = await until("diagnostics", () => {
      const list = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === "thalovant");
      return list.length ? list : undefined;
    });
    assert.equal(diagnostics.length, 1, diagnostics.map((d) => d.message).join("; "));
    assert.match(diagnostics[0].message, /no.such.dialog/);
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

test("the simulator runs the skill: speech, SSML, a card, a tap", async () => {
  if (!process.env.THALOVANT_TEST_PYTHON) return;
  await vscode.commands.executeCommand("thalovant.openSimulator");
  const simulator = await until("the simulator", () => api.simulator());
  const session = api.registry.session(api.registry.active!);
  await until("the skill to start", () => session.state === "ready" || session.state === "failed");
  assert.equal(session.state, "ready", session.failure?.message);
  await simulator.say("water the plants");
  const turn = simulator.turns().at(-1)!;
  assert.equal(turn.result?.route.label, "water.plants");
  assert.equal(turn.result?.replies[0].display?.kind, "list");
  assert.match(turn.result?.replies[0].ssml ?? "", /emphasis/);
  const tap = await session.tap("thalovant-skill-plant-care.thalovant:watering", "done", "thalovant-skill-plant-care.thalovant");
  assert.equal(tap.replies[0].utterance, "Marked as watered.");
});

test("saving a skill file restarts it and keeps the conversation", async () => {
  if (!process.env.THALOVANT_TEST_PYTHON) return;
  const simulator = api.simulator()!;
  const before = simulator.turns().length;
  const session = api.registry.session(api.registry.active!);
  const doc = await vscode.workspace.openTextDocument(main());
  await vscode.window.showTextDocument(doc);
  const original = doc.getText();
  const end = doc.positionAt(original.length);
  try {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, end, "\n");
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    await until("the restart", () => session.lastReason?.startsWith("saved"), 10_000);
    await until("the skill to come back", () => session.state === "ready");
  } finally {
    // Put the fixture back as it was.
    const undo = new vscode.WorkspaceEdit();
    undo.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), original);
    await vscode.workspace.applyEdit(undo);
    await doc.save();
  }
  await until("the skill to come back after the undo", () => session.state === "ready");
  const again = await session.say("water the plants");
  assert.equal(again.route.label, "water.plants", "the restarted skill still answers");
  assert.ok(simulator.turns().length >= before, "the conversation is kept");
  assert.ok(simulator.turns().some((t) => t.kind === "notice"));
});

test("skillkit check runs and finds nothing wrong", async () => {
  if (!process.env.THALOVANT_TEST_PYTHON) return;
  const count = await api.checks.run(api.registry.active!, { quiet: true });
  assert.equal(count, 0);
});

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const [name, fn] of tests) {
    const started = Date.now();
    try {
      await fn();
      console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
    } catch (error) {
      console.log(`  ✗ ${name}\n    ${(error as Error).stack}`);
      failures.push(name);
    }
  }
  if (failures.length) throw new Error(`${failures.length} integration test(s) failed`);
}
