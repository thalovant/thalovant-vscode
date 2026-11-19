// One bundle for the extension; the unit tests compile beside it.
import * as esbuild from "esbuild";
import { readdirSync } from "node:fs";

const args = new Set(process.argv.slice(2));
const production = args.has("--production");
const common = { bundle: true, platform: "node", target: "node20", format: "cjs", sourcemap: !production, minify: production, logLevel: "info" };

const builds = [esbuild.build({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", external: ["vscode"] })];
if (args.has("--tests")) {
  const unit = readdirSync("test/unit").filter((f) => f.endsWith(".test.ts")).map((f) => `test/unit/${f}`);
  builds.push(esbuild.build({ ...common, entryPoints: unit, outdir: "out/test/unit", bundle: true, external: ["vscode"] }));
  builds.push(esbuild.build({ ...common, entryPoints: ["test/integration/run.ts", "test/integration/suite.ts"], outdir: "out/test/integration", external: ["vscode", "@vscode/test-electron"] }));
}
if (args.has("--watch")) {
  const ctx = await esbuild.context({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", external: ["vscode"] });
  await ctx.watch();
} else {
  await Promise.all(builds);
}
