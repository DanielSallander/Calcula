//! FILENAME: app/extensions/CustomFunctions/__tests__/refreshEventGeneration.test.ts
// PURPOSE: The backend's `custom-functions:refresh` event carries the library
//          generation an application's subscribe or update merged; the
//          extension must hand it to the re-install, which reports it back once
//          the NEW code is live. Until then the backend files none of the
//          changed functions' served answers (rev10 cache2 residual: the old
//          realm could re-record an old-code answer in that window).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionContext } from "@api/contract";

/* eslint-disable @typescript-eslint/naming-convention -- the doubles must match the real export names */

const tauriListeners = new Map<string, (payload: unknown) => void>();
const installs: Array<Record<string, unknown> | undefined> = [];

vi.mock("@api", () => ({
  loadAndInstallCustomFunctions: async (opts?: Record<string, unknown>) => {
    installs.push(opts);
  },
  uninstallCustomFunctions: () => undefined,
  registerMenuItem: () => undefined,
  DialogExtensions: { openDialog: () => undefined, closeDialog: () => undefined },
  AppEvents: { AFTER_OPEN: "app:after-open" },
  IconCustomFunctions: null,
  listenTauriEvent: async (name: string, cb: (payload: unknown) => void) => {
    tauriListeners.set(name, cb);
    return () => undefined;
  },
  onAppEvent: () => () => undefined,
  describeCapability: (c: string) => c,
  grantCustomFunctionConsent: async () => undefined,
  showToast: () => undefined,
  CUSTOM_FUNCTIONS_CONSENT_NEEDED: "customfunctions:consent-needed",
}));

vi.mock("../components/CustomFunctionsDialog", () => ({ CustomFunctionsDialog: () => null }));
vi.mock("../components/DistributedFunctionsConsentDialog", () => ({
  DistributedFunctionsConsentDialog: () => null,
}));

/* eslint-enable @typescript-eslint/naming-convention */

import extension from "../index";

function makeContext(): ExtensionContext {
  const noop = (): void => undefined;
  return {
    ui: { dialogs: { register: noop, unregister: noop } },
    events: { on: () => () => undefined },
  } as unknown as ExtensionContext;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(async () => {
  tauriListeners.clear();
  installs.length = 0;
  extension.deactivate?.();
  extension.activate(makeContext());
  await settle();
});

describe("custom-functions:refresh", () => {
  it("re-installs with the library generation the event carried", async () => {
    const listener = tauriListeners.get("custom-functions:refresh");
    expect(listener).toBeDefined();
    listener?.({ generation: 12 });
    await settle();
    expect(installs).toContainEqual({ libraryGeneration: 12 });
  });

  it("re-installs without a generation when the event carries none", async () => {
    tauriListeners.get("custom-functions:refresh")?.(null);
    await settle();
    expect(installs).toContainEqual({ libraryGeneration: undefined });
  });
});
