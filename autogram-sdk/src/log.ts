import loglevel from "loglevel";

export interface Logger {
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Verbosity of the SDK's console logging. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "silent";

/**
 * Only warnings and errors by default: debug/info output contains the
 * documents being signed, signing URLs (with the document key) and pairing
 * tokens, which must not end up in the console of a production page.
 */
let currentLevel: LogLevel = "warn";
const loggers: loglevel.Logger[] = [];

/**
 * Sets the verbosity of all SDK loggers (default `"warn"`).
 *
 * `"debug"` and `"trace"` print sensitive data — document contents,
 * signing URLs and pairing tokens — so enable them only while developing.
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
  // `false`: do not persist the level into the host page's localStorage
  loggers.forEach((log) => log.setLevel(level, false));
}

export function createLogger(name: string | symbol): Logger {
  const log = loglevel.getLogger(name);

  const originalFactory = log.methodFactory;
  log.methodFactory = function (methodName, logLevel, loggerName) {
    const rawMethod = originalFactory(methodName, logLevel, loggerName);

    return function (...messages: unknown[]) {
      rawMethod(loggerName.toString() + ": ", ...messages);
    };
  };
  // applies the method factory too
  log.setLevel(currentLevel, false);
  loggers.push(log);

  return log;
}
