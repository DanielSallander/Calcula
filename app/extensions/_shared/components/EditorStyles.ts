//! FILENAME: app/extensions/_shared/components/EditorStyles.ts
// PURPOSE: Shared editor styles for Pivot and Tablix field editors.
// CONTEXT: Emotion CSS-in-JS styles for the field list, drop zones, and related UI.
// DESIGN: Windows 11 Fluent Design with Segoe UI, 4px/8px radii, subtle hover states.
//
// COLOURS ARE TOKENS. This file used to paint with ~35 GitHub Primer literals
// (#24292f, #d0d7de, #0969da, #ddf4ff, ...), so the field editors stayed light
// grey on white under the Dark skin and under any organisation skin. Every
// colour below is a declared theme token — TOKENS from ../lib/themeTokens, or a
// `var(--token, lightBaseline)` for the few tokens that table does not carry —
// and each was chosen for being the nearest light value to the Primer literal it
// replaces, so the light look is essentially unchanged:
//
//   #fafbfc -> panel-bg            #e1e4e8 -> control-divider
//   #24292f -> text-primary        #656d76 -> text-secondary
//   #8b949e -> text-tertiary       #d0d7de -> border-default / control-border
//   #f0f2f5 -> border-subtle       #f6f8fa / #eaeef2 -> button hover / active
//   #0969da -> accent-color        #ddf4ff -> tone-info-bg
//   #cf222e / #ffebe9 -> tone-danger-fg / -bg

import { css } from '@emotion/css';
import { TOKENS } from '../lib/themeTokens';

// Tokens the shared table does not carry, spelled with their light baselines.
const SHADOW_SUBTLE = 'var(--shadow-cluster-hover, 0 1px 2px rgba(16, 24, 40, 0.06))';
const BORDER_HOVER = 'var(--ribbon-cluster-border-hover, #d1d5db)';
const SCROLL_THUMB = 'var(--scrollbar-thumb-bg-default, #c0c0c0)';
const SCROLL_THUMB_HOVER = 'var(--scrollbar-thumb-bg-hover, #a0a0a0)';
/** The old rgba(9, 105, 218, 0.15) focus halo, as a tint of the accent. */
const ACCENT_HALO = `color-mix(in srgb, ${TOKENS.accent} 15%, transparent)`;

// Shared scrollbar mixin
const scrollbarMixin = `
  &::-webkit-scrollbar {
    width: 5px;
  }
  &::-webkit-scrollbar-track {
    background: transparent;
  }
  &::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 5px;
  }
  &:hover::-webkit-scrollbar-thumb {
    background: ${SCROLL_THUMB};
  }
  &::-webkit-scrollbar-thumb:hover {
    background: ${SCROLL_THUMB_HOVER};
  }
`;

export const styles = {
  container: css`
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 240px;
    height: 100%;
    background: ${TOKENS.panelBg};
    border-left: 1px solid ${TOKENS.controlDivider};
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    font-size: 12px;
    overflow: hidden;
  `,

  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    background: ${TOKENS.surfaceBg};
    border-bottom: 1px solid ${TOKENS.controlDivider};
    box-shadow: ${SHADOW_SUBTLE};
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    font-weight: 600;
    font-size: 13px;
    color: ${TOKENS.textPrimary};
    flex-shrink: 0;
  `,

  closeButton: css`
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    cursor: pointer;
    width: 24px;
    height: 24px;
    padding: 0;
    color: ${TOKENS.textSecondary};
    font-size: 16px;
    line-height: 1;
    border-radius: 4px;
    transition: background 0.12s, color 0.12s;

    &:hover {
      background: ${TOKENS.buttonHoverBg};
      color: ${TOKENS.textPrimary};
    }
  `,

  content: css`
    flex: 1;
    overflow: hidden;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
  `,

  section: css`
    display: flex;
    flex-direction: column;
    min-height: 0;
  `,

  sectionTitle: css`
    font-weight: 500;
    color: ${TOKENS.textSecondary};
    margin-bottom: 6px;
    font-size: 11px;
    letter-spacing: 0.2px;
  `,

  fieldList: css`
    background: ${TOKENS.surfaceBg};
    border: 1px solid ${TOKENS.border};
    border-radius: 6px;
    flex: 1;
    min-height: 80px;
    overflow-y: auto;
    overflow-x: hidden;
    ${scrollbarMixin}
  `,

  fieldItem: css`
    display: flex;
    align-items: center;
    padding: 5px 10px;
    cursor: grab;
    user-select: none;
    border-bottom: 1px solid ${TOKENS.borderSubtle};
    transition: background 0.1s ease;
    box-sizing: border-box;

    &:last-child {
      border-bottom: none;
    }

    &:hover {
      background: ${TOKENS.buttonHoverBg};
    }

    &:active {
      background: ${TOKENS.buttonActiveBg};
    }

    &.dragging {
      opacity: 0.4;
      background: ${TOKENS.infoBg};
    }
  `,

  fieldCheckbox: css`
    margin-right: 8px;
    cursor: pointer;
    flex-shrink: 0;
    accent-color: ${TOKENS.accent};
    width: 14px;
    height: 14px;
  `,

  fieldName: css`
    flex: 1;
    color: ${TOKENS.textPrimary};
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  `,

  fieldTypeIcon: css`
    color: ${TOKENS.textTertiary};
    font-size: 10px;
    margin-left: 4px;
    flex-shrink: 0;
  `,

  dropZonesContainer: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 6px;
    flex-shrink: 0;
    min-height: 160px;
  `,

  dropZone: css`
    background: ${TOKENS.surfaceBg};
    border: 1px solid ${TOKENS.border};
    border-radius: 6px;
    min-height: 48px;
    padding: 6px 8px;
    transition: border-color 0.15s, background-color 0.15s, box-shadow 0.15s;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    ${scrollbarMixin}

    &.drag-over {
      border-color: ${TOKENS.accent};
      background: ${TOKENS.infoBg};
      box-shadow: 0 0 0 1px ${TOKENS.accent};
      border-width: 1px;
      padding: 6px 8px;
    }

    &.full-width {
      grid-column: span 2;
    }
  `,

  dropZoneTitle: css`
    font-size: 10px;
    font-weight: 600;
    color: ${TOKENS.textSecondary};
    text-transform: uppercase;
    margin-bottom: 4px;
    letter-spacing: 0.3px;
    flex-shrink: 0;
  `,

  dropZoneContent: css`
    flex: 1;
    min-height: 20px;
    position: relative;
  `,

  dropZonePlaceholder: css`
    color: ${TOKENS.textTertiary};
    font-size: 11px;
    font-style: italic;
    text-align: center;
    padding: 6px 4px;
  `,

  zoneField: css`
    display: flex;
    align-items: center;
    padding: 3px 8px;
    background: ${TOKENS.clusterBg};
    border: 1px solid ${TOKENS.controlBorder};
    border-radius: 4px;
    margin-bottom: 3px;
    cursor: grab;
    user-select: none;
    font-size: 11px;
    transition: background 0.1s ease, border-color 0.1s ease, box-shadow 0.1s ease;

    &:hover {
      background: ${TOKENS.buttonActiveBg};
      border-color: ${BORDER_HOVER};
      box-shadow: ${SHADOW_SUBTLE};
    }

    &.dragging {
      opacity: 0.4;
    }

    &:last-child {
      margin-bottom: 0;
    }
  `,

  zoneFieldName: css`
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    color: ${TOKENS.textPrimary};
  `,

  zoneFieldRemove: css`
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    cursor: pointer;
    width: 18px;
    height: 18px;
    padding: 0;
    color: ${TOKENS.textTertiary};
    font-size: 14px;
    line-height: 1;
    margin-left: 2px;
    border-radius: 3px;
    flex-shrink: 0;
    transition: background 0.1s, color 0.1s;

    &:hover {
      color: ${TOKENS.dangerFg};
      background: ${TOKENS.dangerBg};
    }
  `,

  zoneFieldDropdown: css`
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    cursor: pointer;
    width: 18px;
    height: 18px;
    padding: 0;
    color: ${TOKENS.textSecondary};
    font-size: 8px;
    margin-left: auto;
    border-radius: 3px;
    flex-shrink: 0;
    line-height: 1;
    transition: background 0.1s, color 0.1s;

    &:hover {
      background: ${TOKENS.buttonHoverBg};
      color: ${TOKENS.textPrimary};
    }
  `,

  aggregationMenu: css`
    position: absolute;
    background: ${TOKENS.surfaceBg};
    border: 1px solid ${TOKENS.border};
    border-radius: 8px;
    box-shadow: ${TOKENS.shadowPopover};
    z-index: 1000;
    min-width: 150px;
    padding: 4px 0;
  `,

  aggregationMenuItem: css`
    display: block;
    width: 100%;
    padding: 6px 12px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 12px;
    color: ${TOKENS.textPrimary};
    transition: background 0.08s;

    &:hover {
      background: ${TOKENS.buttonHoverBg};
    }

    &.selected {
      background: ${TOKENS.infoBg};
      color: ${TOKENS.accent};
    }
  `,

  deferFooter: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    border-top: 1px solid ${TOKENS.border};
    background: ${TOKENS.surfaceBg};
    flex-shrink: 0;
  `,

  deferCheckboxLabel: css`
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: ${TOKENS.textPrimary};
    cursor: pointer;
    user-select: none;

    input {
      accent-color: ${TOKENS.accent};
      width: 13px;
      height: 13px;
      cursor: pointer;
    }
  `,

  deferUpdateButton: css`
    padding: 4px 14px;
    font-size: 11px;
    font-family: inherit;
    border: 1px solid ${TOKENS.controlBorder};
    border-radius: 4px;
    background: ${TOKENS.clusterBg};
    color: ${TOKENS.textPrimary};
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;

    &:hover:not(:disabled) {
      background: ${TOKENS.buttonActiveBg};
      border-color: ${BORDER_HOVER};
    }

    &:disabled {
      opacity: 0.5;
      cursor: default;
    }
  `,

  layoutSection: css`
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid ${TOKENS.border};
  `,

  layoutOption: css`
    display: flex;
    align-items: center;
    margin-bottom: 6px;
    font-size: 12px;
    color: ${TOKENS.textPrimary};

    input {
      margin-right: 8px;
      accent-color: ${TOKENS.accent};
    }

    select {
      margin-left: 8px;
      padding: 4px 8px;
      border: 1px solid ${TOKENS.controlBorder};
      border-radius: 6px;
      font-size: 11px;
      font-family: inherit;
      background: ${TOKENS.surfaceBg};
      color: ${TOKENS.textPrimary};

      &:focus {
        outline: none;
        border-color: ${TOKENS.accent};
        box-shadow: 0 0 0 2px ${ACCENT_HALO};
      }
    }
  `,
};
