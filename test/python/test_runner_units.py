"""The runner's pure parts, without starting OVOS."""
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _runner():
    # Importing the runner moves fd 1 to stderr; keep pytest's capture intact.
    spec = importlib.util.spec_from_file_location("runner", ROOT / "python" / "thalovant_dev_runner.py")
    module = importlib.util.module_from_spec(spec)
    saved = sys.stdout
    try:
        spec.loader.exec_module(module)
    finally:
        sys.stdout = saved
    return module


runner = _runner()


def test_locate_reads_the_entry_point():
    found = runner.locate(ROOT / "test" / "fixtures" / "thalovant-skill-plant-care")
    assert found == {"skill_id": "thalovant-skill-plant-care.thalovant",
                     "module": "thalovant_skill_plant_care", "class": "PlantCareSkill"}


def test_setup_py_entry_points(tmp_path):
    (tmp_path / "setup.py").write_text(
        'setup(entry_points={"opm.skill": ["thalovant-skill-x.thalovant=thalovant_skill_x:XSkill"]})')
    assert runner.locate(tmp_path)["class"] == "XSkill"


def test_the_default_pipeline_is_a_paired_hubs():
    stages = runner.pipeline("hub")
    assert stages[0] == "ovos-stop-pipeline-plugin-high"
    # Paired hubs blacklist Adapt and run only the low fallback tier.
    assert not any("adapt" in s for s in stages)
    assert [s for s in stages if "fallback" in s] == ["ovos-fallback-pipeline-plugin-low"]
    assert any(s.endswith("pipeline-plugin-high") and ("padatious" in s or "padacioso" in s) for s in stages)
    assert not any("m2v" in s for s in stages)
    # The old setting values still work.
    assert runner.pipeline("local") == stages


def test_m2v_uses_the_hubs_prototype_stages_never_the_frozen_classifier():
    stages = runner.pipeline("hub-m2v")
    assert "ovos-m2v-prototype-pipeline-high" in stages
    assert "ovos-m2v-prototype-pipeline-medium" in stages
    assert not any(s.startswith("ovos-m2v-pipeline") for s in stages)
    assert stages.index("ovos-m2v-prototype-pipeline-medium") < stages.index("ovos-fallback-pipeline-plugin-low")
    assert runner.pipeline("m2v") == stages


def test_unpaired_runtimes_keep_adapt():
    assert "ovos-adapt-pipeline-plugin-high" in runner.pipeline("unpaired")


def test_hub_config_is_written_only_for_m2v(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    runner._write_hub_config(runner.pipeline("hub"))
    assert not (tmp_path / "mycroft" / "mycroft.conf").exists()
    runner._write_hub_config(runner.pipeline("hub-m2v"))
    conf = json.loads((tmp_path / "mycroft" / "mycroft.conf").read_text())
    assert conf["intents"]["ovos-m2v-prototype-pipeline"]["subfolder"] == "encoder"
    assert conf["intents"]["ovos-m2v-prototype-pipeline"]["conf_medium"] == 0.80


def test_intent_labels_and_matching():
    assert runner._intent_label("skill.x:water.plants") == "water.plants"
    assert runner._intent_label("ovos.skills.fallback.skill.x.request") == "fallback"
    assert runner._same_intent("water.plants.intent", "water.plants")
    assert runner._same_intent("change_volume", "change_volume")
    assert not runner._same_intent("water.plants.intent", "name.plant")


def test_judge_explains_every_failure():
    own = "s.thalovant"
    turn = {"ended": "handled", "ms": 1, "replies": [], "messages": [],
            "route": {"matched": True, "skill_id": "other.skill", "label": "time"}}
    assert runner.judge({"utterance": "x"}, turn, own)["reason"] == "other.skill took it (time)"
    turn["route"] = {"matched": False}
    assert "nobody answered" in runner.judge({"utterance": "x"}, turn, own)["reason"]
    assert runner.judge({"utterance": "x", "negative": True}, turn, own)["passed"]
    turn["route"] = {"matched": True, "skill_id": own, "label": "fallback"}
    turn["messages"] = [{"type": "ovos.utterance.speak"}]
    assert runner.judge({"utterance": "x", "expected_messages": ["speak"]}, turn, own)["passed"]


def test_trim_keeps_traces_small():
    data = {"binary_data": "ab" * 500, "meta": {"display": {"image": {"mime": "image/png", "data": "x" * 900}}}}
    trimmed = runner._trim(data)
    assert trimmed["binary_data"] == "<1000 characters>"
    assert trimmed["meta"]["display"]["image"]["data"].startswith("<900")
