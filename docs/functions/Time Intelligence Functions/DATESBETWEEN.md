# DATESBETWEEN

Evaluates a measure over an absolute, inclusive date range on the model's date table (DAX-compatible).

## Syntax

```
DATESBETWEEN(expression, "start", "end")
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | The aggregate to evaluate over the range. |
| `"start"` | Inclusive ISO start date, quoted: `"YYYY-MM-DD"`. |
| `"end"` | Inclusive ISO end date, quoted: `"YYYY-MM-DD"`. |

## Return value

The inner aggregate evaluated with the date table restricted to `[start, end]` — replacing any existing date filter (slicers on other tables still apply).

## Remarks

- The dates are quoted strings (unquoted `2024-01-01` would parse as arithmetic). Both bounds are required and validated at parse and model build; `start` must not exceed `end`.
- Requires a marked date table with a `DateKey` role column, like all time intelligence.
- Filter-context only: a date-table column on the query axis fails closed with a clear error (mirror of DATESINPERIOD). Use it for fixed reference windows — "sales in H1 2024" — beside axis-driven measures.
- The absolute range makes it independent of the current date context — unlike [DATESINPERIOD](DATESINPERIOD.md), which anchors to the context's as-of date.

## Example

A fixed-window comparison measure:

```
DEFINE H1 2024 Sales = DATESBETWEEN(SUM(fact_sales[linetotal]), "2024-01-01", "2024-06-30")
```

Shows the same H1 total on every row, regardless of slicers on the date table — ideal as a baseline column next to sliced measures.

## See also

- [DATESINPERIOD](DATESINPERIOD.md)
- [YTD](YTD.md)
