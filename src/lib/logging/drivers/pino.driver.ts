import pino from "pino";
import type {
  Logger,
  LoggerDriver,
  LoggerOptions,
  LogFields,
  LogLevel,
} from "../types";
import { prepareFields } from "../redact";
import { formattingStream, rendererFor } from "../pretty";
import { alsoWriteToSinks } from "../sinks";

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
  // A destination is only ever injected by a test or the conformance suite,
  // both of which read JSON. Formatting it would defeat the assertion — but it
  // still passes the sink registry, so a test exercises the same delivery path
  // production does rather than a shortcut around it.
  if (options.destination) return alsoWriteToSinks(options.destination);

  // The renderer runs as a plain Writable rather than a pino worker-thread
  // transport: worker transports cannot be flushed deterministically, which is
  // exactly what the exit path depends on. It is also the same renderer the
  // Winston driver uses, so the two produce identical human output — which
  // pino-pretty could never guarantee, since Winston cannot use it.
  const render = rendererFor(options.format);

  // Applied to what pino writes — the JSON — not to what the renderer
  // produces, so a sink receives records rather than coloured text.
  return alsoWriteToSinks(
    render ? formattingStream(render) : pino.destination({ dest: 1, sync: false }),
  );
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
