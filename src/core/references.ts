// Where Python code names a locale resource, and which kind of resource it is.
//
// A light reader, not a Python parser: it finds calls such as
// `self.speak_dialog("water.fern")` and the string literal the cursor sits in.
// It is deliberately conservative: a name built at runtime (an f-string, a
// variable) is never reported as missing.
import type { ResourceKind } from "./skill";

export interface CallRule {
  /** Which argument (0-based) holds the resource name; -1 for any string argument. */
  arg: number;
  kinds: ResourceKind[];
  /** The intent decorators and register calls name the file, suffix included. */
  label: string;
}

/** Method names that take a resource name, from ovos-workshop and the kit. */
export const CALLS: Record<string, CallRule> = {
  speak_dialog: { arg: 0, kinds: ["dialog"], label: "dialog" },
  speak_varied_dialog: { arg: 0, kinds: ["dialog"], label: "dialog" },
  dialog: { arg: 0, kinds: ["dialog"], label: "dialog" },
  get_response: { arg: 0, kinds: ["dialog"], label: "dialog" },
  ask_yesno: { arg: 0, kinds: ["dialog"], label: "dialog" },
  ask_selection: { arg: 1, kinds: ["dialog"], label: "dialog" },
  translate: { arg: 0, kinds: ["dialog"], label: "dialog" },
  translate_list: { arg: 0, kinds: ["dialog"], label: "dialog" },
  mentions: { arg: 1, kinds: ["vocab"], label: "vocabulary" },
  mentioned_term: { arg: 1, kinds: ["vocab"], label: "vocabulary" },
  voc_match: { arg: 1, kinds: ["vocab"], label: "vocabulary" },
  voc_list: { arg: 0, kinds: ["vocab"], label: "vocabulary" },
  remove_voc: { arg: 1, kinds: ["vocab"], label: "vocabulary" },
  intent_handler: { arg: 0, kinds: ["intent"], label: "intent" },
  intent_file_handler: { arg: 0, kinds: ["intent"], label: "intent" },
  register_intent_file: { arg: 0, kinds: ["intent"], label: "intent" },
  register_intent: { arg: 0, kinds: ["intent"], label: "intent" },
  register_entity_file: { arg: 0, kinds: ["entity"], label: "entity" },
  layout_file: { arg: 1, kinds: [], label: "layout" },
  // IntentBuilder("name").require("WaterKeyword") names vocabulary.
  require: { arg: 0, kinds: ["vocab"], label: "vocabulary" },
  optionally: { arg: 0, kinds: ["vocab"], label: "vocabulary" },
  one_of: { arg: -1, kinds: ["vocab"], label: "vocabulary" },
  exclude: { arg: 0, kinds: ["vocab"], label: "vocabulary" },
};

export interface StringArg {
  call: string;
  rule: CallRule;
  argIndex: number;
  /** The literal's text, without quotes. */
  value: string;
  /** Offsets of the text inside the quotes. */
  start: number;
  end: number;
  /** False for a literal that is still being typed (no closing quote yet). */
  closed: boolean;
}

/** The resource-naming string argument at `offset`, if the cursor is in one. */
export function stringArgAt(text: string, offset: number): StringArg | undefined {
  // Find the literal the offset sits in, on this line.
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lineEndRaw = text.indexOf("\n", offset);
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
  const line = text.slice(lineStart, lineEnd);
  const col = offset - lineStart;
  let quote: string | undefined;
  let open = -1;
  for (let i = 0; i < col; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
    } else if (c === "#") {
      return undefined;
    } else if (c === '"' || c === "'") {
      // An f-string, raw or byte prefix: only plain literals name resources.
      const prefix = line.slice(Math.max(0, i - 1), i);
      if (/[A-Za-z]/.test(prefix) && !/[rR]/.test(prefix)) {
        quote = c;
        open = -2;
        continue;
      }
      quote = c;
      open = i;
    }
  }
  if (!quote || open < 0) return undefined;
  const close = line.indexOf(quote, col);
  const start = lineStart + open + 1;
  const end = close < 0 ? lineStart + col : lineStart + close;
  const call = enclosingCall(text, lineStart + open);
  if (!call) return undefined;
  const rule = CALLS[call.name];
  if (!rule) return undefined;
  if (rule.arg >= 0 && call.argIndex !== rule.arg) return undefined;
  return { call: call.name, rule, argIndex: call.argIndex, value: text.slice(start, end), start, end, closed: close >= 0 };
}

/** The call whose argument list contains `offset`, and which argument it is. */
export function enclosingCall(text: string, offset: number): { name: string; argIndex: number } | undefined {
  let depth = 0;
  let argIndex = 0;
  let quote: string | undefined;
  // Walk back; good enough for the one or two lines a call spans.
  for (let i = offset - 1, steps = 0; i >= 0 && steps < 2000; i--, steps++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = undefined;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "[" || c === "{") {
      if (depth === 0) return undefined;
      depth--;
    } else if (c === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const before = text.slice(Math.max(0, i - 80), i);
      const m = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(before);
      return m ? { name: m[1], argIndex } : undefined;
    } else if (c === "," && depth === 0) {
      argIndex++;
    }
  }
  return undefined;
}

/** Every resource-naming literal in a Python file. */
export function references(text: string): StringArg[] {
  const out: StringArg[] = [];
  const pattern = /(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text))) {
    // Skip f/b/u-prefixed literals and triple-quoted docstrings.
    const prefix = text[m.index - 1] ?? "";
    if (/[A-Za-z]/.test(prefix) && !/[rR]/.test(prefix)) continue;
    if (text.slice(m.index, m.index + 3) === m[1].repeat(3)) {
      const close = text.indexOf(m[1].repeat(3), m.index + 3);
      pattern.lastIndex = close < 0 ? text.length : close + 3;
      continue;
    }
    if (isInComment(text, m.index)) continue;
    const found = stringArgAt(text, m.index + 1);
    if (found && found.closed && found.value && !found.value.includes("{")) out.push(found);
  }
  return out;
}

function isInComment(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  let quote: string | undefined;
  for (let i = lineStart; i < offset; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return true;
  }
  return false;
}

/**
 * The name as the locale tree spells it, or undefined when the literal does not
 * name a file: `intent_handler("Water")` names an Adapt intent built in code.
 */
export function resourceKey(arg: StringArg): string | undefined {
  if (arg.rule.kinds.includes("intent")) {
    if (arg.value.endsWith(".intent")) return arg.value;
    return arg.call === "intent_file_handler" || arg.call === "register_intent_file" ? `${arg.value}.intent` : undefined;
  }
  if (arg.rule.kinds.includes("entity")) return arg.value.endsWith(".entity") ? arg.value : `${arg.value}.entity`;
  return arg.value;
}

/** IntentBuilder's chain methods are ordinary words; trust them only beside IntentBuilder. */
export const BUILDER_CALLS = new Set(["require", "optionally", "one_of", "exclude"]);
