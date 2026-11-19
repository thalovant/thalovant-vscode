// Thalovant Skills: write a skill, and try it as you write it.
import * as vscode from "vscode";
import { Checks, runIn } from "./checks";
import { GoldenTests } from "./golden";
import { registerLanguage } from "./language";
import { Outline } from "./outline";
import { SkillRegistry } from "./registry";
import { addDialog, newSkill, selectPython, setupEnvironment } from "./scaffold";
import { Simulator } from "./simulator";

export interface Api {
  registry: SkillRegistry;
  simulator: () => Simulator | undefined;
  checks: Checks;
}

export function activate(context: vscode.ExtensionContext): Api {
  const log = vscode.window.createOutputChannel("Thalovant Skill Log", { log: true });
  const output = vscode.window.createOutputChannel("Thalovant");
  context.subscriptions.push(log, output);

  const registry = new SkillRegistry(context, log);
  context.subscriptions.push(registry);

  // SkillKit's shared dialogs, learnt from the first runner that says hello.
  const shared = new Set<string>();
  const sharedDialogs = () => {
    if (!shared.size) {
      for (const model of registry.all) {
        for (const name of registry.existingSession(model.root)?.hello?.shared_dialogs ?? []) shared.add(name);
      }
    }
    return shared;
  };

  registerLanguage(context, registry, sharedDialogs);
  const checks = new Checks(registry, log, output);
  context.subscriptions.push(checks);
  const golden = new GoldenTests(context, registry, log);
  context.subscriptions.push(golden);
  const outline = new Outline(registry);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("thalovant.outline", outline));

  // -- status bar: the running skill --
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "thalovant.openSimulator";
  context.subscriptions.push(status);
  const watched = new Set<string>();
  const updateStatus = () => {
    const model = registry.active;
    if (!model) {
      status.hide();
      return;
    }
    const session = registry.existingSession(model.root);
    if (session && !watched.has(model.root)) {
      watched.add(model.root);
      context.subscriptions.push(session.onDidChange(() => {
        updateStatus();
        outline.touch();
      }));
    }
    const state = session?.state ?? "stopped";
    const icon = { ready: "$(play-circle)", starting: "$(loading~spin)", failed: "$(error)", stopped: "$(circle-large-outline)" }[state];
    status.text = `${icon} ${model.title}`;
    status.tooltip = new vscode.MarkdownString(
      state === "ready" ? `**${model.title}** is running in the simulator (${session?.info?.class}).\n\nClick to open it.`
        : state === "failed" ? `**${model.title}** is not running: ${session?.failure?.message}`
          : `Open **${model.title}** in the simulator`,
    );
    status.backgroundColor = state === "failed" ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    status.show();
  };
  registry.onDidChangeActive(updateStatus, undefined, context.subscriptions);

  const modelFor = (root?: unknown) => (typeof root === "string" && registry.all.find((m) => m.root === root)) || registry.active;

  const command = (id: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  command("thalovant.newSkill", () => newSkill(output));
  command("thalovant.openSimulator", (root?: unknown) => {
    const model = modelFor(root instanceof vscode.Uri ? registry.modelFor(root)?.root : root);
    if (!model) {
      void vscode.window.showInformationMessage("No Thalovant skill in this workspace.", "New Skill…").then((c) => c && vscode.commands.executeCommand("thalovant.newSkill"));
      return;
    }
    Simulator.show(context, registry, model);
    updateStatus();
  });
  command("thalovant.say", async () => {
    const model = registry.active;
    if (!model) return;
    const text = await vscode.window.showInputBox({ title: `Say something to ${model.title}`, placeHolder: "what is garden watering" });
    if (!text?.trim()) return;
    await Simulator.show(context, registry, model).say(text.trim());
    updateStatus();
  });
  command("thalovant.sayLine", async (sentence?: unknown, lang?: unknown, root?: unknown) => {
    const model = modelFor(root);
    if (!model || typeof sentence !== "string") return;
    await Simulator.show(context, registry, model).say(sentence, typeof lang === "string" ? lang : undefined);
    updateStatus();
  });
  command("thalovant.restartSkill", async () => {
    const model = registry.active;
    if (!model) return;
    await registry.session(model).restart("restarted");
    updateStatus();
  });
  command("thalovant.check", async (root?: unknown) => {
    const model = modelFor(root);
    if (model) await checks.run(model);
  });
  command("thalovant.checkFleet", runIn(registry, output, (m) => ["-m", "thalovant_skillkit.cli", "check", m.root, "--fleet-only"], "Comparing this skill's sentences with the fleet's"));
  command("thalovant.writeLocales", runIn(registry, output, (m) => ["-m", "thalovant_skillkit.cli", "locales", m.root, "--write"], "Regenerating regional locales"));
  command("thalovant.addDialog", () => addDialog(registry));
  command("thalovant.selectPython", () => selectPython(registry));
  command("thalovant.setupEnvironment", (root?: unknown) => setupEnvironment(registry, output, typeof root === "string" ? root : undefined));
  command("thalovant.showRunnerLog", () => log.show());
  command("thalovant.refreshOutline", () => outline.refresh());

  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
    for (const model of registry.all) void registry.existingSession(model.root)?.restart("workspace trusted");
  }));

  registry.discover();
  golden.refresh();
  updateStatus();
  return { registry, simulator: () => Simulator.instance, checks };
}

export function deactivate(): void {
  // Sessions are disposed with the registry, which kills their runners.
}
