//! FILENAME: app/src/shell/dialogs/MoveOrCopySheetDialog.styles.ts
// PURPOSE: Styled-components for the Move or Copy dialog. The window chrome
//          (backdrop, container, header, footer, buttons) is the Column Width
//          dialog's, re-exported so the two shell dialogs read as one family;
//          only the "Before sheet" list and the copy box are new.

import styled from "styled-components";

export {
  Backdrop,
  DialogContainer,
  Header,
  Title,
  CloseButton,
  Body,
  Hint,
  Footer,
  Button,
} from "./DimensionInputDialog.styles";

const v = (name: string) => `var(${name})`;

export const Label = styled.div`
  font-size: 12px;
  color: ${v("--text-secondary")};
`;

export const SourceName = styled.span`
  color: ${v("--text-primary")};
  font-weight: 600;
`;

/** The "Before sheet" list: Excel's single-select list box, ~8 rows tall. */
export const List = styled.div`
  height: 168px;
  overflow-y: auto;
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  background: ${v("--grid-bg")};
  outline: none;
  padding: 2px 0;

  &:focus-visible {
    border-color: ${v("--accent-primary")};
  }
`;

export const Option = styled.div<{ $selected: boolean }>`
  padding: 3px 9px;
  font-size: 13px;
  cursor: default;
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  background: ${(p) => (p.$selected ? v("--accent-primary") : "transparent")};
  color: ${(p) => (p.$selected ? "#ffffff" : v("--text-primary"))};

  &:hover {
    background: ${(p) => (p.$selected ? v("--accent-primary") : v("--panel-bg"))};
  }
`;

export const CheckRow = styled.label<{ $disabled: boolean }>`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: ${(p) => (p.$disabled ? v("--text-secondary") : v("--text-primary"))};
  opacity: ${(p) => (p.$disabled ? 0.6 : 1)};
  cursor: ${(p) => (p.$disabled ? "not-allowed" : "pointer")};
`;
