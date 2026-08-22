import { Writable } from "node:stream";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { AnyValue, AnyValueMap } from "@opentelemetry/api-logs";
import { ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import { OTEL_SEVERITY } from "../lib/logging/config";
import type { LogLevel } from "../lib/logging/types";

/**
 * Ships log records to the OpenTelemetry collector.
 *
 * Implemented as a sink on the serialised log stream (see lib/logging/sinks)
 * rather than as `pino-opentelemetry-transport` plus
 * `@opentelemetry/winston-transport`. Those are two separate projects with
 * their own field handling and their own bugs, and using both would mean the
 * telemetry a request produced depended on LOG_DRIVER — precisely the property
 * the conformance suite exists to rule out. One bridge over the JSON both
 * drivers already emit has neither problem, and it sees records after
 * redaction, which a driver-level hook does not.
 *
 * The record is not reshaped on the way through. A log line's fields arrive at
 * the collector under the names they were written with, so what you searched
 * for in the console is what you search for in the backend.
 */

const SEVERITY_NUMBER: Record<LogLevel, SeverityNumber> = {
  trace: OTEL_SEVERITY.trace,
  debug: OTEL_SEVERITY.debug,
  info: OTEL_SEVERITY.info,
  warn: OTEL_SEVERITY.warn,
  error: OTEL_SEVERITY.error,
  fatal: OTEL_SEVERITY.fatal,
};

const INSTRUMENTATION_SCOPE = "oravanti.logging";

/**
 * Rebuilds the trace context from the record's own fields.
 *
 * The alternative would be reading the ambient context here, but by the time a
 * record reaches this stream the write has crossed a tick boundary and the
 * AsyncLocalStorage context that produced it is gone. The fields were captured
 * at emit time by `traceFields()`, so they are the authoritative answer — and
 * this way the exported record and the line on stdout can never disagree about
 * which trace they belong to.
 */
function contextFor(record: Record<string, unknown>): Context | undefined {
  const traceId = record.trace_id;
  const spanId = record.span_id;

  if (typeof traceId !== "string" || typeof spanId !== "string") return undefined;

  const flags = Number.parseInt(String(record.trace_flags ?? "01"), 16);

  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId,
    traceFlags: Number.isNaN(flags) ? TraceFlags.SAMPLED : flags,
    isRemote: false,
  });
}

const timestampOf = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

/**
 * The two fields that are not attributes, because each becomes a first-class
 * part of the LogRecord instead: `message` is the body, `level` is the
 * severity. Copying either into attributes as well would store it twice and
 * create a second copy that can disagree with the first.
 *
 * Everything else — including `time`, `trace_id`, `span_id` and `trace_flags`,
 * which are also set on the record — is passed through, matching what
 * `@opentelemetry/winston-transport` does.
 */
const NOT_ATTRIBUTES = new Set(["message", "msg", "level"]);

/**
 * The record, as written, becomes the LogRecord's attributes.
 *
 * No renaming, no flattening, no mapping table. `LogAttributes` is an
 * `AnyValueMap`, so a nested object is a legal attribute value and there is no
 * technical reason to reshape anything — and every reason not to. A field is
 * called in the telemetry backend what it is called in the code that wrote it
 * and in the line on stdout, so a name found in one place can be searched for
 * in the others.
 */
function attributesOf(record: Record<string, unknown>): AnyValueMap {
  const out: AnyValueMap = {};

  for (const [key, value] of Object.entries(record)) {
    if (NOT_ATTRIBUTES.has(key) || value === undefined) continue;
    // The cast is the whole point: a record parsed from JSON is already
    // AnyValue-shaped — scalars, arrays and maps — so there is nothing to
    // convert, only a type to state.
    out[key] = value as AnyValue;
  }

  return out;
}

function emit(record: Record<string, unknown>): void {
  const level = String(record.level ?? "info") as LogLevel;
  const severityNumber = SEVERITY_NUMBER[level] ?? SeverityNumber.INFO;

  logs.getLogger(INSTRUMENTATION_SCOPE).emit({
    severityNumber,
    severityText: level,
    // The body is the human sentence. Everything structured is an attribute —
    // a backend groups on attributes and only displays the body, so putting
    // data in the body is how it becomes unqueryable.
    body: String(record.message ?? ""),
    timestamp: timestampOf(record.time ?? record.timestamp),
    attributes: attributesOf(record),
    context: contextFor(record),
  });
}

/**
 * The sink registered with the log mirror.
 *
 * Errors are swallowed: a malformed record or an exporter fault must not be
 * able to fail the request that produced the log line. That is also why the
 * mirror takes no backpressure from here.
 */
export function createLogBridge(): NodeJS.WritableStream {
  let buffer = "";

  const consume = (line: string): void => {
    try {
      emit(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A line that is not a record is not this bridge's business.
    }
  };

  return new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) consume(line);
        newline = buffer.indexOf("\n");
      }

      callback();
    },
    final(callback) {
      if (buffer.trim()) consume(buffer);
      buffer = "";
      callback();
    },
  });
}
