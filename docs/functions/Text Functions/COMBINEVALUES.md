# COMBINEVALUES

Joins two or more text strings with a delimiter between each value.

## Syntax

```
COMBINEVALUES(delimiter, text1, text2 [, ...])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `delimiter` | The text string to place between each value. Can be any text, including an empty string `""`. |
| `text1` | The first text string or expression to join. |
| `text2` | The second text string or expression to join. |
| `...` | Optional additional text strings or expressions. |

## Return value

A single text string with all values joined by the delimiter.

## Remarks

- Generates a SQL `CONCAT_WS(delimiter, text1, text2, ...)` expression internally.
- NULL values are skipped entirely (no delimiter is inserted for them), following SQL `CONCAT_WS` behavior.
- Use [CONCATENATE](CONCATENATE.md) if you do not need a delimiter between values.
- The delimiter can be a multi-character string, such as `" - "` or `", "`.

## Example 1: Dash-separated product key

Build a composite key from category and subcategory.

```
DEFINE ProductKey = COMBINEVALUES("-", dim_product[productcategory], dim_product[productsubcategory])
```

## Example 2: Comma-separated list

Create a comma-separated address line.

```
DEFINE AddressLine = COMBINEVALUES(", ", dim_customer[city], dim_customer[stateprovince], dim_customer[countryregion])
```

## Example 3: Space-separated name

```
DEFINE DisplayName = COMBINEVALUES(" ", dim_customer[firstname], dim_customer[middlename], dim_customer[lastname])
```

## See also

- [CONCATENATE](CONCATENATE.md) -- join text without a delimiter
- [TRIM](TRIM.md) -- remove leading and trailing spaces from text
- [SUBSTITUTE](SUBSTITUTE.md) -- replace occurrences of text within a string
