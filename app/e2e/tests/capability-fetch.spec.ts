/**
 * Phase 4.1 — net.fetch capability gate (Rust authoritative check).
 *
 * Exercises script_http_fetch + the grant/revoke commands directly over IPC
 * from the main window, verifying the Rust-side enforcement that no compromised
 * renderer can bypass: https-only, per-script PER-ORIGIN grants, origin
 * isolation, method allowlist, and revoke. It uses https://localhost:1 / :2 so
 * the test makes NO real external request: ungranted/non-https/etc. are denied
 * before any network call, and a GRANTED origin's only failure is an immediate
 * connection refusal — never "not granted" — which proves authorization passed
 * without a slow or external fetch.
 *
 * The full JIT dialog -> grant -> fetch vertical is covered by the consent-flow
 * e2e specs in Phase 4.4.
 */
import { test, expect } from "../fixtures";

test.describe("Capability gate: script_http_fetch", () => {
  test("Rust enforces https-only, per-origin grants, isolation, method, revoke", async ({
    appPage: page,
  }) => {
    const r = await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const fetch = (req: any) =>
        tauri.core
          .invoke("script_http_fetch", { request: req })
          .then((v: any) => ({ ok: true, v }))
          .catch((e: any) => ({ ok: false, e: String(e) }));
      const scriptId = "cap-e2e-script";

      // Before any grant: every shape of request is denied by Rust.
      const ungranted = await fetch({ scriptId, url: "https://localhost:1/" });
      const nonHttps = await fetch({ scriptId, url: "http://localhost:1/" });
      const userinfo = await fetch({ scriptId, url: "https://u:p@localhost:1/" });

      // Grant exactly one origin.
      await tauri.core.invoke("grant_script_net_origin", {
        scriptId,
        origin: "https://localhost:1",
      });

      // Granted origin: authorization PASSES — the request reaches reqwest and
      // fails only on the immediate connection refusal (port 1), never "not granted".
      const grantedAuth = await fetch({ scriptId, url: "https://localhost:1/" });
      // Per-origin isolation: a different origin is still denied.
      const otherOrigin = await fetch({ scriptId, url: "https://localhost:2/" });
      // Method allowlist (on a granted origin): TRACE rejected.
      const badMethod = await fetch({ scriptId, url: "https://localhost:1/", method: "TRACE" });

      // Revoke: the granted origin is denied again.
      await tauri.core.invoke("revoke_script_capabilities", { scriptId });
      const afterRevoke = await fetch({ scriptId, url: "https://localhost:1/" });

      return { ungranted, nonHttps, userinfo, grantedAuth, otherOrigin, badMethod, afterRevoke };
    });

    // --- Denials (rejected before any network call) ---
    expect(r.ungranted.ok).toBe(false);
    expect(r.ungranted.e).toContain("not granted");
    expect(r.nonHttps.ok).toBe(false);
    expect(r.nonHttps.e).toMatch(/https/i);
    expect(r.userinfo.ok).toBe(false);

    // --- Granted origin: authorization passed (failure is connection, not permission) ---
    expect(r.grantedAuth.ok).toBe(false);
    expect(r.grantedAuth.e).not.toContain("not granted");

    // --- Per-origin isolation ---
    expect(r.otherOrigin.ok).toBe(false);
    expect(r.otherOrigin.e).toContain("not granted");

    // --- Method allowlist ---
    expect(r.badMethod.ok).toBe(false);
    expect(r.badMethod.e).toMatch(/method/i);

    // --- Revoke ---
    expect(r.afterRevoke.ok).toBe(false);
    expect(r.afterRevoke.e).toContain("not granted");
  });
});
