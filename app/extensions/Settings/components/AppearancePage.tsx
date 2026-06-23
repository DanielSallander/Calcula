//! FILENAME: app/extensions/Settings/components/AppearancePage.tsx
// PURPOSE: Appearance (App Skin) picker for the Settings panel — gallery of skins
//          with live-preview swatches, an advisory "managed by org" banner, and
//          accessibility toggles. Distinct from the Office-style Document Theme.
// CONTEXT: Extension UI — imports ONLY from @api (facade rule).

import React, { useEffect, useState } from "react";
import {
  listAvailableSkins,
  getActiveSkinId,
  setActiveSkin,
  subscribeToAppearance,
  getSkinTokens,
  getSkinGridTheme,
  getManagedAppearanceInfo,
  refreshManagedAppearance,
  getUserAccessibility,
  setUserAccessibility,
  type Skin,
  type AccessibilityOverride,
  type EffectiveAppearancePolicy,
} from "@api";

/** A small live-preview of a skin built from its resolved (non-applied) values. */
function SkinSwatch({ skin }: { skin: Skin }): React.ReactElement {
  const t = getSkinTokens(skin);
  const grid = getSkinGridTheme(skin);
  const v = (name: string, fallback: string) => t[name] ?? fallback;
  return (
    <div
      style={{
        width: "100%",
        height: 64,
        borderRadius: 4,
        overflow: "hidden",
        border: `1px solid ${v("--border-default", "#d1d5db")}`,
        background: v("--grid-bg", "#ffffff"),
        position: "relative",
      }}
    >
      {/* menu/title strip */}
      <div style={{ height: 12, background: v("--menu-bar-bg", "#3c3c3c") }} />
      {/* header row */}
      <div style={{ height: 12, background: v("--grid-header-bg", "#f8f9fa"), borderBottom: `1px solid ${grid.headerBorder}` }} />
      {/* grid body with a selection rectangle + accent dot */}
      <div style={{ position: "relative", height: 40, background: grid.cellBackground }}>
        <div style={{ position: "absolute", top: 6, left: 8, width: 28, height: 16, border: `1.5px solid ${grid.selectionBorder}`, background: grid.selectionBackground }} />
        <div style={{ position: "absolute", top: 8, right: 10, width: 18, height: 6, borderRadius: 3, background: v("--accent-primary", "#10b981") }} />
        <div style={{ position: "absolute", bottom: 6, left: 8, fontSize: 8, color: grid.cellText, fontFamily: grid.cellFontFamily }}>Aa 123</div>
      </div>
    </div>
  );
}

export function AppearancePage(): React.ReactElement {
  const [skins, setSkins] = useState<Skin[]>(() => listAvailableSkins());
  const [activeId, setActiveId] = useState<string>(() => getActiveSkinId());
  const [managed, setManaged] = useState<EffectiveAppearancePolicy | null>(() => getManagedAppearanceInfo());
  const [a11y, setA11y] = useState<AccessibilityOverride>(() => getUserAccessibility());

  // Keep the highlighted card + list in sync with any appearance change.
  useEffect(() => {
    const refresh = () => {
      setSkins(listAvailableSkins());
      setActiveId(getActiveSkinId());
      setManaged(getManagedAppearanceInfo());
    };
    const unsub = subscribeToAppearance(refresh);
    // The managed policy resolves asynchronously just after boot; re-check shortly.
    const t = window.setTimeout(refresh, 400);
    return () => {
      unsub();
      window.clearTimeout(t);
    };
  }, []);

  const [checking, setChecking] = useState(false);

  const updateA11y = (patch: Partial<AccessibilityOverride>) => {
    const next = { ...a11y, ...patch };
    setA11y(next);
    setUserAccessibility(next);
  };

  const checkForUpdates = async () => {
    setChecking(true);
    try {
      await refreshManagedAppearance();
      setSkins(listAvailableSkins());
      setActiveId(getActiveSkinId());
      setManaged(getManagedAppearanceInfo());
    } finally {
      setChecking(false);
    }
  };

  return (
    <div style={styles.content}>
      {managed?.managed && (
        <div style={styles.managedBanner}>
          <div style={styles.managedTitle}>
            Default appearance suggested by {managed.managedBy || "your organization"}
          </div>
          <div style={styles.managedDetail}>
            Source: {managed.registryUrl || "(local)"} · Signed: {managed.publisherFingerprint || "—"} · Trust: {managed.trust}
            {managed.version ? ` · v${managed.version}` : ""}
          </div>
          <div style={styles.managedNote}>You can change the appearance freely below — this is only the starting default.</div>
          {managed.registryUrl && (
            <button style={styles.checkButton} onClick={checkForUpdates} disabled={checking}>
              {checking ? "Checking…" : "Check for updates"}
            </button>
          )}
        </div>
      )}

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Skin</div>
        <div style={styles.gallery}>
          {skins.map((skin) => {
            const isActive = skin.id === activeId;
            return (
              <button
                key={skin.id}
                style={isActive ? { ...styles.card, ...styles.cardActive } : styles.card}
                onClick={() => setActiveSkin(skin.id)}
                title={skin.name}
              >
                <SkinSwatch skin={skin} />
                <div style={styles.cardLabelRow}>
                  <span style={styles.cardName}>{skin.name}</span>
                  <span style={styles.baseBadge}>{skin.base}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Accessibility</div>
        <div style={styles.settingHint}>These always apply on top of the chosen skin and are never overridden.</div>

        <label style={styles.checkRow}>
          <input
            type="checkbox"
            checked={!!a11y.highContrast}
            onChange={(e) => updateA11y({ highContrast: e.target.checked })}
            style={styles.checkInput}
          />
          <span>High contrast</span>
        </label>

        <label style={styles.checkRow}>
          <input
            type="checkbox"
            checked={!!a11y.reducedMotion}
            onChange={(e) => updateA11y({ reducedMotion: e.target.checked })}
            style={styles.checkInput}
          />
          <span>Reduce motion</span>
        </label>

        <div style={styles.setting}>
          <div style={styles.settingLabel}>Force base</div>
          <select
            style={styles.select}
            value={a11y.forcedBase ?? "auto"}
            onChange={(e) => {
              const val = e.target.value;
              updateA11y({ forcedBase: val === "auto" ? null : (val as "light" | "dark") });
            }}
          >
            <option value="auto">Auto (use the skin's base)</option>
            <option value="light">Always light</option>
            <option value="dark">Always dark</option>
          </select>
        </div>

        <div style={styles.setting}>
          <div style={styles.settingLabel}>Minimum text size</div>
          <select
            style={styles.select}
            value={String(a11y.minFontScale ?? 1)}
            onChange={(e) => updateA11y({ minFontScale: parseFloat(e.target.value) })}
          >
            <option value="1">Default</option>
            <option value="1.25">Large (125%)</option>
            <option value="1.5">Larger (150%)</option>
          </select>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  content: {
    flex: 1,
    overflow: "auto",
    padding: "14px 16px",
    color: "var(--text-primary)",
  },
  managedBanner: {
    marginBottom: 20,
    padding: "10px 12px",
    borderRadius: 4,
    border: "1px solid var(--border-default)",
    background: "var(--panel-bg)",
  },
  managedTitle: { fontSize: 12, fontWeight: 600, color: "var(--text-primary)" },
  managedDetail: { fontSize: 10.5, color: "var(--text-secondary)", marginTop: 4, fontFamily: "'Cascadia Code', 'Consolas', monospace" },
  managedNote: { fontSize: 11, color: "var(--text-tertiary)", marginTop: 6 },
  checkButton: {
    marginTop: 8,
    padding: "4px 10px",
    fontSize: 11,
    borderRadius: 4,
    border: "1px solid var(--border-default)",
    background: "var(--bg-surface)",
    color: "var(--text-primary)",
    cursor: "pointer",
  },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    color: "var(--text-secondary)",
    marginBottom: 14,
    paddingBottom: 6,
    borderBottom: "1px solid var(--border-default)",
  },
  gallery: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
    gap: 10,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: 6,
    borderRadius: 6,
    border: "2px solid transparent",
    background: "var(--bg-surface)",
    cursor: "pointer",
    textAlign: "left" as const,
  },
  cardActive: { borderColor: "var(--accent-primary)" },
  cardLabelRow: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  cardName: { fontSize: 12, fontWeight: 500, color: "var(--text-primary)" },
  baseBadge: {
    fontSize: 9,
    textTransform: "uppercase" as const,
    color: "var(--text-tertiary)",
    border: "1px solid var(--border-default)",
    borderRadius: 3,
    padding: "1px 4px",
  },
  setting: { marginTop: 12 },
  settingLabel: { fontSize: 12, fontWeight: 500, color: "var(--text-primary)", marginBottom: 6 },
  settingHint: { fontSize: 11, color: "var(--text-tertiary)", marginBottom: 12, lineHeight: "1.5" },
  checkRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-primary)", cursor: "pointer", marginBottom: 8 },
  checkInput: { margin: 0, cursor: "pointer", accentColor: "var(--accent-primary)" },
  select: {
    width: "100%",
    padding: "6px 8px",
    fontSize: 12,
    borderRadius: 4,
    border: "1px solid var(--border-default)",
    background: "var(--bg-surface)",
    color: "var(--text-primary)",
    cursor: "pointer",
    outline: "none",
  },
};
