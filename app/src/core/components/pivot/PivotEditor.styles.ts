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
  `,

  fieldItem: css`
    display: flex;
    align-items: center;
    padding: 6px 10px;
    cursor: grab;
    user-select: none;
    border-bottom: 1px solid #f0f0f0;
    transition: background 0.15s;

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
  `,

  fieldName: css`
    flex: 1;
    color: #333;
    font-size: 12px;
  `,

  fieldTypeIcon: css`
    color: #999;
    font-size: 10px;
    margin-left: 4px;
  `,

  dropZonesContainer: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  `,

  dropZone: css`
    background: #fff;
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    min-height: 80px;
    padding: 8px;
    transition: all 0.2s;

    &.drag-over {
      border-color: #0078d4;
      background: #f0f7ff;
    }

    &.full-width {
      grid-column: span 2;
    }
  `,

  dropZoneTitle: css`
    font-size: 10px;
    font-weight: 600;
    color: #666;
    text-transform: uppercase;
    margin-bottom: 6px;
    letter-spacing: 0.5px;
  `,

  dropZoneContent: css`
    min-height: 40px;
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