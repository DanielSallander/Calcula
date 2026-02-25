//! FILENAME: app/extensions/_shared/components/EditorStyles.ts
// PURPOSE: Shared editor styles for Pivot and Tablix field editors.
// CONTEXT: Emotion CSS-in-JS styles for the field list, drop zones, and related UI.
// DESIGN: Windows 11 Fluent Design with Segoe UI, 4px/8px radii, subtle hover states.

import { css } from '@emotion/css';

export const styles = {
  container: css`
    display: flex;
    flex-direction: column;
    width: 320px;
    height: 100%;
    background: #f9f9f9;
    border-left: 1px solid #e5e5e5;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    font-size: 12px;
    overflow: hidden;
  `,

  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: #fff;
    border-bottom: 1px solid #e5e5e5;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
    font-weight: 600;
    font-size: 14px;
    color: #1a1a1a;
  `,

  closeButton: css`
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px 6px;
    color: #666;
    font-size: 16px;
    line-height: 1;
    border-radius: 4px;

    &:hover {
      background: #e5e5e5;
      color: #1a1a1a;
    }
  `,

  content: css`
    flex: 1;
    overflow-y: auto;
    padding: 12px;

    &::-webkit-scrollbar {
      width: 6px;
    }

    &::-webkit-scrollbar-track {
      background: transparent;
    }

    &::-webkit-scrollbar-thumb {
      background: transparent;
      border-radius: 6px;
      transition: background 0.2s;
    }

    &:hover::-webkit-scrollbar-thumb {
      background: #c1c1c1;
    }

    &::-webkit-scrollbar-thumb:hover {
      background: #a0a0a0;
    }
  `,

  section: css`
    margin-bottom: 16px;
  `,

  sectionTitle: css`
    font-weight: 600;
    color: #555;
    margin-bottom: 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  `,

  fieldList: css`
    background: #fff;
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    max-height: 200px;
    overflow-y: auto;
    overflow-x: hidden;

    &::-webkit-scrollbar {
      width: 6px;
    }

    &::-webkit-scrollbar-track {
      background: transparent;
    }

    &::-webkit-scrollbar-thumb {
      background: transparent;
      border-radius: 6px;
      transition: background 0.2s;
    }

    &:hover::-webkit-scrollbar-thumb {
      background: #c1c1c1;
    }

    &::-webkit-scrollbar-thumb:hover {
      background: #a0a0a0;
    }
  `,

  fieldItem: css`
    display: flex;
    align-items: center;
    padding: 6px 10px;
    cursor: grab;
    user-select: none;
    border-bottom: 1px solid #f0f0f0;
    transition: background 0.1s ease;
    box-sizing: border-box;

    &:last-child {
      border-bottom: none;
    }

    &:hover {
      background: #f0f0f0;
    }

    &:active {
      background: #e8e8e8;
    }

    &.dragging {
      opacity: 0.5;
      background: #e5f3ff;
    }
  `,

  fieldCheckbox: css`
    margin-right: 8px;
    cursor: pointer;
    flex-shrink: 0;
    accent-color: #005fb8;
    width: 16px;
    height: 16px;
  `,

  fieldName: css`
    flex: 1;
    color: #1a1a1a;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  `,

  fieldTypeIcon: css`
    color: #999;
    font-size: 10px;
    margin-left: 4px;
    flex-shrink: 0;
  `,

  dropZonesContainer: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-auto-rows: minmax(60px, 1fr);
    gap: 6px;
    min-height: 260px;
  `,

  dropZone: css`
    background: #fff;
    border: 1px solid #d4d4d4;
    border-radius: 4px;
    min-height: 50px;
    max-height: 100px;
    padding: 6px 8px;
    transition: border-color 0.15s, background-color 0.15s;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;

    &::-webkit-scrollbar {
      width: 6px;
    }

    &::-webkit-scrollbar-track {
      background: transparent;
    }

    &::-webkit-scrollbar-thumb {
      background: transparent;
      border-radius: 6px;
      transition: background 0.2s;
    }

    &:hover::-webkit-scrollbar-thumb {
      background: #c1c1c1;
    }

    &::-webkit-scrollbar-thumb:hover {
      background: #a0a0a0;
    }

    &.drag-over {
      border-color: #005fb8;
      background: #e5f3ff;
      border-width: 2px;
      padding: 5px 7px;
    }

    &.full-width {
      grid-column: span 2;
      max-height: 80px;
    }
  `,

  dropZoneTitle: css`
    font-size: 10px;
    font-weight: 600;
    color: #444;
    text-transform: uppercase;
    margin-bottom: 4px;
    letter-spacing: 0.3px;
    flex-shrink: 0;
  `,

  dropZoneContent: css`
    flex: 1;
    min-height: 24px;
    position: relative;
  `,

  dropZonePlaceholder: css`
    color: #999;
    font-size: 11px;
    font-style: italic;
    text-align: center;
    padding: 10px;
  `,

  zoneField: css`
    display: flex;
    align-items: center;
    padding: 4px 8px;
    background: #f0f0f0;
    border: 1px solid transparent;
    border-radius: 4px;
    margin-bottom: 4px;
    cursor: grab;
    user-select: none;
    font-size: 11px;
    transition: background 0.1s ease, border-color 0.1s ease;

    &:hover {
      background: #e8e8e8;
      border-color: #d0d0d0;
    }

    &.dragging {
      opacity: 0.5;
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
    color: #1a1a1a;
  `,

  zoneFieldRemove: css`
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 4px;
    color: #999;
    font-size: 14px;
    line-height: 1;
    margin-left: 4px;
    border-radius: 2px;

    &:hover {
      color: #d32f2f;
      background: #ffebee;
    }
  `,

  zoneFieldDropdown: css`
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 6px;
    color: #666;
    font-size: 8px;
    margin-left: auto;
    border-radius: 2px;
    flex-shrink: 0;
    line-height: 1;

    &:hover {
      background: #d8d8d8;
      color: #1a1a1a;
    }
  `,

  aggregationMenu: css`
    position: absolute;
    background: #fff;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
    z-index: 1000;
    min-width: 150px;
    padding: 4px 0;
  `,

  aggregationMenuItem: css`
    display: block;
    width: 100%;
    padding: 8px 12px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 12px;
    color: #333;

    &:hover {
      background: #f5f5f5;
    }

    &.selected {
      background: #e5f3ff;
      color: #005fb8;
    }
  `,

  layoutSection: css`
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid #e0e0e0;
  `,

  layoutOption: css`
    display: flex;
    align-items: center;
    margin-bottom: 8px;
    font-size: 12px;
    color: #333;

    input {
      margin-right: 8px;
      accent-color: #005fb8;
    }

    select {
      margin-left: 8px;
      padding: 4px 8px;
      border: 1px solid #e0e0e0;
      border-radius: 4px;
      font-size: 11px;
      font-family: inherit;

      &:focus {
        outline: none;
        border-color: #005fb8;
      }
    }
  `,
};
