//! FILENAME: app/extensions/BuiltIn/ObjectPosition/components/SizePositionDialog.tsx
// PURPOSE: The Size and Position dialog: X, Y, Width and Height of ONE
//          floating object, committed as ONE undo step (BUG-0258 design phase
//          5b -- the no-drag route WCAG 2.2 SC 2.5.7 requires).
// CONTEXT: Opened through @api/objectPosition (`openSizeAndPosition`) from the
//          grip's menu, every object family's right-click menu, the canvas's
//          Arrange group and the `object.sizeAndPosition` command. It knows no
//          family: it reads the object's published region, asks the seam what
//          the object may do (`sizeAndPositionAvailability` -- Core's own drag
//          rule), and commits through @api/objectGeometry, whose provider for
//          that family persists it.
//
//          The four boxes keep a LOCAL draft; nothing is written until OK, and
//          OK writes exactly once (`commitObjectGeometry([change],
//          "Size and Position")`) -- never per box, so the edit is one Ctrl+Z.
//          Cancel, Escape (the shell's) and an unchanged OK write nothing.
//
//          Plan decision D7: px (logical, the units the families store), no
//          snap, kept on the page on a canvas, at least 16 px; every box
//          disabled, with the reason, where Core's drag would refuse (locked,
//          subscribed page, run-mode button); Width and Height disabled where
//          the family derives the size (a floating grid).

import React, { useCallback, useId, useRef, useState } from "react";
import type { DialogProps } from "@api/uiTypes";
import { Button, Field, LT, NumberField } from "@api/layout";
import { DialogBody, DialogFieldGrid, DialogPane, DialogSection, dialogWidth } from "@api/dialogLayout";
import { useDialogWindow } from "@api/dialogWindow";
import { getGridRegions, type GridRegion } from "@api/gridOverlays";
import { commitObjectGeometry } from "@api/objectGeometry";
import { showToast } from "@api/notifications";
import { SIZE_AND_POSITION_UNDO_LABEL, sizeAndPositionAvailability } from "@api/objectPosition";
import { objectLabelOf } from "@api/objectSelection";
import { changedFields, initialFields, sizePositionChange, type SizePositionFields } from "../lib/sizePosition";

/** The dialog's id in the dialog registry. */
export const SIZE_POSITION_DIALOG_ID = "objectPosition:sizeAndPosition";

/** What the dialog says when the object it was opened for is gone. */
export const SIZE_POSITION_GONE = "The object is no longer on this sheet.";

function findRegion(regionId: string | null): GridRegion | null {
  if (!regionId) return null;
  return getGridRegions().find((r) => r.id === regionId && !!r.floating) ?? null;
}

/** Whole and fractional px alike, without float noise ("100", "100.5"). */
function px(n: number): string {
  return String(parseFloat(n.toPrecision(12)));
}

export function SizePositionDialog({ onClose, data }: DialogProps): React.ReactElement | null {
  const regionId = typeof data?.regionId === "string" ? data.regionId : null;
  const region = findRegion(regionId);
  const win = useDialogWindow({ minWidth: 320, minHeight: 200, resizable: false });
  const titleId = useId();

  return (
    <div style={styles.backdrop} data-size-position-dialog="">
      <div
        ref={win.ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ ...styles.dialog, ...win.style }}
      >
        <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <span id={titleId} style={styles.title}>
            Size and Position
          </span>
        </div>
        {region ? (
          <SizePositionForm key={region.id} region={region} onClose={onClose} />
        ) : (
          <>
            <DialogBody stacked>
              <DialogPane scroll={false}>
                <div style={styles.note} data-testid="size-position-reason">
                  {SIZE_POSITION_GONE}
                </div>
              </DialogPane>
            </DialogBody>
            <div style={styles.footer}>
              <Button variant="outlined" style={styles.footerButton} onClick={onClose} data-testid="size-position-close">
                Close
              </Button>
            </div>
          </>
        )}
        {win.resizeHandles}
      </div>
    </div>
  );
}

function SizePositionForm({ region, onClose }: { region: GridRegion; onClose: () => void }): React.ReactElement {
  const [initial] = useState<SizePositionFields>(() => initialFields(region));
  const [fields, setFields] = useState<SizePositionFields>(initial);
  const [busy, setBusy] = useState(false);
  // A ref, not the state: a second OK in the same tick (a double click, Enter
  // and a click) must not commit twice before React re-renders.
  const committing = useRef(false);

  // Read live: Design Mode, a lock or a detach can change while the dialog is open.
  const availability = sizeAndPositionAvailability(region);
  const canMove = availability.move;
  const canResize = availability.move && availability.resize;
  const name = objectLabelOf(region);

  const set = (key: keyof SizePositionFields) => (value: number | null) =>
    setFields((prev) => ({ ...prev, [key]: value }));

  const commit = useCallback(async () => {
    if (committing.current) return;
    const fresh = findRegion(region.id);
    if (!fresh) {
      showToast(`Size and Position: ${SIZE_POSITION_GONE}`, { type: "error" });
      onClose();
      return;
    }
    const now = sizeAndPositionAvailability(fresh);
    if (!now.move) {
      onClose();
      return;
    }
    const change = sizePositionChange(fresh, changedFields(initial, fields), now.page, { resize: now.resize });
    if (!change) {
      onClose();
      return;
    }
    committing.current = true;
    setBusy(true);
    try {
      // ONE call, ONE change: the seam runs it inside ONE undo transaction and
      // shows ONE toast if the backend refuses it (a protected sheet).
      await commitObjectGeometry([change], SIZE_AND_POSITION_UNDO_LABEL);
    } finally {
      onClose();
    }
  }, [fields, initial, onClose, region.id]);

  const page = availability.page;
  return (
    <form
      style={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (canMove) void commit();
        else onClose();
      }}
    >
      <DialogBody stacked>
        <DialogPane scroll={false} padding="12px 16px">
          {name && (
            <div style={styles.subject} data-testid="size-position-subject">
              {name}
            </div>
          )}
          <DialogFieldGrid minColumnWidth={140} maxColumns={2} rowGap={12}>
            <DialogSection title="Position">
              <div style={styles.pair}>
                <Field label="X">
                  <NumberField
                    value={fields.x}
                    onChange={set("x")}
                    min={0}
                    suffix="px"
                    width={84}
                    ariaLabel="X"
                    disabled={!canMove}
                    autoFocus={canMove}
                    testId="size-position-x"
                  />
                </Field>
                <Field label="Y">
                  <NumberField
                    value={fields.y}
                    onChange={set("y")}
                    min={0}
                    suffix="px"
                    width={84}
                    ariaLabel="Y"
                    disabled={!canMove}
                    testId="size-position-y"
                  />
                </Field>
              </div>
            </DialogSection>
            <DialogSection title="Size">
              <div style={styles.pair}>
                <Field label="Width">
                  <NumberField
                    value={fields.width}
                    onChange={set("width")}
                    suffix="px"
                    width={84}
                    ariaLabel="Width"
                    disabled={!canResize}
                    testId="size-position-width"
                  />
                </Field>
                <Field label="Height">
                  <NumberField
                    value={fields.height}
                    onChange={set("height")}
                    suffix="px"
                    width={84}
                    ariaLabel="Height"
                    disabled={!canResize}
                    testId="size-position-height"
                  />
                </Field>
              </div>
            </DialogSection>
          </DialogFieldGrid>
          {(availability.reason ?? (canMove ? availability.sizeReason : null)) && (
            <div style={styles.note} role="note" data-testid="size-position-reason">
              {availability.reason ?? availability.sizeReason}
            </div>
          )}
          {canMove && page && (
            <div style={styles.hint} data-testid="size-position-page">
              Kept on the {px(page.width)} x {px(page.height)} px page.
            </div>
          )}
        </DialogPane>
      </DialogBody>
      <div style={styles.footer}>
        {canMove ? (
          <>
            <Button
              type="button"
              variant="outlined"
              style={styles.footerButton}
              onClick={onClose}
              data-testid="size-position-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="outlined"
              style={{ ...styles.footerButton, ...styles.primary }}
              disabled={busy}
              data-testid="size-position-ok"
            >
              OK
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="outlined"
            style={styles.footerButton}
            onClick={onClose}
            data-testid="size-position-close"
            autoFocus
          >
            Close
          </Button>
        )}
      </div>
    </form>
  );
}

// ============================================================================
// Styles (theme tokens only, so the dialog follows the skin)
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "var(--dialog-overlay-bg, rgba(0, 0, 0, 0.3))",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10000,
  },
  dialog: {
    position: "relative",
    background: "var(--dialog-bg, #ffffff)",
    border: "1px solid var(--dialog-border, #d1d5db)",
    borderRadius: LT.radiusPopover,
    color: LT.text,
    width: dialogWidth(400),
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    boxShadow: LT.shadowRaised,
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  },
  header: {
    display: "flex",
    alignItems: "center",
    padding: "12px 16px",
    borderBottom: `1px solid ${LT.border}`,
    cursor: "move",
    userSelect: "none",
    flexShrink: 0,
  },
  title: {
    fontSize: "14px",
    fontWeight: 600,
    color: "var(--dialog-title-text, #111827)",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
  },
  subject: {
    fontSize: "12px",
    color: LT.textSecondary,
    marginBottom: "10px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pair: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  note: {
    marginTop: "12px",
    padding: "8px 10px",
    fontSize: "12px",
    lineHeight: "16px",
    color: LT.warnFg,
    background: LT.warnBg,
    borderRadius: LT.radiusControl,
  },
  hint: {
    marginTop: "10px",
    fontSize: "11px",
    color: LT.textSecondary,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "12px 16px",
    borderTop: `1px solid ${LT.border}`,
    flexShrink: 0,
  },
  footerButton: {
    minWidth: 80,
  },
  primary: {
    fontWeight: 600,
  },
};
