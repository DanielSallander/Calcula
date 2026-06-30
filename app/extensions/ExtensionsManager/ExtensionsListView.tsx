//! FILENAME: app/extensions/ExtensionsManager/ExtensionsListView.tsx
// PURPOSE: Extensions manager view for the Activity Bar side panel.
// CONTEXT: Lists every loaded extension with its trust class, signature status,
//          declared capabilities and sandbox state, and lets the user
//          enable/disable third-party extensions (built-ins are kernel-adjacent
//          and always on). This is the transparency surface for the vision's
//          "always know what code is present and what it can touch" rule.

import React, { useCallback, useEffect, useState } from "react";
import type { ActivityViewProps } from "@api/uiTypes";
import { getExtensionManager, describeCapability } from "@api";
import type { LoadedExtension, ExtensionStatus, CapabilityId } from "@api";

/** Status badge colors */
const STATUS_COLORS: Record<ExtensionStatus, { bg: string; text: string }> = {
  active: { bg: "#e6f4ea", text: "#137333" },
  pending: { bg: "#fef7e0", text: "#b06000" },
  error: { bg: "#fce8e6", text: "#c5221f" },
  inactive: { bg: "#f1f3f4", text: "#5f6368" },
};

/** Signature/verification badge appearance, keyed by sidecar trustStatus. */
const SIGNATURE_BADGES: Record<string, { label: string; bg: string; text: string; title: string }> = {
  verified: { label: "Signed", bg: "#e6f4ea", text: "#137333", title: "Signature verified against a known publisher key." },
  firstUse: { label: "Signed (new)", bg: "#e8f0fe", text: "#1967d2", title: "Signed by a publisher seen for the first time (trust-on-first-use)." },
  unsigned: { label: "Unsigned", bg: "#f1f3f4", text: "#5f6368", title: "No signature. Capabilities are denied by default." },
  invalid: { label: "Invalid signature", bg: "#fce8e6", text: "#c5221f", title: "Signature did not verify. Capabilities are denied by default." },
  publisherChanged: { label: "Publisher changed!", bg: "#fce8e6", text: "#c5221f", title: "The signing key changed since this extension was first trusted. Capabilities are denied by default." },
};

/**
 * Extensions manager view - lists all loaded extensions and controls them.
 */
export function ExtensionsListView(_props: ActivityViewProps): React.ReactElement {
  const [extensions, setExtensions] = useState<LoadedExtension[]>([]);

  const refresh = useCallback(() => {
    setExtensions([...getExtensionManager().getExtensions()]);
  }, []);

  useEffect(() => {
    refresh();
    const unsub = getExtensionManager().subscribe(refresh);
    return unsub;
  }, [refresh]);

  const errorCount = extensions.filter((e) => e.status === "error").length;
  const disabledCount = extensions.filter((e) => e.disabled).length;

  return (
    <div style={styles.container}>
      {/* Summary */}
      <div style={styles.summary}>
        <span style={styles.summaryText}>
          {extensions.length} extension{extensions.length !== 1 ? "s" : ""}
        </span>
        {errorCount > 0 && (
          <span style={styles.errorBadge}>{errorCount} error{errorCount !== 1 ? "s" : ""}</span>
        )}
        {disabledCount > 0 && (
          <span style={styles.disabledBadge}>{disabledCount} disabled</span>
        )}
      </div>

      {/* Extension list */}
      <div style={styles.list}>
        {extensions.length === 0 ? (
          <div style={styles.emptyState}>No managed extensions loaded</div>
        ) : (
          extensions.map((ext) => (
            <ExtensionItem key={ext.id} extension={ext} />
          ))
        )}
      </div>

      {/* Info footer */}
      <div style={styles.footer}>
        <div style={styles.footerText}>
          Built-in features are kernel-adjacent and always on. Third-party
          extensions can be disabled; enabling one takes effect on the next reload.
        </div>
      </div>
    </div>
  );
}

function ExtensionItem({ extension }: { extension: LoadedExtension }): React.ReactElement {
  const [isHovered, setIsHovered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const [uninstallError, setUninstallError] = useState<string | null>(null);
  const statusColor = STATUS_COLORS[extension.status];

  const isBuiltIn = extension.trust === "trusted";
  const isDisabled = extension.disabled === true;
  // B3: scanned but held back pending first-use consent (code never imported).
  const needsConsent = extension.needsConsent === true;
  // Enabled at the persisted level but not running yet -> awaiting a reload.
  const pendingReload = !isBuiltIn && !isDisabled && !needsConsent && extension.status === "inactive";
  const signature = extension.trustStatus ? SIGNATURE_BADGES[extension.trustStatus] : undefined;
  const caps = extension.declaredCapabilities ?? [];
  const canUninstall = !isBuiltIn && !!extension.fileName;

  const toggle = useCallback(async () => {
    setBusy(true);
    try {
      await getExtensionManager().setExtensionEnabled(extension.id, isDisabled);
    } finally {
      setBusy(false);
    }
  }, [extension.id, isDisabled]);

  const grant = useCallback(async () => {
    setBusy(true);
    try {
      await getExtensionManager().grantConsentAndActivate(extension.id);
      // On success the entry is replaced by the live (active) extension.
    } finally {
      setBusy(false);
    }
  }, [extension.id]);

  const uninstall = useCallback(async () => {
    setBusy(true);
    setUninstallError(null);
    try {
      await getExtensionManager().uninstallExtension(extension.id);
      // On success the entry disappears from the list (no further state needed).
    } catch (e) {
      setUninstallError(e instanceof Error ? e.message : String(e));
      setConfirmingUninstall(false);
      setBusy(false);
    }
  }, [extension.id]);

  return (
    <div
      style={{
        ...styles.item,
        backgroundColor: isHovered ? "#f7f7f7" : "transparent",
        opacity: isDisabled ? 0.65 : 1,
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div style={styles.itemHeader}>
        <span style={styles.itemName}>{extension.name}</span>
        <span style={{
          ...styles.statusBadge,
          backgroundColor: statusColor.bg,
          color: statusColor.text,
        }}>
          {isDisabled ? "disabled" : needsConsent ? "needs consent" : extension.status}
        </span>
      </div>

      <div style={styles.itemMeta}>
        <span style={styles.itemVersion}>v{extension.version}</span>
        <span style={styles.itemId}>{extension.id}</span>
      </div>

      {/* Trust / signature / sandbox badges */}
      <div style={styles.badgeRow}>
        <span style={{ ...styles.tagBadge, ...(isBuiltIn ? styles.builtInTag : styles.thirdPartyTag) }}>
          {isBuiltIn ? "Built-in" : "Third-party"}
        </span>
        {signature && (
          <span
            style={{ ...styles.tagBadge, backgroundColor: signature.bg, color: signature.text }}
            title={signature.title}
          >
            {signature.label}
          </span>
        )}
        {extension.worker && (
          <span style={{ ...styles.tagBadge, ...styles.sandboxTag }} title="Runs sandboxed in an isolated worker realm.">
            Sandboxed
          </span>
        )}
      </div>

      {/* Declared capabilities (third-party only) */}
      {!isBuiltIn && (
        <div style={styles.capRow}>
          {caps.length === 0 ? (
            <span style={styles.noCaps}>No capabilities (deny-by-default)</span>
          ) : (
            caps.map((c: CapabilityId) => (
              <span key={c} style={styles.capChip} title={describeCapability(c)}>
                {c}
              </span>
            ))
          )}
        </div>
      )}

      {extension.error && (
        <div style={styles.itemError}>{extension.error.message}</div>
      )}

      {uninstallError && (
        <div style={styles.itemError}>Uninstall failed: {uninstallError}</div>
      )}

      {/* Actions (third-party only) */}
      {!isBuiltIn && (
        <div style={styles.actionRow}>
          {pendingReload && !confirmingUninstall && (
            <span style={styles.reloadHint}>Reload to apply</span>
          )}
          {confirmingUninstall ? (
            <>
              <span style={styles.confirmHint}>Remove permanently?</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmingUninstall(false)}
                style={{ ...styles.actionButton, ...styles.disableButton }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={uninstall}
                style={{ ...styles.actionButton, ...styles.uninstallButton }}
              >
                Remove
              </button>
            </>
          ) : needsConsent ? (
            <>
              <span style={styles.confirmHint}>Not yet allowed to run</span>
              <button
                type="button"
                disabled={busy}
                onClick={grant}
                style={{ ...styles.actionButton, ...styles.enableButton }}
                title="Allow this third-party extension to load and run"
              >
                Allow
              </button>
              {canUninstall && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { setUninstallError(null); setConfirmingUninstall(true); }}
                  style={{ ...styles.actionButton, ...styles.disableButton }}
                  title="Delete this extension's files from disk"
                >
                  Uninstall
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={toggle}
                style={{ ...styles.actionButton, ...(isDisabled ? styles.enableButton : styles.disableButton) }}
              >
                {isDisabled ? "Enable" : "Disable"}
              </button>
              {canUninstall && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { setUninstallError(null); setConfirmingUninstall(true); }}
                  style={{ ...styles.actionButton, ...styles.disableButton }}
                  title="Delete this extension's files from disk"
                >
                  Uninstall
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
  },
  summary: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderBottom: "1px solid #e0e0e0",
    flexShrink: 0,
  },
  summaryText: {
    fontSize: 12,
    color: "#444",
    fontWeight: 500,
  },
  errorBadge: {
    fontSize: 10,
    color: "#c5221f",
    backgroundColor: "#fce8e6",
    padding: "1px 6px",
    borderRadius: 8,
  },
  disabledBadge: {
    fontSize: 10,
    color: "#5f6368",
    backgroundColor: "#f1f3f4",
    padding: "1px 6px",
    borderRadius: 8,
  },
  list: {
    flex: 1,
    overflowY: "auto",
    padding: "4px 0",
  },
  item: {
    padding: "8px 12px",
    cursor: "default",
    borderBottom: "1px solid #f0f0f0",
  },
  itemHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  itemName: {
    fontSize: 12,
    fontWeight: 600,
    color: "#333",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  statusBadge: {
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 8,
    flexShrink: 0,
  },
  itemMeta: {
    display: "flex",
    gap: 8,
    marginTop: 2,
  },
  itemVersion: {
    fontSize: 11,
    color: "#888",
  },
  itemId: {
    fontSize: 11,
    color: "#aaa",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  badgeRow: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 4,
    marginTop: 6,
  },
  tagBadge: {
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 4,
    fontWeight: 500,
  },
  builtInTag: {
    backgroundColor: "#ede7f6",
    color: "#5e35b1",
  },
  thirdPartyTag: {
    backgroundColor: "#e8f0fe",
    color: "#1967d2",
  },
  sandboxTag: {
    backgroundColor: "#e0f2f1",
    color: "#00695c",
  },
  capRow: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 4,
    marginTop: 6,
  },
  capChip: {
    fontSize: 10,
    fontFamily: "monospace",
    padding: "1px 5px",
    borderRadius: 3,
    backgroundColor: "#f1f3f4",
    color: "#3c4043",
    cursor: "help",
  },
  noCaps: {
    fontSize: 10,
    color: "#9aa0a6",
    fontStyle: "italic" as const,
  },
  itemError: {
    fontSize: 11,
    color: "#c5221f",
    marginTop: 4,
    padding: "3px 6px",
    backgroundColor: "#fce8e6",
    borderRadius: 3,
  },
  actionRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 8,
  },
  reloadHint: {
    fontSize: 10,
    color: "#b06000",
    fontStyle: "italic" as const,
  },
  confirmHint: {
    fontSize: 11,
    color: "#c5221f",
    fontWeight: 500,
  },
  uninstallButton: {
    backgroundColor: "#c5221f",
    color: "#fff",
  },
  actionButton: {
    fontSize: 11,
    padding: "3px 10px",
    borderRadius: 4,
    border: "1px solid transparent",
    cursor: "pointer",
  },
  disableButton: {
    backgroundColor: "#fff",
    borderColor: "#d0d0d0",
    color: "#5f6368",
  },
  enableButton: {
    backgroundColor: "#1967d2",
    color: "#fff",
  },
  emptyState: {
    padding: "24px 12px",
    textAlign: "center" as const,
    color: "#999",
    fontSize: 12,
  },
  footer: {
    padding: "8px 12px",
    borderTop: "1px solid #e0e0e0",
    flexShrink: 0,
  },
  footerText: {
    fontSize: 11,
    color: "#999",
    lineHeight: "1.4",
  },
};
