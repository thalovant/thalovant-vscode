"""The runner's pure parts, without starting OVOS."""
import importlib.util
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


def test_every_fallback_tier_is_in_the_local_pipeline():
    stages = runner.pipeline("local")
    for tier in ("high", "medium", "low"):
        assert f"ovos-fallback-pipeline-plugin-{tier}" in stages
    assert stages[0] == "ovos-stop-pipeline-plugin-high"
    assert any("m2v" in s for s in runner.pipeline("m2v"))
    assert not any("m2v" in s for s in stages)


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
