//! FILENAME: app/src/core/components/pivot/PivotEditor.styles.ts
import { css } from '@emotion/css';

export const styles = {
  container: css`
    display: flex;
    flex-direction: column;
    width: 320px;
    height: 100%;
    background: #f8f9fa;
    border-left: 1px solid #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
      sans-serif;
    font-size: 12px;
    overflow: hidden;
  `,

  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: #fff;
    border-bottom: 1px solid #e0e0e0;
    font-weight: 600;
    font-size: 14px;
    color: #333;
  `,

  closeButton: css`
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px;
    color: #666;
    font-size: 18px;
    line-height: 1;

    &:hover {
      color: #333;
    }
  `,

  content: css`
    flex: 1;
    overflow-y: auto;
    padding: 12px;
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
  `,

  fieldItem: css`
    display: flex;
    align-items: center;
    padding: 6px 10px;
    cursor: grab;
    user-select: none;
    border-bottom: 1px solid #f0f0f0;
    transition: background 0.15s;
    box-sizing: border-box;

    &:last-child {
      border-bottom: none;
    }

    &:hover {
      background: #f5f5f5;
    }

    &.dragging {
      opacity: 0.5;
      background: #e8f4fc;
    }
  `,

  fieldCheckbox: css`
    margin-right: 8px;
    cursor: pointer;
    flex-shrink: 0;
  `,

  fieldName: css`
    flex: 1;
    color: #333;
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
    grid-template-rows: minmax(50px, auto) minmax(70px, 1fr) minmax(70px, 1fr) minmax(50px, auto);
    gap: 6px;
    min-height: 260px;
  `,

  dropZone: css`
    background: #fff;
    border: 1px solid #d4d4d4;
    border-radius: 2px;
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

    &::-webkit-scrollbar-thumb {
      background: #c1c1c1;
      border-radius: 3px;
    }

    &.drag-over {
      border-color: #0078d4;
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
    border-radius: 3px;
    margin-bottom: 4px;
    cursor: grab;
    user-select: none;
    font-size: 11px;

    &:hover {
      background: #e8e8e8;
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

    &:hover {
      color: #d32f2f;
    }
  `,

  zoneFieldDropdown: css`
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 4px;
    color: #666;
    font-size: 10px;
    margin-left: 4px;

    &:hover {
      color: #333;
    }
  `,

  aggregationMenu: css`
    position: absolute;
    background: #fff;
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
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
      background: #e8f4fc;
      color: #0078d4;
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
    }

    select {
      margin-left: 8px;
      padding: 4px 8px;
      border: 1px solid #e0e0e0;
      border-radius: 3px;
      font-size: 11px;
    }
  `,
};