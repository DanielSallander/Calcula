# SELECTEDMEASURE

A placeholder that stands for the measure a **calculation item** is being applied to. When a calculation group is applied to a query, the engine substitutes every `SELECTEDMEASURE()` in the item's expression with the target measure's own expression, producing one result column per (measure × item) pair.

## Syntax

```
SELECTEDMEASURE()
```

Takes no arguments.

## Remarks

- `SELECTEDMEASURE()` is only meaningful inside a **calculation-item** expression. Outside a calculation group it has no measure to stand in for.
- At query time the calculation group is applied via `QueryRequest.calculation_group`; the engine replaces each `SELECTEDMEASURE()` node with the applied measure's expression tree and names the result column `"{measure} [{item}]"`.
- This is how one calculation item (e.g. a "Prior Year" or "YoY %" transform) is reused across many base measures without rewriting each one.

## Example

A calculation group whose items transform whichever measure they wrap:

```
CALCULATION GROUP Time
  ITEM Current   = SELECTEDMEASURE()
  ITEM Prior Year = PRIORYEAR(SELECTEDMEASURE())
  ITEM YoY %     = DIVIDE(
                     SELECTEDMEASURE() - PRIORYEAR(SELECTEDMEASURE()),
                     PRIORYEAR(SELECTEDMEASURE())
                   )
```

Applying this group to `Revenue` and `Orders` yields columns `Revenue [Current]`, `Revenue [Prior Year]`, `Revenue [YoY %]`, `Orders [Current]`, and so on.

## See also

- [PRIORYEAR](PRIORYEAR.md), [YTD](YTD.md) — common transforms used in calculation items
- The expression-language reference for the full calculation-group definition syntax
