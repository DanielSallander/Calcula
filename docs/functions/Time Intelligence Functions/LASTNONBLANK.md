# LASTNONBLANK

Evaluates the inner measure at the **last date of the current context that has fact data** — the canonical semi-additive pattern for inventory, balances, and headcount when data does not extend to the period's calendar end. (The engine's single-argument form of the DAX `LASTNONBLANKVALUE(<date key>, <expr>)` pattern.)

## Syntax

```
LASTNONBLANK(<simple aggregate>)
```

The inner expression must be a **simple aggregate over a single column** (e.g. `SUM(Sales[on_hand])`) or `COUNTROWS` — the non-blank boundary needs a concrete column to probe.

## Remarks

- **Filter-context only**; a date column on the group-by axis fails closed.
- The boundary is probed from the **fact**: `MAX(DateKey)` over fact rows joined to the date table under the date context, restricted to rows where the aggregate's operand is non-BLANK. Contrast [CLOSINGBALANCE](CLOSINGBALANCE.md), which reads the *calendar* boundary even when no data exists there.
- **Probed once per query** over the whole context — not per group-by cell. When group-by members have different last-data dates, every member is read at the same (global) boundary date; members without data at that date show BLANK. (Documented divergence from DAX, which evaluates the non-blank boundary per cell.)
- No qualifying fact row in the context yields BLANK, never an error.
- Works on fiscal (non-Gregorian) calendars — the probe is calendar-agnostic.

## Example

March has stock readings only through March 15 (and the March 15 reading is NULL). With a March slicer:

- `CLOSINGBALANCE(SUM(Stock[on_hand]))` -> BLANK (no row on March 31)
- `LASTNONBLANK(SUM(Stock[on_hand]))` -> the March 14 reading

## See also

- [FIRSTNONBLANK](FIRSTNONBLANK.md), [CLOSINGBALANCE](CLOSINGBALANCE.md), [OPENINGBALANCE](OPENINGBALANCE.md)
