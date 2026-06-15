// FILENAME: app/extensions/Distribution/components/SubscriptionManagerPane.tsx
// PURPOSE: Task pane listing all .calp subscriptions with management actions (D6).
// CONTEXT: Wires the previously caller-less calp_get_subscriptions + calp_detach
//          so the user can see what they're subscribed to (package, pinned vs
//          resolved version, registry, sheet count) and detach — instead of
//          subscriptions being invisible in-memory state.

import React, { useState, useEffect, useCallback } from "react";
import { getSubscriptions, detach, emitAppEvent, onAppEvent, AppEvents } from "@api";
import type { Subscription } from "@api/distribution";

export function SubscriptionManagerPane(): React.ReactElement {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDetach, setConfirmingDetach] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const manifest = await getSubscriptions();
      setSubs(manifest.subscriptions);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // Re-list when the workbook changes (pull / refresh / detach touch subscriptions).
    const unsub = onAppEvent(AppEvents.SHEET_CHANGED, refresh);
    return unsub;
  }, [refresh]);

  const handleDetachAll = useCallback(async () => {
    setError(null);
    try {
      await detach();
      setConfirmingDetach(false);
      emitAppEvent(AppEvents.SHEET_CHANGED, {});
      await refresh();
    } catch (e: unknown) {
      setError(String(e));
    }
  }, [refresh]);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.headerText}>
          {subs.length} subscription{subs.length !== 1 ? "s" : ""}
        </span>
        <button onClick={refresh} disabled={loading} style={styles.smallBtn}>
          {loading ? "..." : "Refresh list"}
        </button>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.list}>
        {subs.length === 0 ? (
          <div style={styles.empty}>
            Not subscribed to any package. Use <strong>Data &rarr; Subscribe to Package</strong>.
          </div>
        ) : (
          subs.map((s) => {
            const stale = s.versionPin !== s.resolvedVersion && s.versionPin !== `=${s.resolvedVersion}`;
            return (
              <div key={`${s.packageName}@${s.registryUrl}`} style={styles.item}>
                <div style={styles.itemHeader}>
                  <span style={styles.pkgName}>{s.packageName}</span>
                  <span style={styles.version}>
                    {s.resolvedVersion}
                    {stale && <span style={styles.pinHint}> (pin {s.versionPin})</span>}
                  </span>
                </div>
                <div style={styles.meta}>{s.registryUrl}</div>
                <div style={styles.meta}>
                  {s.sheets.length} sheet{s.sheets.length !== 1 ? "s" : ""} · resolved {s.resolvedAt}
                </div>
              </div>
            );
          })
        )}
      </div>

      {subs.length > 0 && (
        <div style={styles.footer}>
          {confirmingDetach ? (
            <>
              <span style={styles.confirmHint}>Detach from all packages?</span>
              <button onClick={() => setConfirmingDetach(false)} style={styles.smallBtn}>Cancel</button>
              <button onClick={handleDetachAll} style={{ ...styles.smallBtn, ...styles.danger }}>Detach all</button>
            </>
          ) : (
            <button onClick={() => setConfirmingDetach(true)} style={styles.smallBtn}>
              Detach all subscriptions
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", fontSize: 13 },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 12px", borderBottom: "1px solid #e0e0e0", flexShrink: 0 },
  headerText: { fontSize: 12, color: "#444", fontWeight: 500 },
  list: { flex: 1, overflowY: "auto", padding: "4px 0" },
  item: { padding: "8px 12px", borderBottom: "1px solid #f0f0f0" },
  itemHeader: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
  pkgName: { fontWeight: 600, color: "#333", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  version: { fontSize: 12, color: "#1967d2", flexShrink: 0 },
  pinHint: { color: "#b06000", fontStyle: "italic" as const },
  meta: { fontSize: 11, color: "#888", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  footer: { padding: "8px 12px", borderTop: "1px solid #e0e0e0", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, flexShrink: 0 },
  confirmHint: { fontSize: 12, color: "#c5221f", marginRight: "auto" },
  smallBtn: { fontSize: 12, padding: "3px 10px", borderRadius: 4, border: "1px solid #d0d0d0", background: "#fff", cursor: "pointer" },
  danger: { background: "#c5221f", color: "#fff", borderColor: "#c5221f" },
  error: { color: "#c5221f", fontSize: 12, padding: "6px 12px" },
  empty: { padding: "24px 12px", textAlign: "center" as const, color: "#999", fontSize: 12, lineHeight: 1.5 },
};
