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
  /** Lower collapses first. */
  collapsePriority: number;
  /** Already height-demoted or declared launcher — occupies launcher width. */
  alreadyLauncher: boolean;
}

/**
 * Given measured section widths and the band width, decide which sections
 * demote to launchers to make the strip fit. Deterministic: demote in
 * ascending collapsePriority until the total fits (or all are launchers).
 */
export function computeWidthDemotions(
  sections: WidthDemotionInput[],
  containerWidth: number,
): Set<string> {
  const demoted = new Set<string>();
  if (containerWidth <= 0) return demoted;

  const widthOf = (s: WidthDemotionInput): number =>
    s.alreadyLauncher || demoted.has(s.id) ? LAUNCHER_BAND_WIDTH : s.width;

  let total = sections.reduce((sum, s) => sum + widthOf(s), 0);
  if (total <= containerWidth) return demoted;

  const candidates = sections
    .filter((s) => !s.alreadyLauncher)
    .sort((a, b) => a.collapsePriority - b.collapsePriority);

  for (const s of candidates) {
    if (total <= containerWidth) break;
    demoted.add(s.id);
    total -= s.width - LAUNCHER_BAND_WIDTH;
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
 * Height-fit decision for one ribbon section.
 * - "launcher": always demoted, never probed.
 * - "inline": never demoted (the band's overflow clip is the backstop).
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
      if (!el || declared !== null) return;
      if (typeof ResizeObserver === "undefined") return;

      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const height = entry.contentRect.height;
          const width = entry.contentRect.width;
          onNaturalWidthRef.current?.(width);
          if (shouldDemoteForHeight(height)) {
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
