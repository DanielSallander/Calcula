//! FILENAME: app/extensions/_shared/components/EditorStyles.ts
// PURPOSE: Shared editor styles for Pivot and Tablix field editors.
// CONTEXT: Emotion CSS-in-JS styles for the field list, drop zones, and related UI.
// DESIGN: Windows 11 Fluent Design with Segoe UI, 4px/8px radii, subtle hover states.

import { css } from '@emotion/css';

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
    background: rgba(0, 0, 0, 0.15);
  }
  &::-webkit-scrollbar-thumb:hover {
    background: rgba(0, 0, 0, 0.25);
  }
`;

export const styles = {
  container: css`
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 240px;
    height: 100%;
    background: #fafbfc;
    border-left: 1px solid #e1e4e8;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    font-size: 12px;
    overflow: hidden;
  `,

  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    background: #fff;
    border-bottom: 1px solid #e1e4e8;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    font-weight: 600;
    font-size: 13px;
    color: #24292f;
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
    color: #656d76;
    font-size: 16px;
    line-height: 1;
    border-radius: 4px;
    transition: background 0.12s, color 0.12s;

    &:hover {
      background: #eaeef2;
      color: #24292f;
    }
  `,

  content: css`
    flex: 1;
    overflow-y: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    ${scrollbarMixin}
  `,

  section: css`
    display: flex;
    flex-direction: column;
  `,

  sectionTitle: css`
    font-weight: 500;
    color: #656d76;
    margin-bottom: 6px;
    font-size: 11px;
    letter-spacing: 0.2px;
  `,

  fieldList: css`
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    flex: 1;
    min-height: 80px;
    max-height: 40vh;
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
    border-bottom: 1px solid #f0f2f5;
    transition: background 0.1s ease;
    box-sizing: border-box;

    &:last-child {
      border-bottom: none;
    }

    &:hover {
      background: #f6f8fa;
    }

    &:active {
      background: #eaeef2;
    }

    &.dragging {
      opacity: 0.4;
      background: #ddf4ff;
    }
  `,

  fieldCheckbox: css`
    margin-right: 8px;
    cursor: pointer;
    flex-shrink: 0;
    accent-color: #0969da;
    width: 14px;
    height: 14px;
  `,

  fieldName: css`
    flex: 1;
    color: #24292f;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  `,

  fieldTypeIcon: css`
    color: #8b949e;
    font-size: 10px;
    margin-left: 4px;
    flex-shrink: 0;
  `,

  dropZonesContainer: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 6px;
    flex: 1;
    min-height: 160px;
  `,

  dropZone: css`
    background: #fff;
    border: 1px solid #d0d7de;
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
      border-color: #0969da;
      background: #ddf4ff;
      box-shadow: 0 0 0 1px #0969da;
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
    color: #656d76;
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
    color: #8b949e;
    font-size: 11px;
    font-style: italic;
    text-align: center;
    padding: 6px 4px;
  `,

  zoneField: css`
    display: flex;
    align-items: center;
    padding: 3px 8px;
    background: #f6f8fa;
    border: 1px solid #d0d7de;
    border-radius: 4px;
    margin-bottom: 3px;
    cursor: grab;
    user-select: none;
    font-size: 11px;
    transition: background 0.1s ease, border-color 0.1s ease, box-shadow 0.1s ease;

    &:hover {
      background: #eaeef2;
      border-color: #afb8c1;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
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
    color: #24292f;
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
    color: #8b949e;
    font-size: 14px;
    line-height: 1;
    margin-left: 2px;
    border-radius: 3px;
    flex-shrink: 0;
    transition: background 0.1s, color 0.1s;

    &:hover {
      color: #cf222e;
      background: #ffebe9;
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
    color: #656d76;
    font-size: 8px;
    margin-left: auto;
    border-radius: 3px;
    flex-shrink: 0;
    line-height: 1;
    transition: background 0.1s, color 0.1s;

    &:hover {
      background: #eaeef2;
      color: #24292f;
    }
  `,

  aggregationMenu: css`
    position: absolute;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(140, 149, 159, 0.2);
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
    color: #24292f;
    transition: background 0.08s;

    &:hover {
      background: #f6f8fa;
    }

    &.selected {
      background: #ddf4ff;
      color: #0969da;
    }
  `,

  layoutSection: css`
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid #d0d7de;
  `,

  layoutOption: css`
    display: flex;
    align-items: center;
    margin-bottom: 6px;
    font-size: 12px;
    color: #24292f;

    input {
      margin-right: 8px;
      accent-color: #0969da;
    }

    select {
      margin-left: 8px;
      padding: 4px 8px;
      border: 1px solid #d0d7de;
      border-radius: 6px;
      font-size: 11px;
      font-family: inherit;
      background: #fff;

      &:focus {
        outline: none;
        border-color: #0969da;
        box-shadow: 0 0 0 2px rgba(9, 105, 218, 0.15);
      }
    }
  `,
};
