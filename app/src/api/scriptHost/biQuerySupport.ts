//! FILENAME: app/src/api/scriptHost/biQuerySupport.ts
// PURPOSE: Shared helpers for the model-scoped bi.query capability (Wave 3).
//          The connection summary a script may see is built by WHITELISTING
//          non-sensitive fields — never connectionString / server / database /
//          credentials — so listing connections can't leak how to reach them.

/** The non-sensitive connection summary exposed to scripts via bi.query. */
export interface BiConnectionSummary {
  id: string;
  name: string;
  connectionType: string;
  isConnected: boolean;
  tableCount: number;
  measureCount: number;
}

/**
 * Project a backend ConnectionInfo down to the script-safe summary. Whitelist,
 * not blacklist: only these fields ever cross to a script, so a future field
 * added to ConnectionInfo (e.g. another credential) can never leak by default.
 */
export function toBiConnectionSummary(conn: Record<string, unknown>): BiConnectionSummary {
  return {
    id: String(conn.id ?? ""),
    name: String(conn.name ?? ""),
    connectionType: String(conn.connectionType ?? ""),
    isConnected: Boolean(conn.isConnected),
    tableCount: Number(conn.tableCount ?? 0),
    measureCount: Number(conn.measureCount ?? 0),
  };
}
