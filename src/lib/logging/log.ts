import { describeEvent, domainOf, type LogEventName } from "./events";
import { getServiceLogger } from "./service-logger";
import { traceFields } from "./trace-context";
import type { LogFields, LogLevel } from "./types";

/**
 * The logging API for application code. Import from here, not from the drivers
 * and not from `getLogger()`.
 *
 *   logInfo(LogEvent.EMAIL_SENT, { to });
 *   logWarning(LogEvent.AI_SCAN_RESULT_ORPHANED, { jobId });
 *   logFailure(LogEvent.EMAIL_SEND_FAILED, error, { to });
 *
 * Every helper takes a catalogued event first, so no call site invents its own
 * key, and each guarantees the same envelope: `event`, `domain`, a `message`,
 * and the request's correlation fields. A raw `getServiceLogger().info(...)`
 * would produce a record missing `event` and `domain` — readable, but invisible
 * to anything that filters.
 *
 * ── Argument order ──────────────────────────────────────────────────────────
 * `(event, [error], fields?, message?)`. Fields before message matches the
 * underlying Logger contract, so the two never read inconsistently. `message`
 * is last and optional: it defaults to prose derived from the event, which
 * means a line is readable with no effort and a better sentence is available
 * when one is worth writing.
 */

/**
 * Assembles the envelope every record shares.
 *
 * Trace correlation is resolved here rather than bound to the child logger,
 * because the active span changes several times within one request — see
 * trace-context.ts. It is absent, at no cost, when no telemetry SDK is running.
 */
function envelope(
  event: LogEventName,
  fields?: LogFields,
  module?: string,
): LogFields {
  return {
    ...fields,
    event,
    domain: domainOf(event),
    ...(module ? { module } : {}),
    ...traceFields(),
  };
}

function emit(
  level: LogLevel,
  event: LogEventName,
  fields?: LogFields,
  message?: string,
  module?: string,
): void {
  getServiceLogger()[level](
    envelope(event, fields, module),
    message ?? describeEvent(event),
  );
}

function emitWithError(
  level: "error" | "fatal",
  event: LogEventName,
  error?: unknown,
  fields?: LogFields,
  message?: string,
  module?: string,
): void {
  getServiceLogger()[level](
    {
      ...envelope(event, fields, module),
      ...(error === undefined ? {} : { err: error }),
    },
    message ?? describeEvent(event),
  );
}

/**
 * Logs at a level decided at runtime. For the handful of places where severity
 * is derived rather than known — the access log, whose level follows the HTTP
 * status. Prefer the named helpers everywhere else; a literal level passed here
 * is just a less readable `logInfo`.
 */
export function logAt(
  level: LogLevel,
  event: LogEventName,
  fields?: LogFields,
  message?: string,
): void {
  emit(level, event, fields, message);
}

/** Very fine-grained tracing. Off in every deployed environment. */
export function logTrace(
  event: LogEventName,
  fields?: LogFields,
  message?: string,
): void {
  emit("trace", event, fields, message);
}

/** Diagnostics useful while working on something, noise otherwise. */
export function logDebug(
  event: LogEventName,
  fields?: LogFields,
  message?: string,
): void {
  emit("debug", event, fields, message);
}

/** Something expected happened and is worth a permanent record. */
export function logInfo(
  event: LogEventName,
  fields?: LogFields,
  message?: string,
): void {
  emit("info", event, fields, message);
}

/**
 * Something is wrong but the request survived it — a degraded path, a
 * rejected input, a retry. Also where 4xx belongs: a client sending an invalid
 * payload is expected traffic, and logging it at `error` makes the error rate
 * measure the callers rather than the service.
 */
export function logWarning(
  event: LogEventName,
  fields?: LogFields,
  message?: string,
): void {
  emit("warn", event, fields, message);
}

/**
 * Something broke that we are responsible for.
 *
 * The error goes under `err` and is serialised to `{ type, message, stack }`
 * by the driver — pass the caught value directly rather than `err.message`,
 * or the stack is gone and with it any chance of locating the failure.
 */
export function logFailure(
  event: LogEventName,
  error?: unknown,
  fields?: LogFields,
  message?: string,
): void {
  emitWithError("error", event, error, fields, message);
}

/**
 * The process cannot continue. Reserved for the exit path — an unrecoverable
 * startup failure, an uncaught exception. `flushLogs()` must be awaited after
 * one of these or the record explaining the exit is lost with the buffer.
 */
export function logFatal(
  event: LogEventName,
  error?: unknown,
  fields?: LogFields,
  message?: string,
): void {
  emitWithError("fatal", event, error, fields, message);
}

/**
 * Something a user or the system did, as opposed to something that went wrong.
 *
 * Marked `kind: "action"` so the business-event stream can be separated from
 * diagnostics in one filter — "everything this user did today" without wading
 * through retries and warnings. Always `info`: an action succeeded, by
 * definition, or it would be a failure instead.
 *
 * The actor is not passed in. `requestId`, `userId`, `orgId`, `staffId` and
 * `actorType` are already bound from the request context, so an action logged
 * from anywhere in a request is attributed automatically — and cannot be
 * attributed to the wrong person by a copy-pasted call site.
 */
export function logAction(
  event: LogEventName,
  fields?: LogFields,
  message?: string,
): void {
  emit("info", event, { ...fields, kind: "action" }, message);
}

/**
 * The same API, with a `module` field bound to every record.
 *
 *   const log = createModuleLogger("leads.service");
 *   log.failure(LogEvent.LEAD_NOTE_SAVE_FAILED, err, { leadId });
 *
 * Preferred over the free functions inside a service. `event` says what
 * happened and `module` says who said so, which is the difference between
 * "a note failed to save" and knowing which of the four call sites that write
 * notes produced it. A stack answers the same question for errors, but not for
 * info and warn records, and stacks are absent from the shipped log once it
 * has been through a collector that truncates them.
 *
 * Name it after the file, dotted: `leads.service`, `queue.reminder_worker`,
 * `middleware.inject_user_dek`.
 *
 * Not to be confused with `apiModule`, which the request context binds
 * separately. `apiModule` is the API surface the caller hit ("cases");
 * `module` is the code that wrote the line ("leads.service"). They differ
 * whenever a shared service is called from more than one route, which is
 * exactly the case where knowing both is what locates a failure.
 */
export interface ModuleLogger {
  /** Level decided at runtime — see `logAt`. */
  at(
    level: LogLevel,
    event: LogEventName,
    fields?: LogFields,
    message?: string,
  ): void;
  trace(event: LogEventName, fields?: LogFields, message?: string): void;
  debug(event: LogEventName, fields?: LogFields, message?: string): void;
  info(event: LogEventName, fields?: LogFields, message?: string): void;
  warn(event: LogEventName, fields?: LogFields, message?: string): void;
  action(event: LogEventName, fields?: LogFields, message?: string): void;
  failure(
    event: LogEventName,
    error?: unknown,
    fields?: LogFields,
    message?: string,
  ): void;
  fatal(
    event: LogEventName,
    error?: unknown,
    fields?: LogFields,
    message?: string,
  ): void;
}

export function createModuleLogger(module: string): ModuleLogger {
  return {
    at: (level, event, fields, message) =>
      emit(level, event, fields, message, module),
    trace: (event, fields, message) =>
      emit("trace", event, fields, message, module),
    debug: (event, fields, message) =>
      emit("debug", event, fields, message, module),
    info: (event, fields, message) =>
      emit("info", event, fields, message, module),
    warn: (event, fields, message) =>
      emit("warn", event, fields, message, module),
    action: (event, fields, message) =>
      emit("info", event, { ...fields, kind: "action" }, message, module),
    failure: (event, error, fields, message) =>
      emitWithError("error", event, error, fields, message, module),
    fatal: (event, error, fields, message) =>
      emitWithError("fatal", event, error, fields, message, module),
  };
}

/**
 * Guard for work that is only worth doing if it will be logged — building an
 * expensive diagnostic payload, mostly. Skip it for ordinary call sites; the
 * check costs more than it saves when the fields are already to hand.
 */
export function isLogLevelEnabled(level: LogLevel): boolean {
  return getServiceLogger().isLevelEnabled(level);
}

/** Drains buffered records. Await before a deliberate exit. */
export function flushLogs(): Promise<void> {
  return getServiceLogger().flush();
}

export { LogEvent } from "./events";
export type { LogEventName } from "./events";
export type { LogFields, LogLevel } from "./types";
