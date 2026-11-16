/**
 * Lenient parser for tool calls a model wrote as TEXT instead of native tool calls.
 *
 * Recognized shapes (only for KNOWN tool names; everything else is left as prose):
 *   fs_write{path: <|"|>notes.md<|"|>, content: "a\nb"}     Gemma-style object, bare keys, <|"|> quote token
 *   fs_read(path="notes.md")  /  fs_read({"path": "x"})     call syntax with kwargs or an object
 *   {"name": "fs_read", "arguments": {...}}                 JSON-ish blocks (also "tool"/"function", "args"/"parameters"/"input")
 *   ```json … ```                                           fenced versions of the above
 *
 * Values are parsed by a small recursive-descent reader (not JSON.parse), so it tolerates bare keys,
 * single quotes, `=` instead of `:`, trailing commas, missing commas, raw newlines in strings, Python
 * literals (True/False/None) and bare words. Strings containing braces/commas/colons are safe because
 * the reader consumes string literals as units.
 */

export interface TextToolCall {
  name: string;
  args: Record<string, unknown>;
  /** the exact text span of the call */
  raw: string;
}

const QTOK = '<|"|>';

class Reader {
  i: number;
  constructor(
    readonly s: string,
    start: number,
  ) {
    this.i = start;
  }
  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  peek(): string {
    return this.s[this.i] ?? '';
  }
  startsWith(t: string): boolean {
    return this.s.startsWith(t, this.i);
  }
  fail(): never {
    throw new SyntaxError(`unexpected ${JSON.stringify(this.s.slice(this.i, this.i + 10))} at ${this.i}`);
  }

  value(stop = ',}])'): unknown {
    this.ws();
    if (this.startsWith(QTOK)) return this.tokString();
    const c = this.peek();
    if (c === '{') return this.object('}');
    if (c === '[') return this.array();
    if (c === '"' || c === "'" || c === '`') return this.quoted(c);
    if (/[-+\d.]/.test(c)) {
      const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(this.s.slice(this.i));
      if (m) {
        const after = this.s[this.i + m[0].length] ?? '';
        if (!after || stop.includes(after) || /\s/.test(after)) {
          this.i += m[0].length;
          return Number(m[0]);
        }
      }
    }
    // bare word (identifier literal or unquoted text) up to a separator / newline
    const start = this.i;
    while (this.i < this.s.length && !stop.includes(this.s[this.i]) && this.s[this.i] !== '\n') this.i++;
    const w = this.s.slice(start, this.i).trim();
    if (!w) this.fail();
    if (w === 'true' || w === 'True') return true;
    if (w === 'false' || w === 'False') return false;
    if (w === 'null' || w === 'None' || w === 'undefined') return null;
    return w;
  }

  tokString(): string {
    this.i += QTOK.length;
    const end = this.s.indexOf(QTOK, this.i);
    if (end < 0) this.fail();
    const out = this.s.slice(this.i, end);
    this.i = end + QTOK.length;
    return out;
  }

  quoted(q: string): string {
    this.i++;
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === q) {
        this.i++;
        return out;
      }
      if (c === '\\' && this.i + 1 < this.s.length) {
        const n = this.s[this.i + 1];
        this.i += 2;
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '0': '\0' };
        if (n in map) out += map[n];
        else if (n === 'u' && /^[0-9a-fA-F]{4}/.test(this.s.slice(this.i, this.i + 4))) {
          out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 4), 16));
          this.i += 4;
        } else out += n; // \" \\ \' \/ and unknown escapes
        continue;
      }
      out += c;
      this.i++;
    }
    this.fail();
  }

  key(): string {
    this.ws();
    if (this.startsWith(QTOK)) return this.tokString();
    const c = this.peek();
    if (c === '"' || c === "'" || c === '`') return this.quoted(c);
    const m = /^[A-Za-z_$][\w$.-]*/.exec(this.s.slice(this.i));
    if (!m) this.fail();
    this.i += m[0].length;
    return m[0];
  }

  /** object body up to `close` (the opening brace, if any, must already be consumed or is consumed here) */
  object(close: string, opened = false): Record<string, unknown> {
    if (!opened) this.i++; // '{'
    const out: Record<string, unknown> = {};
    for (;;) {
      this.ws();
      if (this.peek() === close) {
        this.i++;
        return out;
      }
      if (this.peek() === ',') {
        this.i++;
        continue;
      }
      if (this.i >= this.s.length) this.fail();
      const k = this.key();
      this.ws();
      if (this.peek() !== ':' && this.peek() !== '=') this.fail();
      this.i++;
      out[k] = this.value(`,${close}`);
    }
  }

  array(): unknown[] {
    this.i++;
    const out: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.peek() === ']') {
        this.i++;
        return out;
      }
      if (this.peek() === ',') {
        this.i++;
        continue;
      }
      if (this.i >= this.s.length) this.fail();
      out.push(this.value(',]'));
    }
  }
}

/** parse a loose object literal starting at `start` (must be '{'); returns the value and the end index */
export function parseLooseObject(s: string, start: number): { value: Record<string, unknown>; end: number } | null {
  try {
    const r = new Reader(s, start);
    const value = r.object('}');
    return { value, end: r.i };
  } catch {
    return null;
  }
}

/** `name(...)`: an object inside, or kwargs `a="x", b: 2` */
function parseParenArgs(s: string, open: number): { value: Record<string, unknown>; end: number } | null {
  try {
    const r = new Reader(s, open + 1);
    r.ws();
    let value: Record<string, unknown>;
    if (r.peek() === '{') {
      value = r.object('}');
      r.ws();
      if (r.peek() !== ')') return null;
      r.i++;
    } else value = r.object(')', true);
    return { value, end: r.i };
  } catch {
    return null;
  }
}

const NAME_KEYS = ['name', 'tool', 'tool_name', 'function', 'recipient_name'];
const ARG_KEYS = ['arguments', 'args', 'parameters', 'params', 'input'];

function asArgs(v: unknown): Record<string, unknown> | undefined {
  if (v == null) return {};
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return {};
    if (t.startsWith('{')) return parseLooseObject(t, 0)?.value;
  }
  return undefined;
}

/** a JSON-ish block describing a call: {"name": "x", "arguments": {...}} or {"function": {"name", "arguments"}} */
function callFromBlock(o: Record<string, unknown>, known: Set<string>): { name: string; args: Record<string, unknown> } | undefined {
  for (const nk of NAME_KEYS) {
    const nv = o[nk];
    if (nv && typeof nv === 'object' && !Array.isArray(nv)) {
      const inner = callFromBlock(nv as Record<string, unknown>, known);
      if (inner) return inner;
    }
    if (typeof nv !== 'string') continue;
    const name = normName(nv);
    if (!known.has(name)) continue;
    const ak = ARG_KEYS.find((k) => k in o);
    const args = ak ? asArgs(o[ak]) : {};
    if (args) return { name, args };
  }
  return undefined;
}

function normName(n: string): string {
  const parts = n.trim().split('.');
  return parts[parts.length - 1];
}

/**
 * Find tool calls written as text. Only names in `knownToolNames` count. Returns the calls in order and
 * the remaining prose (call spans and call-wrapper tokens/fences removed).
 */
export function parseTextToolCalls(text: string, knownToolNames: Iterable<string>): { calls: TextToolCall[]; prose: string } {
  const known = new Set(knownToolNames);
  const calls: TextToolCall[] = [];
  const spans: [number, number][] = [];
  if (!text || !known.size) return { calls, prose: text ?? '' };
  const identRe = /[A-Za-z_][\w.]*/y;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    // identifier at a word boundary
    if (/[A-Za-z_]/.test(c) && (i === 0 || !/[\w.]/.test(text[i - 1]))) {
      identRe.lastIndex = i;
      const m = identRe.exec(text);
      if (m) {
        const name = normName(m[0]);
        let j = i + m[0].length;
        if (known.has(name)) {
          if (text[j] === '`') j++; // `name`{…}
          while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
          const parsed = text[j] === '{' ? parseLooseObject(text, j) : text[j] === '(' ? parseParenArgs(text, j) : null;
          if (parsed) {
            calls.push({ name, args: parsed.value, raw: text.slice(i, parsed.end) });
            spans.push([i, parsed.end]);
            i = parsed.end;
            continue;
          }
        }
        i += m[0].length;
        continue;
      }
    }
    if (c === '{') {
      const parsed = parseLooseObject(text, i);
      if (parsed) {
        const call = callFromBlock(parsed.value, known);
        if (call) {
          calls.push({ ...call, raw: text.slice(i, parsed.end) });
          spans.push([i, parsed.end]);
          i = parsed.end;
          continue;
        }
      }
    }
    i++;
  }
  if (!calls.length) return { calls, prose: text };
  let prose = '';
  let last = 0;
  for (const [a, b] of spans) {
    prose += text.slice(last, a);
    last = b;
  }
  prose += text.slice(last);
  prose = prose
    .replace(/<\|?\/?(?:start_function_call|end_function_call|tool_call|tool_calls|function_call)\|?>/gi, '')
    .replace(/<\/?tool_call>/gi, '')
    .replace(/```[\w-]*\s*```/g, '')
    .replace(/^\s*(?:call|tool_call|tool|function)\s*:\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { calls, prose };
}

/** quick check: does this text look like it tries to call one of these tools (`name{` / `name(` / JSON block)? */
export function looksLikeTextToolCall(text: string, knownToolNames: Iterable<string>): boolean {
  if (!text) return false;
  const names = [...knownToolNames];
  if (parseTextToolCalls(text, names).calls.length) return true;
  const set = new Set(names);
  for (const m of text.matchAll(/\b([A-Za-z_]\w*)\s*[{(]/g)) if (set.has(m[1])) return true;
  return false;
}

/** render executed text-call results as the follow-up user message */
export function textToolResultsMessage(results: { name: string; ok: boolean; output: string }[]): string {
  const body = results.map((r, n) => `${n + 1}. ${r.name} → ${r.ok ? 'ok' : 'ERROR'}\n${r.output}`).join('\n\n');
  return (
    `[Monarch system note] Results of your tool calls (they were executed for real):\n\n${body}\n\n` +
    'Continue: if more steps are needed, call more tools the same way; otherwise answer the user in plain sentences ' +
    '(no tool-call syntax) and only claim what these results show.'
  );
}
