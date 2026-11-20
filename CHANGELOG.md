# Changelog

## 0.1.1

- **The simulator routes like a paired hub.** The default pipeline is now
  `hub`: stop, converse, Padatious, common query and the low fallback tier,
  as paired hubs run. The old default also ran Adapt and the high and medium
  fallback tiers, which paired hubs never run, so a skill could answer in the
  simulator and stay silent on a hub.
- When a skill registers Adapt intents and the pipeline does not run Adapt,
  the simulator says which intents a paired hub will never answer.
- `hub-m2v` uses the hub's model2vec **prototype** stages on Thalovant's own
  encoder, with the hub's settings. The old `m2v` used the frozen classifier,
  which cannot match a skill's registered intents.
- `unpaired` keeps Adapt, for skills meant for unpaired runtimes. The old
  values `local` and `m2v` still work, as `hub` and `hub-m2v`.

## 0.1.0

First version.

- **Simulator**: the skill runs in a real OVOS core (OVOScope's MiniCroft) with
  the skill's own Python. Each turn shows what the skill says (and its SSML
  twin), what an app writes (`utterance_written`), the card a screen shows, and
  which intent and handler took the sentence, with its log lines and bus
  messages. Card buttons send `thalovant.display.action` back to the skill. A
  question asked with `get_response` waits for your answer. Saving a skill file
  restarts the skill and keeps the conversation.
- A skill that OVOS refuses to load is reported with OVOS's reason. OVOS itself
  only logs it.
- **Golden utterances** from `test/end2end/golden_utterances*.jsonl` in the
  Testing view, each run in a hub of its own. Save any simulator turn as a row,
  or as a sentence the skill must leave alone.
- **Locale intelligence** in Python: completion, hover, go to definition and
  missing-resource warnings for dialogs, vocabulary, intents and layouts.
  CodeLens to say an intent's sentence.
- **SkillKit**: `thalovant-skillkit check` on save in the Problems panel, placed
  on the file and line each problem names. New Skill… wraps `thalovant-skillkit
  new` and builds the skill's `.venv`.
- Highlighting for `.dialog`, `.voc`, `.intent`, `.entity`, `.ssml` and
  `.rfwtxt`, snippets for cards, taps and SSML, and schemas for `supported.json`
  and `skill.json`.
