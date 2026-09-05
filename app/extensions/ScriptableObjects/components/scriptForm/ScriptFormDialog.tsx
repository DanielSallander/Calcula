//! FILENAME: app/extensions/ScriptableObjects/components/scriptForm/ScriptFormDialog.tsx
// PURPOSE: The TRUSTED renderer for TypeScript Forms (the VBA UserForm
//          replacement) — the modal a script's `form.define(spec).show()`
//          opens. The script sends DATA only (@api ScriptFormRequestPayload);
//          this component paints it with app tokens and the standard movable/
//          resizable dialog behaviour (useDialogWindow, like every dialog in
//          the app), and reports what the user did over ONE data-only event
//          (SCRIPT_FORM_INPUT_EVENT). The host registry decides what happens
//          next: a PATCH keeps the form open and changes what it shows, a CLOSE
//          takes it down.
//
// SECURITY: the header band is chrome the script cannot address — it always
// states which script is asking, where it came from, who opened it on the
// owner's behalf, which sheet the bindings are pinned to, and whether this is
// a preview. A script-supplied title is body content below that band, so a
// form can never present itself as the application (or as another script).
//
// THE ONE-TERMINAL-EVENT RULE: exactly one of submit / cancel leaves this
// component per session, guarded by `answered`. The only thing that re-arms
// it is the host REFUSING a submit (a PATCH carrying errors or a message),
// after which the user may submit or cancel again. Everything that closes
// without a terminal event (the host's CLOSE, the dialog manager) is covered
// by index.ts, which emits a cancel if the dialog vanished unanswered.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emitAppEvent, onAppEvent } from "@api/events";
import { useDialogWindow } from "@api/dialogWindow";
import type { DialogProps } from "@api/uiTypes";
import type {
  FormBinding,
  FormSeed,
  FormSpec,
  ScriptFormClosePayload,
  ScriptFormInputKind,
  ScriptFormInputPayload,
  ScriptFormPatchPayload,
  ScriptFormRequestPayload,
} from "@api/scriptHost/scriptFormSpec";
import {
  MAX_FORM_WIDTH,
  MIN_FORM_WIDTH,
  SCRIPT_FORM_CLOSE_EVENT,
  SCRIPT_FORM_INPUT_EVENT,
  SCRIPT_FORM_PATCH_EVENT,
} from "@api/scriptHost/scriptFormSpec";
import {
  buildFormResult,
  collectInputs,
  collectWidgets,
  dirtySet,
  initialFormValues,
  landFormPatch,
  validateFormValues,
  type FormControlOverride,
  type FormInputWidget,
  type ScriptFormValue,
  type ScriptFormValues,
  type WidgetOf,
} from "../../lib/scriptFormState";
import { FormWidgetTree, type FormRenderContext } from "./FormWidgetTree";
import { ScriptGlyphSvg, findFormWidgetFocusable, originPhrase } from "./hostChrome";
import * as S from "./ScriptFormDialog.styles";

/** The default dialog width when the spec names none. */
const DEFAULT_FORM_WIDTH = 460;
/** Idle-deadline re-arms are coalesced to one per this many ms. */
const INTERACTION_THROTTLE_MS = 1000;
/**
 * How long after a SCRIPT-driven focus a focus event is still the script's
 * doing. The event fires synchronously inside `.focus()`, so this only has to
 * cover the same tick; it is deliberately short so a user who reaches for the
 * keyboard right after a patch still counts as present.
 */
const SCRIPT_FOCUS_GRACE_MS = 100;

// ============================================================================
// Preview summary
// ============================================================================

interface PreviewRow {
  name: string;
  /** Where the value would go, in the script's own words; null when unbound. */
  target: string | null;
  /** The bound cell's current display, when the host seeded one. */
  current?: string;
  value: string;
}

function describeBinding(bind: FormBinding | undefined): string | null {
  if (bind === undefined) return null;
  if (typeof bind === "string") return bind;
  if ("cell" in bind) return bind.sheet !== undefined ? `${bind.sheet}!${bind.cell}` : bind.cell;
  if ("name" in bind) return bind.name;
  return `control ${bind.control}`;
}

function formatValue(value: ScriptFormValue | undefined): string {
  if (value === null || value === undefined) return "(blank)";
  if (Array.isArray(value)) return value.length === 0 ? "(none)" : value.join(", ");
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") return value === "" ? "(blank)" : value;
  return String(value);
}

function buildPreviewRows(
  spec: FormSpec,
  seeds: Record<string, FormSeed>,
  values: ScriptFormValues,
): PreviewRow[] {
  const result = buildFormResult(spec, values);
  return collectInputs(spec).map(({ widget }) => ({
    name: widget.name,
    target: describeBinding(widget.bind),
    current: seeds[widget.name]?.display,
    value: formatValue(result[widget.name]),
  }));
}

// ============================================================================
// Session (all hooks; mounted only with a request)
// ============================================================================

interface SessionProps {
  request: ScriptFormRequestPayload;
  onClose: () => void;
}

function FormSession({ request, onClose }: SessionProps): React.ReactElement {
  const { showId, spec } = request;
  const preview = request.preview === true;
  const {
    ref: dialogRef,
    style: dialogStyle,
    onHeaderMouseDown,
    resizeHandles,
  } = useDialogWindow({ minWidth: 360, minHeight: 200 });

  const inputs = useMemo(() => collectInputs(spec), [spec]);
  const inputsByName = useMemo(() => {
    const map = new Map<string, FormInputWidget>();
    for (const { widget } of inputs) map.set(widget.name, widget);
    return map;
  }, [inputs]);
  const buttonWidgets = useMemo(
    () =>
      collectWidgets(spec)
        .map((e) => e.widget)
        .filter((w): w is WidgetOf<"button"> => w.type === "button"),
    [spec],
  );

  // State the widgets read. Refs shadow the pieces the event listeners need,
  // so a PATCH arriving between renders sees the latest values, not a closure.
  const [seeds, setSeedsState] = useState<Record<string, FormSeed>>(() => ({ ...request.seeds }));
  const seedsRef = useRef(seeds);
  const [values, setValuesState] = useState<ScriptFormValues>(() => initialFormValues(spec, request.seeds));
  const valuesRef = useRef(values);
  const [controls, setControlsState] = useState<Record<string, FormControlOverride>>({});
  const controlsRef = useRef(controls);
  const [stale, setStaleState] = useState<ReadonlySet<string>>(() => new Set());
  const staleRef = useRef(stale);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ text: string; kind?: "info" | "warning" | "error" } | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ name: string; seq: number; fromScript?: boolean } | null>(null);
  const focusSeq = useRef(0);
  const [pending, setPending] = useState(false);
  const [previewRows, setPreviewRows] = useState<PreviewRow[] | null>(null);

  // Exactly one terminal event may leave; `closed` stops anything after CLOSE.
  const answered = useRef(false);
  const closed = useRef(false);
  const shownEmitted = useRef(false);
  const lastInteraction = useRef(0);
  // When a SCRIPT patch last moved the focus. The focus event that follows is
  // the script's doing, not the user's, and must not be reported as an
  // interaction — see `onInteraction`. A timestamp rather than a flag, because
  // focusing an element that already has focus fires no event at all and a
  // flag would then swallow the user's next real keystroke.
  const scriptFocusAt = useRef(0);
  // Names the USER has changed — what decides whether a refreshed seed may
  // overwrite a widget. A script patch is not a user edit.
  const touched = useRef(new Set<string>());

  const setValues = useCallback((next: ScriptFormValues) => {
    valuesRef.current = next;
    setValuesState(next);
  }, []);
  const setControls = useCallback((next: Record<string, FormControlOverride>) => {
    controlsRef.current = next;
    setControlsState(next);
  }, []);
  const setSeeds = useCallback((next: Record<string, FormSeed>) => {
    seedsRef.current = next;
    setSeedsState(next);
  }, []);
  const setStale = useCallback((next: ReadonlySet<string>) => {
    staleRef.current = next;
    setStaleState(next);
  }, []);

  const requestFocus = useCallback((name: string, fromScript = false) => {
    focusSeq.current += 1;
    setFocusRequest({ name, seq: focusSeq.current, fromScript });
  }, []);

  const emit = useCallback(
    (kind: ScriptFormInputKind, extra: { name?: string; value?: ScriptFormValue } = {}) => {
      const payload: ScriptFormInputPayload = {
        showId,
        kind,
        ...extra,
        values: valuesRef.current,
      };
      emitAppEvent(SCRIPT_FORM_INPUT_EVENT, payload);
    },
    [showId],
  );

  // `show()` resolves on this.
  useEffect(() => {
    if (shownEmitted.current) return;
    shownEmitted.current = true;
    emit("shown");
  }, [emit]);

  const dirty = useMemo(() => dirtySet(values, seeds, spec), [values, seeds, spec]);

  const onValueChange = useCallback(
    (name: string, value: ScriptFormValue) => {
      if (closed.current) return;
      touched.current.add(name);
      const next = { ...valuesRef.current, [name]: value };
      setValues(next);
      setErrors((prev) => {
        if (prev[name] === undefined) return prev;
        const rest = { ...prev };
        delete rest[name];
        return rest;
      });
      if (staleRef.current.has(name)) {
        const rest = new Set(staleRef.current);
        rest.delete(name);
        setStale(rest);
      }
      emit("change", { name, value });
    },
    [emit, setValues, setStale],
  );

  const onInteraction = useCallback(() => {
    if (closed.current) return;
    // A focus the SCRIPT asked for is not the user being present. The host's
    // 30-minute idle deadline exists to free the app-wide modal slot when
    // nobody is answering the form, and it is re-armed by interaction — so a
    // script that patches `{ focus: "…" }` on a timer would move focus, the
    // DOM focus handler would report an interaction, and the form would sit
    // open with no user until the 8-hour absolute cap.
    const now = Date.now();
    if (now - scriptFocusAt.current < SCRIPT_FOCUS_GRACE_MS) return;
    if (now - lastInteraction.current < INTERACTION_THROTTLE_MS) return;
    lastInteraction.current = now;
    emit("interaction");
  }, [emit]);

  // Cancel / Escape / X / backdrop / a role:"cancel" button all take THIS path.
  const cancel = useCallback(() => {
    if (answered.current || closed.current) return;
    answered.current = true;
    closed.current = true;
    emit("cancel");
    onClose();
  }, [emit, onClose]);

  const submit = useCallback(() => {
    if (answered.current || closed.current) return;
    const found = validateFormValues(spec, valuesRef.current, {
      seeds: seedsRef.current,
      controls: controlsRef.current,
    });
    const names = Object.keys(found);
    if (names.length > 0) {
      setErrors(found);
      requestFocus(names[0]);
      return;
    }
    if (preview) {
      // Nothing leaves the renderer: the author sees what WOULD be written.
      setPreviewRows(buildPreviewRows(spec, seedsRef.current, valuesRef.current));
      return;
    }
    answered.current = true;
    setPending(true);
    emit("submit");
  }, [spec, preview, emit, requestFocus]);

  const onButton = useCallback(
    (widget: WidgetOf<"button">) => {
      if (closed.current) return;
      const role = widget.role ?? "default";
      if (role === "submit") submit();
      else if (role === "cancel") cancel();
      else emit("click", { name: widget.name });
    },
    [submit, cancel, emit],
  );

  // ---- Host -> renderer: PATCH ----
  useEffect(
    () =>
      onAppEvent<ScriptFormPatchPayload>(SCRIPT_FORM_PATCH_EVENT, (detail) => {
        if (!detail || detail.showId !== showId || closed.current) return;

        // The values / control / seed rules live in ONE place (landFormPatch,
        // scriptFormState.ts) because the modeless pane lands the same patch:
        // a script's `values: { amount: "12" }` is 12 on a number widget, and
        // refreshed seeds land ONLY on widgets the user has not touched — a
        // dirty widget keeps the user's value and is marked stale so they know
        // the cell moved underneath them.
        const landed = landFormPatch(
          {
            values: valuesRef.current,
            controls: controlsRef.current,
            seeds: seedsRef.current,
            stale: staleRef.current,
          },
          detail,
          inputsByName,
          touched.current,
        );

        if (detail.patch) {
          if (detail.patch.values) {
            const patched = landed.patchedNames;
            setErrors((prev) => {
              const rest = { ...prev };
              for (const name of patched) delete rest[name];
              return rest;
            });
          }
          if (detail.patch.message !== undefined) setMessage(detail.patch.message);
          if (detail.patch.focus) requestFocus(detail.patch.focus, true);
        }

        if (detail.seeds) {
          setSeeds(landed.seeds);
          setStale(landed.stale);
        }

        if (landed.values !== valuesRef.current) setValues(landed.values);
        if (landed.controls !== controlsRef.current) setControls(landed.controls);

        if (detail.errors) {
          const incoming = detail.errors;
          setErrors((prev) => ({ ...prev, ...incoming }));
          const first = Object.keys(incoming)[0];
          if (first) requestFocus(first);
        }
        if (detail.message !== undefined) setMessage(detail.message);

        // A refusal: the host kept the form open, so the user may act again.
        // `refused` is READ, not inferred: a script may refuse bare — `false`,
        // `"cancel"`, or `{ cancel: true }` alone — and a form that clears its
        // pending state only when errors or a banner arrive stays disabled
        // forever on exactly that verdict.
        const refused =
          detail.refused === true ||
          detail.errors !== undefined ||
          (detail.message !== undefined && detail.message !== null);
        if (refused) {
          answered.current = false;
          setPending(false);
          // A bare refusal says nothing at all. The user pressed a button and
          // watched it do nothing, so the host says why in its OWN words — the
          // script gets to block the submit, not to write the chrome.
          if (detail.errors === undefined && detail.message === undefined) {
            setMessage({ text: "The script did not accept these values.", kind: "warning" });
          }
        }
      }),
    [showId, inputsByName, requestFocus, setValues, setControls, setSeeds, setStale],
  );

  // ---- Host -> renderer: CLOSE (submitted, script, deadline, unmount) ----
  useEffect(
    () =>
      onAppEvent<ScriptFormClosePayload>(SCRIPT_FORM_CLOSE_EVENT, (detail) => {
        if (!detail || detail.showId !== showId) return;
        answered.current = true;
        closed.current = true;
        onClose();
      }),
    [showId, onClose],
  );

  // ---- Focus requests (script patch, first error) ----
  // Runs after EVERY render while a request is outstanding: the widget may
  // sit on a tab page that TabStrip is only now bringing forward. The request
  // is consumed through a ref (its sequence number), never by setting state
  // from inside the effect.
  const consumedFocusSeq = useRef(0);
  useEffect(() => {
    if (!focusRequest || focusRequest.seq === consumedFocusSeq.current) return;
    const root = dialogRef.current;
    if (!root) return;
    const lookup = findFormWidgetFocusable(root, focusRequest.name);
    if (lookup.kind === "unsafe") {
      consumedFocusSeq.current = focusRequest.seq;
      return;
    }
    // Not rendered yet: keep the request and look again on the next render.
    if (lookup.kind === "missing") return;
    // Stamped immediately before the call, because the focus event it raises
    // is synchronous: `onInteraction` reads this to tell the script's own
    // focus from the user's, and only the user's re-arms the idle deadline.
    if (focusRequest.fromScript) scriptFocusAt.current = Date.now();
    lookup.focusable?.focus();
    consumedFocusSeq.current = focusRequest.seq;
  });

  // ---- Keyboard ----
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
        return;
      }
      if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      if (spec.submitOnEnter === false) return;
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      // Enter is a newline in a textarea, a selection in a list, and the
      // button's own click on a button — never Submit.
      if (tag === "TEXTAREA" || tag === "BUTTON" || tag === "A") return;
      if (tag === "SELECT" && (target as HTMLSelectElement).multiple) return;
      if (target.closest("[data-form-listbox], [role='tablist']")) return;
      e.preventDefault();
      submit();
    },
    [cancel, submit, spec.submitOnEnter],
  );

  // ---- Derived presentation ----
  const width = useMemo(() => {
    const viewport = typeof window !== "undefined" ? window.innerWidth - 64 : MAX_FORM_WIDTH;
    const ceiling = Math.min(MAX_FORM_WIDTH, viewport);
    return Math.max(MIN_FORM_WIDTH, Math.min(spec.width ?? DEFAULT_FORM_WIDTH, ceiling));
  }, [spec.width]);

  const autoFocusName = useMemo(() => {
    const usable = (w: FormInputWidget): boolean => {
      const seed = request.seeds[w.name];
      return !w.hidden && !w.disabled && seed?.readOnly !== true && seed?.formula === undefined;
    };
    if (spec.focus) {
      const input = inputsByName.get(spec.focus);
      if (input) {
        if (usable(input)) return spec.focus;
      } else if (buttonWidgets.some((b) => b.name === spec.focus && !b.hidden && !b.disabled)) {
        return spec.focus;
      }
    }
    return inputs.find(({ widget }) => usable(widget))?.widget.name ?? null;
  }, [spec.focus, inputs, inputsByName, buttonWidgets, request.seeds]);

  // INITIAL FOCUS AS A REQUEST, NOT ONLY AS `autoFocus`.
  //
  // React's `autoFocus` reaches an element that is RENDERED. `spec.focus` may
  // name a widget on a tab page that is not the active one, and the tree
  // renders only the active page — so the attribute landed on nothing and the
  // form opened with focus nowhere at all: the first keystroke went to the
  // document and Enter did not submit. A focus REQUEST brings the owning page
  // forward (TabStrip switches for it) and the dialog's focus effect then finds
  // the element on the next render. Issued once, on mount.
  //
  // It is also ONE SHOT. `autoFocus` is an attribute on a rendered element, and
  // a tab page's widgets REMOUNT every time the user comes back to it — so the
  // attribute can fire again on each return, pulling focus off the tab strip
  // and into the first field, which breaks arrow-key navigation between pages.
  // After the initial focus is placed, the attribute is disarmed and focus is
  // only ever moved by a request (an error, a script patch).
  //
  // NOT PINNED BY A UNIT TEST: jsdom does not reproduce the re-focus (reverting
  // this line leaves every test green), so a test here would only look like
  // cover. The e2e journey drives a real browser and is where it can be seen.
  const initialFocusIssued = useRef(false);
  useEffect(() => {
    if (initialFocusIssued.current || autoFocusName === null) return;
    initialFocusIssued.current = true;
    requestFocus(autoFocusName);
  }, [autoFocusName, requestFocus]);

  // THE ONE LINE A FORM MUST NOT BE ABLE TO CHOOSE.
  //
  // The branch is on `kind`, never on a name. It used to test
  // `scriptOrigin === "local"` against a field that carried EITHER the sentinel
  // OR the application name — so publishing an application called `local` made
  // this band tell the reviewer the form came from their own workbook. The
  // discriminated `FormOrigin` removes the value that did it: a package named
  // "local" is `{ kind: "package", name: "local" }` and paints as a package.
  const provenance = useMemo(() => {
    const origin = `A form from ${originPhrase(request.origin)}`;
    return request.callerName ? `${origin} — opened by ${request.callerName}` : origin;
  }, [request.origin, request.callerName]);

  const hasSubmitWidget = buttonWidgets.some(
    (b) => b.role === "submit" && !b.hidden && !controls[b.name]?.hidden,
  );
  const hasCancelWidget = buttonWidgets.some(
    (b) => b.role === "cancel" && !b.hidden && !controls[b.name]?.hidden,
  );
  const submitLabel = spec.submitLabel ?? "OK";
  const cancelLabel = spec.cancelLabel ?? "Cancel";
  const bandId = `script-form-band-${showId}`;

  const ctx: FormRenderContext = {
    showId,
    values,
    controls,
    seeds,
    errors,
    dirty,
    stale,
    // Armed for the FIRST paint only, and disarmed by the existence of a focus
    // request rather than by a flag: the mount effect above issues one
    // immediately, so this is true for exactly the first render. That matters
    // because a tab page's widgets remount every time the user returns to it,
    // and a live `autoFocus` fired again each time — pulling focus off the tab
    // strip and breaking arrow-key navigation between pages.
    autoFocusName: focusRequest === null ? autoFocusName : null,
    focusRequest,
    locked: pending,
    onValueChange,
    onButton,
    onInteraction,
  };

  return (
    <S.Backdrop onMouseDown={cancel}>
      <S.DialogContainer
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={bandId}
        data-script-form={showId}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{ position: "relative", width, ...dialogStyle }}
      >
        {/* Attribution band — chrome, drag handle, and the one thing a script
            cannot influence: every line here is host-derived. */}
        <S.Header onMouseDown={onHeaderMouseDown}>
          <S.ScriptGlyph>{ScriptGlyphSvg}</S.ScriptGlyph>
          <S.HeaderText id={bandId} data-script-form-band="">
            <S.AskedBy>{request.scriptName}</S.AskedBy>
            <S.Provenance>{provenance}</S.Provenance>
            {request.pinnedSheetName ? <S.Provenance>{`Sheet: ${request.pinnedSheetName}`}</S.Provenance> : null}
            {preview ? <S.PreviewBanner>Preview — nothing will be written</S.PreviewBanner> : null}
          </S.HeaderText>
          <S.CloseButton type="button" onClick={cancel} title="Close (Esc)" aria-label="Close">
            X
          </S.CloseButton>
        </S.Header>

        <S.Body style={{ maxHeight: "80vh" }}>
          {spec.title ? <S.ScriptTitle data-script-form-title="">{spec.title}</S.ScriptTitle> : null}
          {spec.description ? <S.Message>{spec.description}</S.Message> : null}
          {message ? (
            <S.MessageBanner $kind={message.kind ?? "info"} role={message.kind === "error" ? "alert" : "status"} data-script-form-message="">
              {message.text}
            </S.MessageBanner>
          ) : null}

          {previewRows ? (
            <>
              <S.PreviewHeading>What would be written</S.PreviewHeading>
              <S.PreviewList data-script-form-preview="">
                {previewRows.map((row) => (
                  <React.Fragment key={row.name}>
                    <dt>{row.target ? `${row.name} → ${row.target}` : row.name}</dt>
                    <dd>{row.current !== undefined ? `${row.value} (now ${row.current})` : row.value}</dd>
                  </React.Fragment>
                ))}
              </S.PreviewList>
            </>
          ) : (
            <FormWidgetTree widgets={spec.children} ctx={ctx} width={width - 32} />
          )}
        </S.Body>

        <S.Footer>
          {previewRows ? (
            <>
              <S.Button type="button" onClick={() => setPreviewRows(null)} data-script-form-back="">
                Back
              </S.Button>
              <S.PrimaryButton type="button" onClick={cancel} data-script-form-close="">
                Close
              </S.PrimaryButton>
            </>
          ) : (
            <>
              {hasCancelWidget ? null : (
                <S.Button type="button" onClick={cancel} disabled={pending} data-script-form-cancel="">
                  {cancelLabel}
                </S.Button>
              )}
              {hasSubmitWidget ? null : (
                <S.PrimaryButton type="button" onClick={submit} disabled={pending} data-script-form-submit="">
                  {pending ? "Working…" : submitLabel}
                </S.PrimaryButton>
              )}
            </>
          )}
        </S.Footer>

        {resizeHandles}
      </S.DialogContainer>
    </S.Backdrop>
  );
}

// ============================================================================
// Dialog entry (DialogProps)
// ============================================================================

export default function ScriptFormDialog({ onClose, data }: DialogProps): React.ReactElement | null {
  const request = data as unknown as ScriptFormRequestPayload | undefined;
  if (!request || typeof request.showId !== "string" || !request.spec) return null;
  // Keyed by showId so a second request re-mounts a fresh session rather than
  // inheriting the previous form's state.
  return <FormSession key={request.showId} request={request} onClose={onClose} />;
}
