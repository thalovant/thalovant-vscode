// The simulator's page. Plain DOM, no framework; every string from the skill
// goes in through textContent, never as HTML.
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const state = {
    skill: {},
    turns: [],
    lang: undefined,
    location: undefined,
    settings: {},
    bus: [],
    screen: null, // { card, skill, shownAt, turnId }
    screenOpen: saved.screenOpen !== false,
    history: saved.history || [],
    historyIndex: -1,
    open: new Set(), // expanded detail panes: `${turnId}:${pane}`
  };

  const WEATHER = { clear: "☀️", "clear-night": "🌙", partly: "⛅", cloudy: "☁️", fog: "🌫️", drizzle: "🌦️", rain: "🌧️", showers: "🌦️", snow: "❄️", sleet: "🌨️", storm: "⛈️", wind: "💨" };
  const ICONS = { drop: "💧", water: "💧", sun: "☀️", timer: "⏱️", alarm: "⏰", music: "🎵", check: "✓", warning: "⚠️", calendar: "📅", home: "🏠", light: "💡", ...WEATHER };

  // -- tiny DOM helper --
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
      else if (key === "text") el.textContent = value;
      else el.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  /** Element.append writes "null" for a null child; this skips the absent ones. */
  function add(el, ...children) {
    for (const child of children.flat()) if (child !== undefined && child !== null && child !== false) el.append(child);
    return el;
  }

  const app = document.getElementById("app");
  const header = h("header", { class: "bar" });
  const screenBox = h("section", { class: "screen-box" });
  const log = h("main", { class: "conversation", "aria-live": "polite" });
  const suggestionsBox = h("div", { class: "suggestions" });
  const langSelect = h("select", { class: "lang", title: "The language the sentence is in", onchange: () => { state.lang = langSelect.value; vscode.postMessage({ type: "lang", lang: state.lang }); renderSuggestions(); } });
  const input = h("input", { class: "say", type: "text", spellcheck: "false", autocomplete: "off" });
  const send = h("button", { class: "send", title: "Say it (Enter)", text: "Say" });
  const form = h("form", { class: "composer", onsubmit: (e) => { e.preventDefault(); submit(); } }, langSelect, input, send);
  app.append(header, screenBox, log, h("footer", {}, suggestionsBox, form));

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" && state.history.length) {
      state.historyIndex = Math.min(state.history.length - 1, state.historyIndex + 1);
      input.value = state.history[state.history.length - 1 - state.historyIndex];
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      state.historyIndex = Math.max(-1, state.historyIndex - 1);
      input.value = state.historyIndex < 0 ? "" : state.history[state.history.length - 1 - state.historyIndex];
      e.preventDefault();
    }
  });

  function submit(text) {
    const value = (text !== undefined ? text : input.value).trim();
    if (!value) return;
    vscode.postMessage({ type: "say", text: value, lang: state.lang });
    state.history = state.history.filter((x) => x !== value).concat(value).slice(-50);
    state.historyIndex = -1;
    persist();
    if (text === undefined) input.value = "";
    input.focus();
  }

  function persist() {
    vscode.setState({ screenOpen: state.screenOpen, history: state.history });
  }

  // -- header --
  function renderHeader() {
    const s = state.skill;
    const info = s.info || {};
    const status = { ready: "Running", starting: "Starting…", failed: "Not running", stopped: "Stopped" }[s.state] || s.state;
    const picker = (s.skills || []).length > 1
      ? h("select", { class: "skill-picker", title: "Which skill the simulator runs", onchange: (e) => vscode.postMessage({ type: "switch", root: e.target.value }) },
        s.skills.map((k) => h("option", { value: k.root, selected: k.root === s.root ? true : undefined, text: k.title })))
      : h("strong", { class: "title", text: s.title || "Thalovant" });
    const details = s.state === "ready"
      ? [info.class, kindLabel(info.base, info.fallback_priority), `booted in ${info.boot_seconds}s`].filter(Boolean).join(" · ")
      : s.state === "starting" ? (s.reason && s.reason !== "start" ? s.reason : "starting OVOS") : "";
    header.replaceChildren(
      h("div", { class: "who" }, picker, h("span", { class: `dot ${s.state}`, title: status }), h("span", { class: "status", text: status }), h("span", { class: "details", text: details })),
      h("div", { class: "tools" },
        locationPicker(),
        h("button", { class: "icon", title: "Stop what the skill is doing (says “stop”)", onclick: () => vscode.postMessage({ type: "stop" }), text: "■" }),
        h("button", { class: "icon", title: "Restart the skill", onclick: () => vscode.postMessage({ type: "restart" }), text: "↻" }),
        h("button", { class: "icon", title: "Clear the conversation", onclick: () => vscode.postMessage({ type: "clear" }), text: "⌫" }),
        h("button", { class: "icon", title: "The skill's log", onclick: () => vscode.postMessage({ type: "log" }), text: "≡" }),
        h("button", { class: "icon", title: "Simulator settings", onclick: () => vscode.postMessage({ type: "settings" }), text: "⚙" }),
      ),
    );
    if (s.state === "ready" && (info.adapt_intents || []).length && !info.adapt_runs) {
      add(header, h("div", { class: "adapt-warning" },
        h("strong", { text: "Paired hubs don't run Adapt. " }),
        h("span", { text: `These intents never answer there: ${info.adapt_intents.join(", ")}. Rewrite them as .intent files, or set thalovant.simulator.pipeline to “unpaired” if the skill is only for unpaired runtimes.` })));
    }
    if (s.state === "failed" && s.failure) {
      const fixLabel = { setup: "Set up the environment", python: "Choose a Python", trust: "Trust the workspace", check: "Check the skill" }[s.failure.fix];
      add(header, h("div", { class: "failure" },
        h("div", { class: "failure-text", text: s.failure.message }),
        s.failure.detail ? h("details", {}, h("summary", { text: "Details" }), h("pre", { text: s.failure.detail })) : null,
        h("div", { class: "failure-actions" },
          fixLabel ? h("button", { onclick: () => vscode.postMessage({ type: "fix", fix: s.failure.fix }), text: fixLabel }) : null,
          h("button", { class: "secondary", onclick: () => vscode.postMessage({ type: "restart" }), text: "Try again" }),
          h("button", { class: "secondary", onclick: () => vscode.postMessage({ type: "log" }), text: "Open the log" }))));
    }
    const name = s.title || "the skill";
    const waiting = lastTurn() && lastTurn().result && lastTurn().result.waiting_for_answer;
    input.placeholder = waiting ? `${name} is waiting for your answer…` : `Say something to ${name}…`;
    form.classList.toggle("waiting", !!waiting);
    const langs = s.langs || [];
    const current = state.lang || (info.lang) || langs[0];
    langSelect.replaceChildren(...langs.map((l) => h("option", { value: l, selected: l === current ? true : undefined, text: l })));
    langSelect.hidden = langs.length < 2;
  }

  function kindLabel(base, priority) {
    if (!base) return "";
    const name = base.replace(/^Thalovant/, "").replace(/Skill$/, "") || "Skill";
    const label = { "": "skill", Fallback: "fallback", Conversational: "conversational", ConversationalFallback: "conversational fallback" }[name] || name.toLowerCase();
    return priority ? `${label} at ${priority}` : label;
  }

  function locationPicker() {
    const names = (state.settings.locations || []);
    return h("select", { class: "location", title: "Where the speaker is (the location sent with each sentence)", onchange: (e) => { state.location = e.target.value; vscode.postMessage({ type: "location", location: state.location }); } },
      h("option", { value: "", text: "📍 settings", selected: !state.location ? true : undefined }),
      names.map((n) => h("option", { value: n, text: `📍 ${n}`, selected: state.location === n ? true : undefined })));
  }

  // -- the screen --
  function renderScreen() {
    const shown = state.screen;
    const toggle = h("button", { class: "screen-toggle", onclick: () => { state.screenOpen = !state.screenOpen; persist(); renderScreen(); } },
      h("span", { text: state.screenOpen ? "▾" : "▸" }), " Screen", shown ? h("span", { class: "muted", text: ` · ${shown.card.kind}${shown.card.layout ? " " + shown.card.layout.name : ""}` }) : h("span", { class: "muted", text: " · nothing shown" }));
    if (!state.screenOpen) {
      screenBox.replaceChildren(toggle);
      return;
    }
    const frame = h("div", { class: `device ${shown && shown.card.fullscreen ? "fullscreen" : ""}` });
    if (!(shown && shown.card.fullscreen)) add(frame, h("div", { class: "device-top" }, h("span", { text: shown ? (shown.skillTitle || "") : "" }), h("span", { class: "clock", text: clock() })));
    add(frame, shown ? cardView(shown.card, shown.skill, true) : h("div", { class: "idle" }, h("div", { class: "idle-time", text: clock() }), h("div", { class: "muted", text: "A card the skill shows appears here." })));
    screenBox.replaceChildren(toggle, frame);
  }

  function clock() {
    const d = new Date();
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function cardView(card, skill, live) {
    const box = h("div", { class: `card card-${card.kind}` });
    const actions = (card.actions || []).map((a) => h("button", {
      class: "card-action", disabled: live ? undefined : true, title: live ? `Tap: sends ${a.id}` : "Tap it on the screen above",
      onclick: () => live && vscode.postMessage({ type: "tap", card: card.id || "", action: a.id, skill, label: a.label }),
      text: a.label,
    }));
    if (card.kind === "weather") {
      const f = card.figures || {};
      const unit = f.unit || "";
      add(box, 
        h("div", { class: "card-title", text: card.title }),
        h("div", { class: "weather-now" },
          h("span", { class: "weather-icon", text: WEATHER[card.icon] || "" }),
          f.temperature !== undefined ? h("span", { class: "weather-temp", text: `${f.temperature}${unit}` }) : null,
          h("div", { class: "weather-side" },
            card.body ? h("div", { text: card.body }) : null,
            (f.high !== undefined || f.low !== undefined) ? h("div", { class: "muted", text: [f.high !== undefined && `↑ ${f.high}${unit}`, f.low !== undefined && `↓ ${f.low}${unit}`].filter(Boolean).join("  ") }) : null,
            h("div", { class: "muted", text: [f.feels_like !== undefined && `feels ${f.feels_like}${unit}`, f.wind !== undefined && `wind ${f.wind}`, f.humidity !== undefined && `humidity ${f.humidity}`, f.precipitation !== undefined && `rain ${f.precipitation}`].filter(Boolean).join(" · ") }))),
        (card.items || []).length ? h("div", { class: "weather-days" }, card.items.map((d) => h("div", { class: "day" }, h("div", { class: "muted", text: d.label }), h("div", { text: ICONS[d.icon] || "" }), h("div", { text: d.value || "" })))) : null,
      );
    } else if (card.kind === "list") {
      add(box, card.title ? h("div", { class: "card-title", text: card.title }) : null, card.subtitle ? h("div", { class: "card-subtitle", text: card.subtitle }) : null,
        h("ul", { class: "card-list" }, (card.items || []).map((i) => h("li", {}, h("span", { class: "item-icon", text: ICONS[i.icon] || (i.icon ? "•" : "") }), h("span", { class: "item-label", text: i.label }), h("span", { class: "item-value", text: i.value || "" })))));
    } else if (card.kind === "media") {
      add(box, card.title ? h("div", { class: "card-title", text: card.title }) : null,
        card.image ? h("img", { class: "card-image", alt: card.title || "", src: `data:${card.image.mime};base64,${card.image.data}` }) : null,
        card.body ? h("div", { class: "card-body", text: card.body }) : null);
    } else if (card.kind === "layout") {
      // The satellite draws an RFW layout with its own widget library; this
      // page cannot, so it shows what a screen that cannot draw it shows,
      // and the data bound to it.
      add(box, 
        h("div", { class: "layout-note" }, h("span", { class: "badge", text: `layout ${card.layout ? card.layout.name : ""}` }), h("span", { class: "muted", text: "drawn by the satellite; shown here as its fallback text" })),
        card.title ? h("div", { class: "card-title", text: card.title }) : null,
        card.body ? h("div", { class: "card-body", text: card.body }) : null,
        card.data && Object.keys(card.data).length ? h("details", { class: "layout-data" }, h("summary", { text: "data" }), h("pre", { text: JSON.stringify(card.data, null, 2) })) : null,
        card.image ? h("img", { class: "card-image", alt: "", src: `data:${card.image.mime};base64,${card.image.data}` }) : null,
      );
    } else if (card.kind === "clear") {
      add(box, h("div", { class: "muted", text: card.skill ? `clears ${card.skill}'s cards` : "clears the screen" }));
    } else {
      add(box, card.title ? h("div", { class: "card-title", text: card.title }) : null, card.subtitle ? h("div", { class: "card-subtitle", text: card.subtitle }) : null, card.body ? h("div", { class: "card-body", text: card.body }) : null);
    }
    if (actions.length) add(box, h("div", { class: "card-actions" }, actions));
    return box;
  }

  /** What the screen shows after this turn, as a satellite would apply it. */
  function applyToScreen(turn) {
    if (!turn.result) return;
    for (const reply of turn.result.replies) {
      const card = reply.display;
      if (!card) continue;
      if (card.kind === "clear") {
        if (!card.skill || (state.screen && state.screen.skill === card.skill)) state.screen = null;
      } else {
        state.screen = { card, skill: reply.skill, skillTitle: state.skill.title, shownAt: Date.now(), turnId: turn.id };
        const ttl = card.ttl === undefined ? 120 : card.ttl;
        if (ttl) {
          const shown = state.screen;
          setTimeout(() => { if (state.screen === shown) { state.screen = null; renderScreen(); } }, ttl * 1000);
        }
      }
    }
  }

  // -- the conversation --
  function lastTurn() {
    return state.turns[state.turns.length - 1];
  }

  function renderTurns() {
    const keep = log.scrollTop;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.replaceChildren(...(state.turns.length ? state.turns.map(turnView) : [emptyView()]));
    // Follow new turns; stay put while someone reads an expanded log higher up.
    log.scrollTop = atBottom || lastTurn()?.pending ? log.scrollHeight : keep;
  }

  function emptyView() {
    const s = state.skill;
    return h("div", { class: "empty" },
      h("div", { class: "empty-title", text: s.state === "ready" ? `${s.title} is listening.` : s.state === "failed" ? "The skill is not running." : "Starting the skill…" }),
      h("div", { class: "muted", text: "Type what someone would say. Replies show what is spoken, what an app writes and what a screen shows; saving a skill file restarts it here." }));
  }

  function turnView(turn) {
    if (turn.kind === "notice") return h("div", { class: "notice", text: `↻ ${turn.text}` });
    const el = h("article", { class: `turn ${turn.pending ? "pending" : ""}` });
    if (turn.kind === "say") add(el, h("div", { class: "you" }, h("div", { class: "bubble you-bubble", text: turn.text }), turn.lang ? h("span", { class: "lang-tag", text: turn.lang }) : null));
    if (turn.kind === "tap") add(el, h("div", { class: "you" }, h("div", { class: "bubble tap-bubble" }, h("span", { class: "muted", text: "tapped " }), turn.text)));
    if (turn.kind === "event") add(el, h("div", { class: "muted small", text: "said by itself (a timer, an event, a schedule)" }));
    if (turn.pending) {
      add(el, h("div", { class: "thinking" }, h("span"), h("span"), h("span")));
      return el;
    }
    if (turn.error) {
      add(el, h("div", { class: "error" }, h("div", { text: turn.error.message }), turn.error.detail ? h("details", {}, h("summary", { text: "Details" }), h("pre", { text: turn.error.detail })) : null));
      return el;
    }
    const r = turn.result;
    if (turn.kind !== "event") add(el, routeView(turn));
    for (const reply of r.replies) add(el, replyView(reply, turn));
    for (const sound of r.sounds) add(el, h("div", { class: "sound" }, "♪ ", h("span", { text: sound.uri || `${sound.bytes} bytes of audio` })));
    for (const error of r.errors) {
      add(el, h("div", { class: "error" },
        h("div", { class: "error-title", text: `${error.handler || "the skill"} raised ${error.exception || "an error"}` }),
        turn.where ? h("a", { href: "#", onclick: (e) => { e.preventDefault(); vscode.postMessage({ type: "open", file: turn.where.file, line: turn.where.line }); }, text: `Open ${turn.where.label}` }) : null,
        error.traceback ? h("details", {}, h("summary", { text: "Traceback" }), h("pre", { text: error.traceback })) : null));
    }
    if (r.ended === "timeout") add(el, h("div", { class: "warning", text: `No end to this turn after ${Math.round(r.ms / 1000)} s: a handler may be blocked (a get_response without an answer, a network call).` }));
    add(el, detailsView(turn));
    return el;
  }

  function routeView(turn) {
    const r = turn.result;
    const route = r.route || {};
    const ms = `${Math.round(r.ms)} ms`;
    if (turn.kind === "tap") {
      return h("div", { class: "route" }, h("span", { class: r.replies.length ? "ok" : "warn", text: r.replies.length ? "✓" : "∅" }), h("span", { text: r.replies.length ? "the skill answered the tap" : "nothing answered the tap" }), h("span", { class: "muted", text: ms }));
    }
    if (!route.matched) {
      return h("div", { class: "route" }, h("span", { class: "warn", text: "∅" }), h("span", { text: "Nobody answered: no intent matched and no fallback skill said yes." }), h("span", { class: "muted", text: ms }));
    }
    const parts = [h("span", { class: route.own ? "ok" : "bad", text: route.own ? "✓" : "✗" })];
    if (!route.own) parts.push(h("span", { text: `${route.skill_id} took it` }));
    parts.push(h("span", { class: "intent", text: route.label === "fallback" ? "fallback" : route.label || route.intent }));
    if (route.handler) parts.push(h("span", { class: "handler", text: `→ ${route.handler}` }));
    parts.push(h("span", { class: "muted", text: ms }));
    return h("div", { class: "route" }, parts);
  }

  function replyView(reply, turn) {
    const box = h("div", { class: "reply" });
    const spoken = h("div", { class: "bubble skill-bubble" }, h("span", { class: "channel", title: "What the speaker says", text: "🔊" }), h("span", { text: reply.utterance || "(nothing)" }));
    add(box, spoken);
    const extras = h("div", { class: "reply-extras" });
    if (reply.written && reply.written !== reply.utterance) add(extras, h("div", { class: "channel-row" }, h("span", { class: "channel", title: "What an app or a screen writes", text: "✎" }), h("span", { class: "written", text: reply.written })));
    if (reply.ssml) add(extras, h("details", { class: "channel-row ssml" }, h("summary", {}, h("span", { class: "channel", text: "‹›" }), " SSML"), h("pre", {}, ssmlView(reply.ssml))));
    if (reply.display) {
      add(extras, h("div", { class: "channel-row" }, h("span", { class: "channel", title: "What the screen shows", text: "▭" }),
        h("div", { class: "mini-card" }, cardView(reply.display, reply.skill, false))));
    }
    if (reply.expect_response) add(extras, h("div", { class: "listening", text: "● listening for an answer" }));
    if (reply.dialog) add(extras, h("div", { class: "muted small", text: `dialog ${reply.dialog}` }));
    if (extras.childNodes.length) add(box, extras);
    return box;
  }

  function ssmlView(ssml) {
    const frag = document.createDocumentFragment();
    for (const part of ssml.split(/(<[^>]+>)/)) {
      if (!part) continue;
      frag.append(part.startsWith("<") ? h("span", { class: "tag", text: part }) : document.createTextNode(part));
    }
    return frag;
  }

  function detailsView(turn) {
    const r = turn.result;
    const own = r.logs.filter((l) => l.own);
    const warnings = r.logs.filter((l) => !l.own && (l.level === "WARNING" || l.level === "ERROR" || l.level === "CRITICAL"));
    const toggle = (pane, label, count) => h("button", {
      class: `link ${state.open.has(`${turn.id}:${pane}`) ? "on" : ""}`,
      onclick: () => { const key = `${turn.id}:${pane}`; state.open.has(key) ? state.open.delete(key) : state.open.add(key); renderTurns(); },
      text: count === undefined ? label : `${label} (${count})`,
    });
    const bar = h("div", { class: "turn-tools" },
      r.logs.length ? toggle("logs", "Log", own.length + warnings.length) : null,
      r.messages.length ? toggle("bus", "Bus", r.messages.length) : null,
      turn.kind === "say" ? h("button", { class: "link", title: "Add this sentence to test/end2end/golden_utterances.jsonl", onclick: () => vscode.postMessage({ type: "golden", id: turn.id }), text: "Save as golden" }) : null,
      turn.kind === "say" && r.route && r.route.own ? h("button", { class: "link", title: "Save it as a sentence the skill must leave alone", onclick: () => vscode.postMessage({ type: "golden", id: turn.id, negative: true }), text: "Should not match" }) : null,
      turn.kind === "say" ? h("button", { class: "link", title: "Say it again", onclick: () => submit(turn.text), text: "Again" }) : null,
    );
    const panes = [];
    if (state.open.has(`${turn.id}:logs`)) {
      panes.push(h("div", { class: "pane" }, [...own, ...warnings].map((l) => h("div", { class: `logline ${l.level.toLowerCase()} ${l.own ? "own" : ""}` },
        h("span", { class: "level", text: l.level }), h("span", { class: "logger", text: l.own ? "★" : l.logger }), h("span", { text: l.text })))));
    }
    if (state.open.has(`${turn.id}:bus`)) {
      panes.push(h("div", { class: "pane" }, r.messages.map((m) => h("details", { class: "busline" }, h("summary", { text: m.type }), h("pre", { text: JSON.stringify(m.data, null, 2) })))));
    }
    return h("div", {}, bar, panes);
  }

  function renderSuggestions() {
    const all = state.skill.suggestions || {};
    const lang = state.lang || (state.skill.info && state.skill.info.lang) || (state.skill.langs || [])[0];
    const list = all[lang] || [];
    suggestionsBox.replaceChildren(...list.map((text) => h("button", { class: "chip", title: "Say this", onclick: () => submit(text), text })));
    suggestionsBox.hidden = list.length === 0;
  }

  function renderAll() {
    renderHeader();
    renderScreen();
    renderTurns();
    renderSuggestions();
  }

  // -- speech out --
  function speak(text, lang) {
    if (!("speechSynthesis" in window) || !text) return;
    const u = new SpeechSynthesisUtterance(text);
    if (lang) u.lang = lang;
    window.speechSynthesis.speak(u);
  }

  window.addEventListener("message", (event) => {
    const m = event.data;
    switch (m.type) {
      case "all":
        state.skill = m.skill || {};
        state.turns = m.turns || [];
        state.lang = m.lang;
        state.location = m.location;
        state.settings = m.settings || {};
        state.screen = null;
        for (const t of state.turns) applyToScreen(t);
        renderAll();
        break;
      case "skill":
        state.skill = m.skill || {};
        renderHeader();
        renderSuggestions();
        if (!state.turns.length) renderTurns();
        break;
      case "settings":
        state.settings = m.settings || {};
        renderHeader();
        break;
      case "turn": {
        const index = state.turns.findIndex((t) => t.id === m.turn.id);
        if (index >= 0) state.turns[index] = m.turn;
        else state.turns.push(m.turn);
        if (!m.turn.pending) applyToScreen(m.turn);
        renderTurns();
        renderScreen();
        renderHeader();
        break;
      }
      case "speak":
        speak(m.text, m.lang);
        break;
      case "bus":
        state.bus.push(m.message);
        if (state.bus.length > 200) state.bus.shift();
        break;
    }
  });

  setInterval(() => { const c = screenBox.querySelector(".clock"); if (c) c.textContent = clock(); }, 30000);
  renderAll();
  input.focus();
  vscode.postMessage({ type: "ready" });
})();
