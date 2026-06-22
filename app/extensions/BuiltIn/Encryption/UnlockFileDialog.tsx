//! FILENAME: app/extensions/BuiltIn/Encryption/UnlockFileDialog.tsx
// PURPOSE: Prompt for the passphrase needed to open an encrypted workbook.
// CONTEXT: Driven by the open re-prompt loop in core/lib/file-api via the
// registered password-prompt hook. Returns {password, remember} or null
// (cancel) through data.onResult.

import React, { useState, useCallback, useRef, useEffect } from "react";
import type { DialogProps } from "@api/uiTypes";
import * as S from "./dialog.styles";

export interface UnlockDialogResult {
  password: string;
  remember: boolean;
}

interface UnlockDialogData {
  /** Display name of the file being opened. */
  fileName?: string;
  /** 'wrong' when the previous attempt failed authentication. */
  errorKind?: "wrong" | null;
  onResult?: (result: UnlockDialogResult | null) => void;
}

export function UnlockFileDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;
  const { fileName, errorKind, onResult } = (data ?? {}) as UnlockDialogData;

  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const finish = useCallback(
    (result: UnlockDialogResult | null) => {
      onResult?.(result);
      onClose();
    },
    [onResult, onClose]
  );

  const handleCancel = useCallback(() => finish(null), [finish]);

  const handleOK = useCallback(() => {
    if (password.length === 0) return;
    finish({ password, remember });
  }, [password, remember, finish]);

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

  return (
    <S.Backdrop onClick={handleCancel}>
      <S.DialogContainer
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <S.Header>
          <S.Title>Password Required</S.Title>
          <S.CloseButton onClick={handleCancel} title="Close (Esc)">
            X
          </S.CloseButton>
        </S.Header>

        <S.Body>
          <S.Field>
            {fileName
              ? `"${fileName}" is encrypted. Enter its password:`
              : "This workbook is encrypted. Enter its password:"}
            <S.Input
              ref={inputRef}
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
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

          <S.ErrorText>
            {errorKind === "wrong" ? "Incorrect password. Try again." : ""}
          </S.ErrorText>
        </S.Body>

        <S.Footer>
          <S.FooterLeft />
          <S.FooterRight>
            <S.Button onClick={handleCancel}>Cancel</S.Button>
            <S.Button $primary onClick={handleOK} disabled={password.length === 0}>
              Open
            </S.Button>
          </S.FooterRight>
        </S.Footer>
      </S.DialogContainer>
    </S.Backdrop>
  );
}

export default UnlockFileDialog;
