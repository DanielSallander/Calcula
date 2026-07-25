# SELECTEDMEASUREFORMATSTRING

Returns the **format string** of the measure a calculation item is being applied to (or `BLANK()` when the measure has none). Its main home is a calculation item's **format string expression**, where it lets an item preserve-and-modify the base measure's format instead of overriding it with a static one.

## Syntax

```
SELECTEDMEASUREFORMATSTRING()
```

Takes no arguments.

## Remarks

- Only valid inside a **calculation item** (value expression or format string expression) or a group's selection expression.
- Resolved when the group is applied: folds to a string literal of the applied measure's *static* format string before evaluation.
- A calculation item's dynamic format lives in its `format_string_expression` (the item-level analog of a measure's dynamic format string). Evaluated once per query per transformed measure; a non-BLANK string result wins over the item's static `format_string` and the base measure's format. A constant expression (the common case after substitution) is folded directly without a query.
- Precedence for a calc-group result column's format: item `format_string_expression` -> item static `format_string` -> base measure's dynamic format -> base measure's static format.

## Example

Append a thousands marker to whatever format the base measure has; fall back to a plain format for measures without one:

```
ITEM In Thousands
  EXPRESSION    = SELECTEDMEASURE() / 1000
  FORMAT STRING = IF(ISBLANK(SELECTEDMEASUREFORMATSTRING()),
                     "0.0",
                     CONCATENATE(SELECTEDMEASUREFORMATSTRING(), " K"))
```

Applied to a measure formatted `#,0`, the `[In Thousands]` column reports `#,0 K`; applied to an unformatted measure it reports `0.0`.

## See also

- [SELECTEDMEASURE](SELECTEDMEASURE.md), [ISSELECTEDMEASURE](ISSELECTEDMEASURE.md), [SELECTEDMEASURENAME](SELECTEDMEASURENAME.md)
