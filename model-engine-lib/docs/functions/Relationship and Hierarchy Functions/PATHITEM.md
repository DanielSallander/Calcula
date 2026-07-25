# PATHITEM

Returns the item at a given (1-based, root-first) position in a `|`-separated path string (DAX-compatible).

## Syntax

```
PATHITEM(path, position)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `path` | A path text value, typically a [PATH](PATH.md) calculated column. |
| `position` | 1-based position from the ROOT: 1 is the top ancestor. |

## Return value

The id at that position as text, or empty when the position is beyond the path's depth. For `"1|2|4"`: position 1 → `"1"`, position 3 → `"4"`, position 5 → empty.

## Remarks

- Positions count from the root (matching DAX PATHITEM's default). To take the row's own id, use `PATHITEM(path, PATHLENGTH(path))`.
- The result is text even for numeric ids — compare against text, or wrap in a conversion when joining on numeric keys.
- The common use is ancestor columns: `Root = PATHITEM(Emp[Path], 1)`, `Level2 = PATHITEM(Emp[Path], 2)` — flattening a parent-child hierarchy into fixed level columns you can group or build a model hierarchy over.

## Example

```
Root = PATHITEM(Emp[Path], 1)
```

Every employee row gets its top-level ancestor's id — grouping by `Root` rolls the whole org up to the CEOs.

## See also

- [PATH](PATH.md)
- [PATHLENGTH](PATHLENGTH.md)
