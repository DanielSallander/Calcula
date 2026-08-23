//! FILENAME: app/extensions/AIChat/lib/textToolCalls.ts
// PURPOSE: Recover a tool call that the model WROTE AS TEXT instead of emitting
//          through the tool-calling interface, so the agentic loop can run it.
// CONTEXT: Reported 2026-08-22. A local model asked to "create a script that
//          formats the background color of each selected cell" answered with a
//          fenced ```json block:
//
//              { "name": "format_cells", "arguments": { ... } }
//
//          and nothing happened. Two failures in one reply: it PRINTED a call
//          rather than emitting one, and it INVENTED a name. The turn was
//          indistinguishable from a normal conversational answer — `finish()`
//          (ai/stream.rs) saw no `delta.tool_calls`, so the response carried zero
//          `toolUse` blocks and `stopReason: "endTurn"`, and ChatView broke out
//          of the loop having done exactly what a chat is supposed to do with
//          prose: render it.
//
//          WHY A PARSER AND NOT JUST A BETTER PROMPT. The prompt is the real fix
//          and it changes the RATE (see SYSTEM_PROMPT in chatTools.ts). It cannot
//          change the FLOOR: a 3B model has "here is the JSON you asked for" very
//          heavily represented in its training data, and it will regress to it
//          under a long conversation or an unusual request. Calcula's premise is
//          that a local model is a first-class way to use the product, so the
//          floor is what the user actually experiences. This module is the net.
//
//          WHY IT IS DELIBERATELY STRICT. A net that catches too much is worse
//          than none: a model EXPLAINING a tool call ("you could call
//          set_cell_value with...") must not cause a write. Three rules keep it
//          honest, and each has a test:
//            1. NAMES ARE MATCHED EXACTLY against the live tool list. No fuzzy
//               matching, no aliases, no case folding. `format_cells` is not
//               `apply_formatting` and never becomes it — it is reported as an
//               unknown name so the model can be told, and told what does exist.
//            2. THE OBJECT MUST LOOK LIKE AN ENVELOPE, not merely contain a
//               matching string. Every key must be one of the small set of
//               spellings a tool-call envelope actually uses, so a row of data
//               that happens to carry `{"name": "run_script", "owner": "x"}` is
//               not a call.
//            3. NOTHING IS EVALUATED. `JSON.parse` only. A tool call written as
//               a JavaScript object literal is not recovered, on purpose.
//
//          Authority is decided by the CALLER, not here: this module reports what
//          it found and ChatView applies `SALVAGE_AUTORUN` (chatTools.ts), which
//          confirms every mutating call with the user before running it. This
//          file is pure — text in, findings out — which is what makes the rules
//          above testable without a model, a Worker or a backend.

/** One tool call recovered from prose. */
export interface SalvagedCall {
  /** Exactly as it appears in `TOOLS` — never a corrected or guessed name. */
  name: string;
  input: Record<string, unknown>;
}

export interface SalvageResult {
  /** Calls whose name exists in the surface. Safe to dispatch (subject to the
   *  caller's own authority rules). */
  calls: SalvagedCall[];
  /**
   * Names that parsed as a tool-call envelope but do not exist.
   *
   * Kept rather than dropped so the caller can hand the model a repair message
   * naming the tools that DO exist. Silence here is what produced the reported
   * bug: the model had no way to learn that `format_cells` is not a thing.
   */
  unknownNames: string[];
  /**
   * `[start, end)` offsets in the input that were consumed as calls.
   *
   * The transcript uses these to drop the raw JSON from the assistant bubble —
   * once a call is actually running, showing its source blob as prose as well is
   * noise, and it is the thing that made the failure look like an answer.
   */
  consumedSpans: Array<[number, number]>;
}

const EMPTY: SalvageResult = { calls: [], unknownNames: [], consumedSpans: [] };

/**
 * Keys an object may carry and still be considered a tool-call envelope.
 *
 * Rule 2 above. The union of the spellings observed across OpenAI's function
 * format, Anthropic's tool_use block, Ollama/llama.cpp chat templates and the
 * ad-hoc shapes small models produce when they are imitating one of those from
 * memory. `type` and `id` are here because a model copying OpenAI's wire format
 * includes them; they are ignored, not required.
 */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "name",
  "tool",
  "tool_name",
  "toolName",
  "function",
  "arguments",
  "args",
  "parameters",
  "params",
  "input",
  "type",
  "id",
  "index",
]);

/**
 * Keys that may carry the name. Checked in order.
 *
 * `function` is here because a model imitating OpenAI's format from memory
 * flattens it: `{"function": "format_selected_cells", "arguments": {...}}`,
 * observed from qwen2.5-coder:3b on 2026-08-22. The nested form
 * (`{"function": {"name": ...}}`) is handled separately above, so this branch is
 * reached only when the value is a plain string.
 */
const NAME_KEYS = ["name", "tool", "tool_name", "toolName", "function"] as const;

/** Keys that may carry the arguments. Checked in order. */
const ARG_KEYS = ["arguments", "args", "parameters", "params", "input"] as const;

/** Wrappers a model may nest the real envelope inside. */
const WRAPPER_KEYS = ["tool_call", "toolCall", "tool_calls", "toolCalls", "function_call", "functionCall"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The arguments, whichever spelling and whichever encoding.
 *
 * OpenAI sends `arguments` as a JSON STRING and a model imitating it from memory
 * usually does too; the same model on the next turn may send an object. Parsed
 * ONCE — a string that does not parse yields no arguments rather than being
 * passed through as a single mystery value, because a tool receiving
 * `{"__raw": "..."}` would fail in a way that reads as a Calcula bug.
 */
function readArgs(env: Record<string, unknown>): Record<string, unknown> | null {
  for (const key of ARG_KEYS) {
    if (!(key in env)) continue;
    const raw = env[key];
    if (isRecord(raw)) return raw;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      // An explicitly empty argument object is legitimate for a zero-arg tool.
      if (trimmed === "" || trimmed === "{}") return {};
      try {
        const parsed: unknown = JSON.parse(trimmed);
        return isRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
    // Present but neither an object nor a string (null, a number, an array):
    // not something a tool's input schema can accept.
    return null;
  }
  // No arguments key at all. Legitimate for a zero-argument tool.
  return {};
}

/**
 * Interpret one parsed value as zero or more tool-call envelopes.
 *
 * Recursive because the wrappers nest: `{"tool_calls": [{"function": {...}}]}`
 * is one real shape, and so is a bare array of envelopes.
 */
function envelopesIn(value: unknown, depth = 0): Array<{ name: string; input: Record<string, unknown> }> {
  // Bounded so a pathological nesting cannot spin. Four is deeper than any
  // observed shape (array -> object -> tool_calls -> function).
  if (depth > 4) return [];

  if (Array.isArray(value)) {
    return value.flatMap((v) => envelopesIn(v, depth + 1));
  }
  if (!isRecord(value)) return [];

  // A wrapper: descend, and do NOT also treat the wrapper itself as an envelope.
  for (const key of WRAPPER_KEYS) {
    if (key in value) return envelopesIn(value[key], depth + 1);
  }

  // OpenAI's nested form: { type: "function", function: { name, arguments } }.
  // The inner object is the envelope; the outer carries only envelope keys, so
  // it still has to satisfy rule 2.
  if (isRecord(value.function)) {
    const outerOk = Object.keys(value).every((k) => ENVELOPE_KEYS.has(k));
    return outerOk ? envelopesIn(value.function, depth + 1) : [];
  }

  // Rule 2: every key must belong to an envelope. This is what separates a call
  // from a piece of data that happens to have a `name`.
  if (!Object.keys(value).every((k) => ENVELOPE_KEYS.has(k))) return [];

  let name: string | null = null;
  for (const key of NAME_KEYS) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim() !== "") {
      name = raw.trim();
      break;
    }
  }
  if (name === null) return [];

  const input = readArgs(value);
  if (input === null) return [];

  return [{ name, input }];
}

/**
 * The end offset of the JSON value starting at `start`, or -1.
 *
 * A brace counter that understands strings and escapes. `text.indexOf("}")` is
 * the tempting version and it truncates the first call whose arguments contain a
 * `}` inside a string — which, for `draft_object_script`, is every call that
 * drafts a script with a function body in it.
 */
function jsonEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  // Unterminated — the generation was cut off mid-call. Reported as "no value"
  // so a truncated fence salvages nothing rather than half a call.
  return -1;
}

/** A candidate JSON region: `[start, end)` plus the text to parse. */
interface Candidate {
  start: number;
  end: number;
  body: string;
}

/**
 * Every region of the text that could be a JSON value.
 *
 * Fenced blocks first (the overwhelmingly common shape, and their offsets cover
 * the fence markers so the whole block can be stripped from the bubble), then
 * bare `{`/`[` values outside any fence.
 */
function candidates(text: string): Candidate[] {
  const found: Candidate[] = [];
  const covered: Array<[number, number]> = [];

  // ```json ... ``` / ```JSON ... ``` / ``` ... ``` / ```tool_call ... ```
  const fence = /```[ \t]*([A-Za-z_]*)[ \t]*\r?\n?/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const bodyStart = m.index + m[0].length;
    const closeIdx = text.indexOf("```", bodyStart);
    // An unterminated fence still gets its body examined: the model may have
    // stopped before closing it, and the JSON inside can still be complete.
    const bodyEnd = closeIdx === -1 ? text.length : closeIdx;
    const blockEnd = closeIdx === -1 ? text.length : closeIdx + 3;
    found.push({ start: m.index, end: blockEnd, body: text.slice(bodyStart, bodyEnd) });
    covered.push([m.index, blockEnd]);
    fence.lastIndex = blockEnd;
  }

  const inFence = (i: number): boolean => covered.some(([a, b]) => i >= a && i < b);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    if (inFence(i)) continue;
    const end = jsonEnd(text, i);
    if (end === -1) continue;
    found.push({ start: i, end, body: text.slice(i, end) });
    // Skip past it: inner braces are part of this value, not new candidates.
    i = end - 1;
  }

  return found.sort((a, b) => a.start - b.start);
}

/**
 * Recover tool calls the model wrote as text.
 *
 * `known` is the live tool list (`TOOL_NAMES` from chatTools.ts, derived from
 * `TOOLS`). Passing it in rather than importing it keeps this module pure and
 * lets the tests state the surface explicitly.
 */
export function salvageTextualToolCalls(text: string, known: readonly string[]): SalvageResult {
  if (!text || text.indexOf("{") === -1) return EMPTY;

  const knownSet = new Set(known);
  const calls: SalvagedCall[] = [];
  const unknownNames: string[] = [];
  const consumedSpans: Array<[number, number]> = [];

  for (const cand of candidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cand.body.trim());
    } catch {
      continue;
    }
    const envelopes = envelopesIn(parsed);
    if (envelopes.length === 0) continue;

    let consumed = false;
    for (const env of envelopes) {
      if (knownSet.has(env.name)) {
        calls.push({ name: env.name, input: env.input });
        consumed = true;
      } else if (!unknownNames.includes(env.name)) {
        unknownNames.push(env.name);
      }
    }
    // Only a region that produced a RUNNABLE call is removed from the bubble.
    // An unknown name stays visible: the user should see what the model tried to
    // do when nothing ran.
    if (consumed) consumedSpans.push([cand.start, cand.end]);
  }

  if (calls.length === 0 && unknownNames.length === 0) return EMPTY;
  return { calls, unknownNames, consumedSpans };
}

/**
 * The text with the given spans removed, tidied.
 *
 * Used for the assistant bubble once the calls in it are running: the prose
 * around the block ("Here is the script that will...") is worth keeping, the
 * JSON blob is not. Whitespace is collapsed so removing a block from the middle
 * of a message does not leave a three-line hole.
 */
export function stripSpans(text: string, spans: ReadonlyArray<[number, number]>): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (start < cursor) continue; // overlapping — already removed
    out += text.slice(cursor, start);
    cursor = end;
  }
  out += text.slice(cursor);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The repair message handed back to the model when it called a name that does
 * not exist.
 *
 * Names the closed set, and suggests the nearest real tools by edit distance —
 * `format_cells` should point at `apply_formatting`. Written as a tool RESULT so
 * the model's own agentic loop performs the repair, which is the same mechanism
 * `draftGate.ts` uses for a rejected draft rather than adding a second loop.
 */
export function unknownToolMessage(name: string, known: readonly string[]): string {
  const near = nearestNames(name, known, 3);
  return (
    `There is no tool called "${name}", so nothing ran.` +
    (near.length ? ` Did you mean: ${near.join(", ")}?` : "") +
    `\n\nThe complete set of tools is: ${known.join(", ")}.` +
    `\n\nCall one of those, emitting a real tool call rather than writing it as text.`
  );
}

/**
 * The `n` known names closest to `name`.
 *
 * A local Levenshtein rather than a reach into `@api/scriptHost/scriptValidation`:
 * that module's suggester scores dotted SURFACE CHAINS (`api.setRangeFormat`)
 * with chain-specific segment weighting, and borrowing it would couple the chat's
 * tool vocabulary to the script surface's — two lists that have no reason to stay
 * the same shape. Twenty-odd short names is not a place that needs a shared
 * implementation.
 */
function nearestNames(name: string, known: readonly string[], n: number): string[] {
  const target = name.toLowerCase();
  return known
    .map((k) => ({ k, d: distance(target, k.toLowerCase()) }))
    // Half the length is a loose-but-not-absurd bar: it lets format_cells reach
    // apply_formatting while keeping unrelated names out of the suggestion.
    .filter(({ k, d }) => d <= Math.max(4, Math.floor(k.length / 2)))
    .sort((a, b) => a.d - b.d || a.k.localeCompare(b.k))
    .slice(0, n)
    .map(({ k }) => k);
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}
