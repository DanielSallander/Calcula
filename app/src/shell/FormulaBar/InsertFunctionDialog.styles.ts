//! FILENAME: app/src/shell/FormulaBar/InsertFunctionDialog.styles.ts
import styled from 'styled-components';
import { dialogWidth, dialogHeight } from '../../api/dialogLayout';

const v = (name: string) => `var(${name})`;

export const Overlay = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: ${v('--dialog-overlay-bg')};
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
`;

interface DialogContainerProps {
  /** The argument-builder step is a form in a column, sized to its own content. */
  $wide?: boolean;
}

/** The catalog step's natural size, clamped so it still fits a small screen. */
const CATALOG_WIDTH = dialogWidth(760);
const CATALOG_HEIGHT = dialogHeight(760, 0.8);

/**
 * The catalog step is a BROWSER, so it gets a browser's proportions: 760px wide
 * for a category rail beside the list, and a DEFINITE height rather than a
 * content-driven one. The height is not cosmetic — with the list free to fill
 * the body, a content-driven box would grow to 80vh with 500+ functions in it
 * and shrink back as soon as a search matched three, walking the footer up the
 * screen while the user typed. The builder step is still a column and keeps its
 * content height; it is only widened 580 -> 640.
 */
export const DialogContainer = styled.div<DialogContainerProps>`
  background-color: ${v('--dialog-bg')};
  border-radius: 4px;
  box-shadow: 0 4px 20px ${v('--dialog-shadow')};
  width: ${props => (props.$wide ? '640px' : CATALOG_WIDTH)};
  height: ${props => (props.$wide ? 'auto' : CATALOG_HEIGHT)};
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

export const Header = styled.div`
  padding: 16px;
  border-bottom: 1px solid ${v('--dialog-border')};
  display: flex;
  justify-content: space-between;
  align-items: center;
  /* The title bar is also the drag handle: it never scrolls away. */
  flex-shrink: 0;
`;

export const Title = styled.h2`
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: ${v('--dialog-title-text')};
`;

export const CloseButton = styled.button`
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 18px;
  color: ${v('--dialog-close-button')};
  padding: 4px;

  &:hover {
    color: ${v('--dialog-close-button-hover')};
  }
`;

/** Full width above the split: search filters BOTH panes' meaning. */
export const SearchContainer = styled.div`
  padding: 12px 16px;
  border-bottom: 1px solid ${v('--dialog-border')};
  flex-shrink: 0;
`;

export const SearchInput = styled.input`
  width: 100%;
  padding: 8px 12px;
  border: 1px solid ${v('--dialog-input-border')};
  border-radius: 4px;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
  background-color: ${v('--dialog-input-bg')};
  color: ${v('--dialog-input-text')};

  &:focus {
    border-color: ${v('--dialog-input-border-focus')};
  }
`;

/**
 * A RAIL down the left of the split, not a wrapping bar above the list. There
 * is one chip per catalog category plus "All" — well over a dozen, and derived
 * from the catalog, so the count is whatever the backend ships. As a wrapping
 * row they reflowed into three or four rows depending on the dialog's width,
 * spending ~110px of the vertical budget the list needed and moving the list
 * every time the user resized. Stacked, they cost WIDTH instead, which the
 * dialog now has.
 */
export const CategoryContainer = styled.div`
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

interface CategoryButtonProps {
  isActive: boolean;
}

export const CategoryButton = styled.button<CategoryButtonProps>`
  padding: 4px 8px;
  font-size: 11px;
  /* Still a <button>, stacked: labels read down a rail, so they align left and
     never squash when the rail is scrolled. */
  text-align: left;
  flex-shrink: 0;
  border: 1px solid ${v('--dialog-category-border')};
  border-radius: 3px;
  background-color: ${props => props.isActive ? v('--dialog-category-active-bg') : v('--dialog-category-bg')};
  color: ${props => props.isActive ? v('--dialog-category-active-text') : v('--dialog-category-text')};
  cursor: pointer;

  &:hover {
    background-color: ${props => props.isActive ? v('--dialog-category-active-bg') : v('--dialog-category-hover-bg')};
  }
`;

/**
 * A plain block: the DialogPane around it is the ONE scroller. The 300px cap
 * that used to live here showed six or seven of 500+ functions and, worse,
 * defeated the dialog's own resize — dragging it taller landed the extra height
 * as a dead band below the footer instead of as more rows.
 */
export const FunctionListContainer = styled.div`
  min-width: 0;
`;

export const LoadingMessage = styled.div`
  padding: 20px;
  text-align: center;
  color: ${v('--dialog-loading-text')};
`;

export const EmptyMessage = styled.div`
  padding: 20px;
  text-align: center;
  color: ${v('--dialog-empty-text')};
`;

interface FunctionItemProps {
  isSelected: boolean;
}

export const FunctionItem = styled.div<FunctionItemProps>`
  padding: 8px 16px;
  cursor: pointer;
  background-color: ${props => props.isSelected ? v('--dialog-function-selected-bg') : 'transparent'};
  border-left: 3px solid ${props => props.isSelected ? v('--dialog-function-selected-border') : 'transparent'};

  &:hover {
    background-color: ${v('--dialog-function-hover-bg')};
  }
`;

export const FunctionName = styled.div`
  font-weight: 500;
  font-size: 13px;
  color: ${v('--dialog-function-name')};
`;

export const FunctionDescription = styled.div`
  font-size: 11px;
  color: ${v('--dialog-function-description')};
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

/** Sized for its tallest state (signature + description + builder badge) so
 *  arrowing through the list does not resize the list under the selection. */
export const FunctionDetails = styled.div`
  padding: 12px 16px;
  border-top: 1px solid ${v('--dialog-border')};
  background-color: ${v('--dialog-details-bg')};
  min-height: 86px;
  box-sizing: border-box;
  flex-shrink: 0;
`;

export const FunctionSignature = styled.div`
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
  color: ${v('--dialog-function-signature')};
`;

export const FunctionFullDescription = styled.div`
  font-size: 12px;
  color: ${v('--dialog-function-full-description')};
`;

/** Marks a function whose arguments an extension can assemble for the user. */
export const BuilderBadge = styled.div`
  display: inline-block;
  margin-top: 6px;
  padding: 2px 6px;
  border: 1px solid ${v('--dialog-category-border')};
  border-radius: 3px;
  font-size: 11px;
  color: ${v('--dialog-function-description')};
  background-color: ${v('--dialog-category-bg')};
`;

/** Scroll host for a registered argument builder (step 2 of Insert Function). */
export const BuilderBody = styled.div`
  flex: 1;
  overflow: auto;
  min-height: 200px;
  padding: 12px 16px;
`;

/** The formula the host will actually insert — rendered by the host, never the
 *  builder, so what is previewed and what is committed cannot disagree. */
export const BuilderPreview = styled.div`
  padding: 12px 16px;
  border-top: 1px solid ${v('--dialog-border')};
  background-color: ${v('--dialog-details-bg')};
  font-family: monospace;
  font-size: 12px;
  color: ${v('--dialog-function-signature')};
  word-break: break-all;
  flex-shrink: 0;
`;

export const Footer = styled.div`
  padding: 12px 16px;
  border-top: 1px solid ${v('--dialog-border')};
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  /* Insert must never scroll out from under the list. */
  flex-shrink: 0;
`;

/** Pushes Back to the left so it reads as navigation, not as a third action. */
export const FooterSpacer = styled.div`
  flex: 1;
`;

export const CancelButton = styled.button`
  padding: 6px 16px;
  border: 1px solid ${v('--dialog-button-border')};
  border-radius: 4px;
  background-color: ${v('--dialog-button-bg')};
  color: ${v('--dialog-button-text')};
  cursor: pointer;
  font-size: 13px;

  &:hover {
    background-color: ${v('--dialog-button-hover-bg')};
  }
`;

interface InsertButtonProps {
  disabled: boolean;
}

export const InsertButton = styled.button<InsertButtonProps>`
  padding: 6px 16px;
  border: none;
  border-radius: 4px;
  background-color: ${props => props.disabled ? v('--dialog-insert-disabled-bg') : v('--dialog-insert-bg')};
  color: ${v('--dialog-insert-text')};
  cursor: ${props => props.disabled ? 'default' : 'pointer'};
  font-size: 13px;

  &:hover:not(:disabled) {
    background-color: ${v('--dialog-insert-hover-bg')};
  }
`;