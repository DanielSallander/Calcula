//! FILENAME: app/extensions/BuiltIn/Encryption/EncryptFileDialog.tsx
// PURPOSE: Set, change, or remove the password on the current workbook.
// CONTEXT: Opened from File > "Encrypt with Password…". Returns the chosen
// action via data.onResult; the extension performs the actual save.

import React, { useState, useCallback, useRef, useEffect } from "react";
import type { DialogProps } from "@api/uiTypes";
import * as S from "./dialog.styles";

export interface EncryptDialogResult {
  /** True when the user chose to remove encryption instead of setting it. */
  remove: boolean;
  password: string;
  remember: boolean;
}

interface EncryptDialogData {
  /** Whether the document is already encrypted (enables "Remove Password"). */
  isEncrypted?: boolean;
  onResult?: (result: EncryptDialogResult | null) => void;
}

export function EncryptFileDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;
  const { isEncrypted = false, onResult } = (data ?? {}) as EncryptDialogData;

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  const finish = useCallback(
    (result: EncryptDialogResult | null) => {
      onResult?.(result);
      onClose();
    },
    [onResult, onClose]
  );

  const handleCancel = useCallback(() => finish(null), [finish]);

  const handleOK = useCallback(() => {
    if (password.length === 0) {
      setError("Enter a password.");
      return;
    }
    if (password !== confirm) {
      setError("The passwords don't match.");
      return;
    }
    finish({ remove: false, password, remember });
  }, [password, confirm, remember, finish]);

  const handleRemove = useCallback(() => {
    finish({ remove: true, password: "", remember: false });
  }, [finish]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        handleCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        handleOK();
      }
    },
    [handleCancel, handleOK]
  );

  const title = isEncrypted ? "Change Password" : "Encrypt with Password";

  return (
    <S.Backdrop onClick={handleCancel}>
      <S.DialogContainer
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <S.Header>
          <S.Title>{title}</S.Title>
          <S.CloseButton onClick={handleCancel} title="Close (Esc)">
            X
          </S.CloseButton>
        </S.Header>

        <S.Body>
          <S.Warning>
            Encrypts the entire workbook on disk. Keep your password safe — if you
            lose it, the file <strong>cannot be recovered</strong>.
          </S.Warning>

          <S.Field>
            {isEncrypted ? "New password" : "Password"}
            <S.Input
              ref={firstInputRef}
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(e) => {
                setPassword(e.target.value);
                setError("");
              }}
            />
          </S.Field>

          <S.Field>
            Confirm password
            <S.Input
              type="password"
              value={confirm}
              autoComplete="new-password"
              onChange={(e) => {
                setConfirm(e.target.value);
                setError("");
              }}
            />
          </S.Field>

          <S.CheckboxLabel>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Remember password on this machine
          </S.CheckboxLabel>

          <S.ErrorText>{error}</S.ErrorText>
        </S.Body>

        <S.Footer>
          <S.FooterLeft>
            {isEncrypted && (
              <S.Button $danger onClick={handleRemove}>
                Remove Password
              </S.Button>
            )}
          </S.FooterLeft>
          <S.FooterRight>
            <S.Button onClick={handleCancel}>Cancel</S.Button>
            <S.Button $primary onClick={handleOK}>
              OK
            </S.Button>
          </S.FooterRight>
        </S.Footer>
      </S.DialogContainer>
    </S.Backdrop>
  );
}

export default EncryptFileDialog;
