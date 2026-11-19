import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { parseCheckOutput, placeProblem, frameInSkill } from "../../src/core/problems";
import { references, resourceKey, stringArgAt } from "../../src/core/references";
import { coverage, entryFromPyproject, findSkillRoots, loadSkill } from "../../src/core/skill";
import { expand, sayable } from "../../src/core/templates";

const FIXTURE = path.resolve(__dirname, "../../../test/fixtures/thalovant-skill-plant-care");

test("the fixture skill is read from its files alone", () => {
  const model = loadSkill(FIXTURE);
  assert.equal(model.entry?.skillId, "thalovant-skill-plant-care.thalovant");
  assert.equal(model.entry?.className, "PlantCareSkill");
  assert.deepEqual(model.locales, ["en-US", "fr-FR"]);
  assert.equal(model.sourceLocale, "en-US");
  assert.equal(model.title, "Plant Care");
  const names = new Set(model.resources.map((r) => `${r.lang}/${r.kind}/${r.name}`));
  assert.ok(names.has("en-US/intent/water.plants.intent"));
  assert.ok(names.has("en-US/ssml/water.fern"));
  assert.ok(names.has("fr-FR/dialog/water.fern"));
  assert.equal(model.goldens.length, 5);
  assert.equal(model.goldens[2].lang, "fr-FR");
  assert.equal(model.goldens[0].intent, "water.plants.intent");
  assert.deepEqual(coverage(model, ["ssml"], "water.fern").missing, ["fr-FR"]);
});

test("skill roots are found one level down, and not inside a virtualenv", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tv-"));
  fs.mkdirSync(path.join(dir, "a", "thalovant_skill_a"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a", "thalovant_skill_a", "__init__.py"), "");
  fs.mkdirSync(path.join(dir, ".venv", "x", "thalovant_skill_b"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".venv", "x", "thalovant_skill_b", "__init__.py"), "");
  try {
    assert.deepEqual(findSkillRoots(dir), [path.join(dir, "a")]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pyproject entry points in every quoting style", () => {
  const e = entryFromPyproject(`[project]\nname = "x"\n\n[project.entry-points.'opm.skill']\nthalovant-skill-x.thalovant = "thalovant_skill_x:XSkill"\n[tool.x]\n`);
  assert.deepEqual(e, { skillId: "thalovant-skill-x.thalovant", module: "thalovant_skill_x", className: "XSkill", line: 4 });
  assert.equal(entryFromPyproject(`[project.entry-points."console_scripts"]\nx = "a:b"\n`), undefined);
});

test("the string argument a cursor sits in, and the call it belongs to", () => {
  const src = `self.speak_dialog("water.f`;
  const arg = stringArgAt(src, src.length);
  assert.equal(arg?.call, "speak_dialog");
  assert.equal(arg?.value, "water.f");
  assert.equal(arg?.closed, false);
  const vocab = `if self.mentions(utterance, "Wat", lang):`;
  assert.equal(stringArgAt(vocab, vocab.indexOf("Wat") + 2)?.rule.label, "vocabulary");
  // The utterance argument is not a resource.
  const first = `self.mentions("free text", "Voc")`;
  assert.equal(stringArgAt(first, 18), undefined);
  // f-strings and comments never name resources.
  assert.equal(stringArgAt(`self.speak_dialog(f"x{y}")`, 22), undefined);
  assert.equal(stringArgAt(`# self.speak_dialog("x")`, 21), undefined);
  // Nested calls: the innermost open call wins.
  const nested = `self.speak_dialog("a", {"n": len("bc")})`;
  assert.equal(stringArgAt(nested, nested.indexOf("bc") + 1), undefined);
});

test("every resource reference in a file", () => {
  const src = [
    `"""Docs mention speak_dialog("not.real")."""`,
    `@intent_handler("water.plants.intent")`,
    `def h(self, m):`,
    `    self.speak_dialog("water.fern", {"x": 1})`,
    `    self.speak_dialog(f"dyn.{x}")`,
    `    # self.speak_dialog("commented")`,
    `    layout = display.layout_file(self, "weather.day")`,
    `    @intent_handler(IntentBuilder("Water").require("WaterKeyword"))`,
  ].join("\n");
  const found = references(src).map((r) => `${r.call}:${r.value}`);
  assert.deepEqual(found, ["intent_handler:water.plants.intent", "speak_dialog:water.fern", "layout_file:weather.day", "require:WaterKeyword"]);
  const builder = references(`@intent_handler("Water")`)[0];
  assert.equal(resourceKey(builder), undefined);
  assert.equal(resourceKey(references(`self.register_intent_file("x", h)`)[0]), "x.intent");
});

test("templates expand the way OVOS reads them", () => {
  assert.deepEqual(expand("(water|watering) the [house] plants"), ["water the house plants", "water the plants", "watering the house plants", "watering the plants"]);
  assert.equal(sayable("set a timer for {duration}"), "set a timer for {duration}");
  assert.equal(sayable("what is (the|) weather"), "what is the weather");
  assert.deepEqual(expand("broken (group"), []);
});

test("check problems land on the file they name", () => {
  const model = loadSkill(FIXTURE);
  const pkg = model.packageDir!;
  const onLine = placeProblem("locale/en-US/dialog/water.fern.ssml:1: does not say the same words as the plain line", model);
  assert.equal(onLine.file, path.join(pkg, "locale/en-US/dialog/water.fern.ssml"));
  assert.equal(onLine.line, 0);
  const missing = placeProblem("locale/de-DE/dialog/water.fern.dialog is missing (en-US has it)", model);
  assert.equal(missing.file, path.join(pkg, "locale/en-US/dialog/water.fern.dialog"));
  const priority = placeProblem("FALLBACK_PRIORITY = 80 is outside 91-100; below 91 it outranks every skill", model);
  assert.equal(priority.file, path.join(pkg, "__init__.py"));
  const parsed = parseCheckOutput("2 problem(s) in x:\n  - first\n  - second one\n    continued\n");
  assert.deepEqual(parsed.problems, ["first", "second one continued"]);
  assert.equal(parseCheckOutput("ok: x keeps its contracts\n").ok, true);
});

test("a traceback points at the deepest frame in the skill", () => {
  const tb = `Traceback (most recent call last):\n  File "/venv/lib/python3.13/site-packages/ovos_workshop/x.py", line 10, in a\n  File "${FIXTURE}/thalovant_skill_plant_care/__init__.py", line 33, in handle_broken\n  File "/venv/lib/python3.13/site-packages/other.py", line 4, in b\nRuntimeError: x`;
  assert.deepEqual(frameInSkill(tb, FIXTURE), { file: `${FIXTURE}/thalovant_skill_plant_care/__init__.py`, line: 32 });
});
