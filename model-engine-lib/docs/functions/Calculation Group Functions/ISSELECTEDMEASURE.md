# ISSELECTEDMEASURE

Returns `TRUE` when the measure a **calculation item** is being applied to is one of the listed measures. Use it to make an item behave differently per measure (or skip measures entirely) inside one calculation group.

## Syntax

```
ISSELECTEDMEASURE([Measure1] [, [Measure2], ...])
```

Every argument must be a plain `[Measure]` reference. At least one is required.

## Remarks

- Only valid inside a **calculation item** (or a group's selection expression) — like [SELECTEDMEASURE](SELECTEDMEASURE.md), it is rejected in ordinary measures and calculated columns.
- Resolved when the group is applied: the engine compares the applied measure's name against the list (exact, case-sensitive — the same matching used for measure lookup) and folds the call to `TRUE()`/`FALSE()` before planning. There is no runtime cost.
- The listed measures are **validated at model build** (an unknown name fails the build) and reported by the dependency APIs (`measure_references`, lineage) — so renaming or deleting a measure surfaces the stale reference instead of silently changing results.
- Prefer this over comparing [SELECTEDMEASURENAME](SELECTEDMEASURENAME.md) to a string: name comparisons are not rename-checked.

## Example

Double only `Revenue`; pass every other measure through unchanged:

```
ITEM Boost = IF(ISSELECTEDMEASURE([Revenue]), SELECTEDMEASURE() * 2, SELECTEDMEASURE())
```

Applied to `Revenue` and `Orders`, `Revenue [Boost]` is doubled while `Orders [Boost]` equals plain `Orders`.

## See also

- [SELECTEDMEASURE](SELECTEDMEASURE.md) — the applied measure's expression
- [SELECTEDMEASURENAME](SELECTEDMEASURENAME.md) — the applied measure's name as a string
