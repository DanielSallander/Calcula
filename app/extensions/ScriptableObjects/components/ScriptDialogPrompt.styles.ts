//! FILENAME: app/extensions/ScriptableObjects/components/ScriptDialogPrompt.styles.ts
// PURPOSE: Styled-components for the trusted script dialog (the ui.dialog
//          capability). Every colour is a theme token, so a script's modal is
//          skinned by the app rather than painted by the script — which is also
//          why it can never be made to look like something it is not.

import styled from "styled-components";

const v = (name: string) => `var(${name})`;

export const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 20000;
  background: ${v("--dialog-overlay-bg")};
  display: flex;
  align-items: center;
  justify-content: center;
`;

export const DialogContainer = styled.div`
  background: ${v("--dialog-bg")};
  border: 1px solid ${v("--dialog-border")};
  border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  width: 460px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  color: ${v("--text-primary")};
  font-family: ${v("--font-family-sans")}, "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
`;

/**
 * The ATTRIBUTION band. It is the dialog's title bar and its drag handle, and
 * nothing a script sends can reach it — the script's own heading is body
 * content further down. That separation is what makes "which code is asking me
 * this?" answerable at a glance.
 */
export const Header = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid ${v("--dialog-border")};
  cursor: move;
  flex-shrink: 0;
`;

export const ScriptGlyph = styled.div`
  width: 26px;
  height: 26px;
  border-radius: 13px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: ${v("--dialog-category-active-bg")};
  color: ${v("--accent-color")};
`;

export const HeaderText = styled.div`
  min-width: 0;
  flex: 1;
`;

export const AskedBy = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: ${v("--dialog-title-text")};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export const Provenance = styled.div`
  font-size: 11px;
  color: ${v("--text-secondary")};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export const CloseButton = styled.button`
  background: transparent;
  border: none;
  color: ${v("--dialog-close-button")};
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 14px;
  line-height: 1;

  &:hover {
    background: ${v("--dialog-button-hover-bg")};
    color: ${v("--dialog-close-button-hover")};
  }
`;

export const Body = styled.div`
  padding: 16px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

/** The script-supplied heading — body content, deliberately not chrome. */
export const ScriptTitle = styled.div`
  font-size: 14px;
  font-weight: 600;
  color: ${v("--text-primary")};
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

export const Message = styled.div`
  font-size: 13px;
  line-height: 1.6;
  color: ${v("--text-primary")};
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

export const FieldList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

export const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

export const FieldLabel = styled.span`
  font-size: 12px;
  font-weight: 600;
  color: ${v("--text-primary")};
  overflow-wrap: anywhere;
`;

export const Required = styled.span`
  color: ${v("--text-error")};
  margin-left: 3px;
`;

export const Help = styled.span`
  font-size: 11px;
  color: ${v("--text-secondary")};
  overflow-wrap: anywhere;
`;

export const ErrorText = styled.span`
  font-size: 11px;
  color: ${v("--text-error")};
`;

const inputBase = `
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  font-size: 13px;
  font-family: inherit;
  border-radius: 4px;
`;

export const TextInput = styled.input`
  ${inputBase}
  background: ${v("--dialog-input-bg")};
  color: ${v("--dialog-input-text")};
  border: 1px solid ${v("--dialog-input-border")};

  &:focus {
    outline: none;
    border-color: ${v("--dialog-input-border-focus")};
  }
`;

export const TextArea = styled.textarea`
  ${inputBase}
  min-height: 72px;
  resize: vertical;
  background: ${v("--dialog-input-bg")};
  color: ${v("--dialog-input-text")};
  border: 1px solid ${v("--dialog-input-border")};

  &:focus {
    outline: none;
    border-color: ${v("--dialog-input-border-focus")};
  }
`;

export const Select = styled.select`
  ${inputBase}
  background: ${v("--dialog-input-bg")};
  color: ${v("--dialog-input-text")};
  border: 1px solid ${v("--dialog-input-border")};

  &:focus {
    outline: none;
    border-color: ${v("--dialog-input-border-focus")};
  }
`;

export const CheckboxRow = styled.label`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: ${v("--text-primary")};
`;

export const Footer = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid ${v("--dialog-border")};
  flex-shrink: 0;
`;

export const Button = styled.button`
  padding: 6px 16px;
  font-size: 12px;
  font-family: inherit;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid ${v("--dialog-button-border")};
  background: ${v("--dialog-button-bg")};
  color: ${v("--dialog-button-text")};

  &:hover {
    background: ${v("--dialog-button-hover-bg")};
  }
`;

export const PrimaryButton = styled(Button)<{ $danger?: boolean }>`
  border-color: ${(p) => (p.$danger ? v("--text-error") : v("--dialog-insert-bg"))};
  background: ${(p) => (p.$danger ? v("--text-error") : v("--dialog-insert-bg"))};
  color: ${v("--dialog-insert-text")};

  &:hover {
    background: ${(p) => (p.$danger ? v("--text-error") : v("--dialog-insert-hover-bg"))};
    filter: ${(p) => (p.$danger ? "brightness(1.1)" : "none")};
  }
`;
