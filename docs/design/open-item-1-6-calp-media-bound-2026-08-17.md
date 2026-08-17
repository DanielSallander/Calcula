# Open-item 1.6 — bounding inline payloads on the `.calp` pull path

**Status: CLOSED 2026-08-17.** Implemented as recommended in
`open-items-1-owner-calls-2026-08-16.md` §1.6. That analysis is still the place to read for WHY the
bound goes where it goes and what was explicitly rejected; this file records what was actually
built, the one gap the recommendation did not state, and the two defects an adversarial review found
in the implementation.

---

## 1. What the item was about

A control (button, checkbox, picture) is a bag of name → string properties. A picture's bytes
historically lived in one of those strings as a `data:image/png;base64,…` URL — the whole file,
inlined as text.

BUG-0086 established the split that governs such payloads when the host inspects and refuses one:

| class | examples | treatment |
|---|---|---|
| **Hazard** | over the byte cap, over a dimension cap, over the pixel cap | **cleared to `""`** — handing it to a decoder *is* the attack (a 30,000×30,000 one-colour PNG is 5 KB of text and 3.6 GB of RAM) |
| **Policy** | SVG, BMP, unknown format, broken header | **left exactly as-is** — safe to look at, and destroying it would remove a picture the user can see because a later build narrowed the allowlist |

That split is right and did not change. What was missing was any **size bound at all** on the pull
path, and the discovery of this pass is that the split was also being applied to a third, unnamed
class — payloads the host could not read at all.

## 2. The harm, and what it is not

There is **no code-execution path here** and the recommendation was right about that: `onSelect` is
stripped on every distributed path, an SVG delivered through `<img>` renders in secure static mode,
and the CSP has no `data:` in `script-src` and `object-src 'none'`.

The axis that matters is **persistence**. Materialization writes straight into `ControlStorage` — a
pull calls `materialize_saved_controls` directly, so the 64 KiB property bound never sees it — and
whatever lands there is written verbatim into the SUBSCRIBER's own `.cala` on their next save. The
media GC prunes the *media store*; an inline string is not in the media store, it **is** the
document, so nothing ever reclaims it. A durable, silent bloating of the victim's own file,
delivered inside a correctly-signed artifact.

One nuance worth keeping from the review's negative results: `row`/`col` are `u32`, so they add no
volume by themselves — but they let the bloat be anchored at row 1,048,575, where a subscriber will
never find the control to delete it. **Deletion is the only reclamation path.**

## 3. What was built

### 3.1 `exceeds_byte_cap_encoded`, widened

It used to answer only for `;base64,` payloads and return `false` for every other shape. Since
`decode_image_data_url` returns `None` for a non-base64 or comma-less data URL *without measuring
it*, those shapes reached `LeaveInline` at any length: a `data:image/svg+xml,<svg …>` of arbitrary
size was copied through untouched. All three shapes now measure against `MAX_MEDIA_BYTES`.

**This is a widening of an existing rule to encodings it was silently skipping, not a new policy** —
which is why it is also safe on the `.cala` load path, where a genuinely new bound would not be. A
differential run of the old and new function bodies over base64-shaped inputs agreed on every one;
the only behavioural change is the intended widening.

### 3.2 `clamp_oversized_distributed_values` — the pull path only

Walks the admitted JSON and clears any string that is either a `data:image/` payload over
`MAX_MEDIA_BYTES` or any other string over `MAX_CONTROL_PROPERTY_CHARS` (64 KiB), counting each into
a new `MediaMigration.oversized`.

Four design points, each of which a reviewer asked about:

- **Pull path only.** Applying the same cap on `.cala` load was considered and rejected: a user whose
  own workbook holds a 90 KiB inline SVG logo — legal, created by the shipped picker, rendering fine
  today — would lose their picture on the next open, silently. Pinned by
  `the_local_cala_path_does_not_apply_the_distributed_property_ceiling`.
- **It runs LAST**, after `rewrite_inline_images` has turned every admissible image into a
  ~70-character `media:` handle. The ordering is load-bearing: an admissible picture's data URL can
  legitimately be 8–10.67 MiB, which is *over* this clamp's own `data:image/` ceiling, and only the
  ordering saves it.
- **`data:image/` gets the larger ceiling** because a policy-refused picture is a picture the
  subscriber can see, and BUG-0086 says those survive.
- **Value-shaped, not `properties`-shaped**, exactly as `rewrite_inline_images` already is: a
  name-scoped walk would miss the day someone adds a field, and here that miss is the whole
  vulnerability. No legitimate `control_type` or `value_type` is 64 KiB long.

Cleared to `""` rather than removed, matching the established `Drop` treatment, so geometry and
identity survive and a picture control paints "No Image" instead of vanishing.

### 3.3 The gap the recommendation did not state

A base64 payload passes `exceeds_byte_cap_encoded` on its **decoded** size, so its **encoded** text
can reach 4/3 × `MAX_MEDIA_BYTES` ≈ **10.67 MiB — 171× the property cap** — and still be
policy-refused and left inline. Measuring the string's own length in the clamp is what bounds it.

### 3.4 BUG-0086 through two other spellings

**The most serious finding, and it came from adversarial review rather than from the plan.**

The hazard/policy split is only as good as the agreement between the host's parser and the parser
that ultimately runs. The host's was **stricter**:

- `decode_image_data_url` required a byte-exact, lowercase `;base64` — and the newly widened
  `exceeds_byte_cap_encoded` repeated that same literal, so there were two copies of one wrong
  spelling.
- The WHATWG data-URL processor that WebView2 implements matches the `base64` tag **ASCII
  case-insensitively**, and **percent-decodes the body BEFORE base64-decoding**.

Every string in that gap took the `None` arm of `judge_inline_image` and, because a bomb is only a
few KB, was classified `LeaveInline` — counted as `refused`, the class the design promises to leave
inline *because it is safe on screen*. It was not safe. Traced end to end:

```
data:image/png;BASE64,<4 KB 30000x30000 PNG>
  -> rewrite_inline_images prefilter starts_with("data:image/")     passes
  -> judge_inline_image -> decode_image_data_url                    None (tag case)
  -> exceeds_byte_cap_encoded non-base64 branch, 4 KB              not over
  -> InlineVerdict::LeaveInline, report.refused += 1
  -> clamp sees data:image/ prefix, 4 KB < 8 MiB                    left alone
  -> sanitize_distributed_controls strips only onSelect
  -> materialize_saved_controls inserts verbatim
  -> paintableUrl returns any non-handle string as-is  (imageRenderer.ts:214)
  -> img.src = url                                    (imageRenderer.ts:246)
  -> WebView2 decodes 900 MP, ~3.6 GB of RGBA
```

The percent-encoded variant is more convincing still, because it needs no assumption about case:
`data:image/png;base64,%69VBORw…` **satisfies** `ends_with(";base64")`, so the byte cap measured it
on the base64 branch and passed it at 4 KB, while `decode_base64` bailed at the first `%`.

The existing regression test could not see any of this: its fixture is built by the `data_url()`
helper, which is lowercase-only.

**Fixed in two parts:**

1. **Make the host agree with the browser.** One shared `ends_with_base64_tag` (ASCII
   case-insensitive) used by both call sites so the two cannot drift again, and percent-decode the
   body before base64-decoding. Both are pure widenings of what the host can READ, so they strictly
   increase inspection coverage.
2. **Invert the default.** `LeaveInline` now requires a payload the host could actually read. An
   undecodable string that declares a **raster** format is dropped, because *"we could not parse it"
   is not evidence that the renderer cannot*. **SVG keeps its tolerance** — it is the one declared
   type this host never decodes by design (the media module refuses to carry an XML parser, and
   correctly), and it is what the legacy corpus actually contains.

The line lands in exactly the right place, and one test exists to say so: an **empty** payload
(`data:image/gif;base64,`) decodes perfectly well — to zero bytes — so it is an ordinary policy
refusal, not an uninspected one. The first draft of that test expected a `Drop` there and the code
was right.

## 4. What is still not caught

Both were named as accepted limitations in the original recommendation and remain so:

- **Aggregate volume.** 5,000 controls × 63 KiB is ~315 MB and every value is legal. That needs a
  per-pull total budget, which is a larger change. The review confirmed this pass makes it no worse.
- **An SVG under the cap that is expensive to rasterise.** Uncatchable without an SVG parser, which
  the media module refuses on principle.

## 5. Verification

| suite | result |
|---|---|
| `media::` module tests | **40 passed** |
| app crate (`app_lib` unit tests) | **1,695 passed, 0 failed, 5 ignored** |
| `cargo test --workspace` (core) | **1,411 passed, 0 failed** |

**Sabotage-checked in four rounds**, because a test that has never been made to fail is a test
nobody knows the state of:

| sabotage | tests reddened |
|---|---|
| clamp not called on the pull path | 2 |
| byte cap narrowed back to base64-only | 2 |
| non-base64 arm alone disabled | 2 (incl. the no-clamp-path test) |
| the three bypass fixes reverted | 4 |

**One test-design defect found by reading a sabotage result rather than by writing a test.** With the
widened cap reverted, the two distributed shape-tests still bounded their payloads — the clamp caught
them — and failed only on *which counter* fired. On the pull path the two halves overlap, so part 1
had to be pinned where it is actually load-bearing: the `.cala` load path and the write door, where
nothing else looks. That is
`the_widened_byte_cap_holds_on_the_paths_with_no_clamp`.

**Two of the review's findings were about the tests, not the code**, and both are fixed:

- `a_large_but_admissible_picture_still_arrives_as_a_handle` padded its fixture to 87 KB and asserted
  its precondition against the **property** cap, while the clamp holds `data:image/` strings to the
  **media** cap. Reversing the order would have changed nothing, so the test's stated failure mode was
  unexhibitable and its assertions were tautological. It now sits in the 8–10.67 MiB window where the
  ordering genuinely decides the outcome.
- The clamp's `data:image/` branch had **no test at all**: deleting it and holding everything to
  64 KiB was green across every distributed test. Now covered by
  `a_policy_refused_svg_over_the_property_cap_survives_a_pull`.

`check_property_value` was made `pub(crate)` for one purpose: so the clamp's boundary test pins
itself **against** the local write door rather than restating 64 KiB. The two must agree at the exact
cap, or a property that is legal when a user authors it locally gets cleared when the same document
arrives through a pull.

## 6. Process note

The adversarial review ran five lenses over the finished change (half-conversion hunt, the BUG-0086
split, bypass, plain correctness, test honesty) with a refute-by-default skeptic on each finding:
**24 raised, 17 refuted, 4 confirmed** (1 high, 1 high duplicate of it, 2 low). The high was found by
the lens explicitly told to hunt for "the OTHER SPELLING of every path this change touches" — which
is the shape the previous pass's post-mortem identified as this project's recurring failure mode. It
keeps earning its place.
