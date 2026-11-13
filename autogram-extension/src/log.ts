import loglevel from "loglevel";
// import prefix from "loglevel-plugin-prefix";
// prefix.reg(loglevel);
// prefix.apply(loglevel);

type Logger = loglevel.Logger & {
  addListener: (
    callback: (
      level: string,
      loggerName: string | symbol,
      args: unknown[]
    ) => void
  ) => void;
  removeListener: (
    callback: (
      level: string,
      loggerName: string | symbol,
      args: unknown[]
    ) => void
  ) => void;
  listeners: Array<
    (level: string, loggerName: string | symbol, args: unknown[]) => void
  >;
};

/** Development builds (and tests, where the define is absent) log everything. */
const VERBOSE = typeof __IS_PRODUCTION__ === "undefined" || !__IS_PRODUCTION__;

export function createLogger(name: string | symbol) {
  const log: Logger = loglevel.getLogger(name) as Logger;

  log.listeners = [];
  log.addListener = function (
    callback: (
      level: string,
      loggerName: string | symbol,
      args: unknown[]
    ) => void
  ) {
    log.listeners.push(callback);
  };
  log.removeListener = function (
    callback: (
      level: string,
      loggerName: string | symbol,
      args: unknown[]
    ) => void
  ) {
    log.listeners = log.listeners.filter((listener) => listener !== callback);
  };

  const originalFactory = log.methodFactory;
  log.methodFactory = function (methodName, logLevel, loggerName) {
    const rawMethod = originalFactory(methodName, logLevel, loggerName);

    return function (...messages: unknown[]) {
      log.listeners.forEach((listener) => {
        listener(methodName, loggerName, messages);
      });
      rawMethod(loggerName.toString() + ": ", ...messages);
    };
  };
  // Release builds log warnings and errors only: debug/info output carries
  // the documents being signed and signing URLs, and the inject bundle
  // logs into the console of the government portal it runs in.
  // `false`: never persist the level into the host page's localStorage.
  log.setLevel(VERBOSE ? "trace" : "warn", false);

  // prefix.apply(log, {
  //   format(level, name, timestamp) {
  //     return `[${timestamp}] [${level.toUpperCase()}](${level})} ${name}:`;
  //   },
  // });

  return log;
}
