# Pivot Transformation Functions

Transformation functions add conditional logic, comparisons, scalar math, and
text handling to `CALC` expressions in the Pivot Design view. They are evaluated
**after aggregation** — a field reference such as `[Sales]` resolves to the
aggregated value for the current cell — and, unlike the
[visual calculation functions](window-functions.md), they need no pivot context.

Their key feature is that **`IF` and `SWITCH` can return text or booleans**, not
only numbers, so a calculated field can produce labels like `"High"`/`"Low"`.

```
VALUES: [Sales],
        CALC Rating = IF([Sales] > 1000, "High", "Low"),
        CALC Margin = ([Sales] - [Cost]) / [Sales]
```

## Operators

| Operator | Meaning |
|----------|---------|
| `+` `-` `*` `/` | Arithmetic (`/` by zero → `#DIV/0!`) |
| `>` `<` `>=` `<=` `=` `<>` | Comparison — yields a boolean |
| `&` | Text concatenation (same as `CONCAT`) |

Precedence, loosest to tightest: comparison → concatenation → `+ -` → `* /` →
unary `-`. So `[Sales] > 100 + 50` parses as `[Sales] > (100 + 50)`.

Strings are written in **double quotes** (`"High"`). Single quotes denote a
**field name** with spaces (`'Total Sales'`) — the two are distinct.

## Conditional

### IF(condition, then, [else])

Returns `then` when `condition` is truthy, otherwise `else`. With no `else`, a
false condition yields a blank. Only the taken branch is evaluated.

```
CALC Rating = IF([Sales] > 1000, "High", "Low")
CALC Bonus  = IF([Margin] >= 0.3, [Sales] * 0.1, 0)
CALC Flag   = IF([Stock] = 0, "Out of stock")
```

### SWITCH(expr, value1, result1, [value2, result2, …], [default])

Evaluates `expr` once and returns the result paired with the first matching
value. A trailing odd argument is the default; with no default and no match, the
result is blank.

```
CALC Tier   = SWITCH([Region], "W", 1, "E", 2, 0)
CALC Grade  = SWITCH([Band], "A", "Excellent", "B", "Good", "Needs work")
```

## Boolean

| Function | Description |
|----------|-------------|
| `AND(a, b, …)` | True if every argument is truthy |
| `OR(a, b, …)` | True if any argument is truthy |
| `NOT(x)` | Boolean negation |

```
CALC InBand   = AND([Sales] > 100, [Sales] < 1000)
CALC Eligible = OR([Vip] = 1, [Spend] > 5000)
```

## Scalar Math

| Function | Description |
|----------|-------------|
| `ABS(x)` | Absolute value |
| `ROUND(x, digits)` | Round to `digits` decimals |
| `MIN(a, b, …)` | Smallest argument |
| `MAX(a, b, …)` | Largest argument |
| `CEILING(x, [significance])` | Round up (to a multiple of `significance`, default 1) |
| `FLOOR(x, [significance])` | Round down |
| `SQRT(x)` | Square root (negative → `#NUM!`) |
| `MOD(x, divisor)` | Remainder (`divisor` of 0 → `#DIV/0!`) |
| `INT(x)` | Round down to an integer |
| `SIGN(x)` | `-1`, `0`, or `1` |
| `POWER(base, exp)` | `base` raised to `exp` |

```
CALC Rounded = ROUND([Margin] * 100, 1)
CALC Capped  = MIN([Sales], 10000)
```

## Text

| Function | Description |
|----------|-------------|
| `CONCAT(a, b, …)` | Join values as text (or use `&`) |
| `LEFT(text, [count])` | Leading characters (default 1) |
| `RIGHT(text, [count])` | Trailing characters (default 1) |
| `MID(text, start, count)` | Substring, `start` is 1-based |
| `LEN(text)` | Character count |
| `UPPER(text)` / `LOWER(text)` | Change case |
| `TRIM(text)` | Remove surrounding whitespace |
| `TEXT(value, format)` | Format a number as text |

```
CALC Label = [Class] & " — " & [Style]
CALC Code  = UPPER(LEFT([Product], 3))
CALC Pct   = TEXT([Margin], "0.0%")
```

`TEXT` currently supports the common numeric patterns — a fixed number of
decimals (`"0.00"`), an optional trailing `%` (scales by 100, e.g. `"0.0%"`), and
thousands grouping when the integer part contains a comma (`"#,##0"`). Richer
number-format support is planned.

## Type Coercion & Errors

- **Booleans** coerce to `1` / `0` in arithmetic and comparisons.
- **Blank** counts as `0` numerically and `""` textually, so it compares equal to
  both `0` and the empty string.
- **Comparisons** are numeric when both sides coerce to numbers; otherwise they
  compare as case-insensitive text.
- **Errors** surface as spreadsheet-style values in the cell: `#DIV/0!` (division
  by zero, or `MOD` by zero), `#VALUE!` (arithmetic on non-numeric text),
  `#NUM!` (e.g. `SQRT` of a negative). An error propagates through the rest of an
  expression, except that `IF`/`SWITCH` do not evaluate branches they don't take.

## Combining with Visual Calculation Functions

Transformation functions compose freely with the
[visual calculation functions](README.md):

```
CALC Trend = IF([Sales] >= PREVIOUS([Sales]), "Up", "Down")
CALC PctOfTotal = TEXT([Sales] / GRANDTOTAL([Sales]), "0.0%")
```
