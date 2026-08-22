import { Writable } from "node:stream";

/**
 * Extra destinations for the serialised log stream.
 *
 * Both drivers write newline-delimited JSON, and both already send it through
 * one stream. Anything that wants a copy of every record — the OpenTelemetry
 * log bridge, and whatever comes after it — registers a sink here rather than
 * hooking into a driver. Two consequences worth having:
 *
 *   - There is one implementation, not a pino transport and a winston
 *     transport that drift. The whole point of LOG_DRIVER being swappable is
 *     that nothing downstream can tell which driver is loaded.
 *   - A sink sees the record exactly as it will be stored: after redaction,
 *     after error serialisation, with the child logger's correlation fields
 *     already merged. A hook any earlier would see a different object than
 *     the one on disk, which is how a redaction bypass gets shipped.
 *
 * With no sinks registered this costs one empty iteration per record, which is
 * the normal case: telemetry is off unless it has been configured.
 */

/**
 * Anything with a `write`. Wider than `NodeJS.WritableStream` because pino's
 * destination is a SonicBoom, which is write-compatible without implementing
 * the full interface.
 */
export interface WritableLike {
  write(chunk: string | Uint8Array): unknown;
  once?(event: string, listener: () => void): unknown;
}

const sinks = new Set<WritableLike>();

export function addLogSink(sink: WritableLike): void {
  sinks.add(sink);
}

export function removeLogSink(sink: WritableLike): void {
  sinks.delete(sink);
}

export function hasLogSinks(): boolean {
  return sinks.size > 0;
}

/** Test seam. */
export function __clearLogSinks(): void {
  sinks.clear();
}

/**
 * Wraps the driver's output so every record reaches the primary destination
 * and each registered sink.
 *
 * Backpressure is taken from the primary alone. A sink holds a copy; if the
 * collector's socket fills, the choice is between stalling the application's
 * own log output and dropping telemetry, and telemetry loses every time. A
 * sink that throws is swallowed for the same reason — a broken exporter must
 * not be able to fail a request by way of a log line.
 */
export function alsoWriteToSinks(primary: WritableLike): NodeJS.WritableStream {
  return new Writable({
    write(chunk, _encoding, callback) {
      for (const sink of sinks) {
        try {
          sink.write(chunk);
        } catch {
          // See above: a failing sink is never the application's problem.
        }
      }

      /*
       * Single-argument write, and the callback is ours to fire.
       *
       * The obvious `primary.write(chunk, encoding, callback)` is wrong here:
       * pino's destination is a SonicBoom, whose write() takes the data and
       * ignores everything after it. The callback would never fire, Node would
       * never ask for another chunk, and every record after the first would
       * sit in this stream's buffer forever — visibly, on stdout, as a log
       * that stops.
       */
      const flushed = primary.write(chunk);

      // Backpressure, where the primary can report it. A SonicBoom emits
      // 'drain'; anything without `once` is written to optimistically.
      if (flushed === false && typeof primary.once === "function") {
        primary.once("drain", callback);
        return;
      }

      callback();
    },
    final(callback) {
      callback();
    },
  });
}
