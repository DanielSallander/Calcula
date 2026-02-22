//! FILENAME: app/extensions/BuiltIn/PasteSpecial/PasteSpecialDialog.styles.ts
// PURPOSE: Styled-components for the Paste Special dialog.

import styled from "styled-components";

const v = (name: string) => `var(${name})`;

export const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 1050;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
`;

export const DialogContainer = styled.div`
  background: ${v("--panel-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  width: 440px;
  display: flex;
  flex-direction: column;
  color: ${v("--text-primary")};
  font-family: "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
`;

export const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px 0 16px;
  flex-shrink: 0;
`;

export const Title = styled.span`
  font-weight: 600;
  font-size: 15px;
  color: ${v("--text-primary")};
`;

export const CloseButton = styled.button`
  background: transparent;
  border: none;
  color: ${v("--text-secondary")};
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 14px;
  line-height: 1;

  &:hover {
    background: ${v("--grid-bg")};
    color: ${v("--text-primary")};
  }
`;

export const Body = styled.div`
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
`;

export const ColumnsRow = styled.div`
  display: flex;
  gap: 24px;
`;

export const Column = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

export const GroupLabel = styled.div`
  font-weight: 600;
  font-size: 12px;
  color: ${v("--text-secondary")};
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
`;

export const RadioLabel = styled.label`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  cursor: pointer;
  font-size: 13px;
  color: ${v("--text-primary")};

  &:hover {
    color: ${v("--accent-primary")};
  }

  input[type="radio"] {
    margin: 0;
    accent-color: ${v("--accent-primary")};
  }
`;

export const CheckboxRow = styled.div`
  display: flex;
  gap: 24px;
  padding-top: 4px;
  border-top: 1px solid ${v("--border-default")};
`;

export const CheckboxLabel = styled.label`
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 13px;
  color: ${v("--text-primary")};

  &:hover {
    color: ${v("--accent-primary")};
  }

  input[type="checkbox"] {
    margin: 0;
    accent-color: ${v("--accent-primary")};
  }
`;

export const Footer = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-top: 1px solid ${v("--border-default")};
  flex-shrink: 0;
`;

export const FooterLeft = styled.div`
  display: flex;
  gap: 8px;
`;

export const FooterRight = styled.div`
  display: flex;
  gap: 8px;
`;

export const Button = styled.button<{ $primary?: boolean }>`
  padding: 6px 20px;
  font-size: 13px;
  border-radius: 4px;
  cursor: pointer;
  min-width: 80px;
  transition: opacity 0.1s;

  background: ${(p) =>
    p.$primary ? v("--accent-primary") : v("--grid-bg")};
  color: ${(p) => (p.$primary ? "#ffffff" : v("--text-primary"))};
  border: 1px solid
    ${(p) => (p.$primary ? v("--accent-primary") : v("--border-default"))};

  &:hover {
    opacity: 0.85;
  }

  &:active {
    opacity: 0.7;
  }

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
`;
