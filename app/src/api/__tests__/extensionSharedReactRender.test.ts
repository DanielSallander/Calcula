// PURPOSE: Prove the C2 authoring model end-to-end at the render level — a
//          runtime-loaded third-party extension that reads Calcula's shared
//          React (globalThis.CalculaReact, the way docs/examples/hello-extension
//          does) renders with WORKING HOOKS.
// WHY THIS IS THE PROOF: React throws "Invalid hook call" when a component's
//          hooks come from a DIFFERENT React instance than the renderer's. So if
//          a component built against globalThis.CalculaReact renders without
//          throwing — and produces the expected output — the shared singleton IS
//          the host's React. This is exactly the failure C2 prevents (a
//          second, vendored React), caught deterministically without a CDP e2e.

import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { exposeExtensionRuntimeGlobals } from "../extensionRuntime";

/** The shape a built third-party extension references at runtime. */
type SharedReact = typeof import("react");
function hostReact(): SharedReact {
  return (globalThis as unknown as { CalculaReact: SharedReact }).CalculaReact;
}

describe("C2: a shared-React extension component renders with working hooks", () => {
  it("a component reading globalThis.CalculaReact renders (hooks resolve to the host React)", () => {
    // The real host call that publishes the shared singleton before extensions load.
    exposeExtensionRuntimeGlobals();
    const React = hostReact();
    expect(React).toBeDefined();

    // The post-build form of an extension component: it uses the shared React's
    // hooks, exactly like docs/examples/hello-extension after `react` is aliased
    // to the CalculaReact shim.
    function HelloPanel(): ReturnType<SharedReact["createElement"]> {
      const [count] = React.useState(7);
      const label = React.useMemo(() => `clicked ${count} times`, [count]);
      return React.createElement("div", null, label);
    }

    // If globalThis.CalculaReact were a SECOND React instance, this throws
    // "Invalid hook call". It does not, because it IS the host's React.
    const html = renderToString(React.createElement(HelloPanel));
    expect(html).toContain("clicked 7 times");
  });

  it("the shared instance is identity-equal to the renderer's React (no duplicate)", async () => {
    exposeExtensionRuntimeGlobals();
    // The module a renderer (and the host) use must be the very same object the
    // extension reads — that identity is the whole point.
    const rendererReact = (await import("react")).default;
    expect(hostReact()).toBe(rendererReact);
  });
});
