// Starting a skill and getting it a Python that can run it.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { SkillModel } from "./core/skill";
import { probePython, resolvePython, venvPython } from "./python";
import { SkillRegistry } from "./registry";

const BASE_PYTHONS = ["python3.13", "python3.12", "python3.14", "python3.11", "python3", "python"];

export function slugOf(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^thalovant-skill-/, "").replace(/^skill-/, "");
}

export async function newSkill(output: vscode.OutputChannel): Promise<void> {
  const raw = await vscode.window.showInputBox({
    title: "New Thalovant skill (1/3)",
    prompt: "What is the skill about? A word or two: “garden watering”, “news”.",
    placeHolder: "garden watering",
    validateInput: (value) => {
      const slug = slugOf(value);
      if (!value.trim()) return undefined;
      return slug ? { message: `thalovant-skill-${slug}`, severity: vscode.InputBoxValidationSeverity.Info } : "Use letters and digits.";
    },
  });
  if (!raw || !slugOf(raw)) return;
  const slug = slugOf(raw);

  const priority = await vscode.window.showQuickPick([
    { label: "98", description: "a topic", detail: "Answers questions about its subject (the scaffold's default). Most skills sit here.", value: 98 },
    { label: "93", description: "one specific thing", detail: "Answers a narrow request, ahead of topic skills.", value: 93 },
    { label: "96", description: "a broad topic", detail: "Answers early for a wide subject; check it leaves room chatter alone.", value: 96 },
    { label: "100", description: "almost anything", detail: "The last voice in the house: claims what no one else did.", value: 100 },
  ], {
    title: "New Thalovant skill (2/3): where it sits in the fallback ladder",
    placeHolder: "The hub asks fallback skills in order and stops at the first that says yes",
  });
  if (!priority) return;

  const defaultParent = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(path.join(os.homedir()));
  const parentPick = await vscode.window.showOpenDialog({
    title: `New Thalovant skill (3/3): the folder thalovant-skill-${slug}/ goes in`,
    defaultUri: defaultParent,
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: "Create the skill here",
  });
  if (!parentPick?.[0]) return;
  const dest = path.join(parentPick[0].fsPath, `thalovant-skill-${slug}`);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) {
    void vscode.window.showErrorMessage(`${dest} exists and is not empty; choose another folder.`);
    return;
  }

  const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating thalovant-skill-${slug}`, cancellable: false }, async (progress) => {
    output.show(true);
    output.appendLine(`# New skill: ${dest}`);
    progress.report({ message: "finding Python 3.11 or newer" });
    const base = await findBasePython(parentPick[0].fsPath);
    if (!base) {
      void vscode.window.showErrorMessage("SkillKit needs Python 3.11 or newer, and none was found. Install one, or set thalovant.python.");
      return false;
    }
    fs.mkdirSync(dest, { recursive: true });
    const venv = path.join(dest, ".venv");
    progress.report({ message: `creating .venv with Python ${base.version}` });
    if (!(await step(output, base.path, ["-m", "venv", venv], dest))) return false;
    const python = venvPython(venv)!;
    progress.report({ message: "installing thalovant-skillkit and OVOS (a minute or two)" });
    if (!(await step(output, python, ["-m", "pip", "install", "--pre", "--upgrade", "pip", "thalovant-skillkit[testing]"], dest))) return false;
    progress.report({ message: "writing the skill" });
    const scratch = path.join(dest, ".scaffold");
    if (!(await step(output, python, ["-m", "thalovant_skillkit.cli", "new", slug, "--directory", scratch, "--priority", String(priority.value)], dest))) return false;
    for (const entry of fs.readdirSync(scratch)) fs.renameSync(path.join(scratch, entry), path.join(dest, entry));
    fs.rmdirSync(scratch);
    progress.report({ message: "installing the skill into its environment" });
    if (!(await step(output, python, ["-m", "pip", "install", "--pre", "-e", ".[test]", "build"], dest))) return false;
    progress.report({ message: "checking it" });
    await step(output, python, ["-m", "thalovant_skillkit.cli", "check", "--no-fleet"], dest);
    return true;
  });
  if (!ok) {
    const choice = await vscode.window.showErrorMessage("Creating the skill did not finish; the output has the details.", "Show Output");
    if (choice) output.show();
    return;
  }
  const inWorkspace = vscode.workspace.workspaceFolders?.some((f) => dest.startsWith(f.uri.fsPath + path.sep));
  const main = vscode.Uri.file(path.join(dest, `thalovant_skill_${slug.replace(/-/g, "_")}`, "__init__.py"));
  if (inWorkspace) {
    await vscode.window.showTextDocument(main);
    await vscode.commands.executeCommand("thalovant.openSimulator", dest);
    return;
  }
  const choice = await vscode.window.showInformationMessage(`thalovant-skill-${slug} is ready, with its tests passing.`, "Open", "Open in New Window", "Add to Workspace");
  if (choice === "Open") await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dest), false);
  else if (choice === "Open in New Window") await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dest), true);
  else if (choice === "Add to Workspace") {
    vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(dest) });
  }
}

/** A .venv in the skill with the skill, its tests and OVOScope installed. */
export async function setupEnvironment(registry: SkillRegistry, output: vscode.OutputChannel, root?: string): Promise<boolean> {
  const model = (root && registry.all.find((m) => m.root === root)) || registry.active;
  if (!model) return false;
  const venv = path.join(model.root, ".venv");
  const existing = venvPython(venv);
  const confirm = await vscode.window.showInformationMessage(
    existing ? `Install ${model.title} and thalovant-skillkit[testing] into its .venv?` : `Create ${path.basename(model.root)}/.venv and install ${model.title} with thalovant-skillkit[testing]?`,
    { modal: true, detail: "Runs pip with --pre (the OVOS stack is in prereleases). Nothing outside the skill folder changes." },
    "Set Up",
  );
  if (confirm !== "Set Up") return false;
  const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Setting up ${model.title}` }, async (progress) => {
    output.show(true);
    let python = existing;
    if (!python) {
      progress.report({ message: "finding Python 3.11 or newer" });
      const base = await findBasePython(model.root);
      if (!base) {
        void vscode.window.showErrorMessage("SkillKit needs Python 3.11 or newer, and none was found.");
        return false;
      }
      progress.report({ message: `creating .venv with Python ${base.version}` });
      if (!(await step(output, base.path, ["-m", "venv", venv], model.root))) return false;
      python = venvPython(venv)!;
    }
    progress.report({ message: "installing (a minute or two)" });
    const extras = hasTestExtra(model) ? ".[test]" : ".";
    return step(output, python, ["-m", "pip", "install", "--pre", "-e", extras, "thalovant-skillkit[testing]"], model.root);
  });
  if (ok) {
    const configured = vscode.workspace.getConfiguration("thalovant", vscode.Uri.file(model.root)).get<string>("python");
    if (configured) void vscode.window.showWarningMessage(`thalovant.python is set to ${configured}, so the new .venv is not used until you clear it.`);
    await registry.existingSession(model.root)?.restart("environment set up");
    void vscode.window.showInformationMessage(`${model.title} has its environment: ${venv}`);
  } else {
    const choice = await vscode.window.showErrorMessage("The setup did not finish; the output has the details.", "Show Output");
    if (choice) output.show();
  }
  return ok;
}

function hasTestExtra(model: SkillModel): boolean {
  const pyproject = path.join(model.root, "pyproject.toml");
  try {
    return /^\s*test\s*=\s*\[/m.test(fs.readFileSync(pyproject, "utf8"));
  } catch {
    return false;
  }
}

export async function selectPython(registry: SkillRegistry): Promise<void> {
  const model = registry.active;
  const root = model?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;
  const current = await resolvePython(root);
  const candidates = new Map<string, string>();
  for (const name of [".venv", "venv"]) {
    const p = venvPython(path.join(root, name));
    if (p) candidates.set(p, `the skill's ${name}`);
  }
  candidates.set(current.path, `in use (${current.source})`);
  for (const name of BASE_PYTHONS) candidates.set(name, "on PATH");
  const items: (vscode.QuickPickItem & { value?: string })[] = [];
  for (const [p, why] of candidates) {
    const probe = await probePython(p, root);
    if (!probe) continue;
    items.push({ label: p, description: `Python ${probe.version}`, detail: [why, probe.skillkit ? `SkillKit ${probe.skillkit}` : "no SkillKit", probe.ovoscope ? `OVOScope ${probe.ovoscope}` : "no OVOScope", !probe.ok ? "too old: SkillKit needs 3.11" : ""].filter(Boolean).join(" · "), value: p });
  }
  items.push({ label: "$(folder) Browse…", value: "browse" }, { label: "$(discard) Use the default", description: "the skill's .venv, then the Python extension's choice", value: "" });
  const pick = await vscode.window.showQuickPick(items, { title: "The Python that runs the skill", placeHolder: "The interpreter the skill's tests run with" });
  if (!pick || pick.value === undefined) return;
  let value = pick.value;
  if (value === "browse") {
    const file = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, title: "Python interpreter", defaultUri: vscode.Uri.file(root) });
    if (!file?.[0]) return;
    value = file[0].fsPath;
  }
  const target = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root)) ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration("thalovant", vscode.Uri.file(root)).update("python", value || undefined, target);
}

/** A dialog file in every locale: the sentence in the source locale, a marked copy elsewhere. */
export async function addDialog(registry: SkillRegistry): Promise<void> {
  const model = registry.active;
  if (!model?.packageDir) return;
  const name = await vscode.window.showInputBox({
    title: "New dialog",
    prompt: "Its name, as code says it: self.speak_dialog(\"…\")",
    placeHolder: "watering.done",
    validateInput: (v) => (/^[a-z0-9][a-z0-9._-]*$/i.test(v.trim()) || !v.trim() ? undefined : "Letters, digits, dots, dashes and underscores."),
  });
  if (!name?.trim()) return;
  const sentence = await vscode.window.showInputBox({ title: `New dialog ${name} (${model.sourceLocale})`, prompt: "What the skill says. {placeholders} are filled from code.", placeHolder: "The {plant} is watered." });
  if (sentence === undefined) return;
  let source: string | undefined;
  for (const lang of model.locales) {
    const file = path.join(model.packageDir, "locale", lang, "dialog", `${name.trim()}.dialog`);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = lang === model.sourceLocale ? `${sentence}\n` : `# Translate from ${model.sourceLocale}, then remove this line.\n${sentence}\n`;
    fs.writeFileSync(file, text);
    if (lang === model.sourceLocale) source = file;
  }
  registry.reload(model.root);
  if (source) await vscode.window.showTextDocument(vscode.Uri.file(source));
  await vscode.env.clipboard.writeText(`self.speak_dialog("${name.trim()}")`);
  void vscode.window.setStatusBarMessage(`$(clippy) self.speak_dialog("${name.trim()}") is on the clipboard`, 5000);
}

async function findBasePython(cwd: string): Promise<{ path: string; version: string } | undefined> {
  const configured = vscode.workspace.getConfiguration("thalovant").get<string>("python")?.trim();
  for (const candidate of [configured, ...BASE_PYTHONS].filter(Boolean) as string[]) {
    const probe = await probePython(candidate, cwd);
    if (probe?.ok) return { path: candidate, version: probe.version };
  }
  return undefined;
}

function step(output: vscode.OutputChannel, command: string, args: string[], cwd: string): Promise<boolean> {
  output.appendLine(`$ ${command} ${args.join(" ")}`);
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" } });
    child.stdout.on("data", (d) => output.append(String(d)));
    child.stderr.on("data", (d) => output.append(String(d)));
    child.on("error", (e) => {
      output.appendLine(String(e));
      resolve(false);
    });
    child.on("exit", (code) => {
      output.appendLine(code === 0 ? "" : `exit ${code}\n`);
      resolve(code === 0);
    });
  });
}
