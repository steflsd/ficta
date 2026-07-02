import pino from "pino";
import pretty from "pino-pretty";
import { parseLogLevel } from "./log-level.js";

// The proxy's runtime logger. One pino instance, level driven by FICTA_LOG_LEVEL (pino's standard
// levels are a superset of ours — see log-level.ts). Everything writes to stderr (fd 2): stdout
// belongs to the wrapped agent's TUI, and logging to stderr is the Unix convention. The stream is
// synchronous so a short-lived CLI never loses buffered lines on exit (no worker-thread transport).
//
// Pretty when stderr is an interactive terminal; raw JSON lines when redirected/piped, so logs stay
// machine-parseable for aggregation. `base: undefined` drops pid/hostname from the JSON records too.
//
// Built lazily on the first actual log call, reading the env at that point. This matters for the
// agent wrapper: cli.ts imports plugin metadata at top level, and some plugins import this module for
// request-time warnings. Eager construction here would capture the environment before cli.ts sets
// `FICTA_LOG_LEVEL=silent`, causing request-time logs to garble the TUI.
function buildLogger() {
  const level = parseLogLevel(process.env.FICTA_LOG_LEVEL);
  // TTY → colorized pino-pretty on fd 2. Piped/redirected → JSON lines straight to the process.stderr
  // stream (fd 2). We pass the stream object (not pino.destination(fd:2)) so writes go through
  // process.stderr.write — Node flushes it on exit, and it stays observable to tests.
  const stream = process.stderr.isTTY
    ? pretty({ sync: true, destination: 2, colorize: true, ignore: "pid,hostname", translateTime: "HH:MM:ss" })
    : process.stderr;
  return pino({ level, base: undefined }, stream);
}

type PinoLogger = ReturnType<typeof buildLogger>;

let cachedLogger: PinoLogger | undefined;

function logger(): PinoLogger {
  if (!cachedLogger) cachedLogger = buildLogger();
  return cachedLogger;
}

export const log = new Proxy({} as PinoLogger, {
  get(_target, prop) {
    const instance = logger();
    const value = Reflect.get(instance, prop) as unknown;
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
