# FIRSTNONBLANK

Evaluates the inner measure at the **first date of the current context that has fact data** — the opening counterpart of [LASTNONBLANK](LASTNONBLANK.md).

## Syntax

```
FIRSTNONBLANK(<simple aggregate>)
```

The inner expression must be a simple aggregate over a single column, or `COUNTROWS`.

## Remarks

- **Filter-context only**; a date column on the group-by axis fails closed.
- The boundary is probed from the fact: `MIN(DateKey)` over fact rows under the date context where the aggregate's operand is non-BLANK. Contrast [OPENINGBALANCE](OPENINGBALANCE.md), which reads the calendar boundary.
- Probed **once per query** over the whole context (not per group-by cell — see [LASTNONBLANK](LASTNONBLANK.md) for the divergence note).
- No qualifying fact row yields BLANK, never an error. Fiscal calendars are supported.

## Example

March data starts on March 5. With a March slicer, `FIRSTNONBLANK(SUM(Stock[on_hand]))` reads March 5, while `OPENINGBALANCE(...)` (March 1, no row) is BLANK.

## See also

- [LASTNONBLANK](LASTNONBLANK.md), [OPENINGBALANCE](OPENINGBALANCE.md)
