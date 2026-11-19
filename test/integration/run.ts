// Launch VS Code with the extension under development and run suite.ts in it.
// Uses VSCODE_BINARY (or a downloaded stable build) and a throwaway profile.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const root = path.resolve(__dirname, "../../..");
  const fixture = path.join(root, "test/fixtures/thalovant-skill-plant-care");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "thalovant-vscode-test-"));
  const python = process.env.THALOVANT_TEST_PYTHON;
  fs.mkdirSync(path.join(profile, "user", "User"), { recursive: true });
  fs.writeFileSync(path.join(profile, "user", "User", "settings.json"), JSON.stringify({
    "security.workspace.trust.enabled": false,
    "thalovant.python": python ?? "",
    "workbench.startupEditor": "none",
    "extensions.autoUpdate": false,
    "telemetry.telemetryLevel": "off",
  }, null, 2));
  // Run from inside VS Code, the terminal carries variables that would make the
  // test editor start as plain Node or talk to the running editor.
  for (const key of Object.keys(process.env)) if (key.startsWith("VSCODE_") || key === "ELECTRON_RUN_AS_NODE") delete process.env[key];
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_BINARY,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, "suite.js"),
      launchArgs: [fixture, "--disable-extensions", "--skip-welcome", "--skip-release-notes", `--user-data-dir=${path.join(profile, "user")}`, `--extensions-dir=${path.join(profile, "extensions")}`],
      extensionTestsEnv: { THALOVANT_TEST_PYTHON: python ?? "" },
    });
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
