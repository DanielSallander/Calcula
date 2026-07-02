//! FILENAME: app/src/api/layout/primitives/containers.tsx
// PURPOSE: Orientation-aware container primitives: Group, Stack, ControlRow,
//          Grow, ActionRow.
// CONTEXT: Composition building blocks that read SurfaceLayoutContext, so one
//          JSX tree renders as a horizontal ribbon group or a vertical sidebar
//          block. See @api/layout/context.ts for the geometry contract.

import React from "react";
import { useSurfaceLayout } from "../context";
import {
  GAP_MD,
  GAP_SM,
  GAP_XS,
  GROUP_LABEL_FONT_SIZE,
  FONT_FAMILY,
  LABEL_FONT_SIZE,
  RIBBON_CONTENT_HEIGHT,
} from "../tokens";

// ============================================================================
// Group — sub-grouping inside a section
// ============================================================================

export interface GroupProps {
  label: string;
  children: React.ReactNode;
}

/**
 * A labeled sub-group. Band: mini column with a 10px uppercase label below
 * (the classic ribbon-group look). Panel/popover: bold sub-header above a
 * vertical block.
 */
export function Group({ label, children }: GroupProps): React.ReactElement {
  const layout = useSurfaceLayout();

  if (layout.container === "band") {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          boxSizing: "border-box",
          minWidth: 0,
        }}
      >
        <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
        <div
          style={{
            fontSize: GROUP_LABEL_FONT_SIZE,
            color: "var(--text-tertiary)",
            textAlign: "center",
            marginTop: 2,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            fontFamily: FONT_FAMILY,
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: GAP_XS }}>
      <div
        style={{
          fontSize: LABEL_FONT_SIZE,
          fontWeight: 600,
          opacity: 0.7,
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          fontFamily: FONT_FAMILY,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

// ============================================================================
// Stack — cross-axis stack
// ============================================================================

export interface StackProps {
  gap?: number;
  children: React.ReactNode;
}

/**
 * Vertical stack everywhere. In the band it caps at the usable content height
 * and column-wraps, so rows pack into side-by-side columns Excel-style instead
 * of overflowing the 92px strip.
 */
export function Stack({ gap = GAP_XS, children }: StackProps): React.ReactElement {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap,
        ...(band
          ? {
              flexWrap: "wrap" as const,
              maxHeight: layout.maxContentHeight ?? RIBBON_CONTENT_HEIGHT,
              alignContent: "flex-start",
              columnGap: GAP_SM * 2,
            }
          : {}),
      }}
    >
      {children}
    </div>
  );
}

// ============================================================================
// ControlRow — a row of small controls
// ============================================================================

export interface ControlRowProps {
  gap?: number;
  children: React.ReactNode;
}

/**
 * A horizontal row of compact controls (buttons, toggles, readouts, scrubbers).
 * Band: single row, never wraps. Panel/popover: toolbar row that wraps.
 */
export function ControlRow({ gap = GAP_SM, children }: ControlRowProps): React.ReactElement {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap,
        flexWrap: band ? "nowrap" : "wrap",
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}

/** Marks a ControlRow child (e.g. a scrubber) as taking the remaining width. */
export function Grow({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ flex: 1, minWidth: 40, display: "flex", alignItems: "center" }}>
      {children}
    </div>
  );
}

// ============================================================================
// ActionRow — command buttons + status text
// ============================================================================

export interface ActionRowProps {
  gap?: number;
  children: React.ReactNode;
}

/**
 * A row of action buttons with optional trailing status text. Same flow as
 * ControlRow; exists as a named archetype so sections read declaratively.
 */
export function ActionRow({ gap = GAP_MD, children }: ActionRowProps): React.ReactElement {
  const layout = useSurfaceLayout();
  const band = layout.container === "band";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap,
        flexWrap: band ? "nowrap" : "wrap",
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}

/** Ellipsizing inline status message for ActionRow/ControlRow tails. */
export function StatusText({ children, title }: { children: React.ReactNode; title?: string }): React.ReactElement {
  return (
    <span
      style={{
        fontSize: LABEL_FONT_SIZE,
        opacity: 0.8,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minWidth: 0,
        fontFamily: FONT_FAMILY,
      }}
      title={title}
    >
      {children}
    </span>
  );
}
