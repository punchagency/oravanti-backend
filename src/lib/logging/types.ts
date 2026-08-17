/**
 * The logging contract.
 *
 * Object-first, message-last — `log.info({ leadId }, "lead created")`.
 * That is Pino's native shape and the reverse of Winston's; the Winston
 * driver absorbs the translation so call sites never learn which driver
 * is loaded. Nothing outside `src/lib/logging` imports pino or winston.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * How a record is written out.
 *
 *   json         One record per line. The only format a log shipper can parse,
 *                and therefore the only one production may use.
 *   pretty       Coloured header plus aligned fields. The default locally.
 *   json-pretty  Indented JSON. Still parses when copied out of the terminal.
 *
 * Rendering lives in `pretty.ts` and is shared, so the format a record is read
 * in is independent of the driver that wrote it.
 */
export type LogFormat = "json" | "pretty" | "json-pretty";

export interface LogFields {
  [key: string]: unknown;
  /** An Error, or anything thrown. Serialised to { type, message, stack }. */
  err?: unknown;
}

export interface Logger {
  trace(fields: LogFields, msg: string): void;
  trace(msg: string): void;
  debug(fields: LogFields, msg: string): void;
  debug(msg: string): void;
  info(fields: LogFields, msg: string): void;
  info(msg: string): void;
  warn(fields: LogFields, msg: string): void;
  warn(msg: string): void;
  error(fields: LogFields, msg: string): void;
  error(msg: string): void;
  fatal(fields: LogFields, msg: string): void;
  fatal(msg: string): void;

  /** Returns a logger that merges `fields` into every record it writes. */
  child(fields: LogFields): Logger;

  isLevelEnabled(level: LogLevel): boolean;

  /**
   * Both drivers buffer. Await this before a deliberate exit or the last
   * records — usually the ones explaining the exit — are lost.
   */
  flush(): Promise<void>;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Output shape. Anything other than `json` is for a human, not a shipper. */
  format: LogFormat;
  /** Merged into every record. Service name, version, environment. */
  base: Record<string, unknown>;
  /** Winston only, and off by default — see D5. */
  fileEnabled: boolean;
  /** Where records go. Injectable so the conformance suite can capture them. */
  destination?: NodeJS.WritableStream;
}

export interface LoggerDriver {
  readonly name: "pino" | "winston";
  create(options: LoggerOptions): Logger;
}
