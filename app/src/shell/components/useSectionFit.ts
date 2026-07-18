//! FILENAME: app/src/shell/components/useSectionFit.ts
// PURPOSE: Decides whether a ribbon section renders inline or demotes to a
//          launcher, by declaration (ribbonPresentation) or live measurement.
// CONTEXT: The safety net that makes ANY panel placeable in the ribbon: a
//          section whose natural height exceeds the band demotes to a launcher
//          flyout instead of clipping. Decisions are cached at module level
//          keyed by panelId+sectionId so remounts (contextual tabs re-register
//          on every selection change) render the remembered form immediately
//          with no probe flash. A demoted section stays demoted for the app
//          session (the inline content is unmounted, so it cannot be
//          re-measured); growth WHILE inline demotes live via ResizeObserver.

import { useCallback, useEffect, useRef, useState } from "react";
import type { SectionRibbonPresentation } from "../../api/uiTypes";
import { DEMOTE_HEIGHT, LAUNCHER_BAND_WIDTH } from "../../api/layout";

// ============================================================================
// Module-level fit cache (survives unregister/re-register churn)
// ============================================================================

const sectionFitCache = new Map<string, boolean>();

/** Test/skin-change hook: forget all measured demotion decisions. */
export function clearSectionFitCache(): void {
  sectionFitCache.clear();
}

// ============================================================================
// Pure decision helpers (unit-testable without a DOM)
// ============================================================================

/** Whether a measured natural height demotes an "auto" section. */
export function shouldDemoteForHeight(naturalHeight: number): boolean {
  return naturalHeight > DEMOTE_HEIGHT;
}

export interface WidthDemotionInput {
  id: string;
  /** Measured natural inline width (content + chrome), px. */
  width: number;
  /**
   * Measured rendered width of this section's LAUNCHER cell (chrome included).
   * Real launchers are usually much wider than the 64px token (min-width 56 +
   * padding + a label up to 110px + cell chrome) — modeling them at 64 made
   * the collapse stop several hundred px too early on section-heavy tabs
   * (Chart Design), leaving a permanently overflowing strip. Unmeasured
   * launchers fall back to LAUNCHER_BAND_WIDTH until their probe reports.
   */
  launcherWidth?: number;
  /** Lower collapses first. */
  collapsePriority: number;
  /** Already height-demoted or declared launcher — occupies launcher width. */
  alreadyLauncher: boolean;
}

/**
 * Given measured section widths and the band width, decide which sections
 * demote to launchers to make the strip fit. Deterministic: demote in
 * ascending collapsePriority until the total fits (or all are launchers).
 *
 * `extraDemotions` demotes that many candidates BEYOND the model's fit point —
 * the renderer's DOM-truth backstop uses it when the strip's real scrollWidth
 * still overflows after the modeled demotions (constant drift, lost probe).
 *
 * Sections whose inline form is no wider than their launcher are never
 * demoted for width: swapping them would grow the strip, not shrink it.
 */
export function computeWidthDemotions(
  sections: WidthDemotionInput[],
  containerWidth: number,
  extraDemotions = 0,
): Set<string> {
  const demoted = new Set<string>();
  if (containerWidth <= 0) return demoted;

  const launcherWidthOf = (s: WidthDemotionInput): number =>
    s.launcherWidth ?? LAUNCHER_BAND_WIDTH;
  const widthOf = (s: WidthDemotionInput): number =>
    s.alreadyLauncher || demoted.has(s.id) ? launcherWidthOf(s) : s.width;

  let total = sections.reduce((sum, s) => sum + widthOf(s), 0);

  const candidates = sections
    .filter((s) => !s.alreadyLauncher && s.width > launcherWidthOf(s))
    .sort((a, b) => a.collapsePriority - b.collapsePriority);

  let forced = extraDemotions;
  for (const s of candidates) {
    if (total <= containerWidth) {
      if (forced <= 0) break;
      forced -= 1;
    }
    demoted.add(s.id);
    total -= s.width - launcherWidthOf(s);
  }
  return demoted;
}

// ============================================================================
// Hook
// ============================================================================

export interface SectionFit {
  /** True when the section renders as a launcher (height-demoted or declared). */
  demoted: boolean;
  /** Attach to the unclipped sizer element wrapping the inline content. */
  probeRef: (el: HTMLElement | null) => void;
}

/**
 * Fit decision for one ribbon section.
 * - "launcher": always demoted, never probed.
 * - "inline": never height-demoted (the band's overflow clip is the height
 *   backstop), but still width-probed — the renderer's width-overflow collapse
 *   sums real widths across the whole strip and may demote the section under
 *   width pressure through its own `widthDemoted` channel.
 * - "auto": measured via ResizeObserver on the sizer; demotes when the natural
 *   height exceeds DEMOTE_HEIGHT, live (covers content that grows at runtime).
 *
 * `onNaturalWidth` reports the sizer's natural width for the renderer's
 * width-overflow collapse.
 */
export function useSectionFit(
  cacheKey: string,
  presentation: SectionRibbonPresentation,
  onNaturalWidth?: (width: number) => void,
): SectionFit {
  const declared =
    presentation === "launcher" ? true : presentation === "inline" ? false : null;

  const [measuredDemoted, setMeasuredDemoted] = useState<boolean>(
    () => sectionFitCache.get(cacheKey) ?? false,
  );
  const observerRef = useRef<ResizeObserver | null>(null);
  // Latest-callback ref, updated in an effect (the observer only reads it
  // asynchronously, so effect timing is sufficient).
  const onNaturalWidthRef = useRef(onNaturalWidth);
  useEffect(() => {
    onNaturalWidthRef.current = onNaturalWidth;
  }, [onNaturalWidth]);

  // Re-sync when the key changes (cell reused for a different section) —
  // render-time state adjustment per the "storing information from previous
  // renders" pattern, so the stale section's decision never paints.
  const [prevKey, setPrevKey] = useState(cacheKey);
  if (prevKey !== cacheKey) {
    setPrevKey(cacheKey);
    setMeasuredDemoted(sectionFitCache.get(cacheKey) ?? false);
  }

  const probeRef = useCallback(
    (el: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      // "launcher" never mounts inline content, so there is nothing to probe.
      if (!el || declared === true) return;
      if (typeof ResizeObserver === "undefined") return;

      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const height = entry.contentRect.height;
          const width = entry.contentRect.width;
          // EVERY inline-rendered section ("inline" and "auto") reports its
          // natural width: the width-overflow collapse sums real widths across
          // the whole strip. Skipping declared-inline sections here made the
          // renderer under-count them at launcher width, so strips dominated
          // by wide inline sections (Chart Design) overflowed instead of
          // folding.
          onNaturalWidthRef.current?.(width);
          // Height demotion stays "auto"-only; "inline" trusts the author.
          if (declared === null && shouldDemoteForHeight(height)) {
            sectionFitCache.set(cacheKey, true);
            setMeasuredDemoted(true);
          }
        }
      });
      observer.observe(el);
      observerRef.current = observer;
    },
    [cacheKey, declared],
  );

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  return { demoted: declared ?? measuredDemoted, probeRef };
}
