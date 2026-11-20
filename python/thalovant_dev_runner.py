"""Run one Thalovant skill in a real OVOS MiniCroft and talk to it over stdio.

The VS Code extension starts this file with the skill's own Python
interpreter (the one its tests run with), so the skill runs with its own
dependencies, the installed thalovant-skillkit and OVOScope. Nothing is
installed or written outside a private temporary XDG tree.

Protocol: one JSON object per line.

    extension -> runner   {"id": 1, "op": "utter", "text": "...", ...}
    runner -> extension   {"id": 1, "ok": true, "result": {...}}
                          {"id": 1, "ok": false, "error": "...", "detail": "..."}
                          {"event": "...", ...}       (not tied to a request)

The protocol has the real stdout to itself: file descriptor 1 is pointed at
stderr before OVOS is imported, so a print() or a log handler anywhere in the
stack lands in the extension's log, never in the middle of a reply.
"""
from __future__ import annotations

import importlib
import inspect
import json
import logging
import os
import re
import sys
import threading
import time
import traceback
import uuid
from contextlib import ExitStack
from pathlib import Path
from typing import Any

PROTOCOL = 1

# -- the wire ---------------------------------------------------------------------------

_wire = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr
_wire_lock = threading.Lock()


def _send(payload: dict) -> None:
    line = json.dumps(payload, ensure_ascii=False, default=_jsonable)
    with _wire_lock:
        _wire.write(line + "\n")
        _wire.flush()


def _jsonable(value: Any) -> Any:
    if isinstance(value, bytes | bytearray):
        return {"bytes": len(value)}
    if isinstance(value, set | tuple):
        return list(value)
    if hasattr(value, "serialize"):
        try:
            return json.loads(value.serialize()) if isinstance(value.serialize(), str) \
                else value.serialize()
        except Exception:  # noqa: BLE001, S110 - a trace entry must never fail a turn
            pass
    return repr(value)


def event(name: str, **fields: Any) -> None:
    _send({"event": name, **fields})


# -- finding the skill --------------------------------------------------------------------

ENTRY_GROUPS = ("opm.skill", "ovos.plugin.skill", "mycroft.plugin.skill")
_SETUP_ENTRY = re.compile(r"""["']\s*([A-Za-z0-9_.\-]+)\s*=\s*([A-Za-z0-9_.]+)\s*:\s*([A-Za-z0-9_]+)\s*["']""")


def _entry_point(root: Path) -> tuple[str, str, str] | None:
    """(skill_id, module, class) from pyproject.toml, then setup.py."""
    pyproject = root / "pyproject.toml"
    if pyproject.is_file():
        import tomllib

        try:
            data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError:
            data = {}
        groups = data.get("project", {}).get("entry-points", {})
        for group in ENTRY_GROUPS:
            for name, target in (groups.get(group) or {}).items():
                module, _, clazz = str(target).partition(":")
                if clazz:
                    return name.strip(), module.strip(), clazz.strip()
    setup = root / "setup.py"
    if setup.is_file():
        match = _SETUP_ENTRY.search(setup.read_text(encoding="utf-8", errors="replace"))
        if match:
            return match.group(1), match.group(2), match.group(3)
    return None


def _package(root: Path) -> Path | None:
    for candidate in sorted(root.glob("thalovant_skill_*")):
        if (candidate / "__init__.py").is_file():
            return candidate
    return None


def _skill_class_in(module: Any) -> type | None:
    from ovos_workshop.skills.ovos import OVOSSkill

    for _, value in inspect.getmembers(module, inspect.isclass):
        if issubclass(value, OVOSSkill) and value.__module__ == module.__name__:
            return value
    return None


def locate(root: Path) -> dict:
    """What the hub would load from this checkout, without loading it."""
    entry = _entry_point(root)
    package = _package(root)
    if entry is None and package is None:
        raise RuntimeError(
            f"{root} declares no skill entry point and has no thalovant_skill_* package")
    if entry is not None:
        skill_id, module, clazz = entry
    else:
        module, clazz = package.name, ""
        skill_id = package.name.replace("_", "-") + ".thalovant"
    return {"skill_id": skill_id, "module": module, "class": clazz}


def _base_kind(skill_type: type) -> str:
    names = [klass.__name__ for klass in skill_type.__mro__]
    for kind in ("ThalovantConversationalFallbackSkill", "ThalovantFallbackSkill",
                 "ThalovantConversationalSkill", "ThalovantSkill",
                 "FallbackSkill", "ConversationalSkill", "OVOSSkill"):
        if kind in names:
            return kind
    return names[1] if len(names) > 1 else names[0]


# -- pipelines ------------------------------------------------------------------------------

#: The prototype stage's settings on a hub (thalovant-api intent_pipelines.M2V_PROTOTYPE_CONFIG) and
#: the encoder the runtime image bakes for it (ovos-runtime-image bake_m2v_model.py).
M2V_PROTOTYPE = {
    "model": "thalovant/thalovant-m2v-intents",
    "revision": "b556241a0f5bc574bbe852c6140d9dda1b0a4482",
    "subfolder": "encoder",
    "conf_medium": 0.80,
    "preload_model": True,
    "prototype_strategy": "farthest_point",
    "prototype_k": 128,
}
#: Older setting values, kept working.
PIPELINE_ALIASES = {"local": "hub", "m2v": "hub-m2v"}


def _installed_pipeline(plugin: str) -> bool:
    from importlib.metadata import entry_points
    return any(ep.name == plugin for ep in entry_points(group="opm.pipeline"))


def pipeline(name: str | list[str]) -> list[str]:
    """The intent stages a turn walks through: what a Thalovant hub runs.

    "hub" is a paired hub (thalovant-api gitops._PAIRED_SKILL_PIPELINE) without
    its model download: stop, converse, Padatious, common query, and only the
    low fallback tier. Paired hubs blacklist Adapt and Padacioso, so an Adapt
    intent that answers here would never answer there. "hub-m2v" adds the
    hub's model2vec prototype stages (Thalovant's encoder, downloaded on first
    use). "unpaired" adds Adapt, as unpaired runtimes keep it. Padacioso stands
    in for Padatious only where the compiled engine is missing.
    """
    if isinstance(name, list):
        return name
    name = PIPELINE_ALIASES.get(name, name)
    try:
        import padatious  # noqa: F401
        exact = "ovos-padatious-pipeline-plugin-high"
    except Exception:  # noqa: BLE001 - no compiled engine: the pure-Python twin
        exact = "ovos-padacioso-pipeline-plugin-high"
    m2v = name == "hub-m2v"
    common = _installed_pipeline("ovos-common-query-pipeline-plugin")
    stages = ["ovos-stop-pipeline-plugin-high", "ovos-converse-pipeline-plugin", exact]
    if name == "unpaired":
        stages.append("ovos-adapt-pipeline-plugin-high")
    if m2v:
        stages.append("ovos-m2v-prototype-pipeline-high")
    if common:
        stages.append("ovos-common-query-pipeline-plugin")
    if m2v:
        stages.append("ovos-m2v-prototype-pipeline-medium")
    stages.append("ovos-fallback-pipeline-plugin-low")
    return stages


def pipeline_config(stages: list[str]) -> dict[str, dict] | None:
    """The hub's settings for the m2v prototype stage, for MiniCroft's ``pipeline_config``.

    MiniCroft isolates the user configuration, so the settings go in through
    the argument it reads them from, never through a mycroft.conf file.
    """
    if not any("m2v-prototype" in stage for stage in stages):
        return None
    return {"ovos-m2v-prototype-pipeline": dict(M2V_PROTOTYPE)}


def _adapt_intents(skill: Any) -> list[str]:
    """The skill's intents registered with Adapt (an intent object, not a Padatious file)."""
    service = getattr(skill, "intent_service", None)
    registered = getattr(service, "registered_intents", None) or []
    return sorted({str(name).split(":")[-1] for name, data in registered if not isinstance(data, dict)})


# -- watching a turn --------------------------------------------------------------------------

SPEECH = ("ovos.utterance.speak", "speak")
#: Large fields that a trace shows as a size, never as their bytes.
ELIDE = ("binary_data", "rfw")


def _trim(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        return "…"
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if key in ELIDE and isinstance(item, str) and len(item) > 200:
                out[key] = f"<{len(item)} characters>"
            elif key == "image" and isinstance(item, dict) and "data" in item:
                out[key] = {**item, "data": f"<{len(str(item['data']))} base64 characters>"}
            else:
                out[key] = _trim(item, depth + 1)
        return out
    if isinstance(value, list):
        return [_trim(item, depth + 1) for item in value[:200]]
    if isinstance(value, str) and len(value) > 4000:
        return value[:4000] + f"… <{len(value)} characters>"
    return value


class _LogTap(logging.Handler):
    """Log records raised while a turn runs: the skill's own at every level,
    everyone's warnings and errors."""

    def __init__(self, runner: Runner):
        super().__init__(logging.DEBUG)
        self.runner = runner

    def emit(self, record: logging.LogRecord) -> None:
        turn = self.runner.turn
        if turn is None:
            return
        own = any(mark and mark in record.name for mark in self.runner.log_marks) \
            or any(mark and mark in (record.pathname or "") for mark in self.runner.path_marks)
        if record.levelno < logging.WARNING and not own:
            return
        if not own and str(record.msg).startswith("Deprecation"):
            return
        try:
            text = record.getMessage()
        except Exception:  # noqa: BLE001
            text = str(record.msg)
        entry = {"level": record.levelname, "logger": record.name, "text": text[:4000],
                 "own": own, "file": record.pathname, "line": record.lineno}
        if record.exc_info:
            entry["traceback"] = "".join(traceback.format_exception(*record.exc_info))[-8000:]
        turn.logs.append(entry)


class Turn:
    def __init__(self, kind: str, quiet_after_speech: float):
        self.kind = kind
        self.messages: list[Any] = []
        self.logs: list[dict] = []
        self.started = time.monotonic()
        self.done = threading.Event()
        self.last = self.started
        self.spoke = False
        self.asked = False
        self.handled = False
        self.quiet_after_speech = quiet_after_speech


class Runner:
    def __init__(self) -> None:
        self.stack = ExitStack()
        self.croft = None
        self.info: dict = {}
        self.sessions: dict[str, Any] = {}
        self.turn: Turn | None = None
        self.turn_lock = threading.Lock()
        self.log_marks: list[str] = []
        self.path_marks: list[str] = []
        self.root: Path | None = None
        self.default_lang = "en-US"

    # -- lifecycle --

    def hello(self, _: dict) -> dict:
        from importlib.metadata import PackageNotFoundError, version

        def have(name: str) -> str | None:
            try:
                return version(name)
            except PackageNotFoundError:
                return None

        shared: list[str] = []
        try:
            import thalovant_skillkit

            kit = Path(thalovant_skillkit.__file__).parent / "shared_dialog"
            shared = sorted({path.stem for path in kit.glob("*/dialog/*.dialog")})
        except Exception:  # noqa: BLE001, S110 - no kit: hello says so in packages
            pass
        return {"protocol": PROTOCOL, "python": sys.version.split()[0],
                "shared_dialogs": shared,
                "executable": sys.executable,
                "packages": {name: have(name) for name in (
                    "thalovant-skillkit", "ovoscope", "ovos-core", "ovos-workshop",
                    "ovos-padatious", "ovos-m2v-pipeline")}}

    def start(self, request: dict) -> dict:
        root = Path(request["root"]).resolve()
        self.root = root
        found = locate(root)
        from thalovant_skillkit.testing_ovos import isolated_xdg

        self.stack.enter_context(isolated_xdg())
        stages = pipeline(request.get("pipeline") or "hub")
        sys.path.insert(0, str(root))
        started = time.monotonic()
        module = importlib.import_module(found["module"])
        skill_type = getattr(module, found["class"], None) if found["class"] \
            else _skill_class_in(module)
        if skill_type is None:
            raise RuntimeError(f"{found['module']} has no class {found['class'] or '(a skill)'}")
        skill_id = found["skill_id"]
        self.log_marks = [skill_id, found["module"], skill_type.__name__]
        self.path_marks = [str(root / found["module"].split(".")[0])]
        self._tap_logs(_LogTap(self))

        langs = list(request.get("langs") or [])
        lang = request.get("lang") or (langs[0] if langs else "en-US")
        secondary = [code for code in langs if code != lang]
        self.default_lang = lang
        settings = request.get("settings") or None

        skill_class = skill_type
        if settings:
            class _WithSettings(skill_type):  # type: ignore[misc, valid-type]
                def __init__(self, *args, **kwargs):
                    super().__init__(*args, **kwargs)
                    for key, value in settings.items():
                        self.settings[key] = value
            _WithSettings.__name__ = skill_type.__name__
            _WithSettings.__qualname__ = skill_type.__qualname__
            skill_class = _WithSettings

        import ovoscope

        # Collect the boot's log: OVOS reports a skill that fails to load in
        # its log and carries on, so the log is where the reason is.
        boot = Turn("boot", quiet_after_speech=0)
        self.turn = boot
        self._attach_all_loggers()
        try:
            self.croft = ovoscope.get_minicroft(
                [skill_id], extra_skills={skill_id: skill_class}, default_pipeline=stages,
                pipeline_config=pipeline_config(stages),
                lang=lang, secondary_langs=list(secondary))  # get_minicroft appends to it
        finally:
            self.turn = None
        self.stack.callback(self.croft.stop)
        failure = _load_failure(boot.logs, skill_id)
        if failure is not None:
            # No half-started hub: the next turn is told the skill is not running.
            self.stack.close()
            self.stack = ExitStack()
            self.croft = None
            raise SkillLoadError(*failure)
        self._attach_all_loggers()
        self.croft.bus.on("message", self._on_message)
        loaded = time.monotonic() - started

        skill = self._skill()
        priority = None
        for name in ("fallback_priority", "FALLBACK_PRIORITY"):
            value = getattr(skill, name, None) if skill is not None else None
            if isinstance(value, int):
                priority = value
                break
        self.info = {
            "skill_id": skill_id, "module": found["module"], "class": skill_type.__name__,
            "base": _base_kind(skill_type), "fallback_priority": priority,
            "file": inspect.getsourcefile(skill_type), "line": inspect.getsourcelines(skill_type)[1],
            "lang": lang, "langs": [lang, *secondary], "pipeline": stages,
            "boot_seconds": round(loaded, 3),
            # Adapt intents answer only where Adapt runs: never on a paired hub.
            "adapt_intents": _adapt_intents(skill) if skill is not None else [],
            "adapt_runs": any("adapt" in stage for stage in stages),
        }
        return self.info

    def _skill(self) -> Any:
        manager = getattr(self.croft, "skill_manager", None) or self.croft
        for attr in ("plugin_skills", "skills"):
            loaded = getattr(manager, attr, None)
            if isinstance(loaded, dict):
                for loader in loaded.values():
                    instance = getattr(loader, "instance", None) or loader
                    if getattr(instance, "skill_id", None) == self.info.get("skill_id") \
                            or getattr(instance, "skill_id", None) == (self.log_marks or [None])[0]:
                        return instance
        return None

    def _tap_logs(self, tap: logging.Handler) -> None:
        """Every log record, wherever OVOS logs it from.

        ovos_utils builds one logger per call site, on first use, with
        propagation off: a handler on the root sees none of them. Wrapping its
        factory gives each new logger the tap as it is built.
        """
        logging.getLogger().addHandler(tap)
        try:
            from ovos_utils.log import LOG
        except ImportError:
            return
        factory = LOG.create_logger.__func__

        def create_logger(cls, name, *args, **kwargs):
            logger = factory(cls, name, *args, **kwargs)
            if tap not in logger.handlers:
                logger.addHandler(tap)
            return logger

        LOG.create_logger = classmethod(create_logger)
        for logger in list(getattr(LOG, "_loggers", {}).values()):
            if tap not in logger.handlers:
                logger.addHandler(tap)

    def _attach_all_loggers(self) -> None:
        """OVOS loggers often stop propagation; tap each one directly."""
        tap = next((h for h in logging.getLogger().handlers if isinstance(h, _LogTap)), None)
        if tap is None:
            return
        for logger in list(logging.Logger.manager.loggerDict.values()):
            if isinstance(logger, logging.Logger) and not logger.propagate \
                    and tap not in logger.handlers:
                logger.addHandler(tap)

    def stop(self, _: dict) -> dict:
        self.stack.close()
        return {}

    # -- the bus --

    def _on_message(self, serialized: str) -> None:
        from ovos_bus_client.message import Message

        try:
            message = Message.deserialize(serialized) if isinstance(serialized, str) else serialized
        except Exception:  # noqa: BLE001
            return
        turn = self.turn
        if turn is None:
            if message.msg_type in SPEECH:
                event("speak", reply=self._reply(message))
            elif message.msg_type not in ("ovos.skills.settings_changed",):
                event("bus", message=self._entry(message))
            return
        turn.messages.append(message)
        turn.last = time.monotonic()
        if message.msg_type in SPEECH:
            turn.spoke = True
            if message.data.get("expect_response"):
                turn.asked = True
        if message.msg_type == "ovos.utterance.handled":
            turn.handled = True

    def _watch(self, turn: Turn, timeout: float) -> str:
        """How the turn ended: handled, asked (waiting for an answer), quiet, timeout."""
        deadline = turn.started + timeout
        while True:
            now = time.monotonic()
            if turn.handled and now - turn.last > 0.05:
                return "handled"
            if turn.asked and now - turn.last > 0.4:
                return "asked"
            if turn.kind != "utterance" and turn.spoke and now - turn.last > turn.quiet_after_speech:
                return "quiet"
            if turn.kind != "utterance" and not turn.spoke and now - turn.last > 1.5:
                return "quiet"
            if now > deadline:
                return "timeout"
            time.sleep(0.02)

    def _run(self, kind: str, message: Any, timeout: float, session_id: str) -> dict:
        if self.croft is None:
            raise RuntimeError("the skill is not running: it did not start")
        with self.turn_lock:
            turn = Turn(kind, quiet_after_speech=0.6)
            self.turn = turn
            # A handler may block in get_response() until the next utterance,
            # so the emit happens off this thread and the next request is read.
            threading.Thread(target=self.croft.bus.emit, args=(message,), daemon=True).start()
            try:
                ended = self._watch(turn, timeout)
            finally:
                self.turn = None
        return self._summary(turn, ended, session_id)

    # -- what a turn produced --

    def _reply(self, message: Any) -> dict:
        data = message.data or {}
        meta = data.get("meta") or {}
        return {
            "utterance": data.get("utterance", ""),
            "ssml": data.get("utterance_ssml"),
            "written": data.get("utterance_written"),
            "expect_response": bool(data.get("expect_response")),
            "lang": data.get("lang"),
            "dialog": meta.get("dialog"),
            "skill": meta.get("skill"),
            "display": meta.get("display"),
            "schedule": meta.get("schedule"),
            "meta": _trim({k: v for k, v in meta.items() if k not in ("display",)}),
        }

    def _entry(self, message: Any) -> dict:
        context = message.context or {}
        session = context.get("session") if isinstance(context.get("session"), dict) else {}
        return {"type": message.msg_type, "data": _trim(message.data or {}),
                "session": (session or {}).get("session_id"),
                "context": _trim({k: v for k, v in context.items() if k != "session"})}

    def _summary(self, turn: Turn, ended: str, session_id: str) -> dict:
        own = self.info.get("skill_id")
        route: dict[str, Any] = {"matched": False}
        replies, sounds, errors = [], [], []
        newest_session = None
        for message in turn.messages:
            kind, data = message.msg_type, message.data or {}
            if kind == "ovos.intent.matched" and not route["matched"]:
                intent = data.get("intent_name") or ""
                route = {"matched": True, "skill_id": data.get("skill_id"),
                         "intent": intent, "label": _intent_label(intent),
                         "own": data.get("skill_id") == own,
                         "pipeline": data.get("pipeline") or data.get("match_type")}
            elif kind in ("ovos.intent.unmatched", "complete_intent_failure") and not route["matched"]:
                route = {"matched": False, "unmatched": True}
            elif kind == "mycroft.skill.handler.start":
                route.setdefault("handler", data.get("handler") or data.get("name"))
            elif kind.endswith(".response") and data.get("fallback_handler"):
                route["handler"] = data.get("fallback_handler")
            elif kind == "mycroft.skill.handler.complete" and data.get("exception"):
                errors.append({"handler": data.get("handler"), "exception": str(data["exception"])})
            elif kind == "mycroft.skill.handler.error":
                errors.append({"handler": data.get("name"), "exception": str(data.get("exception"))})
            if kind in ("ovos.audio.queue", "mycroft.audio.queue",
                        "ovos.audio.play_sound", "mycroft.audio.play_sound"):
                sounds.append({"uri": data.get("uri"),
                               "bytes": len(data["binary_data"]) // 2 if data.get("binary_data") else None,
                               "type": kind})
            context = message.context or {}
            carrier = context.get("session")
            if isinstance(carrier, dict) and carrier.get("session_id") == session_id:
                newest_session = carrier
        canonical = any(m.msg_type == "ovos.utterance.speak" for m in turn.messages)
        for message in turn.messages:
            if message.msg_type == ("ovos.utterance.speak" if canonical else "speak"):
                replies.append(self._reply(message))
        if newest_session is not None:
            from ovos_bus_client.session import Session

            self.sessions[session_id] = Session.deserialize(newest_session)
        tracebacks = [e["traceback"] for e in turn.logs if e.get("traceback")]
        for error in errors:
            if tracebacks and "traceback" not in error:
                error["traceback"] = tracebacks.pop(0)
        return {
            "ended": ended, "ms": round((time.monotonic() - turn.started) * 1000, 1),
            "route": route, "replies": replies, "sounds": sounds, "errors": errors,
            "logs": turn.logs[-200:], "waiting_for_answer": ended == "asked",
            "messages": [self._entry(m) for m in turn.messages],
        }

    # -- requests --

    def _session(self, request: dict) -> tuple[Any, str]:
        from ovos_bus_client.session import Session

        session_id = request.get("session") or "vscode"
        lang = request.get("lang") or self.default_lang
        session = self.sessions.get(session_id)
        if session is None or request.get("fresh"):
            session = Session(session_id, lang=lang)
            self.sessions[session_id] = session
        session.lang = lang
        return session, session_id

    def _context(self, request: dict, session: Any) -> dict:
        context = {"session": session.serialize(), "source": "vscode", "destination": "skills",
                   "client_name": "thalovant-vscode"}
        if request.get("location"):
            context["location"] = request["location"]
        if request.get("context"):
            context.update(request["context"])
        return context

    def utter(self, request: dict) -> dict:
        from ovos_bus_client.message import Message

        session, session_id = self._session(request)
        text = str(request.get("text") or "").strip()
        if not text:
            raise ValueError("nothing to say")
        message = Message("recognizer_loop:utterance",
                          {"utterances": [text], "lang": session.lang},
                          self._context(request, session))
        return self._run("utterance", message, float(request.get("timeout") or 20), session_id)

    def tap(self, request: dict) -> dict:
        from ovos_bus_client.message import Message

        session, session_id = self._session(request)
        message = Message("thalovant.display.action", {
            "card": request.get("card") or "", "action": request.get("action") or "",
            "skill": request.get("skill") or self.info.get("skill_id"), "at": time.time(),
        }, self._context(request, session))
        return self._run("tap", message, float(request.get("timeout") or 10), session_id)

    def emit(self, request: dict) -> dict:
        """Any bus message, for what no button covers (a stop, a GUI event...)."""
        from ovos_bus_client.message import Message

        session, session_id = self._session(request)
        message = Message(request["type"], request.get("data") or {},
                          self._context(request, session))
        return self._run("emit", message, float(request.get("timeout") or 10), session_id)

    def golden(self, request: dict) -> dict:
        """Golden rows: does each sentence reach this skill (and the intent)?"""
        results = []
        for index, row in enumerate(request.get("rows") or []):
            lang = row.get("lang") or self.default_lang
            try:
                turn = self.utter({"text": row.get("utterance", ""), "lang": lang,
                                   "session": f"golden-{uuid.uuid4().hex[:8]}", "fresh": True,
                                   "timeout": float(request.get("timeout") or 15)})
            except Exception as error:  # noqa: BLE001
                results.append({"index": index, "passed": False, "reason": str(error)})
                continue
            results.append({"index": index, **judge(row, turn, self.info.get("skill_id"))})
        return {"results": results}

    def check(self, request: dict) -> dict:
        from thalovant_skillkit.checks import check_all

        root = Path(request.get("root") or self.root)
        return {"problems": check_all(root)}

    def preview(self, request: dict) -> dict:
        skill = self._skill()
        if skill is None or not hasattr(skill, "preview_reply"):
            return {"text": None}
        return {"text": skill.preview_reply(request.get("text", ""), request.get("lang"))}


class SkillLoadError(RuntimeError):
    """OVOS could not load the skill; the message is OVOS's reason."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(reason)
        self.detail = detail


_LOAD_FAILED = re.compile(r"initialization failed: |Skill loading failed with |failed to load")


def _load_failure(logs: list[dict], skill_id: str) -> tuple[str, str] | None:
    """The first reason OVOS logged for not loading this skill, with its traceback."""
    errors = [e for e in logs if e["level"] in ("ERROR", "CRITICAL")]
    if not any(_LOAD_FAILED.search(e["text"]) for e in errors):
        return None
    for entry in errors:
        text = entry["text"]
        if _LOAD_FAILED.search(text) and text.rstrip().endswith("failed to load") and len(errors) > 1:
            continue
        reason = _LOAD_FAILED.split(text, maxsplit=1)[-1].strip() or text
        return (f"{skill_id} did not load: {reason}", entry.get("traceback") or "")
    return (f"{skill_id} did not load", "")


def _intent_label(intent: str) -> str:
    """`skill_id:weather.intent` -> `weather.intent`; fallback ids stay readable."""
    if ":" in intent:
        return intent.split(":", 1)[1]
    if intent.endswith(".converse.get_response"):
        return "answer to get_response"
    if intent.endswith((".converse.request", ".converse")):
        return "converse"
    if intent.startswith("ovos.skills.fallback.") and intent.endswith(".request"):
        return "fallback"
    return intent


def judge(row: dict, turn: dict, own: str | None) -> dict:
    """The verdict on one golden row, the way the fleet's suites read it."""
    route = turn["route"]
    expected_skill = row.get("skill_id") or own
    negative = bool(row.get("negative")) or row.get("expected") == "unmatched"
    if negative:
        passed = not (route.get("matched") and route.get("skill_id") == expected_skill)
        reason = "" if passed else f"{expected_skill} took it, and should not"
        return {"passed": passed, "reason": reason, "route": route,
                "spoken": [r["utterance"] for r in turn["replies"]], "ms": turn["ms"]}
    if turn["ended"] == "timeout":
        return {"passed": False, "reason": "timed out", "route": route,
                "spoken": [r["utterance"] for r in turn["replies"]], "ms": turn["ms"]}
    if not route.get("matched"):
        return {"passed": False, "reason": "nobody answered (intent unmatched)", "route": route,
                "spoken": [], "ms": turn["ms"]}
    if route.get("skill_id") != expected_skill:
        return {"passed": False, "reason": f"{route.get('skill_id')} took it "
                f"({route.get('label')})", "route": route,
                "spoken": [r["utterance"] for r in turn["replies"]], "ms": turn["ms"]}
    label = row.get("intent_label") or row.get("intent")
    if label and not _same_intent(label, route.get("label") or ""):
        return {"passed": False, "reason": f"reached the skill, but as {route.get('label')}, "
                f"not {label}", "route": route,
                "spoken": [r["utterance"] for r in turn["replies"]], "ms": turn["ms"]}
    expected = row.get("expected_messages") or []
    seen = {m["type"] for m in turn["messages"]}
    missing = [t for t in expected if t not in seen
               and not (t == "speak" and "ovos.utterance.speak" in seen)]
    if missing:
        return {"passed": False, "reason": f"no {', '.join(missing)} on the bus", "route": route,
                "spoken": [r["utterance"] for r in turn["replies"]], "ms": turn["ms"]}
    return {"passed": True, "reason": "", "route": route,
            "spoken": [r["utterance"] for r in turn["replies"]], "ms": turn["ms"]}


def _same_intent(expected: str, got: str) -> bool:
    def bare(name: str) -> str:
        name = name.split(":", 1)[-1]
        for suffix in (".intent", ".voc"):
            name = name.removesuffix(suffix)
        return name.lower()

    return bare(expected) == bare(got) or got.endswith(expected)


# -- the loop ----------------------------------------------------------------------------------

def _serve(runner: Runner, request: dict) -> None:
    op = request.get("op")
    handler = getattr(runner, op, None) if isinstance(op, str) and not op.startswith("_") else None
    if handler is None:
        _send({"id": request.get("id"), "ok": False, "error": f"unknown op {op!r}"})
        return
    try:
        _send({"id": request.get("id"), "ok": True, "result": handler(request)})
    except SkillLoadError as error:
        _send({"id": request.get("id"), "ok": False, "error": str(error), "kind": "load",
               "detail": error.detail[-12000:]})
    except Exception as error:  # noqa: BLE001 - every failure is reported, the runner lives
        _send({"id": request.get("id"), "ok": False, "error": f"{type(error).__name__}: {error}",
               "kind": "import" if isinstance(error, ImportError) else "error",
               "detail": traceback.format_exc()[-12000:]})


def main() -> int:
    runner = Runner()
    in_flight: list[threading.Thread] = []
    event("ready", protocol=PROTOCOL, pid=os.getpid())
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            _send({"id": None, "ok": False, "error": f"bad request: {error}"})
            continue
        if request.get("op") == "exit":
            break
        if request.get("op") in ("utter", "tap", "emit", "golden"):
            # Off the reading thread: an answer to a question the skill asked
            # arrives as the next request while the first handler still waits.
            worker = threading.Thread(target=_serve, args=(runner, request), daemon=True)
            worker.start()
            in_flight[:] = [t for t in in_flight if t.is_alive()] + [worker]
        else:
            _serve(runner, request)
    for worker in in_flight:
        worker.join(timeout=30)
    try:
        runner.stop({})
    except Exception:  # noqa: BLE001
        traceback.print_exc()
    # OVOS leaves non-daemon threads behind; the extension wants this process gone.
    os._exit(0)


if __name__ == "__main__":
    sys.exit(main())
