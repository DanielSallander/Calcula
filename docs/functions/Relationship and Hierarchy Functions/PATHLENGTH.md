# PATHLENGTH

Returns the number of levels in a `|`-separated path string — the row's depth in a parent-child hierarchy (DAX-compatible).

## Syntax

```
PATHLENGTH(path)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `path` | A path text value, typically a [PATH](PATH.md) calculated column. |

## Return value

The level count (an integer): `"1|2|4"` → 3, `"1"` → 1. NULL paths return NULL.

## Remarks

- Usable in calculated columns and row-level expressions; the common shape is a `Level` calculated column beside a generated `Path` column.
- Counts separator-delimited items — it does not validate that the ids exist.

## Example

```
Level = PATHLENGTH(Emp[Path])
```

The CEO (path `"1"`) gets level 1, direct reports level 2, and so on — group by `Level` for per-depth aggregates.

## See also

- [PATH](PATH.md)
- [PATHITEM](PATHITEM.md)
