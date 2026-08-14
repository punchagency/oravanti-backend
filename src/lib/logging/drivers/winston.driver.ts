import winston from "winston";
import type {
  Logger,
  LoggerDriver,
  LoggerOptions,
  LogFields,
  LogLevel,
} from "../types";
import { LEVELS } from "../config";
import { prepareFields } from "../redact";

/**
 * Winston driver.
 *
 * Every defect the original Winston draft carried is fixed here, and each is
 * the kind that only shows up in production:
 *
 *   D1  The draft used Pino's object-first call form, `log.error({ err }, "m")`.
 *       Winston's signature is the reverse. Passing it that way makes Winston
 *       treat the object as the entire record — no `message` field at all —
 *       and the string becomes a splat argument. Every example in the draft
 *       would have produced a log line with no message. `emit()` below is the
 *       translation layer that lets call sites keep the object-first form.
 *
 *   D2  `logger.fatal()` does not exist in Winston. Its default levels stop at
 *       `error`, so the app-startup failure path would have thrown a
 *       TypeError on the very first failure it tried to report. Fixed by
 *       handing Winston our own `LEVELS` map.
 *
 *   D3  Redaction was top-level only. Fixed by `prepareFields` → `deepRedact`,
 *       shared with the Pino driver.
 *
 *   D5  No `winston-daily-rotate-file`. Files are ephemeral in a container and
 *       an unbounded writer fills the volume. Console only, unless
 *       LOG_FILE_ENABLED is explicitly set.
 */

/**
 * Winston's timestamp format writes a `timestamp` key; Pino writes `time`.
 * Renaming here rather than in the conformance suite means the two drivers
 * genuinely agree, instead of being massaged into agreeing at test time.
 */
const timeField = winston.format((info) => {
  const record = info as unknown as Record<string, unknown>;
  record.time = record.timestamp ?? new Date().toISOString();
  delete record.timestamp;
  return info;
});

const buildTransports = (options: LoggerOptions): winston.transport[] => {
  if (options.destination) {
    return [new winston.transports.Stream({ stream: options.destination })];
  }

  const transports: winston.transport[] = [new winston.transports.Console()];

  // D5: opt-in only, and still bounded. Left off in every deployed
  // environment — logs belong on stdout, where the platform collects them.
  if (options.fileEnabled) {
    transports.push(
      new winston.transports.File({
        filename: "logs/app.log",
        maxsize: 10 * 1024 * 1024,
        maxFiles: 3,
        tailable: true,
      }),
    );
  }

  return transports;
};

const wrap = (instance: winston.Logger): Logger => {
  /**
   * D1 lives here. Object-first in, Winston's message-first out.
   */
  const emit =
    (level: LogLevel) =>
    (a: LogFields | string, b?: string): void => {
      if (typeof a === "string") {
        instance.log(level, a);
        return;
      }
      instance.log(level, b ?? "", prepareFields(a));
    };

  return {
    trace: emit("trace"),
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    fatal: emit("fatal"),
    child: (fields: LogFields) => wrap(instance.child(prepareFields(fields))),
    isLevelEnabled: (level: LogLevel) => instance.isLevelEnabled(level),
    /**
     * Winston exposes no flush. Transports drain on the event loop, so
     * yielding twice lets queued writes reach the stream. This is best
     * effort — the deterministic path is Pino, which is why it is default.
     */
    flush: () =>
      new Promise<void>((resolve) => {
        setImmediate(() => setImmediate(resolve));
      }),
  } as Logger;
};

export const winstonDriver: LoggerDriver = {
  name: "winston",
  create(options: LoggerOptions): Logger {
    const instance = winston.createLogger({
      // D2: Winston has no fatal and no trace of its own.
      levels: LEVELS,
      level: options.level,
      defaultMeta: options.base,
      format: winston.format.combine(
        // Required, or Winston drops Error objects on the floor entirely.
        winston.format.errors({ stack: true }),
        winston.format.timestamp(),
        timeField(),
        winston.format.json(),
      ),
      transports: buildTransports(options),
    });

    return wrap(instance);
  },
};
