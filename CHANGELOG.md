# Changelog

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
