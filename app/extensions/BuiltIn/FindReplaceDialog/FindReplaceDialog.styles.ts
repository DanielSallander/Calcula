//! FILENAME: app/extensions/BuiltIn/FindReplaceDialog/FindReplaceDialog.styles.ts
import styled from 'styled-components';

// Helper for CSS variables
const v = (name: string) => `var(${name})`;

export const Overlay = styled.div`
  position: fixed;
  top: 60px;
  right: 20px;
  z-index: 1001;
`;

export const DialogContainer = styled.div`
  background-color: ${v('--panel-bg')};
  border: 1px solid ${v('--border-default')};
  border-radius: 6px;
  padding: 12px;
  min-width: 400px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  color: ${v('--text-primary')};
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 13px;
`;

export const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid ${v('--border-default')};
`;

export const Title = styled.span`
  font-weight: 600;
  font-size: 14px;
  color: ${v('--text-primary')};
`;

export const CloseButton = styled.button`
  background-color: transparent;
  border: none;
  color: ${v('--text-secondary')};
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;

  &:hover {
    background-color: ${v('--grid-bg')};
    color: ${v('--text-primary')};
  }
`;

export const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
`;

export const Label = styled.label`
  width: 60px;
  text-align: right;
  color: ${v('--text-secondary')};
`;

export const Input = styled.input`
  flex: 1;
  padding: 6px 8px;
  background-color: ${v('--grid-bg')};
  border: 1px solid ${v('--border-default')};
  border-radius: 4px;
  color: ${v('--text-primary')};
  font-size: 13px;
  outline: none;

  &:focus {
    border-color: ${v('--accent-primary')};
  }
`;

export const ActionButton = styled.button`
  padding: 6px 12px;
  background-color: ${v('--accent-primary')};
  border: none;
  border-radius: 4px;
  color: ${v('--text-primary')};
  cursor: pointer;
  font-size: 12px;
  min-width: 50px;

  &:disabled {
    background-color: ${v('--text-disabled')};
    cursor: not-allowed;
    opacity: 0.5;
  }

  &:hover:not(:disabled) {
    opacity: 0.9;
  }
`;

export const OptionsRow = styled.div`
  display: flex;
  gap: 16px;
  margin-top: 8px;
  margin-bottom: 8px;
  padding-left: 68px;
`;

export const CheckboxLabel = styled.label`
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  font-size: 12px;
  color: ${v('--text-secondary')};
`;

export const StatusRow = styled.div`
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid ${v('--border-default')};
  font-size: 12px;
  color: ${v('--text-secondary')};
  text-align: center;
`;