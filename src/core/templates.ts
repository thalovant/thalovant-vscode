// Sentences an OVOS template stands for: `(water|watering) the [house] plants`.
//
// Used to offer a sentence to say (CodeLens, the simulator's suggestions) and
// to write golden rows. Slots stay as `{name}`, unless a sample is given.

/** Up to `limit` sentences the template line expands to, in reading order. */
export function expand(template: string, limit = 32, samples: Record<string, string> = {}): string[] {
  const results: string[] = [];
  const parsed = parse(template.trim());
  if (!parsed) return [];
  for (const sentence of combinations(parsed, limit)) {
    const filled = sentence.replace(/\{\s*([^{}\s]+)\s*\}/g, (all, name: string) => samples[name] ?? all);
    const clean = filled.replace(/\s+/g, " ").trim();
    if (clean && !results.includes(clean)) results.push(clean);
    if (results.length >= limit) break;
  }
  return results;
}

/** The first sentence with no slot left, else the first sentence. */
export function sayable(template: string, samples: Record<string, string> = {}): string | undefined {
  const all = expand(template, 64, samples);
  return all.find((s) => !/\{[^}]*\}/.test(s)) ?? all[0];
}

type Node = string | Node[][]; // text, or alternatives (each a sequence)

function parse(text: string): Node[] | undefined {
  let i = 0;
  const sequence = (closer?: string): Node[][] | undefined => {
    const alternatives: Node[][] = [[]];
    let buffer = "";
    const flush = () => {
      if (buffer) alternatives[alternatives.length - 1].push(buffer);
      buffer = "";
    };
    while (i < text.length) {
      const c = text[i];
      if (c === "(" || c === "[") {
        flush();
        i++;
        const inner = sequence(c === "(" ? ")" : "]");
        if (!inner) return undefined;
        if (c === "[") inner.push([]);
        alternatives[alternatives.length - 1].push(inner);
      } else if (c === "|" && closer) {
        flush();
        alternatives.push([]);
        i++;
      } else if (c === closer) {
        flush();
        i++;
        return alternatives;
      } else if (c === ")" || c === "]") {
        return undefined;
      } else {
        buffer += c;
        i++;
      }
    }
    flush();
    return closer ? undefined : alternatives;
  };
  const top = sequence();
  return top ? [top] : undefined;
}

function* combinations(nodes: Node[], _limit: number): Generator<string> {
  yield* sequence(nodes, 0);
}

function* sequence(list: Node[], index: number): Generator<string> {
  if (index === list.length) {
    yield "";
    return;
  }
  const node = list[index];
  const heads: Iterable<string> = typeof node === "string" ? [node] : alternatives(node);
  for (const head of heads) {
    for (const tail of sequence(list, index + 1)) yield head + tail;
  }
}

function* alternatives(node: Node[][]): Generator<string> {
  for (const alternative of node) yield* sequence(alternative, 0);
}
