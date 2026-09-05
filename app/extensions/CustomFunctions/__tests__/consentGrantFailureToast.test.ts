//! FILENAME: app/extensions/CustomFunctions/__tests__/consentGrantFailureToast.test.ts
// PURPOSE: A user who presses Allow on a distributed-functions prompt and whose
//          grant then FAILS must be told — with a toast, not a console line.
// CONTEXT: `customfunctions:consent-granted` handed the grant to
//          `grantCustomFunctionConsent`, which records the approval BEFORE it
//          installs, and reported a rejection with `console.error` alone. No
//          approval was lost, but the user saw nothing: the functions stayed
//          #NAME? after a click that said "Allow". The Charts caller for the
//          same case (`charts:library-consent-granted`) raises a toast; this one
//          did not. The extension is activated for real against a stubbed @api,
//          and the suite drives the prompt exactly as the dialog does.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionContext } from "@api/contract";

/* eslint-disable @typescript-eslint/naming-convention -- the doubles must match the real export names */

type BusHandler = (detail: unknown) => unknown;
const bus = new Map<string, Set<BusHandler>>();
const toasts: Array<{ message: string; options: Record<string, unknown> | undefined }> = [];
const openedDialogs: Array<{ id: string; props: Record<string, unknown> }> = [];
const grantCustomFunctionConsent = vi.fn(async (_p: unknown): Promise<void> => undefined);

vi.mock("@api", () => ({
  loadAndInstallCustomFunctions: async () => undefined,
  uninstallCustomFunctions: () => undefined,
  registerMenuItem: () => undefined,
  DialogExtensions: {
    openDialog: (id: string, props: Record<string, unknown>) => {
      openedDialogs.push({ id, props });
    },
    closeDialog: () => undefined,
  },
  AppEvents: { AFTER_OPEN: "app:after-open" },
  IconCustomFunctions: null,
  listenTauriEvent: async () => () => undefined,
  onAppEvent: (name: string, cb: BusHandler) => {
    const set = bus.get(name) ?? new Set<BusHandler>();
    set.add(cb);
    bus.set(name, set);
    return () => {
      set.delete(cb);
    };
  },
  describeCapability: (c: string) => c,
  grantCustomFunctionConsent: (p: unknown) => grantCustomFunctionConsent(p),
  showToast: (message: string, options?: Record<string, unknown>) => {
    toasts.push({ message, options });
  },
  CUSTOM_FUNCTIONS_CONSENT_NEEDED: "customfunctions:consent-needed",
}));

vi.mock("../components/CustomFunctionsDialog", () => ({ CustomFunctionsDialog: () => null }));
vi.mock("../components/DistributedFunctionsConsentDialog", () => ({
  DistributedFunctionsConsentDialog: () => null,
}));

/* eslint-enable @typescript-eslint/naming-convention */

import extension from "../index";

function emit(name: string, detail: unknown): void {
  for (const handler of [...(bus.get(name) ?? [])]) handler(detail);
}

/** Let the grant's promise chain (then/catch) run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function makeContext(): ExtensionContext {
  const noop = (): void => undefined;
  return {
    ui: { dialogs: { register: noop, unregister: noop } },
    events: { on: () => () => undefined },
  } as unknown as ExtensionContext;
}

const pendingPackage = (packageName: string) => ({
  packageName,
  functionNames: ["VENDORRATE"],
  capabilities: [],
  consentSource: `{"pkg":"${packageName}"}`,
});

beforeEach(() => {
  bus.clear();
  toasts.length = 0;
  openedDialogs.length = 0;
  grantCustomFunctionConsent.mockReset().mockResolvedValue(undefined);
  extension.deactivate?.();
  extension.activate(makeContext());
});

describe("customfunctions:consent-granted when the grant fails", () => {
  it("raises an error toast naming the application and the failure", async () => {
    emit("customfunctions:consent-needed", { pending: [pendingPackage("Acme Finance Pack")] });
    expect(openedDialogs.map((d) => d.props.packageName)).toEqual(["Acme Finance Pack"]);
    grantCustomFunctionConsent.mockRejectedValueOnce(new Error("worker realm refused to compile"));

    emit("customfunctions:consent-granted", { packageName: "Acme Finance Pack" });
    await settle();

    expect(grantCustomFunctionConsent).toHaveBeenCalledTimes(1);
    expect(
      toasts,
      "the user pressed Allow and the functions stayed #NAME? with nothing on screen",
    ).toHaveLength(1);
    expect(toasts[0].message).toContain('"Acme Finance Pack"');
    expect(toasts[0].message).toContain("worker realm refused to compile");
    expect(toasts[0].message).toContain("did not start");
    // The approval is recorded before the install, so the wording must not
    // tell the user their answer was lost — and must not promise it was kept
    // either, because the extension cannot see which step failed.
    expect(toasts[0].message).toContain("keeps the approval");
    expect(toasts[0].message).toContain("could not be saved");
    expect(toasts[0].options?.type).toBe("error");
  });

  it("still advances the queue to the next application after the failure", async () => {
    emit("customfunctions:consent-needed", {
      pending: [pendingPackage("Acme Finance Pack"), pendingPackage("Beta Reports")],
    });
    grantCustomFunctionConsent.mockRejectedValueOnce(new Error("boom"));

    emit("customfunctions:consent-granted", { packageName: "Acme Finance Pack" });
    await settle();

    expect(openedDialogs.map((d) => d.props.packageName)).toEqual([
      "Acme Finance Pack",
      "Beta Reports",
    ]);
  });

  it("raises no toast when the grant succeeds (the positive control)", async () => {
    emit("customfunctions:consent-needed", { pending: [pendingPackage("Acme Finance Pack")] });

    emit("customfunctions:consent-granted", { packageName: "Acme Finance Pack" });
    await settle();

    expect(grantCustomFunctionConsent).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([]);
  });
});
