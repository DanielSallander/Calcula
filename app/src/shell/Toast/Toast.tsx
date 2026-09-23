//! FILENAME: app/src/shell/Toast/Toast.tsx
// PURPOSE: Toast notification UI component.
// CONTEXT: Renders toast messages at the bottom-right of the application window.
//          Calcula Clusters redesign: each variant paints with its semantic
//          tone pair (--tone-<t>-bg surface, --tone-<t>-fg icon and hairline),
//          the icon is the duotone RibbonIcon.Info/Success/Warn/Error at 20px,
//          and the card uses --radius-popover / --shadow-popover like every
//          other floating surface. Before, the four variants were fixed light
//          tints with literal-dark text, which is why the text could not follow
//          the skin; the tone backgrounds are now themed in BOTH baselines, so
//          the message uses --text-primary (>= 9:1 on every tone bg, Light and
//          Dark) and inverts with the skin.

import React from "react";
import { css, keyframes } from "@emotion/css";
import { useToastStore } from "./useToastStore";
import type { ToastItem } from "./useToastStore";
import { Button, FONT_FAMILY, ICON_SIZE_SM } from "../../api/layout";
import { RibbonIcon } from "../../api/ribbonIcons";

type ToastVariant = ToastItem["variant"];

/** One semantic tone per variant: surface, foreground, and the status glyph. */
const VARIANT_TONES: Record<
  ToastVariant,
  { bg: string; fg: string; icon: (props: { size?: number }) => React.ReactElement }
> = {
  info: {
    bg: "var(--tone-info-bg, #eff8ff)",
    fg: "var(--tone-info-fg, #175cd3)",
    icon: RibbonIcon.Info,
  },
  success: {
    bg: "var(--tone-ok-bg, #ecfdf3)",
    fg: "var(--tone-ok-fg, #067647)",
    icon: RibbonIcon.Success,
  },
  warning: {
    bg: "var(--tone-warn-bg, #fffaeb)",
    fg: "var(--tone-warn-fg, #b54708)",
    icon: RibbonIcon.Warn,
  },
  error: {
    bg: "var(--tone-danger-bg, #fef3f2)",
    fg: "var(--tone-danger-fg, #b42318)",
    icon: RibbonIcon.Error,
  },
};

const toastSlideIn = keyframes`
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
`;

/** The card every variant shares. */
const toastCard = css`
  display: flex;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  padding: 10px 10px 10px 14px;
  border-radius: var(--radius-popover, 12px);
  box-shadow: var(--shadow-popover, 0 8px 24px rgba(16, 24, 40, 0.12), 0 1px 3px rgba(16, 24, 40, 0.08));
  font-family: ${FONT_FAMILY};
  font-size: 13px;
  line-height: 1.4;
  color: var(--text-primary, #111827);
  max-width: 380px;
  animation: ${toastSlideIn} var(--motion-popover, 140ms cubic-bezier(0.2, 0, 0, 1));
`;

/** Per-variant surface + hairline (a tint of the tone's foreground). */
const VARIANT_CLASSES: Record<ToastVariant, string> = Object.fromEntries(
  (Object.keys(VARIANT_TONES) as ToastVariant[]).map((variant) => {
    const tone = VARIANT_TONES[variant];
    return [
      variant,
      css`
        background: ${tone.bg};
        border: 1px solid color-mix(in srgb, ${tone.fg} 28%, transparent);
      `,
    ];
  }),
) as Record<ToastVariant, string>;

const toastIcon = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: ${ICON_SIZE_SM}px;
  height: ${ICON_SIZE_SM}px;
`;

const toastMessage = css`
  flex: 1;
  min-width: 0;
`;

function ToastItem({ toast }: { toast: ToastItem }): React.ReactElement {
  const removeToast = useToastStore((s) => s.removeToast);
  const tone = VARIANT_TONES[toast.variant];
  const Icon = tone.icon;

  return (
    <div
      // Addressable from E2E: a toast is the ONLY channel several failure paths
      // have (a Design-Mode click, an unbound button, a mount refusal), so a
      // test that cannot read one cannot prove those paths speak at all.
      data-toast=""
      data-toast-variant={toast.variant}
      className={`${toastCard} ${VARIANT_CLASSES[toast.variant]}`}
      style={{
        // CLICK-THROUGH, like the container — and for the same reason, which was
        // only half-fixed there. The container comment below explains that a
        // LAYOUT BOX at z-index 9999 over the grid swallows clicks; this box is
        // 380px wide and ~58px tall and was doing exactly that for the 5 seconds
        // a toast lives, in the bottom-right corner of every user's grid.
        //
        // MEASURED 2026-08-18, not theorised: `macro-live-edit.spec.ts` places a
        // button at P63, the product shows "Button created at P63", and the click
        // 312 ms later is EATEN. The product's own `hitTestOverlays` returns the
        // button's region for that exact point while `document.elementFromPoint`
        // returns a <div> inside the toast. A/B on that spec: without dismissing
        // the toast 1 test fails, with it 5 pass.
        //
        // Only the OK button needs to be a surface, so only the OK button gets
        // `pointerEvents: "auto"`. Everything else about the toast is text.
        // Kept INLINE (not in the class) because toastClickThrough.test.tsx
        // pins it on the element itself.
        pointerEvents: "none",
      }}
    >
      <span className={toastIcon} style={{ color: tone.fg }} aria-hidden>
        <Icon size={ICON_SIZE_SM} />
      </span>
      <span className={toastMessage}>{toast.message}</span>
      <Button
        size="sm"
        onClick={() => removeToast(toast.id)}
        style={{
          flexShrink: 0,
          // The ONE surface in the toast. Its parent is click-through, so this
          // must re-enable pointer events or the toast becomes undismissable.
          pointerEvents: "auto",
        }}
      >
        OK
      </Button>
    </div>
  );
}

export function ToastContainer(): React.ReactElement | null {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 36,
        right: 16,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        // CLICK-THROUGH. This div is a LAYOUT BOX, not a surface: with
        // `auto` it spanned the union of every stacked toast (380px wide,
        // 200px+ tall with three of them) at z-index 9999 over the grid, so
        // a click in the 8px gaps — or anywhere the box was wider than the
        // toast in it — hit this div and was swallowed. The cell under the
        // pointer never got it. Each toast re-enables pointer events for
        // itself, so its OK button still works.
        pointerEvents: "none",
      }}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
