//! FILENAME: app/src/api/ribbonCollapse.tsx
// PURPOSE: Shared utilities for progressive ribbon group collapsing.
// CONTEXT: When the window is resized smaller, ribbon groups collapse progressively
//          into compact dropdown buttons, like Excel's ribbon behavior.

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import ReactDOM from "react-dom";
import { css } from "@emotion/css";

// ============================================================================
// Hook: useRibbonCollapse
// ============================================================================

export interface RibbonGroupDef {
  /** Collapse priority. Lower number = collapses first. */
  collapseOrder: number;
  /** Estimated expanded width in pixels. */
  expandedWidth: number;
}

/** Width of a collapsed group button. */
const COLLAPSED_WIDTH = 64;

/**
 * Hook that determines which ribbon groups should be collapsed based on
 * the available container width. Groups collapse progressively in order
 * of their `collapseOrder` (lowest first).
 *
 * @param containerRef - Ref to the ribbon tab container element.
 * @param groupDefs - Array of group definitions (one per group).
 * @param gap - Gap between groups in pixels (default 0).
 * @param reservedWidth - Extra width to reserve for elements outside groupDefs
 *   (e.g. a styles gallery that manages its own responsive collapse).
 * @returns Array of booleans, one per group, where `true` = collapsed.
 */
export function useRibbonCollapse(
  containerRef: React.RefObject<HTMLElement | null>,
  groupDefs: RibbonGroupDef[],
  gap = 0,
  reservedWidth = 0,
): boolean[] {
  const [collapsed, setCollapsed] = useState<boolean[]>(() =>
    groupDefs.map(() => false),
  );

  // Memoize the sorted order to avoid recalculating on every render
  const sortedIndices = useMemo(() => {
    return groupDefs
      .map((g, i) => ({ collapseOrder: g.collapseOrder, index: i }))
      .sort((a, b) => a.collapseOrder - b.collapseOrder)
      .map((g) => g.index);
  }, [groupDefs]);

  // Track the actual DOM element so the observer re-attaches when the ref
  // becomes available (e.g. after a conditional render gate like "Select a
  // Table to see design options" is replaced by the real content).
  const [observedEl, setObservedEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el !== observedEl) setObservedEl(el);
  });

  useEffect(() => {
    if (!observedEl) return;

    const calculate = (containerWidth: number) => {
      const totalGap = Math.max(0, groupDefs.length - 1) * gap;
      let totalExpanded = groupDefs.reduce((s, g) => s + g.expandedWidth, 0) + totalGap + reservedWidth;

      const result = new Array(groupDefs.length).fill(false);

      // Progressively collapse groups until everything fits
      for (const idx of sortedIndices) {
        if (totalExpanded <= containerWidth) break;
        result[idx] = true;
        totalExpanded -= (groupDefs[idx].expandedWidth - COLLAPSED_WIDTH);
      }

      setCollapsed(result);
    };

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        calculate(entry.contentRect.width);
      }
    });
    observer.observe(observedEl);
    return () => observer.disconnect();
  }, [observedEl, groupDefs, sortedIndices, gap, reservedWidth]);

  return collapsed;
}

// ============================================================================
// Component: RibbonGroup
// ============================================================================

const groupStyles = {
  // Expanded group
  expanded: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 12px 2px 12px;
    border-right: 1px solid #e0e0e0;
    flex-shrink: 0;
    height: 100%;
    box-sizing: border-box;

    &:first-child {
      padding-left: 8px;
    }

    &:last-child {
      border-right: none;
      padding-right: 8px;
    }
  `,
  expandedContent: css`
    display: flex;
    gap: 8px;
    align-items: center;
    flex: 1;
  `,
  label: css`
    font-size: 10px;
    color: #888;
    text-align: center;
    margin-top: auto;
    padding-top: 2px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    white-space: nowrap;
    line-height: 1;
    padding-bottom: 2px;
  `,

  // Collapsed group button
  collapsedWrapper: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 4px 8px 2px 8px;
    border-right: 1px solid #e0e0e0;
    flex-shrink: 0;
    height: 100%;
    box-sizing: border-box;

    &:last-child {
      border-right: none;
      padding-right: 0;
    }
  `,
  collapsedButton: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    padding: 6px 10px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    min-width: 56px;
    white-space: nowrap;

    &:hover {
      background: #e8e8e8;
      border-color: #d0d0d0;
    }

    &:active {
      background: #d6d6d6;
    }
  `,
  collapsedIcon: css`
    font-size: 24px;
    line-height: 1;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #1a6b3c;
  `,
  collapsedLabel: css`
    display: flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    color: #333;
    font-weight: 500;
    white-space: nowrap;
  `,
  collapsedArrow: css`
    font-size: 8px;
    color: #666;
    margin-left: 1px;
  `,

  // Dropdown popover
  dropdownOverlay: css`
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 1099;
  `,
  dropdown: css`
    position: fixed;
    z-index: 1100;
    background: #ffffff;
    border: 1px solid #d0d0d0;
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    padding: 10px 14px;
  `,
};

interface RibbonGroupProps {
  /** Group label shown below the content (and on collapsed button). */
  label: string;
  /** Icon for the collapsed button (string emoji or JSX). */
  icon?: React.ReactNode;
  /** Whether this group is currently collapsed. */
  collapsed: boolean;
  /** The expanded group content. */
  children: React.ReactNode;
}

/**
 * A ribbon group that can be expanded or collapsed.
 * When collapsed, renders a compact button. Clicking it opens a popover
 * with the expanded content.
 */
export function RibbonGroup({
  label,
  icon,
  collapsed,
  children,
}: RibbonGroupProps): React.ReactElement {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  // Close dropdown when escape is pressed
  useEffect(() => {
    if (!dropdownOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDropdownOpen(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [dropdownOpen]);

  // Close dropdown when group becomes expanded again
  useEffect(() => {
    if (!collapsed) setDropdownOpen(false);
  }, [collapsed]);

  const handleToggle = useCallback(() => {
    if (buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect());
    }
    setDropdownOpen((prev) => !prev);
  }, []);

  if (collapsed) {
    return (
      <div className={groupStyles.collapsedWrapper}>
        <button
          ref={buttonRef}
          className={groupStyles.collapsedButton}
          onClick={handleToggle}
          title={label}
        >
          <span className={groupStyles.collapsedIcon}>
            {icon ?? "\u2630"}
          </span>
          <span className={groupStyles.collapsedLabel}>
            {label} <span className={groupStyles.collapsedArrow}>&#9660;</span>
          </span>
        </button>

        {dropdownOpen && anchorRect && ReactDOM.createPortal(
          <>
            <div
              className={groupStyles.dropdownOverlay}
              onClick={() => setDropdownOpen(false)}
            />
            <div
              className={groupStyles.dropdown}
              style={{
                top: anchorRect.bottom + 2,
                left: Math.max(4, anchorRect.left - 20),
              }}
            >
              {children}
            </div>
          </>,
          document.body,
        )}
      </div>
    );
  }

  return (
    <div className={groupStyles.expanded}>
      <div className={groupStyles.expandedContent}>{children}</div>
      <div className={groupStyles.label}>{label}</div>
    </div>
  );
}
