// Which Python runs the skill: the one its tests run with.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export interface PythonChoice {
  path: string;
  source: "setting" | "python-extension" | "venv" | "system";
}

export interface PythonProbe {
  version: string;
  ok: boolean;
  skillkit?: string;
  ovoscope?: string;
}

const VENV_NAMES = [".venv", "venv", ".env"];

export async function resolvePython(skillRoot: string): Promise<PythonChoice> {
  const uri = vscode.Uri.file(skillRoot);
  const configured = vscode.workspace.getConfiguration("thalovant", uri).get<string>("python")?.trim();
  if (configured) return { path: expandHome(substitute(configured, skillRoot)), source: "setting" };

  for (const name of VENV_NAMES) {
    for (const dir of [skillRoot, path.dirname(skillRoot)]) {
      const candidate = venvPython(path.join(dir, name));
      if (candidate) return { path: candidate, source: "venv" };
    }
  }

  const fromExtension = await pythonExtensionChoice(uri);
  if (fromExtension) return { path: fromExtension, source: "python-extension" };

  return { path: process.platform === "win32" ? "python" : "python3", source: "system" };
}

export function venvPython(venv: string): string | undefined {
  const candidates = process.platform === "win32" ? [path.join(venv, "Scripts", "python.exe")] : [path.join(venv, "bin", "python")];
  return candidates.find((c) => fs.existsSync(c));
}

async function pythonExtensionChoice(uri: vscode.Uri): Promise<string | undefined> {
  const extension = vscode.extensions.getExtension("ms-python.python");
  if (!extension) return undefined;
  try {
    const api = extension.isActive ? extension.exports : await extension.activate();
    const environments = api?.environments;
    if (!environments?.getActiveEnvironmentPath) return undefined;
    const active = environments.getActiveEnvironmentPath(uri);
    const resolved = await environments.resolveEnvironment?.(active);
    return resolved?.executable?.uri?.fsPath ?? active?.path;
  } catch {
    return undefined;
  }
}

/** Version, and the kit and OVOScope versions, without starting OVOS. */
export function probePython(python: string, cwd: string): Promise<PythonProbe | undefined> {
  const script = [
    "import sys, json",
    "from importlib.metadata import version, PackageNotFoundError",
    "def v(n):",
    "    try: return version(n)",
    "    except PackageNotFoundError: return None",
    "print(json.dumps({'version': sys.version.split()[0], 'ok': sys.version_info >= (3, 11),",
    "  'skillkit': v('thalovant-skillkit'), 'ovoscope': v('ovoscope')}))",
  ].join("\n");
  return new Promise((resolve) => {
    execFile(python, ["-c", script], { cwd, timeout: 20_000 }, (error, stdout) => {
      if (error) return resolve(undefined);
      try {
        resolve(JSON.parse(stdout.trim().split("\n").pop() ?? ""));
      } catch {
        resolve(undefined);
      }
    });
  });
}

function substitute(value: string, skillRoot: string): string {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(skillRoot))?.uri.fsPath ?? skillRoot;
  return value.replace(/\$\{workspaceFolder\}/g, folder).replace(/\$\{skillFolder\}/g, skillRoot);
}

function expandHome(value: string): string {
  return value.startsWith("~/") ? path.join(process.env.HOME ?? "", value.slice(2)) : value;
}
