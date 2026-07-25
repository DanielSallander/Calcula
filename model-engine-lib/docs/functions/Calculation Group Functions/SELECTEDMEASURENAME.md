# SELECTEDMEASURENAME

Returns the **name** of the measure a calculation item is being applied to, as a string.

## Syntax

```
SELECTEDMEASURENAME()
```

Takes no arguments.

## Remarks

- Only valid inside a **calculation item** (or a group's selection expression).
- Resolved when the group is applied: the call folds to a string literal of the applied measure's name before planning.
- For per-measure **branching**, prefer [ISSELECTEDMEASURE](ISSELECTEDMEASURE.md) — it is validated against the model and dependency-tracked, so renames are caught at build time. `SELECTEDMEASURENAME()` is best for labels and diagnostics.

## Example

```
ITEM Tagged = IF(SELECTEDMEASURENAME() = "Revenue", SELECTEDMEASURE(), BLANK())
```

## See also

- [ISSELECTEDMEASURE](ISSELECTEDMEASURE.md) — rename-safe per-measure branching
- [SELECTEDMEASUREFORMATSTRING](SELECTEDMEASUREFORMATSTRING.md)
