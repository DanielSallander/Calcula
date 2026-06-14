// CommandRegistry.execute now surfaces the handler's return value (Wave 3
// follow-up), so a command-proxy / executeCommand caller receives a result.

import { describe, it, expect } from "vitest";
import { CommandRegistry } from "../commands";

describe("CommandRegistry.execute surfaces the handler result", () => {
  it("returns a sync handler's value (with args echoed)", async () => {
    CommandRegistry.register("test.returnsValue", (args) => ({ echoed: args, n: 42 }));
    expect(await CommandRegistry.execute("test.returnsValue", "hi")).toEqual({ echoed: "hi", n: 42 });
    CommandRegistry.unregister("test.returnsValue");
  });

  it("awaits an async handler's value", async () => {
    CommandRegistry.register("test.async", async () => "done");
    expect(await CommandRegistry.execute("test.async")).toBe("done");
    CommandRegistry.unregister("test.async");
  });

  it("returns undefined for a void handler or an unknown command", async () => {
    CommandRegistry.register("test.void", () => {});
    expect(await CommandRegistry.execute("test.void")).toBeUndefined();
    expect(await CommandRegistry.execute("test.definitely-not-registered")).toBeUndefined();
    CommandRegistry.unregister("test.void");
  });
});
