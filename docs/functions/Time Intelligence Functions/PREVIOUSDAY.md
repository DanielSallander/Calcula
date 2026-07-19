# PREVIOUSDAY

Evaluates the inner measure at the **single day before the first date** of the current date context. For a context of one day this is "yesterday"; for a month context it is the day before the month starts (a carry-over / opening reading).

## Syntax

```
PREVIOUSDAY(<measure expression>)
```

## Remarks

- **Filter-context only** — the date context comes from the request's date-table filters and the measure's own KEEP filters; a date column on the group-by axis fails closed.
- The boundary day is probed as `MIN(DateKey)` of the context, then shifted one day back and installed as a single-day `DateKey = boundary` filter (the [OPENINGBALANCE](OPENINGBALANCE.md) machinery with a -1 day offset).
- A boundary day outside the date table (or without fact rows) yields BLANK, never an error.
- Meaningful on a **daily-grain** date table; on a coarser calendar the adjacent day rarely matches a calendar row (BLANK).

## Example

With a February slicer, `PREVIOUSDAY(SUM(Sales[amount]))` reads January 31.

## See also

- [NEXTDAY](NEXTDAY.md), [OPENINGBALANCE](OPENINGBALANCE.md), [CLOSINGBALANCE](CLOSINGBALANCE.md)
