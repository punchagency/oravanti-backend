import { Writable } from "node:stream";

/**
 * Human-readable rendering, shared by both drivers.
 *
 * Both drivers emit the same newline-delimited JSON; this module turns one of
 * those records into something a person can read. Doing it here rather than in
 * each driver is what makes the two outputs identical — the earlier
 * arrangement used `pino-pretty` on one side and a hand-rolled
 * `JSON.stringify(rest)` on the other, so switching LOG_DRIVER changed what a
 * developer saw, and the Winston side put every field on one unreadable line.
 *
 * Two renderings, because they answer different questions:
 *
 *   pretty       One line plus aligned fields. For watching a server run.
 *   json-pretty  Indented JSON, still valid JSON when copied. For reading one
 *                record closely, or pasting into a ticket.
 *
 * Neither is for production, where the log shipper wants `json`.
 */

type Record_ = Record<string, unknown>;

/* ── Colour ─────────────────────────────────────────────────────────────── */

const RESET = "\u001b[0m";

const LEVEL_COLOUR: Record<string, string> = {
  fatal: "1;97;41", // white on red — the one level that should be unmissable
  error: "31",
  warn: "33",
  info: "32",
  debug: "34",
  trace: "90",
};

const paint = (code: string, text: string, on: boolean): string =>
  on ? `\u001b[${code}m${text}${RESET}` : text;

/**
 * jq's default palette, so output that has been through nothing looks like
 * output that has been through jq. These are the values jq itself ships (its
 * default JQ_COLORS is `0;90:0;39:0;39:0;39:0;32:1;39:1;39:34;1`) rather than
 * an approximation, because the point is the muscle memory: keys blue, strings
 * green, structure bold, numbers and booleans plain.
 */
const JQ = {
  null: "0;90",
  boolean: "0;39",
  number: "0;39",
  string: "0;32",
  punct: "1;39",
  key: "34;1",
};

/**
 * Honours the NO_COLOR convention and FORCE_COLOR, then falls back to whether
 * the stream is a terminal. Escapes written into a redirected file or a CI log
 * are noise at best and corrupt a grep at worst.
 */
export function supportsColour(
  stream: NodeJS.WritableStream = process.stdout,
): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean((stream as NodeJS.WriteStream).isTTY);
}

/* ── Field ordering ─────────────────────────────────────────────────────── */

/**
 * The fields that identify a record, in the order you look for them: what
 * happened, who wrote it, which request it belongs to, then the HTTP shape.
 * Everything else follows in insertion order, which is the order the call site
 * wrote it — usually the order it thought mattered.
 */
const LEADING_FIELDS = [
  "event",
  "domain",
  "kind",
  "module",
  "apiModule",
  "requestId",
  // Next to requestId because they answer the same question at different
  // scopes: which user action, and which span of it. Both are what you copy
  // into a trace viewer.
  "trace_id",
  "span_id",
  "source",
  "actorType",
  "userId",
  "organizationId",
  "staffId",
  "method",
  "route",
  "path",
  "status",
  "duration_ms",
];

/** Always last: it is the biggest and the one you read line by line. */
const TRAILING_FIELDS = ["err"];

/**
 * Constant for the lifetime of the process, so repeating them on every line is
 * pure noise when a human is reading. They stay in `json` and in `json-pretty`,
 * where a record may have been copied out of context and needs to say where it
 * came from.
 */
const CONSTANT_FIELDS = new Set([
  "service",
  "env",
  "version",
  "pid",
  "hostname",
  // Constant within a trace, and only meaningful to a backend deciding whether
  // a missing trace was sampled out.
  "trace_flags",
]);

/**
 * Hiding is a property of the `pretty` format only, and it can be switched off.
 *
 * Both JSON formats always show everything: they exist to be read in full, and
 * a format that quietly omits fields is one you cannot trust when you are
 * trying to work out what actually happened. `pretty` is the one meant to be
 * skimmed, so the fields that are identical on every line of the process are
 * dropped by default — and `LOG_VERBOSE=true` puts them back for the times
 * when what you need to confirm is precisely that `env` says what you think.
 */
const showEverything = (): boolean => process.env.LOG_VERBOSE === "true";

/** Rendered in the header instead of the field block. */
const HEADER_FIELDS = new Set(["time", "timestamp", "level", "message", "msg"]);

function orderKeys(record: Record_, leading: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const key of leading) {
    if (key in record) {
      out.push(key);
      seen.add(key);
    }
  }
  for (const key of Object.keys(record)) {
    if (!seen.has(key) && !TRAILING_FIELDS.includes(key)) out.push(key);
  }
  for (const key of TRAILING_FIELDS) {
    if (key in record) out.push(key);
  }

  return out;
}

/* ── Values ─────────────────────────────────────────────────────────────── */

const shortTime = (value: unknown): string => {
  if (typeof value !== "string") return new Date().toISOString().slice(11, 23);
  // Already HH:mm:ss.SSS, or a full ISO timestamp to slice down to it.
  const iso = value.indexOf("T");
  return iso === -1 ? value : value.slice(iso + 1, iso + 13);
};

/** Splits a stack string into frames, trimmed. The first line is the message. */
const stackFrames = (stack: unknown): string[] =>
  typeof stack === "string"
    ? stack
        .split("\n")
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];

/* ── jq-style JSON ──────────────────────────────────────────────────────── */

/** A painted scalar, or undefined when the value is a container. */
function jqScalar(value: unknown, colour: boolean): string | undefined {
  const p = (code: string, text: string) => paint(code, text, colour);

  if (value === null || value === undefined) return p(JQ.null, "null");
  if (typeof value === "boolean") return p(JQ.boolean, String(value));
  if (typeof value === "number") return p(JQ.number, String(value));
  if (typeof value === "string") return p(JQ.string, JSON.stringify(value));
  if (typeof value === "object") return undefined;

  // bigint and anything else deepRedact did not normalise. Quoted, because a
  // bare token here would make the output invalid JSON.
  return p(JQ.string, JSON.stringify(String(value)));
}

const entriesOf = (value: object): Array<[string, unknown]> =>
  Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );

/**
 * Renders a value the way `jq .` would: two-space indentation, one entry per
 * line, coloured by type.
 *
 * Written out by hand rather than `JSON.stringify(v, null, 2)` because
 * stringify has nowhere to put the colour — and uncoloured indented JSON was
 * the thing that made the previous output tiring to read. Colour is a
 * parameter rather than a global so a file, a pipe and a CI log get the plain
 * text that is still valid JSON.
 */
function jqJson(value: unknown, colour: boolean, indent = ""): string {
  const p = (code: string, text: string) => paint(code, text, colour);

  const scalar = jqScalar(value, colour);
  if (scalar !== undefined) return scalar;

  const inner = `${indent}  `;
  const comma = `${p(JQ.punct, ",")}\n`;

  if (Array.isArray(value)) {
    if (value.length === 0) return p(JQ.punct, "[]");
    const items = value.map((v) => `${inner}${jqJson(v, colour, inner)}`);
    return `${p(JQ.punct, "[")}\n${items.join(comma)}\n${indent}${p(JQ.punct, "]")}`;
  }

  const entries = entriesOf(value as object);
  if (entries.length === 0) return p(JQ.punct, "{}");

  const items = entries.map(
    ([key, v]) =>
      `${inner}${p(JQ.key, JSON.stringify(key))}${p(JQ.punct, ":")} ${jqJson(v, colour, inner)}`,
  );
  return `${p(JQ.punct, "{")}\n${items.join(comma)}\n${indent}${p(JQ.punct, "}")}`;
}

/** The same colouring on one line, for values small enough not to need a block. */
function jqInline(value: unknown, colour: boolean): string {
  const p = (code: string, text: string) => paint(code, text, colour);

  const scalar = jqScalar(value, colour);
  if (scalar !== undefined) return scalar;

  if (Array.isArray(value)) {
    if (value.length === 0) return p(JQ.punct, "[]");
    const items = value.map((v) => jqInline(v, colour));
    return `${p(JQ.punct, "[")}${items.join(p(JQ.punct, ","))}${p(JQ.punct, "]")}`;
  }

  const entries = entriesOf(value as object);
  if (entries.length === 0) return p(JQ.punct, "{}");

  const items = entries.map(
    ([key, v]) =>
      `${p(JQ.key, JSON.stringify(key))}${p(JQ.punct, ":")} ${jqInline(v, colour)}`,
  );
  return `${p(JQ.punct, "{")}${items.join(`${p(JQ.punct, ",")} `)}${p(JQ.punct, "}")}`;
}

/** Width of a rendered string with the escape sequences discounted. */
const visibleWidth = (text: string): number =>
   
  text.replace(/\u001b\[[0-9;]*m/g, "").length;

function renderValue(value: unknown, indent: string, colour: boolean): string {
  if (typeof value === "string") {
    // Unquoted: a field block is not JSON, and quotes on every value here are
    // noise. Multi-line strings are indented to the value column so the second
    // line does not read as a new field.
    if (!value.includes("\n")) return value;
    return value
      .split("\n")
      .map((line, i) => (i === 0 ? line : `${indent}${line}`))
      .join("\n");
  }

  if (value === null || typeof value !== "object") {
    return jqScalar(value, colour) ?? String(value);
  }

  // Small structures read better on one line than as a five-line block.
  const inline = jqInline(value, colour);
  if (visibleWidth(inline) <= 72) return inline;

  return jqJson(value, colour, indent);
}

/* ── pretty ─────────────────────────────────────────────────────────────── */

/**
 * `14:23:01.123 WARN  (cases) GET /api/cases 400`, then the fields, aligned.
 *
 * The parenthesised tag is `module` when the line came from a named service
 * and `apiModule` otherwise, so the source of a line is visible without
 * reading the field block — the thing that is genuinely hard to see when the
 * console is scrolling.
 */
export function renderPretty(record: Record_, colour = true): string {
  const level = String(record.level ?? "info").toLowerCase();
  const message = String(record.message ?? record.msg ?? "");
  const tag = record.module ?? record.apiModule;

  const head = [
    paint("90", shortTime(record.time ?? record.timestamp), colour),
    paint(LEVEL_COLOUR[level] ?? "0", level.toUpperCase().padEnd(5), colour),
    tag ? paint("36", `(${String(tag)})`, colour) : "",
    paint("1", message, colour),
  ]
    .filter(Boolean)
    .join(" ");

  const verbose = showEverything();
  const keys = orderKeys(record, LEADING_FIELDS).filter(
    (key) =>
      !HEADER_FIELDS.has(key) &&
      (verbose || !CONSTANT_FIELDS.has(key)) &&
      key !== "err",
  );

  const width = keys.reduce((max, key) => Math.max(max, key.length), 0);
  const lines = keys.map((key) => {
    const label = paint("2", key.padEnd(width), colour);
    const indent = " ".repeat(width + 4);
    return `  ${label}  ${renderValue(record[key], indent, colour)}`;
  });

  const err = record.err as Record_ | undefined;
  if (err && typeof err === "object") {
    const type = String(err.type ?? "Error");
    const detail = String(err.message ?? "");
    lines.push(
      `  ${paint(LEVEL_COLOUR.error, `✖ ${type}`, colour)}: ${detail}`,
    );
    if (err.code !== undefined) {
      lines.push(`      ${paint("2", `code ${String(err.code)}`, colour)}`);
    }
    for (const frame of stackFrames(err.stack)) {
      lines.push(`      ${paint("90", frame, colour)}`);
    }
  }

  return lines.length ? `${head}\n${lines.join("\n")}\n` : `${head}\n`;
}

/* ── json-pretty ────────────────────────────────────────────────────────── */

/**
 * The whole record as indented, coloured JSON — what `… | jq .` looks like,
 * without the pipe.
 *
 * Nothing is hidden and nothing is reshaped, so this is the mode to read when
 * you need to see exactly what was stored. Fields are reordered so the
 * identifying ones are at the top instead of wherever the driver happened to
 * put them; that is the only liberty taken with the structure.
 *
 * The one liberty taken with the data is `err.stack`, split into an array of
 * frames. As a single string it is one enormous line of `\n` escapes, which
 * defeats the entire purpose of the mode.
 *
 * Colour follows the terminal, exactly as jq's own does: on for a TTY, off
 * when redirected — so a record selected out of the terminal and pasted
 * somewhere still parses, and a redirected file is not full of escapes.
 */
export function renderJsonPretty(record: Record_, colour = false): string {
  const ordered: Record_ = {};

  for (const key of orderKeys(record, ["time", "level", "message", ...LEADING_FIELDS])) {
    ordered[key] = record[key];
  }

  // Recursive, because the error that explains the failure is usually the
  // innermost `cause` — drizzle's wrapper carries the SQL, the cause carries
  // the reason — and an unsplit stack there is a single unreadable line.
  const splitStacks = (value: unknown, depth = 0): unknown => {
    if (!value || typeof value !== "object" || depth > 5) return value;
    const node = value as Record_;
    const out: Record_ = { ...node };
    if (typeof node.stack === "string") out.stack = stackFrames(node.stack);
    if (node.cause) out.cause = splitStacks(node.cause, depth + 1) as Record_;
    return out;
  };

  const err = ordered.err;
  if (err && typeof err === "object") {
    ordered.err = splitStacks(err) as Record_;
  }

  // The blank line is what separates one multi-line record from the next.
  return `${jqJson(ordered, colour)}\n\n`;
}

/* ── Stream ─────────────────────────────────────────────────────────────── */

/**
 * Wraps a destination so records written to it as NDJSON come out rendered.
 *
 * Both drivers already know how to write newline-delimited JSON, so formatting
 * on the way out means neither driver needs a formatting path of its own, and
 * the pretty output cannot drift from the JSON it was derived from.
 *
 * A line that does not parse is passed through untouched rather than dropped.
 * Something that writes non-JSON to the log stream is usually a stray
 * `process.stdout.write` worth seeing, and swallowing it would hide the bug.
 */
export function formattingStream(
  render: (record: Record_) => string,
  dest: NodeJS.WritableStream = process.stdout,
): NodeJS.WritableStream {
  let buffer = "";

  const emit = (line: string): void => {
    try {
      dest.write(render(JSON.parse(line) as Record_));
    } catch {
      dest.write(`${line}\n`);
    }
  };

  return new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) emit(line);
        newline = buffer.indexOf("\n");
      }

      callback();
    },
    final(callback) {
      if (buffer.trim()) emit(buffer);
      buffer = "";
      callback();
    },
  });
}

/** The renderer for a format, or undefined for `json`, which needs none. */
export function rendererFor(
  format: string,
  colour = supportsColour(),
): ((record: Record_) => string) | undefined {
  if (format === "pretty") return (record) => renderPretty(record, colour);
  if (format === "json-pretty")
    return (record) => renderJsonPretty(record, colour);
  return undefined;
}
