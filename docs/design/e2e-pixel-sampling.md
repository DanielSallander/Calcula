# E2E pixel sampling — the instrument, and the hazard it was built around

**Status:** landed 2026-09-22. Guard: `app/e2e/__tests__/noClippedCapture.test.ts` (repo-wide, reads
the tree at test time). Helper: `app/e2e/viewportSample.ts`.

This is a HARNESS fact, not a chart fact. It was discovered in the Charts journey and was written up
in `docs/design/chart-interaction.md` §6.14 first, but it constrains every pixel assertion in the
tree, so the general statement lives here and that section now points at this file.

---

## 1. The rule

**Do not hand `clip` to a capture in order to READ pixels.** Use `samplePixels` (or
`samplePixelGrid` / `samplePixelGrids` / `samplePixelPatches`) from `app/e2e/viewportSample.ts`, and
compare with the `diffCount` from the same module.

A clip is still correct in exactly one situation: when the clipped image IS the artifact — a golden
whose committed baseline was recorded clipped. Those are `takeRegionScreenshot` and
`takeGridRegionScreenshot` in `app/e2e/helpers/screenshots.ts`, plus `cellInk` in
`journeys/parity-21c.spec.ts`, and all three are listed with their reasons in the guard.

## 2. Why — and what part of "why" is actually settled

Two accounts exist. **The rule is the same under both**, which is why the migration did not wait for
them to be reconciled.

**Account A, measured 2026-09-22.** `page.screenshot({ clip })` is not a passive read: to capture a
sub-rectangle Chromium is asked to put that rectangle on screen, and the pointer's hit-test travels
with the viewport. The Charts Format pane's colour preview was filed as a product defect on four
identical runs — armed, no pixel changed in three seconds, then lapsed with the pointer stationary.
Instrumentation showed the preview painting in **~84 ms every time**. At t+560 ms the swatch received
a `mouseleave` reporting `pt=(305,541)` — **the origin of the clip the test was about to take** —
with a `relatedTarget` that was not an element and no matching `mouseenter` afterwards, while the
button's own `getBoundingClientRect()` was unchanged throughout. Nothing in the page had moved. A
four-way probe from one held pointer position:

| what happened while the pointer sat on the swatch | previewing before → after |
|---|---|
| nothing at all, for 3 s | true → **true** |
| `page.screenshot()` — full viewport | true → **true** |
| `page.screenshot({ clip })` | true → **FALSE** |
| an in-page canvas readback | true → **true** |

**Account B, measured the same day on the same machine, and it did not reproduce.** Before migrating
nine further call sites the mechanism was re-probed against two independent hover state machines (a
ribbon button's CSS `:hover`, and the chart renderer's own `getHoverState()` on a datum) across seven
clip geometries, with capture-phase listeners on every mouse and pointer event. **Not one event
fired**, `window.visualViewport` never moved and `document.elementFromPoint` never changed. Playwright
1.60 passes an in-viewport clip straight to `Page.captureScreenshot` with `captureBeyondViewport:
false`, so on that build there is no emulation override to move anything.

What DID reproduce is a **timing gap**: a clipped 12x12 sample completes in ~63 ms end to end, the
unclipped one in ~194 ms, and the preview paints in ~84 ms. A clipped sample taken immediately after
arming a hover can therefore photograph the frame BEFORE the product painted — which fits
"intermittent, then four consecutive failures" at least as well as a cancelled hover does.

**So: do not repeat Account A as settled fact.** The module header of `viewportSample.ts` carries
both in full. If a hover-shaped flake appears again, re-run the probe on the exact surface rather
than trusting either paragraph.

**The lesson generalises past this hazard.** A sampler that perturbs — or merely outruns — the state
it samples will report that as the product's behaviour, with complete confidence and a reproducible
trace. **A pixel test that flakes around a hover should suspect the instrument before the product.**

## 3. The instrument

`app/e2e/viewportSample.ts`:

- capture **UNCLIPPED**, crop afterwards inside the page against the decoded bitmap;
- the crop rect is computed in Node by `deviceCropRect`, a pure function with unit tests, rather than
  by arithmetic buried in a string only a live browser can execute;
- it scales from the **ROUNDED EDGES**, because `round(x·dpr) + round(w·dpr)` drifts from
  `round((x+w)·dpr)` by a pixel at a half-pixel origin, and a one-pixel drift between two samples
  makes `diffCount` throw "the clip moved" about a chart that never moved;
- the returned array is the same device-pixel RGBA the clipped call decoded to, so **every threshold
  tuned against the old helper still means what it meant**;
- `samplePixelGrids` takes **ONE capture for N clips**. That is a correctness property before it is a
  saving: two patches taken by two captures are two frames, and a repaint between them puts half the
  evidence on each side of it;
- it **THROWS** when a crop is not wholly on screen. This restores an error the clip gave for free
  ("Clipped area is either empty or outside the resulting image"); `drawImage` instead returns
  transparent black off the edge of a bitmap, and two blanks compare equal — a geometry mistake would
  otherwise become a passing comparison.

**Cost, measured at dpr 2, n=20 per size.** A small 12x12 CSS patch: 390 bytes clipped vs 300,179
unclipped, 63.1 ms vs 194.1 ms per whole sample. A large 520x320 patch: 99.5 ms vs 199.3 ms. Across
the 45 sample sites in the nine migrated specs that is about **+4.5 to +5.9 s per run**, minus ~0.4 s
recovered by the two multi-patch pairs, against specs that budget 240–280 s each and spend it in
`waitForTimeout`. The bytes never touch disk. The cost is real and it is not the deciding quantity.

## 4. What was migrated

Ten call sites carried a private `pixels()`/`pixelGrid()`/`captureBlock()` decode **and** a private
`diffCount`, at the identical `> 8` threshold, with the refusal spelled four different ways. One fact,
ten spellings — the same shape as the product defects of the same wave.

Migrated onto the shared helper: `chart-interaction`, `census-followon`, `computed-property-restore`,
`correctness-cluster`, `insight-overlays`, `insight-overlays-pivot`, `remaining-correctness`,
`spill-delete`, `structural-recalc` (journeys) and `tests/flagged-defects`.

Notes that are easy to get wrong:

- **Only `correctness-cluster` was ever actually exposed.** Its test 3d takes its "before" with the
  pointer parked on cell B3 from test 3c, and B3 lies inside the A1:B4 clip. `insight-overlays` and
  `insight-overlays-pivot` sample right after a context-menu click, so the pointer sits over the
  measured rectangle. The other six never hover. **Do not tell anyone the nine were all at risk** —
  they were not; they migrate so that one decode exists instead of ten.
- **`flagged-defects` changed meaning deliberately.** It compared two raw PNG buffers with
  `Buffer.compare(a,b) !== 0`, which flags any byte including encoder noise. It now uses `diffCount`,
  which counts pixels whose R, G or B moved by more than 8 — strictly the stronger claim.
  **THE NUMBER IS NOT STABLE BETWEEN MACHINES OR RUNS, so the gate is `> 0` and the count is
  PRINTED rather than asserted.** Measured at **510** device pixels on three runs during the
  migration, and at **167** on the verification run of 2026-09-22 (`10 passed (1.2m)`, functional
  project, dpr 2) — a 3x spread for the same gesture, which is exactly why a tuned threshold here
  would be a future flake. Both are far above the tolerance. If it ever approaches zero with the
  cell visibly changing, `diffCount(a, b, 0)` restores byte-level strictness.
- **`samplePatch` is a different instrument and must NOT be migrated.** In
  `remaining-correctness.spec.ts`, `image-ingress.spec.ts`, `shapes-hometab.spec.ts` and the
  `vba-idioms-wave3/4` specs it reads the grid canvas's own bitmap through `getImageData`. It takes
  no screenshot at all, so it was never exposed; it also sees only what the grid renderer painted and
  misses anything composited over it. Keep the two straight.

## 5. The guard

`app/e2e/__tests__/noClippedCapture.test.ts` parses **every** `.ts`/`.tsx` under `app/e2e` with the
TypeScript compiler at test time and fails on any capture handed a `clip`. It covers **both**
spellings — `page.screenshot({ clip })` and `expect(page).toHaveScreenshot({ clip })` — because
banning one of two spellings of one fact is the mistake this whole wave was made of. It is keyed on
the enclosing function name, not a line number, so it does not become a chore.

**Why a test and not a lint rule**, given that the repo's other repo-wide ban (the dialog globals) is
a lint rule with a self-test:

1. **The allowlist has to carry a reason, and the reason has to be enforced.** ESLint expresses an
   exemption as a path in `ignores`; there is no way to make an unjustified exemption fail. Here the
   allowlist is data the test owns, so "an entry with no reason is itself a failure" is one more
   assertion — and it is asserted (`MIN_REASON_CHARS`).
2. **`// eslint-disable-next-line` is a reason-free bypass** that would put the exemption at the call
   site, invisible to anyone auditing the ban.
3. **Every block in `eslint.boundaries.js` ignores `**/*.spec.{ts,tsx}`**, and all ten migrated files
   are `.spec.ts`. `app/e2e` is not in any of its `files` globs, and that file is explicitly the
   single source of truth for *architecture* boundaries.

It also asserts the reverse direction — a **stale** allowlist entry fails, so an exemption cannot
outlive the code it exempted and become a standing licence for whatever lands at that name next — and
that exactly **one** definition of `diffCount` exists under `app/e2e`.

**Sabotages run, each confirmed to change behaviour and to hit the intended guard:**

| sabotage | result |
|---|---|
| a new file `helpers/__sabotageClip.ts` with `page.screenshot({ clip })` | 1 failed / 12 passed — "finds no clipped capture that is not sanctioned", naming file, line, holder and the remedy |
| shorten one allowlist reason to `"legacy, leave it"` | 1 failed / 12 passed — "requires a written reason on every allowlist entry" |
| rename an allowlist holder to `cellInkSABOTAGE` | 2 failed / 11 passed — the census AND "has no stale allowlist entry" |
| a second `diffCount` in a new file | 1 failed / 12 passed — "keeps exactly one definition of diffCount" |
| cripple the detector (`CAPTURE_METHODS` misspelled) | 6 failed / 7 passed — the five detector self-tests and the stale check. **A census that scanned nothing cannot pass vacuously.** |

The detector is exported and exercised on synthetic sources for the receiver spelling (`appPage`,
`ctx.pages()[0]`), the shorthand `{ clip }`, the `toHaveScreenshot` form, an options bag it cannot see
into, and the negatives it must NOT flag.

**Known limit, stated rather than hidden.** A spread (`{ ...options }`) whose source is out of sight
is not reported. `helpers/screenshots.ts` spreads narrowly-typed option bags in seven places and none
can carry a clip, so reporting spreads would mean seven exemptions for a hazard that is not there —
and an allowlist padded with non-hazards is an allowlist nobody reads. A whole argument that is
opaque (an identifier, a call) IS reported.

## 6. The capture-environment guard interacts with this, and it is worth knowing

`waitForGridStable` (`helpers/screenshots.ts`) calls `assertCaptureEnvironment`, which THROWS when
`window.devicePixelRatio !== 1` because every committed golden was recorded at 1
(`e2e/captureEnvironment.ts`). That guard is about **comparability with a committed baseline**.

A self-comparing pixel spec has no committed baseline: it compares two captures taken seconds apart
in the same run, at the same dpr, of the same clip. `chart-interaction.spec.ts` therefore uses its own
`settleGrid` rather than borrowing `waitForGridStable`, and says so — otherwise it would be unrunnable
on a 200% display for a reason that has nothing to do with what it measures.

**The other nine still borrow `waitForGridStable`**, so where the reading really is 2 they refuse
before they do anything. Several of them genuinely do take goldens (`insight-overlays` calls
`takeRegionScreenshot`) and so genuinely need dpr 1; others only want the settle. Splitting "settle
the grid" from "assert the corpus environment" is an open question, not a decision taken here.

**READ THE WEBVIEW'S dpr, NOT THE DESKTOP'S SCALE FACTOR — they came apart on this machine, and a
handoff was written on the wrong one.** A migration agent reported on 2026-09-22 that every journey
was blocked here because the desktop is at 200%, and gave that as the reason two specs could not be
verified. The desktop scale really is 200% (GDI `HORZRES` 1472 against `DESKTOPHORZRES` 2944,
measured independently), **and the journeys run anyway**: `spill-delete` went 3 passed in 40.5s, and
it calls `waitForGridStable` seven times, so `assertCaptureEnvironment` ran on the first of them and
found `devicePixelRatio === 1`. Nothing in the launch forces it — `webview2Args.mjs` deliberately
carries no `--force-device-scale-factor`, with its own measurement saying why. So the desktop scale
factor is **not** the quantity the guard compares; the WebView2 instance's own `devicePixelRatio` is,
and the two can disagree. Before concluding that this machine cannot run the suite, launch it and
read the number — do not infer it from Display Settings.

## 7. Verified, 2026-09-22

| gate | result |
|---|---|
| `npm run check-types` | clean |
| `npm run lint:boundaries` | clean |
| `npx vitest run` | **114057 passed, 0 failed**, 1153 files, 224.5s |
| `npx playwright test --project=journey` (full) | **196 passed, 15 failed, 1 skipped, 40.2 min** |
| `npx playwright test --project=functional e2e/tests/flagged-defects.spec.ts` | **10 passed**, 1.2 min |

**Not one of the 15 journey failures is attributable to the sampler.** Re-run on a fresh app,
`remaining-correctness` + `correctness-cluster` + `insight-overlays` gave **21 passed, 1 failed** in
4.5 min, and `census-followon`'s two skipped tests gave **2 passed** — so the ~70–90 ms failures in
the full run (`model-transform`, `parity-21c` x3, `pivot-undo-fidelity` x2, `remaining-correctness`,
`report-store` x2) were a CASCADE off a dead app, not assertions. `correctness-cluster` test 3d — the
one case in the tree where the pointer is parked INSIDE the rectangle being sampled — passes.
`census-followon` test 5 prints `cell 64.3 CSS px, glyphs end 52.4, underline ends 52.4, old-code
clamp 61.3 (capture scale 1.0110)`, so the rounded-edge `scale` change is harmless: the gap to the
clamp is 8.9 against a `> 4` gate.

**Two genuine defects surfaced, both pre-existing and neither about pixels:**

1. **`InlineEditor` loops until React kills the app.** `Maximum update depth exceeded`, thrown from
   the unconditional `useLayoutEffect` at `app/src/core/components/InlineEditor/InlineEditor.tsx:375`
   — it has **no dependency array**, measures `scrollHeight` and the layer box, and `setMeasured`s
   the result, which feeds the width, which feeds the measurement. Its bail-out returns `prev` only
   on an exact three-field match, so it catches a FIXED POINT but not a 2-CYCLE. This is the repo's
   own rule *"a width must never be a function of its own measurement"* (the `PublishDialog` 620px
   finding) recurring in Core. It fails `census-followon` test 3 and `owner-decisions` test 129, then
   takes the whole window down through `RootErrorBoundary` and cascades into everything after it.
2. **`insight-overlays.spec.ts:364` holds a stale expectation.** It clicks the plot background and
   expects the ladder to drop to `{ level: "chart" }`; it gets `{ level: "element" }`. That is
   correct now — `chart-interaction.spec.ts:2398` asserts `{ level: "element", elementId: "plotArea" }`
   and passes. The chart wave made plot-area furniture selectable and this spec was not updated. The
   two specs now hold contradictory expectations of the same gesture. No pixel is involved either
   side; the step only wants to park the chart in a known state before the comparisons below it.

Not individually re-verified, and not obviously cascade (real durations):
`open-items-owner-calls` 1.1, `reload-integrity` §2ab, `shapes-hometab` 5.

## 8. References

- `app/e2e/viewportSample.ts` — the helper, with BOTH accounts of the hazard in its header.
- `app/e2e/__tests__/viewportSample.test.ts` — its unit tier, including the absence assertion.
- `app/e2e/__tests__/noClippedCapture.test.ts` — the repo-wide census and the allowlist.
- `docs/design/chart-interaction.md` §6.14 — the original trace and the four-way probe.
- `docs/design/open-items.md` — what this left open.
