// The real runner against the fixture skill. Needs a Python with SkillKit and
// OVOScope: THALOVANT_TEST_PYTHON, else skipped.
import assert from "node:assert/strict";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { RunnerProcess, SkillInfo, TurnResult } from "../../src/core/runner";

const python = process.env.THALOVANT_TEST_PYTHON;
const ROOT = path.resolve(__dirname, "../../..");
const FIXTURE = path.join(ROOT, "test/fixtures/thalovant-skill-plant-care");
const SKILL = "thalovant-skill-plant-care.thalovant";
let runner: RunnerProcess;
let info: SkillInfo;

before(async () => {
  if (!python) return;
  runner = new RunnerProcess(python, path.join(ROOT, "python/thalovant_dev_runner.py"), FIXTURE, () => undefined);
  await runner.whenReady();
  info = await runner.request<SkillInfo>("start", { root: FIXTURE, langs: ["en-US", "fr-FR"], pipeline: "hub" });
});

after(async () => {
  if (runner) await runner.stop();
});

test("the skill starts and says what it is", { skip: !python }, () => {
  assert.equal(info.skill_id, SKILL);
  assert.equal(info.class, "PlantCareSkill");
  assert.equal(info.base, "ThalovantSkill");
  assert.deepEqual(info.langs, ["en-US", "fr-FR"]);
});

test("an intent: speech, its SSML twin and a card", { skip: !python }, async () => {
  const turn = await runner.request<TurnResult>("utter", { text: "water the plants", session: "t1" });
  assert.equal(turn.ended, "handled");
  assert.equal(turn.route.own, true);
  assert.equal(turn.route.label, "water.plants");
  assert.equal(turn.route.handler, "PlantCareSkill.handle_water");
  const [reply] = turn.replies;
  assert.equal(reply.utterance, "The fern needs water today.");
  assert.match(reply.ssml ?? "", /<emphasis>today<\/emphasis>/);
  assert.equal(reply.display?.kind, "list");
  assert.deepEqual(reply.display?.actions?.map((a) => a.id), ["done", "later"]);
  assert.ok(turn.logs.some((l) => l.own && l.text === "watering card for en-US"));
});

test("a tap on the card comes back to the skill", { skip: !python }, async () => {
  const turn = await runner.request<TurnResult>("tap", { card: `${SKILL}:watering`, action: "done", skill: SKILL, session: "t1" });
  assert.equal(turn.replies[0]?.utterance, "Marked as watered.");
  assert.equal(turn.replies[0]?.display?.kind, "text");
});

test("a question, then its answer through converse, with a written form", { skip: !python }, async () => {
  const asked = await runner.request<TurnResult>("utter", { text: "name my plant", session: "t2" });
  assert.equal(asked.ended, "asked");
  assert.equal(asked.waiting_for_answer, true);
  assert.equal(asked.replies[0].expect_response, true);
  const answered = await runner.request<TurnResult>("utter", { text: "Fernando", session: "t2" });
  assert.equal(answered.replies[0].utterance, "Fernando it is.");
  assert.equal(answered.replies[0].written, "Named: Fernando");
});

test("French reaches the same intent", { skip: !python }, async () => {
  const turn = await runner.request<TurnResult>("utter", { text: "arrose les plantes", lang: "fr-FR", session: "t3" });
  assert.equal(turn.route.label, "water.plants");
  assert.equal(turn.replies[0].utterance, "La fougère a besoin d'eau aujourd'hui.");
});

test("an exception is reported with its traceback", { skip: !python }, async () => {
  const turn = await runner.request<TurnResult>("utter", { text: "break my plant", session: "t4" });
  assert.equal(turn.errors.length, 1);
  assert.match(turn.errors[0].exception ?? "", /the pot is cracked/);
  assert.match(turn.errors[0].traceback ?? "", /handle_broken/);
});

test("nobody answers what is not the skill's", { skip: !python }, async () => {
  const turn = await runner.request<TurnResult>("utter", { text: "what time is it in Lisbon", session: "t5" });
  assert.equal(turn.route.matched, false);
  assert.equal(turn.replies.length, 0);
});

test("golden rows get a verdict each", { skip: !python }, async () => {
  const rows = [
    { utterance: "water the plants", intent_label: "water.plants.intent", lang: "en-US" },
    { utterance: "name my plant", intent_label: "water.plants.intent", lang: "en-US" },
    { utterance: "what time is it", lang: "en-US" },
    { utterance: "what time is it", lang: "en-US", negative: true },
  ];
  const { results } = await runner.request<{ results: { passed: boolean; reason: string }[] }>("golden", { rows });
  assert.deepEqual(results.map((r) => r.passed), [true, false, false, true]);
  assert.match(results[1].reason, /as name.plant, not water.plants.intent/);
  assert.match(results[2].reason, /nobody answered/);
});

test("a skill OVOS refuses to load is reported as not started, with OVOS's reason", { skip: !python }, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "tv-broken-"));
  fs.cpSync(FIXTURE, copy, { recursive: true });
  const main = path.join(copy, "thalovant_skill_plant_care/__init__.py");
  fs.writeFileSync(main, fs.readFileSync(main, "utf8").replace("        self.add_display_action_handler(self.on_tap)", '        raise RuntimeError("the watering can is empty")'));
  const broken = new RunnerProcess(python!, path.join(ROOT, "python/thalovant_dev_runner.py"), copy, () => undefined);
  try {
    await broken.whenReady();
    await assert.rejects(broken.request("start", { root: copy, langs: ["en-US"] }), (error: Error & { kind?: string }) => {
      assert.match(error.message, /did not load: .*the watering can is empty/);
      assert.equal(error.kind, "load");
      return true;
    });
    await assert.rejects(broken.request("utter", { text: "water the plants" }), /not running/);
  } finally {
    await broken.stop();
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test("an Adapt intent: named as never running on a paired hub, answered on an unpaired runtime", { skip: !python }, async () => {
  const probe = path.join(ROOT, "test/fixtures/thalovant-skill-adapt-probe");
  for (const [pipeline, answers] of [["hub", false], ["unpaired", true]] as const) {
    const run = new RunnerProcess(python!, path.join(ROOT, "python/thalovant_dev_runner.py"), probe, () => undefined);
    try {
      await run.whenReady();
      const started = await run.request<SkillInfo>("start", { root: probe, langs: ["en-US"], pipeline });
      assert.deepEqual(started.adapt_intents, ["PingIntent"]);
      assert.equal(started.adapt_runs, answers);
      const turn = await run.request<{ route: { matched: boolean }; replies: { utterance: string }[] }>("utter", { text: "ping" });
      assert.equal(turn.route.matched, answers);
      if (answers) assert.equal(turn.replies[0]?.utterance, "pong");
    } finally {
      await run.stop();
    }
  }
});
