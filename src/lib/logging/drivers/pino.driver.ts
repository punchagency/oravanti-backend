import pino from "pino";
import prettyStream from "pino-pretty";
import type {
  Logger,
  LoggerDriver,
  LoggerOptions,
  LogFields,
  LogLevel,
} from "../types";
import { prepareFields } from "../redact";

/**
 * Pino driver — the default.
 *
 * Two settings exist purely for parity with Winston, and they are the two
 * traps the conformance suite is built to catch:
 *
 *   formatters.level  Pino emits `"level": 30` by default; Winston emits
 *                     `"level": "info"`. Without this the drivers disagree
 *                     on every single record.
 *   messageKey        Pino's default is `msg`, Winston's is `message`.
 *
 * Pino has all six of our levels natively (trace…fatal), so no custom level
 * map is needed here — unlike Winston, which is missing two (D2).
 *
 * Pino's native `redact` option is deliberately NOT used. `deepRedact` has
 * already run over the fields by the time they reach pino, so a second pass
 * could only diverge from what the Winston driver produces, and would buy no
 * speed on data that is already clean.
 */

const buildStream = (options: LoggerOptions) => {
  if (options.destination) return options.destination;

  // pino-pretty is used as a plain stream rather than a worker-thread
  // transport: worker transports cannot be flushed deterministically, which
  // is exactly what the exit path depends on.
  if (options.pretty) {
    return prettyStream({
      colorize: true,
      messageKey: "message",
      translateTime: "HH:MM:ss.l",
    });
  }

  return pino.destination({ dest: 1, sync: false });
};

const wrap = (instance: pino.Logger): Logger => {
  const emit =
    (level: LogLevel) =>
    (a: LogFields | string, b?: string): void => {
      if (typeof a === "string") {
        instance[level](a);
        return;
      }
      instance[level](prepareFields(a), b ?? "");
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
    flush: () =>
      new Promise<void>((resolve) => {
        instance.flush(() => resolve());
      }),
  } as Logger;
};

export const pinoDriver: LoggerDriver = {
  name: "pino",
  create(options: LoggerOptions): Logger {
    const instance = pino(
      {
        level: options.level,
        messageKey: "message",
        // Emit the label, not pino's numeric level, so Winston agrees.
        formatters: { level: (label) => ({ level: label }) },
        /*
          Pino serialises the `err` key by default, and pino-std-serializers
          treats anything carrying a `stack` as error-like. Our `err` has
          already been through serialiseError(), so pino would re-serialise
          the result and overwrite `type` with the plain object's constructor
          name — "Object" instead of "TypeError". Winston does no such thing,
          so this is a parity break as well as wrong on its own terms.
          serialiseError() is the single source of truth for error shape.
        */
        serializers: { err: (value: unknown) => value },
        timestamp: pino.stdTimeFunctions.isoTime,
        // Replaces pino's default { pid, hostname } bindings outright.
        base: options.base,
      },
      buildStream(options),
    );

    return wrap(instance);
  },
};
