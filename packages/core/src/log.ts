/**
 * Minimal logger: one line per event, in the form `scope message key=value`.
 *
 * No logging library: the daemon only needs to be readable on Railway and in the terminal; when
 * structured log queries are needed, the important data already lives in `fetch_runs` and `llm_calls`.
 */
type Fields = Record<string, unknown>;

function format(scope: string, msg: string, fields?: Fields): string {
  const extra = fields
    ? Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ")
    : "";
  return `${new Date().toISOString()} ${scope} ${msg}${extra ? ` ${extra}` : ""}`;
}

export function createLogger(scope: string) {
  return {
    // biome-ignore lint/suspicious/noConsole: this is the logger itself
    info: (msg: string, fields?: Fields) => console.log(format(scope, msg, fields)),
    warn: (msg: string, fields?: Fields) => console.warn(format(scope, msg, fields)),
    error: (msg: string, fields?: Fields) => console.error(format(scope, msg, fields)),
  };
}

export type Logger = ReturnType<typeof createLogger>;
