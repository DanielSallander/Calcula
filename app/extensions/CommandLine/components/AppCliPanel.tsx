//! FILENAME: app/extensions/CommandLine/components/AppCliPanel.tsx
// PURPOSE: The main-window host of the shared CLI panel: a bottom-docked
//          fixed strip wrapping _shared/cli/components/CliPanel with the APP
//          domain always mounted and — when a model provider is registered
//          and a BI connection picked — the MODEL domain beside it. One
//          grammar, one engine; the kernel's single-write-domain rule keeps
//          mixed model+grid runs refused at plan time.
// CONTEXT: Registered through the dialog service; renders nothing while
//          closed. Storage keys are calcula.app.cli.* (the model editor's
//          calcula.modelEditor.cli.* keys are untouched).

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hideDialog, onAppEvent, showDialog } from "@api";
import { createCliEngine } from "../../_shared/cli/engine";
import type { CliEngine } from "../../_shared/cli/engine";
import {
  engineCompletionContext,
  registerCliLanguage,
  setCliCompletionContext,
} from "../../_shared/cli/language";
import { CliPanel } from "../../_shared/cli/components/CliPanel";
import type { CliPanelDriver, CliPanelPlan } from "../../_shared/cli/components/CliPanel";
import {
  getCliDomainProviders,
  onCliDomainProvidersChanged,
} from "../../_shared/cli/domainProviders";
import type { CliDomainBinding } from "../../_shared/cli/registry";
import type { CliDomainTarget } from "../../_shared/cli/domainProviders";
import { createAppDomain } from "../cli/appDomain";
import { createAppCliSession } from "../cli/appSession";
import type { AppCliSession } from "../cli/appSession";
import { createLiveAppGateway } from "../cli/appGateway";

const DIALOG_ID = "command-line-panel";
const APP_CLI_LANGUAGE_ID = "calcula-app-cli";
const STORAGE_PREFIX = "calcula.app.cli";

// ---------------------------------------------------------------------------
// Open/close toggle (used by the command + keybinding + menu item)
// ---------------------------------------------------------------------------

let panelOpen = false;

export function toggleAppCliPanel(): void {
  if (panelOpen) hideDialog(DIALOG_ID);
  else showDialog(DIALOG_ID);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function AppCliPanel(props: {
  isOpen: boolean;
  onClose: () => void;
}): React.ReactElement | null {
  const { isOpen, onClose } = props;

  // One app session per mount; the engine is rebuilt when a model binding is
  // added or removed (kind sets change, so the parser vocabulary changes).
  const appSessionRef = useRef<AppCliSession | null>(null);
  if (appSessionRef.current === null) {
    appSessionRef.current = createAppCliSession(createLiveAppGateway());
  }
  const appSession = appSessionRef.current;

  const [modelBinding, setModelBinding] = useState<CliDomainBinding | null>(null);
  const [modelTargets, setModelTargets] = useState<CliDomainTarget[]>([]);
  const [selectedTarget, setSelectedTarget] = useState("");
  const [providerTick, setProviderTick] = useState(0);
  const [bindError, setBindError] = useState<string | null>(null);

  const engine: CliEngine = useMemo(() => {
    const bindings: CliDomainBinding[] = [
      { domain: createAppDomain(), session: appSession } as CliDomainBinding,
    ];
    if (modelBinding) bindings.push(modelBinding);
    return createCliEngine(bindings, "app");
  }, [appSession, modelBinding]);

  // The Monaco language follows the engine: vocabulary on rebuild, completion
  // context (live names + option keys) from the engine's kind specs.
  useEffect(() => {
    registerCliLanguage(APP_CLI_LANGUAGE_ID, engine.parser.vocabulary);
    setCliCompletionContext(APP_CLI_LANGUAGE_ID, engineCompletionContext(engine));
  }, [engine]);

  // Model provider discovery (the ModelEditor registers one at activation).
  const modelProvider = useMemo(
    () => getCliDomainProviders().find((p) => p.id === "model") ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [providerTick],
  );
  useEffect(() => onCliDomainProvidersChanged(() => setProviderTick((t) => t + 1)), []);

  useEffect(() => {
    panelOpen = isOpen;
    if (!isOpen) return;
    void appSession.refresh();
    if (modelProvider) {
      void modelProvider
        .listTargets()
        .then(setModelTargets)
        .catch(() => setModelTargets([]));
    }
  }, [isOpen, appSession, modelProvider]);

  // The mounted model binding snapshots one overview; edits made elsewhere
  // (the Model Editor window, scripts) would leave it stale, so a model-change
  // event for the bound connection re-creates the binding with a fresh read.
  const selectTargetRef = useRef<(id: string) => void>(() => {});
  useEffect(() => {
    if (!isOpen || !selectedTarget) return;
    return onAppEvent<{ connectionId?: string }>("bi:model-changed", (detail) => {
      if (detail?.connectionId === selectedTarget) {
        selectTargetRef.current(selectedTarget);
      }
    });
  }, [isOpen, selectedTarget]);

  const selectTarget = useCallback(
    (targetId: string) => {
      setSelectedTarget(targetId);
      setBindError(null);
      if (!targetId || !modelProvider) {
        setModelBinding(null);
        return;
      }
      void modelProvider
        .createBinding(targetId)
        .then(setModelBinding)
        .catch((e) => {
          setModelBinding(null);
          setBindError(e instanceof Error ? e.message : String(e));
        });
    },
    [modelProvider],
  );
  selectTargetRef.current = selectTarget;

  const driver: CliPanelDriver = useMemo(
    () => ({
      languageId: APP_CLI_LANGUAGE_ID,
      storagePrefix: STORAGE_PREFIX,
      banner:
        "Calcula command line — type 'help' to get started. Try: ls sheets · set cell B2 = =SUM(A:A) · add sheet Report",
      readOnlyNote: null,
      plan(text: string): CliPanelPlan {
        const plan = engine.planRun(text);
        return {
          writeLabels: plan.writeLabels,
          needsConfirm: plan.needsConfirm,
          confirmNote: plan.confirmNote,
          async execute(io) {
            await engine.executeRun(plan, io);
            await appSession.refresh();
          },
        };
      },
    }),
    [engine, appSession],
  );

  if (!isOpen) return null;

  const picker =
    modelProvider !== null ? (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 11, color: "#6b7280" }}>Model:</span>
        <select
          style={{ fontSize: 11, maxWidth: 180 }}
          value={selectedTarget}
          onChange={(e) => selectTarget(e.target.value)}
          title="Mount a BI connection's model domain into this command line (add measure, ls measures, …)"
        >
          <option value="">— none —</option>
          {modelTargets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        {bindError && (
          <span style={{ fontSize: 11, color: "#b3261e" }} title={bindError}>
            couldn&apos;t mount
          </span>
        )}
      </span>
    ) : undefined;

  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 26,
        zIndex: 900,
        boxShadow: "0 -2px 8px rgba(0,0,0,0.08)",
      }}
    >
      <CliPanel
        driver={driver}
        onClose={onClose}
        headerExtra={picker}
        closeShortcut="Ctrl+Shift+P"
      />
    </div>
  );
}
