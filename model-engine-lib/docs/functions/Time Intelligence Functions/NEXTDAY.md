# NEXTDAY

Evaluates the inner measure at the **single day after the last date** of the current date context — the forward counterpart of [PREVIOUSDAY](PREVIOUSDAY.md).

## Syntax

```
NEXTDAY(<measure expression>)
```

## Remarks

- **Filter-context only**; a date column on the group-by axis fails closed.
- The boundary day is probed as `MAX(DateKey)` of the context, shifted one day forward, and installed as a single-day `DateKey = boundary` filter (the [CLOSINGBALANCE](CLOSINGBALANCE.md) machinery with a +1 day offset).
- A boundary day outside the date table (or without fact rows) yields BLANK, never an error.
- Meaningful on a **daily-grain** date table.

## Example

With a January slicer, `NEXTDAY(SUM(Sales[amount]))` reads February 1.

## See also

- [PREVIOUSDAY](PREVIOUSDAY.md), [CLOSINGBALANCE](CLOSINGBALANCE.md)
