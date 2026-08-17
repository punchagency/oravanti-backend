import { loadLoggerOptions } from "./config";
import { pinoDriver } from "./drivers/pino.driver";
import { winstonDriver } from "./drivers/winston.driver";
import type { Logger, LoggerDriver, LoggerOptions } from "./types";

export type {
  Logger,
  LoggerDriver,
  LoggerOptions,
  LogFields,
  LogFormat,
  LogLevel,
} from "./types";
export {
  LEVELS,
  LOG_FORMATS,
  OTEL_SEVERITY,
  REDACT_KEYS,
  loadLoggerOptions,
} from "./config";
export { deepRedact, serialiseError } from "./redact";
export { renderJsonPretty, renderPretty } from "./pretty";
export { pinoDriver } from "./drivers/pino.driver";
export { winstonDriver } from "./drivers/winston.driver";

const DRIVERS: Record<string, LoggerDriver> = {
  pino: pinoDriver,
  winston: winstonDriver,
};

export const DRIVER_NAMES = Object.keys(DRIVERS);

/**
 * Resolves LOG_DRIVER.
 *
 * An unknown value throws rather than falling back to the default. A silent
 * fallback is worse than a crash here: you would believe you had switched
 * drivers, and every conclusion you drew from the output afterwards would be
 * about the driver you thought you had replaced.
 */
export function resolveDriver(name = process.env.LOG_DRIVER?.trim() || "pino"): LoggerDriver {
  const driver = DRIVERS[name];

  if (!driver) {
    throw new Error(
      `Unknown LOG_DRIVER "${name}". Expected one of: ${DRIVER_NAMES.join(", ")}`,
    );
  }

  return driver;
}

export function createLogger(options?: Partial<LoggerOptions>): Logger {
  return resolveDriver().create(loadLoggerOptions(options));
}

let rootLogger: Logger | undefined;

/**
 * The process-wide logger.
 *
 * Built on first use so that importing this module has no side effects — a
 * script or a test can import the types without standing up a logger.
 *
 * This is the base logger, without correlation fields. Application code should
 * not call it directly: use the helpers in `log.ts`, which go through
 * `getServiceLogger()` and so carry the current request's `requestId`.
 */
export function getLogger(): Logger {
  if (!rootLogger) rootLogger = createLogger();
  return rootLogger;
}

/**
 * Test seam. Installs a logger for the process — normally one built with a
 * `destination` stream so a suite can assert on the records that are actually
 * emitted, rather than on a mock of the logging API.
 *
 * Preferred over jest.mock() for anything that logs: it exercises the real
 * drivers, so redaction and serialisation are covered by the same assertion.
 */
export function __setLogger(logger: Logger): void {
  rootLogger = logger;
}

/** Test seam. Resets the memoised root logger. */
export function __resetLogger(): void {
  rootLogger = undefined;
}
