/**
 * Logger tối giản: một dòng mỗi sự kiện, dạng `scope message key=value`.
 *
 * Không kéo thư viện log vì daemon chỉ cần đọc được trên Railway và terminal; khi cần
 * truy vấn log có cấu trúc thì dữ liệu quan trọng đã nằm trong `fetch_runs` và `llm_calls`.
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
    // biome-ignore lint/suspicious/noConsole: đây chính là logger
    info: (msg: string, fields?: Fields) => console.log(format(scope, msg, fields)),
    warn: (msg: string, fields?: Fields) => console.warn(format(scope, msg, fields)),
    error: (msg: string, fields?: Fields) => console.error(format(scope, msg, fields)),
  };
}

export type Logger = ReturnType<typeof createLogger>;
