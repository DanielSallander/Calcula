//! FILENAME: app/extensions/Settings/components/AppearancePage.tsx
// PURPOSE: Appearance (App Skin) picker for the Settings panel — gallery of skins
//          with live-preview swatches, an advisory "managed by org" banner, the
//          user's own ribbon/accent preferences, and accessibility toggles.
//          Distinct from the Office-style Document Theme.
// CONTEXT: Extension UI — imports ONLY from @api (facade rule).
//
//          Calcula Clusters: every control here is an @api/layout primitive
//          (Checkbox, Dropdown, SegmentedChoice, ColorSwatch, Chip, Button), so
//          the page follows the skin it is choosing. Chrome paints only with
//          LT tokens; this file is under the chrome hex ban.
//
//          SKIN CARDS SHOW THE SKIN. Each card's preview is drawn from that
//          skin's own merged tokens (getSkinTokens), not the active one's: a
//          10px activity rail, the ribbon frame with its tab indicator, the band
//          with two cluster cards (radius, tint, hairline and the state accent
//          all from the skin), and a sliver of grid from its GridTheme. Those
//          colours are the skin's DATA, so the preview carries data-colour-data.
//          A token whose value points at another (`var(--state-accent)`,
//          `color-mix(..., var(--state-accent) 14%, ...)`) is resolved against
//          the SAME skin's map — left as-is it would resolve against whatever
//          skin is active and every card would wear the current accent.
//
//          E2E CONTRACT: skin cards stay `<button title={skin.name}>`
//          (appearance-skins.spec clicks `button[title="Dark"]`).

import React, { useEffect, useState } from "react";
import { css } from "@emotion/css";
import {
  listAvailableSkins,
  getActiveSkinId,
  setActiveSkin,
  subscribeToAppearance,
  getSkinTokens,
  getSkinGridTheme,
  getRibbonLabelMode,
  setRibbonLabelMode,
  getUserTokenOverrides,
  setUserTokenOverrides,
  type AccessibilityOverride,
  type RibbonLabelMode,
  type Skin,
} from "@api/appearance";
import {
  getManagedAppearanceInfo,
  refreshManagedAppearance,
  getUserAccessibility,
  setUserAccessibility,
  type EffectiveAppearancePolicy,
  type SkinTrust,
} from "@api/appearancePolicy";
import {
  Button,
  Checkbox,
  Chip,
  ColorSwatch,
  Dropdown,
  Field,
  FONT_FAMILY,
  FONT_MONO,
  HEADER_FONT_SIZE,
  LT,
  SegmentedChoice,
  normalizeHex,
  type ChipTone,
  type DropdownOption,
} from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";

/**
 * How each org-skin trust state is shown. EVERY member of `SkinTrust` has a row
 * — the map is typed `Record<SkinTrust, ...>`, so adding a Rust variant without
 * a presentation here is a TypeScript error rather than an unlabelled badge.
 *
 * The rule this enforces: a state that is not "the key I expected" must never
 * read as reassuring. `notPinned` is a valid signature by an unrecognised
 * signer — authentic, not trusted — and it says so. The tone is the Chip's
 * semantic colour (ok / warn / danger), so it follows the skin and high
 * contrast instead of being a fixed green or red.
 */
const SKIN_TRUST_PRESENTATION: Record<SkinTrust, { label: string; tone: ChipTone; title: string }> = {
  verified: {
    label: "verified",
    tone: "ok",
    title: "Signed by the publisher key your administrator pinned in policy.json.",
  },
  firstUse: {
    label: "trusted just now",
    tone: "warn",
    title: "This publisher key was pinned by this operation (trust-on-first-use).",
  },
  firstUseKnownPublisher: {
    label: "trusted just now — publisher already known",
    tone: "warn",
    title:
      "This registry was not trusted for this skin package before, but the same publisher key " +
      "is already trusted for it from another registry — a move, a mirror, or the same location " +
      "spelled differently.",
  },
  firstUseAcceptedNameConflict: {
    label: "trusted DESPITE a name conflict",
    tone: "danger",
    title:
      "Another registry holds this skin package name under a DIFFERENT publisher key, and this " +
      "key was recorded anyway. Two registries claiming one name is what a hijack looks like.",
  },
  notPinned: {
    label: "NOT trusted — unrecognised signer",
    tone: "danger",
    title:
      "The skin pack's signature is valid, but this computer has never agreed to trust that " +
      "publisher for this registry. A valid signature only proves the file was not altered after " +
      "signing — anyone can generate a key and sign. The skin is not applied. Your administrator " +
      "must set publisherKey in policy.json to the org's key.",
  },
  notPinnedNameConflict: {
    label: "NOT trusted — NAME CONFLICT with another registry",
    tone: "danger",
    title:
      "Another registry is already trusted for this skin package name under a DIFFERENT " +
      "publisher key, and this one is not trusted here. The skin is not applied.",
  },
  unsigned: {
    label: "unsigned",
    tone: "warn",
    title: "No publisher key was expected, so the pack was applied as advisory unsigned data.",
  },
  unknown: {
    label: "rejected — signature missing or invalid",
    tone: "danger",
    title: "A signature was required but was missing or did not verify. The skin was not applied.",
  },
};

/** A trust state this build does not know reads as the worst case. */
function trustPresentation(trust: string): { label: string; tone: ChipTone; title: string } {
  return (
    (SKIN_TRUST_PRESENTATION as Record<string, { label: string; tone: ChipTone; title: string }>)[
      trust
    ] ?? {
      label: `unrecognised (${trust})`,
      tone: "danger",
      title: `Unrecognised trust state '${trust}'.`,
    }
  );
}

// ============================================================================
// Token helpers
// ============================================================================

const VAR_REFERENCE = /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^()]*))?\)/;

/**
 * A token's value with every `var(--x)` inside it replaced by the SAME map's
 * `--x`, recursively (bounded, so a cyclic skin cannot hang the page). An
 * unknown reference falls back to its own fallback, else `transparent`.
 */
function resolveSkinToken(tokens: Record<string, string>, name: string): string {
  let value = tokens[name] ?? "transparent";
  for (let i = 0; i < 8; i++) {
    const m = VAR_REFERENCE.exec(value);
    if (!m) break;
    const replacement = tokens[m[1]] ?? m[2]?.trim() ?? "transparent";
    value = value.slice(0, m.index) + replacement + value.slice(m.index + m[0].length);
  }
  return value;
}

/** WCAG 2 contrast ratio of a hex colour against white, or null for non-hex. */
function contrastOnWhite(color: string | null | undefined): number | null {
  const hex = normalizeHex(color);
  if (hex === null) return null;
  const linear = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  return 1.05 / (luminance + 0.05);
}

/** Below this an accent reads as a thin mark on white controls (WCAG 1.4.11). */
const MIN_ACCENT_CONTRAST = 3;

/** The tokens an accent pick writes: the pressed tint and the state colour. */
const ACCENT_TOKENS = ["--accent-primary", "--state-accent"] as const;

// ============================================================================
// Styles
// ============================================================================

const s = {
  content: css`
    flex: 1;
    overflow: auto;
    padding: 14px 16px;
    color: ${LT.text};
    font-family: ${FONT_FAMILY};
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 22px;
  `,
  /** The one panel header recipe: 12px/600, sentence case. */
  sectionTitle: css`
    margin: 0;
    font-family: ${FONT_FAMILY};
    font-size: ${HEADER_FONT_SIZE}px;
    font-weight: 600;
    line-height: 16px;
    color: ${LT.text};
  `,
  hint: css`
    margin: 0;
    font-size: 11px;
    line-height: 1.5;
    color: ${LT.textSecondary};
  `,

  // ---- managed banner --------------------------------------------------------
  banner: css`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    margin-bottom: 20px;
    padding: 10px 12px;
    border-radius: ${LT.radiusCluster};
    background: ${LT.clusterBg};
    box-shadow: inset 0 0 0 1px ${LT.clusterBorder};
  `,
  bannerTitle: css`
    font-size: ${HEADER_FONT_SIZE}px;
    font-weight: 600;
    color: ${LT.text};
  `,
  bannerDetail: css`
    font-family: ${FONT_MONO};
    font-size: 11px;
    line-height: 1.45;
    color: ${LT.textSecondary};
    overflow-wrap: anywhere;
  `,
  bannerTrust: css`
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: ${LT.textSecondary};
  `,
  bannerError: css`
    align-self: stretch;
    padding: 6px 8px;
    border-radius: ${LT.radiusControl};
    background: ${LT.dangerBg};
    color: ${LT.dangerFg};
    font-size: 11px;
    line-height: 1.45;
  `,

  // ---- skin gallery ----------------------------------------------------------
  gallery: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(136px, 1fr));
    gap: 10px;
  `,
  card: css`
    display: flex;
    flex-direction: column;
    gap: 7px;
    box-sizing: border-box;
    min-width: 0;
    padding: 7px;
    border: none;
    border-radius: ${LT.radiusCluster};
    background: ${LT.surface};
    box-shadow: inset 0 0 0 1px ${LT.controlBorder};
    color: ${LT.text};
    cursor: pointer;
    font-family: ${FONT_FAMILY};
    text-align: left;
    transition: box-shadow ${LT.motionHover};

    &:hover {
      box-shadow: inset 0 0 0 1px ${LT.clusterBorderHover}, ${LT.shadowClusterHover};
    }

    &[aria-pressed="true"],
    &[aria-pressed="true"]:hover {
      box-shadow: inset 0 0 0 2px ${LT.stateAccent};
    }

    &:focus-visible {
      outline: none;
      box-shadow: ${LT.focusRing};
    }
  `,
  cardLabelRow: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-width: 0;
  `,
  cardName: css`
    min-width: 0;
    overflow: hidden;
    font-size: 12px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  cardMeta: css`
    display: inline-flex;
    align-items: center;
    flex: none;
    font-size: 11px;
    color: ${LT.textSecondary};
  `,
  cardCheck: css`
    display: inline-flex;
    flex: none;
    color: ${LT.stateAccent};
  `,

  // ---- preview (every colour inside is the skin's DATA) ----------------------
  preview: css`
    display: flex;
    height: 60px;
    overflow: hidden;
    border-radius: 6px;
  `,
  previewMain: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  `,

  // ---- customise -------------------------------------------------------------
  accentRow: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  `,
  accentValue: css`
    font-family: ${FONT_MONO};
    font-size: 11px;
    color: ${LT.textSecondary};
  `,
};

// ============================================================================
// Skin preview
// ============================================================================

/** A radius token scaled into the preview (a 12px cluster reads as ~5px). */
function scaledRadius(value: string, scale: number, max: number): number {
  const px = parseFloat(value);
  return Number.isFinite(px) ? Math.max(0, Math.min(px * scale, max)) : 2;
}

/** A small live-preview of a skin built from its resolved (non-applied) values:
 *  the rail, the ribbon frame and band with two cluster cards, and the grid. */
function SkinPreview({ skin }: { skin: Skin }): React.ReactElement {
  const tokens = getSkinTokens(skin);
  const grid = getSkinGridTheme(skin);
  const t = (name: string) => resolveSkinToken(tokens, name);

  const clusterRadius = scaledRadius(t("--radius-cluster"), 0.4, 6);
  const controlRadius = scaledRadius(t("--radius-control"), 0.35, 4);
  const cluster: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 3,
    minWidth: 0,
    padding: "0 4px",
    borderRadius: clusterRadius,
    background: t("--ribbon-cluster-bg"),
    boxShadow: `inset 0 0 0 1px ${t("--ribbon-cluster-border")}`,
  };
  const textLine: React.CSSProperties = {
    flex: 1,
    height: 3,
    borderRadius: 2,
    background: t("--text-secondary"),
    opacity: 0.55,
  };

  return (
    <div
      className={s.preview}
      data-colour-data=""
      data-testid={`appearance-skin-preview-${skin.id}`}
      aria-hidden
      style={{ boxShadow: `inset 0 0 0 1px ${t("--border-default")}`, background: grid.cellBackground }}
    >
      {/* Activity rail: 10px, active item + indicator, two idle items. */}
      <div
        data-preview-part="rail"
        style={{ position: "relative", width: 10, flex: "none", background: t("--activity-bar-bg") }}
      >
        <span
          style={{
            position: "absolute",
            left: 2,
            top: 13,
            width: 6,
            height: 8,
            borderRadius: 2,
            background: t("--activity-bar-item-active-bg"),
          }}
        />
        <span
          style={{
            position: "absolute",
            left: 0,
            top: 14,
            width: 2,
            height: 6,
            borderRadius: 1,
            background: t("--activity-bar-indicator"),
          }}
        />
        {[28, 38].map((top) => (
          <span
            key={top}
            style={{
              position: "absolute",
              left: 3,
              top,
              width: 4,
              height: 4,
              borderRadius: 2,
              background: t("--activity-bar-fg"),
              opacity: 0.6,
            }}
          />
        ))}
      </div>

      <div className={s.previewMain}>
        {/* Ribbon frame: the tab strip with the active tab's indicator. */}
        <div
          data-preview-part="frame"
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 4,
            height: 10,
            padding: "0 6px",
            flex: "none",
            background: t("--ribbon-frame-bg"),
          }}
        >
          <span style={{ width: 14, height: 2, borderRadius: 1, background: t("--ribbon-tab-indicator") }} />
          <span style={{ width: 10, height: 2, borderRadius: 1, background: t("--text-tertiary"), opacity: 0.4 }} />
        </div>

        {/* Band with two cluster cards. */}
        <div
          data-preview-part="band"
          style={{
            display: "flex",
            gap: 3,
            height: 24,
            flex: "none",
            boxSizing: "border-box",
            padding: 3,
            background: t("--ribbon-band-bg"),
            borderBottom: `1px solid ${t("--border-default")}`,
          }}
        >
          <div data-preview-part="cluster" style={{ ...cluster, flex: 3 }}>
            <span
              style={{
                width: 10,
                height: 10,
                flex: "none",
                borderRadius: controlRadius,
                background: t("--state-accent"),
              }}
            />
            <span style={textLine} />
          </div>
          <div data-preview-part="cluster" style={{ ...cluster, flex: 2 }}>
            <span
              style={{
                width: 10,
                height: 10,
                flex: "none",
                borderRadius: controlRadius,
                background: t("--button-pressed-bg"),
                boxShadow: `inset 0 0 0 1px ${t("--button-pressed-border")}`,
              }}
            />
            <span style={textLine} />
          </div>
        </div>

        {/* A sliver of grid: header row, a selection, some text. */}
        <div style={{ position: "relative", flex: 1, background: grid.cellBackground }}>
          <div
            style={{
              height: 5,
              background: t("--grid-header-bg"),
              borderBottom: `1px solid ${grid.headerBorder}`,
            }}
          />
          <div
            style={{
              position: "absolute",
              top: 8,
              left: 6,
              width: 24,
              height: 8,
              border: `1.5px solid ${grid.selectionBorder}`,
              background: grid.selectionBackground,
            }}
          />
          <div
            style={{
              position: "absolute",
              top: 8,
              right: 6,
              fontSize: 8,
              lineHeight: "10px",
              color: grid.cellText,
              fontFamily: grid.cellFontFamily,
            }}
          >
            Aa 123
          </div>
        </div>
      </div>
    </div>
  );
}

function SkinCard({ skin, active }: { skin: Skin; active: boolean }): React.ReactElement {
  return (
    <button
      type="button"
      className={s.card}
      title={skin.name}
      aria-pressed={active}
      data-testid={`appearance-skin-${skin.id}`}
      onClick={() => setActiveSkin(skin.id)}
    >
      <SkinPreview skin={skin} />
      <span className={s.cardLabelRow}>
        <span className={s.cardName}>{skin.name}</span>
        {active ? (
          <span className={s.cardCheck} aria-hidden>
            <RibbonIcon.Check size={16} />
          </span>
        ) : (
          <span className={s.cardMeta}>{skin.base === "dark" ? "Dark" : "Light"}</span>
        )}
      </span>
    </button>
  );
}

// ============================================================================
// Page
// ============================================================================

const LABEL_MODE_OPTIONS: ReadonlyArray<{ value: RibbonLabelMode; label: string; testId: string }> = [
  { value: "show", label: "Show", testId: "appearance-ribbon-labels-show" },
  { value: "hide", label: "Hide", testId: "appearance-ribbon-labels-hide" },
];

type ForcedBaseChoice = "auto" | "light" | "dark";

const FORCED_BASE_OPTIONS: ReadonlyArray<DropdownOption<ForcedBaseChoice>> = [
  { value: "auto", label: "Auto (use the skin's base)" },
  { value: "light", label: "Always light" },
  { value: "dark", label: "Always dark" },
];

const FONT_SCALE_OPTIONS: ReadonlyArray<DropdownOption<number>> = [
  { value: 1, label: "Default" },
  { value: 1.25, label: "Large (125%)" },
  { value: 1.5, label: "Larger (150%)" },
];

export function AppearancePage(): React.ReactElement {
  const [skins, setSkins] = useState<Skin[]>(() => listAvailableSkins());
  const [activeId, setActiveId] = useState<string>(() => getActiveSkinId());
  const [managed, setManaged] = useState<EffectiveAppearancePolicy | null>(() => getManagedAppearanceInfo());
  const [a11y, setA11y] = useState<AccessibilityOverride>(() => getUserAccessibility());
  const [labelMode, setLabelMode] = useState<RibbonLabelMode>(() => getRibbonLabelMode());
  const [userTokens, setUserTokens] = useState<Record<string, string>>(() => getUserTokenOverrides());

  // Keep the highlighted card + list + preferences in sync with any
  // appearance change (a skin switch, a label-mode flip from the View menu, an
  // accent set elsewhere).
  useEffect(() => {
    const refresh = () => {
      setSkins(listAvailableSkins());
      setActiveId(getActiveSkinId());
      setManaged(getManagedAppearanceInfo());
      setLabelMode(getRibbonLabelMode());
      setUserTokens(getUserTokenOverrides());
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

  const changeLabelMode = (mode: RibbonLabelMode) => {
    setLabelMode(mode);
    setRibbonLabelMode(mode);
  };

  // ---- accent -------------------------------------------------------------
  // The override is the user's; the skin's own accent is what shows without
  // one. setUserTokenOverrides REPLACES the whole set, so an accent change
  // keeps any other override the user has.
  const activeSkin = skins.find((sk) => sk.id === activeId) ?? null;
  const accentOverride = normalizeHex(userTokens["--state-accent"]);
  const skinAccent = activeSkin
    ? normalizeHex(resolveSkinToken(getSkinTokens(activeSkin), "--state-accent"))
    : null;
  const accentShown = accentOverride ?? skinAccent;
  const accentContrast = accentOverride ? contrastOnWhite(accentOverride) : null;
  const lowContrast = accentContrast !== null && accentContrast < MIN_ACCENT_CONTRAST;

  const chooseAccent = (hex: string) => {
    const next: Record<string, string> = { ...getUserTokenOverrides() };
    for (const name of ACCENT_TOKENS) next[name] = hex;
    setUserTokenOverrides(next);
    setUserTokens(getUserTokenOverrides());
  };

  const resetAccent = () => {
    const rest: Record<string, string> = { ...getUserTokenOverrides() };
    for (const name of ACCENT_TOKENS) delete rest[name];
    setUserTokenOverrides(Object.keys(rest).length > 0 ? rest : null);
    setUserTokens(getUserTokenOverrides());
  };

  const trust = managed ? trustPresentation(managed.trust) : null;

  return (
    <div className={s.content} data-testid="appearance-page">
      {managed?.managed && trust && (
        <div className={s.banner} data-testid="appearance-managed">
          <div className={s.bannerTitle}>
            Default appearance suggested by {managed.managedBy || "your organization"}
          </div>
          <div className={s.bannerDetail}>
            Source: {managed.registryUrl || "(local)"} · Signed: {managed.publisherFingerprint || "—"}
            {managed.version ? ` · v${managed.version}` : ""}
          </div>
          <div className={s.bannerTrust}>
            Trust
            <Chip tone={trust.tone} title={trust.title} testId="appearance-managed-trust">
              {trust.label}
            </Chip>
          </div>
          {managed.policyError && (
            <div className={s.bannerError} role="alert">
              {managed.policyError}
            </div>
          )}
          <p className={s.hint}>You can change the appearance freely below — this is only the starting default.</p>
          {managed.registryUrl && (
            <Button
              variant="outlined"
              size="sm"
              icon={<RibbonIcon.Refresh size={16} />}
              onClick={checkForUpdates}
              disabled={checking}
            >
              {checking ? "Checking…" : "Check for updates"}
            </Button>
          )}
        </div>
      )}

      <section className={s.section} aria-labelledby="appearance-skin-heading">
        <h3 id="appearance-skin-heading" className={s.sectionTitle}>
          Skin
        </h3>
        <div className={s.gallery}>
          {skins.map((skin) => (
            <SkinCard key={skin.id} skin={skin} active={skin.id === activeId} />
          ))}
        </div>
      </section>

      <section className={s.section} aria-labelledby="appearance-customize-heading">
        <h3 id="appearance-customize-heading" className={s.sectionTitle}>
          Customize
        </h3>

        <Field label="Ribbon group labels">
          <SegmentedChoice<RibbonLabelMode>
            ariaLabel="Ribbon group labels"
            value={labelMode}
            onChange={changeLabelMode}
            options={LABEL_MODE_OPTIONS}
            testId="appearance-ribbon-labels"
          />
        </Field>

        <Field label="Accent colour">
          <div className={s.accentRow}>
            <ColorSwatch
              color={accentShown}
              onChange={chooseAccent}
              label="Accent colour"
              showTheme={false}
              testId="appearance-accent"
            />
            <span className={s.accentValue} data-testid="appearance-accent-value">
              {accentShown === null
                ? "Skin default"
                : `${accentShown.toUpperCase()}${accentOverride ? "" : " (skin)"}`}
            </span>
            <Button
              variant="outlined"
              size="sm"
              onClick={resetAccent}
              disabled={accentOverride === null}
              data-testid="appearance-accent-reset"
            >
              Reset
            </Button>
          </div>
        </Field>
        {lowContrast && accentContrast !== null && (
          <div>
            <Chip
              tone="warn"
              icon={<RibbonIcon.Warn size={14} />}
              title="Focus rings, ticks and selected states in this colour may be hard to see on white."
              testId="appearance-accent-contrast"
            >
              Low contrast: {accentContrast.toFixed(1)}:1 on white
            </Chip>
          </div>
        )}
        <p className={s.hint}>
          The accent marks selection, focus and checked controls. It is layered over the skin, so
          switching skins keeps it until you reset it.
        </p>
      </section>

      <section className={s.section} aria-labelledby="appearance-a11y-heading">
        <h3 id="appearance-a11y-heading" className={s.sectionTitle}>
          Accessibility
        </h3>
        <p className={s.hint}>These always apply on top of the chosen skin and are never overridden.</p>

        <div>
          <Checkbox
            checked={!!a11y.highContrast}
            onChange={(checked) => updateA11y({ highContrast: checked })}
            label="High contrast"
            testId="appearance-high-contrast"
          />
        </div>
        <div>
          <Checkbox
            checked={!!a11y.reducedMotion}
            onChange={(checked) => updateA11y({ reducedMotion: checked })}
            label="Reduce motion"
            testId="appearance-reduced-motion"
          />
        </div>

        <Field label="Force base">
          <Dropdown<ForcedBaseChoice>
            ariaLabel="Force base"
            value={a11y.forcedBase ?? "auto"}
            options={FORCED_BASE_OPTIONS}
            onChange={(val) => updateA11y({ forcedBase: val === "auto" ? null : val })}
            testId="appearance-forced-base"
            optionTestIdPrefix="appearance-forced-base-"
          />
        </Field>

        <Field label="Minimum text size">
          <Dropdown<number>
            ariaLabel="Minimum text size"
            value={a11y.minFontScale ?? 1}
            options={FONT_SCALE_OPTIONS}
            onChange={(val) => updateA11y({ minFontScale: val })}
            testId="appearance-min-font-scale"
            optionTestIdPrefix="appearance-min-font-scale-"
          />
        </Field>
      </section>
    </div>
  );
}
