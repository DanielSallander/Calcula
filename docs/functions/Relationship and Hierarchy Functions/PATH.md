# PATH

Generates a parent-child path column: for each row, the `|`-separated chain of ids from the root ancestor down to the row itself (DAX-compatible). Calculated-column only.

## Syntax

```
PATH(table[id_column], table[parent_column])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[id_column]` | The row's own key column. |
| `table[parent_column]` | The column naming each row's parent id. NULL marks a root. |

## Return value

A text column: the root-first id chain, e.g. `"1|4|9"` for a row 9 whose manager is 4, whose manager is 1. Roots return just their own id.

## Remarks

- `PATH(...)` must be the ENTIRE formula of a calculated column — it is a generated column computed natively at materialization (the recursive parent walk cannot be expressed as a row-level expression), not a composable expression.
- Both columns must be physical columns of the same (host) table.
- A parent id that matches no row ends the chain there (treated as reaching the top); a cycle or a chain deeper than 512 levels is an error.
- Ids render via their string form (integer keys appear without decimals).
- Other calculated columns on the same table may reference the path column — e.g. `PATHLENGTH(Emp[Path])` — because path columns are computed before expression columns.

## Example

An `Emp(id, mgr)` table where 1 is the CEO (NULL mgr), 2 reports to 1, 4 reports to 2:

```
Path = PATH(Emp[id], Emp[mgr])
```

Row 4's `Path` is `"1|2|4"`; row 1's is `"1"`. Group by `Path`, or feed it to [PATHLENGTH](PATHLENGTH.md) / [PATHITEM](PATHITEM.md) for level and ancestor columns.

## See also

- [PATHLENGTH](PATHLENGTH.md)
- [PATHITEM](PATHITEM.md)
