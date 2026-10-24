//! FILENAME: app/src/api/__tests__/notificationsHandle.test.ts
// PURPOSE: showToast returns a ToastHandle whose dismiss() takes back THAT
//          toast through the dismisser registered with the sink -- and is a
//          no-op when there is nothing to take back.
// CONTEXT: Review round 9, F4: AutoRecover's skipped-copies notice must stay up
//          for exactly the streak it describes, which needs a way to take a
//          toast down. The Shell half (its store's sink returns addToast's id,
//          dismiss calls removeToast) is pinned in
//          src/shell/Toast/__tests__/toastDismissHandle.test.ts.

import { describe, it, expect, vi } from "vitest";
import { registerToastSink, showToast, type ToastPayload } from "../notifications";

describe("a toast's handle", () => {
  // Runs FIRST, while this file's fresh module has no sink registered.
  it("is a no-op when no renderer is registered yet, and the message is not lost", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handle = showToast("early");
    expect(() => handle.dismiss()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("before a sink"), "early");
    warn.mockRestore();
  });

  // SABOTAGE: drop the dismisser call from the handle (or pass the wrong id).
  it("dismiss() hands the sink's own id to the dismisser registered with it, once", () => {
    const shown: ToastPayload[] = [];
    const dismissed: string[] = [];
    registerToastSink(
      (t) => {
        shown.push(t);
        return `t${shown.length}`;
      },
      (id) => dismissed.push(id),
    );
    const first = showToast("one", { duration: 0, type: "warning" });
    const second = showToast("two");
    expect(shown.map((t) => t.message)).toEqual(["one", "two"]);
    expect(shown[0]).toEqual({ message: "one", variant: "warning", duration: 0 });
    second.dismiss();
    expect(dismissed, "the handle took back another toast").toEqual(["t2"]);
    second.dismiss();
    expect(dismissed, "a second dismiss of the same toast reached the renderer").toEqual(["t2"]);
    first.dismiss();
    expect(dismissed).toEqual(["t2", "t1"]);
  });

  it("is a no-op when the sink returned no id, or no dismisser was registered", () => {
    const dismissed: string[] = [];
    registerToastSink(() => undefined, (id) => dismissed.push(id));
    showToast("a recorder's toast").dismiss();
    registerToastSink(() => "t1");
    showToast("no dismisser").dismiss();
    expect(dismissed).toEqual([]);
  });

  it("a recorder sink that returns something else (a test's push) still shows the toast", () => {
    const shown: ToastPayload[] = [];
    registerToastSink((t) => shown.push(t));
    expect(() => showToast("recorded").dismiss()).not.toThrow();
    expect(shown.map((t) => t.message)).toEqual(["recorded"]);
  });
});
