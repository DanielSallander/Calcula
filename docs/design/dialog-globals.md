# The dialog globals are banned

**Status: closed, 2026-08-08.** `window.confirm`, `window.alert` and `window.prompt` — and their
bare forms — are a lint error everywhere in `app/src` and `app/extensions`. The sanctioned
replacements are `confirmAsync` / `alertAsync` / `promptAsync` from `@api/dialogs`.

**Re-audited 2026-08-16: every claim in this document verified against source and still true** —
including the counts (171 violations / 63 files, six prior patch-at-the-call-site fixes), the
`MeasuresSection.tsx` NUL-byte story (that file now uses `"\u0000ungrouped"` and contains zero
NUL bytes, checked byte-wise), the two ESLint rules, the sole `src/core/lib/dialogs.ts`
exemption, and all six named consent gates. `npm run lint:boundaries` is clean, and a repo-wide
grep for the qualified globals in production code returns only comments describing the old
defect. No corrections were required.

**Sandboxed analogue.** A distributed extension cannot import `@api/dialogs` — its equivalent is
the `ui.dialog` capability: `capabilities.dialog.{alert,confirm,prompt,form}`
(`app/src/api/scriptHost/worker/extensionWorkerContext.ts:474-489`), painted by trusted host code
from a data-only spec and headed by the extension's own name. It fails safe the same way this
document requires: dismissal resolves (`false` / `null`) and never rejects.

---

## The defect

`tauri-plugin-dialog` injects an init script into every webview that replaces two of the three
globals. Verbatim, from `tauri-plugin-dialog-2.7.0/src/init-iife.js`:

```js
window.alert   = function (m) { invoke("plugin:dialog|message", { message: m.toString() }) }
window.confirm = async function (m) { return await invoke("plugin:dialog|confirm", { message: m.toString() }) }
```

Three distinct hazards follow.

**1. `confirm` returns a Promise.** So

```js
if (!window.confirm("Delete this?")) return;   // tests !Promise
```

tests the negation of an object. `!object` is **always false**. The guard never fires and the code
runs exactly as though the user had pressed OK. Where the guard protected a destructive action,
Cancel deleted. Where it was a **consent gate, Cancel consented.**

**2. `alert` is fire-and-forget and is not `async`.** It starts the IPC call and returns
`undefined` immediately, so `await window.alert(m)` does not wait either — awaiting is not a fix.
Execution continues past a message nobody has read, and the floating invoke promise rejects
unobserved on failure. `alertAsync` calls the plugin's `message()` and awaits *that*, which does
block.

**3. `prompt` is not replaced at all.** Whether it appears is decided by the WebView2 embedder's
script-dialog policy, and a suppressed prompt returns `null` indistinguishably from a user
cancelling. Two surfaces (`DimensionInputDialog`, `ConnectSourceDialog`) had already been rewritten
to escape it. `promptAsync` renders its own modal, so the answer is ours and is identical in all
five webview entry points.

## Why it kept coming back

It was found and fixed **six times**, each time at the call site. A per-site fix cannot reach the
site that has not been written yet, and there were far more sites than anyone had counted: the
sweep that closed this found **171 violations across 63 files**, against a working assumption of
"about ten".

Two things hid them:

* **The bare form.** Roughly two-thirds of the occurrences were unqualified `alert(msg)` /
  `confirm(msg)` with no `window.` prefix. Every previous search had been for `window.confirm`.
* **A file that greps as binary.** `MeasuresSection.tsx` embedded a raw NUL byte
  (`const UNGROUPED = "\x00ungrouped"`), so `grep`/`ripgrep` classified it as binary and skipped it
  entirely — three violations inside were invisible to text search. It now uses the `\u0000`
  escape, which is byte-identical at runtime and leaves the file searchable.

And one thing made the fix *look* unnecessary: **the unit tests doubled the wrong runtime.**
`scriptSecurity.test.ts` had a case named *"on 'needsApproval' + user declines: denies and does NOT
grant"*. It passed throughout, because it mocked `window.confirm` with `mockReturnValueOnce(false)`
— the synchronous jsdom shape. `!false` is `true`, so the broken guard looked correct under test
while being dead in the product. **A synchronous double can never catch this defect.**

## The mechanism, and why a lint rule

Three options were weighed.

| Option | Fires at | Catches the bare form? | Verdict |
| --- | --- | --- | --- |
| Grep-based drift test | test time | Only with a scope-blind regex, and **not at all** in a file grep treats as binary | Rejected |
| `@api` helper alone | never — it is only a suggestion | n/a | Insufficient alone |
| **Lint rule + helper** | **author time, in the editor** | Yes, scope-aware | **Chosen** |

The helper alone gives you a "do" but no "don't": nothing stops the next author writing the bare
call, which is precisely how this recurred. A drift test is cheap but weak — it fires long after the
code is written, a regex cannot tell the global `alert` from a parameter named `alert` (there are
such parameters in this tree), and a text search silently skips any file with a stray NUL. The lint
rule fires in the editor, before the code is ever committed.

It is implemented with **two** ESLint core rules, because the hazard has two syntactic shapes and
each rule sees only one of them:

* `no-restricted-globals` — the bare `alert(msg)` / `confirm(msg)` / `prompt(msg)`. It is
  **scope-aware**, so a local or parameter named `alert` is correctly left alone.
* `no-restricted-properties` — the qualified `window.confirm(msg)`, plus `globalThis.` / `self.`
  aliases, and **non-call references** such as `typeof window.confirm === "function"` — the shape
  that smuggled a raw global past review as a feature probe, and which a call-expression-only rule
  would miss.

Both live in `dialogGuardConfigs` (`app/eslint.boundaries.js`), spread into `boundaryConfigs` so the
existing CI gate `npm run lint:boundaries` runs them alongside the architecture boundaries.
`src/core/lib/dialogs.ts` is the single exemption (it must touch the raw globals for the non-Tauri
fallback) and test files are excluded, because stubbing the globals in jsdom is legitimate and none
of the Tauri hazards exist there.

`app/src/api/__tests__/dialogGlobalsBan.test.ts` runs ESLint with the real project config over
synthetic sources and asserts each banned shape is reported, each sanctioned wrapper is accepted,
and the scope-aware and exemption behaviours hold. **Deleting or weakening the rule fails the test
suite** — the guard on the guard.

## The contract

Every helper **fails CLOSED**: it resolves the refusing value (`false` / `null`) when it cannot get a
real answer — no window, no dialog surface, an IPC failure, a non-boolean resolution. A consent gate
built on these can treat "something went wrong" as "the user did not agree".

```ts
import { confirmAsync } from "@api/dialogs";

if (!(await confirmAsync("Delete this?"))) return;   // means what it says
```

`promptAsync` is a framework-free DOM modal rather than a React component, so it works identically
in all five webview entry points without any of them mounting a provider, and in jsdom so it is
testable.

## Placement

The implementation is a **Core primitive** (`app/src/core/lib/dialogs.ts`) — asking the user a
question is as universal as the undo stack — re-exported verbatim by `@api/dialogs` and from the
`@api` barrel. That keeps Core importable by Shell and by Core itself without inventing a
`core -> api` edge, while extensions reach it through the facade as the Facade Rule requires.

## Consent gates that were failing OPEN

Six gates decided whether untrusted code ran or a capability was granted, and all six treated Cancel
as consent:

| Gate | What Cancel did |
| --- | --- |
| `scriptSecurity.ensureScriptsAllowed` | Granted the session approval; every user script in the workbook ran |
| `scriptSecurity` trust offer | Wrote a **persistent** machine-local trust record — including re-trusting code that had just changed under a lapsed record |
| `scriptHost/capabilities.requestCapabilityGrant` | Skipped the lapsed-grant diff and fell through to the permission dialog, turning documented re-consent into blind re-approval |
| `ExtensionManager.processPendingConsents` | Consented **and activated** every unsigned third-party extension found on disk, at startup, while its dialog was still on screen. Its `catch { allow = false }` fail-closed path was unreachable: a Promise-returning shim throws nothing synchronously |
| `ScriptNotebook.promptAndGrantBiCapability` | Granted `bi.query` / `bi.sql` **and persisted** the grant for that notebook |
| `notebookApi.withScriptSecurityPrompt` | Granted the session approval and ran the cell |

Regression coverage for these is in `app/src/api/__tests__/consentGatesFailClosed.test.ts`, written
against the Tauri (Promise-returning) shape. Those tests **fail against the pre-fix code** — that is
what makes them regression tests rather than descriptions.
