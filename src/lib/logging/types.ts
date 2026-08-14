/**
 * The logging contract.
 *
 * Object-first, message-last — `log.info({ leadId }, "lead created")`.
 * That is Pino's native shape and the reverse of Winston's; the Winston
 * driver absorbs the translation so call sites never learn which driver
 * is loaded. Nothing outside `src/lib/logging` imports pino or winston.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

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
  /** Human-readable output for local development. Never enable in production. */
  pretty: boolean;
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
