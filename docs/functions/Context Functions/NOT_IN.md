# NOT IN

Anti-membership in a KEEP condition or predicate: keep the rows whose value is **not** in a set. The complement of the `IN` operator, in both of its forms.

## Syntax

```
KEEP(<table>, <column> NOT IN {<literal>, <literal>, ...})
KEEP(<table>, <table>[column] NOT IN <variable>[column])
```

## Remarks

- The literal-list form produces a boolean condition (`x NOT IN (...)`); the variable form produces an anti-membership predicate against a table variable's column set — the anti-join complement of the [TREATAS](TREATAS.md)-style `IN` predicate.
- **SQL `<>` semantics** (consistent with the engine's other comparisons): a BLANK tested value satisfies *neither* `IN` nor `NOT IN` — BLANK rows are excluded by both forms.
- An **empty set** keeps every row under `NOT IN` (and no row under `IN`). BLANK members of the variable's set are ignored (they can never match anything).
- The variable form runs on the local aggregation path, like `IN` — paths that cannot apply it fail closed rather than ignoring it.

## Example

```
Non-Premium Sales = SUM(Sales[amount], KEEP(Product, Sales[prod_id] NOT IN premium[id]))
Other Colors      = SUM(Sales[amount], KEEP(Sales, Sales[color_code] NOT IN {1, 2}))
```

## See also

- [KEEP](KEEP.md), [TREATAS](TREATAS.md)
