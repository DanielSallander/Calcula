# CONCATENATE

Joins two or more text strings into a single text string.

## Syntax

```
CONCATENATE(text1, text2 [, ...])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text1` | The first text string or expression to join. |
| `text2` | The second text string or expression to join. |
| `...` | Optional additional text strings or expressions. Unlike DAX (which only accepts 2 arguments), Calcula extends CONCATENATE to accept an arbitrary number of arguments. |

## Return value

A single text string that is the result of joining all arguments together.

## Remarks

- Generates a SQL `CONCAT(text1, text2, ...)` expression internally.
- Arguments can be literal strings, column references, or expressions that return text.
- If any argument is NULL, CONCAT treats it as an empty string (standard SQL CONCAT behavior).
- For joining values with a separator between them, use [COMBINEVALUES](COMBINEVALUES.md) instead.
- This is an extension of the DAX CONCATENATE function, which only accepts exactly 2 arguments.

## Example 1: Combine product fields

Create a full product label from name and product number.

```
DEFINE ProductLabel = CONCATENATE(dim_product[name], " (", dim_product[productnumber], ")")
```

## Example 2: Simple two-argument concatenation

Join first and last name columns.

```
DEFINE FullName = CONCATENATE(dim_customer[firstname], dim_customer[lastname])
```

## Example 3: Build a description from multiple parts

```
DEFINE OrderDescription = CONCATENATE(
    "Order #",
    fact_sales[salesordernumber],
    " - Qty: ",
    fact_sales[orderqty]
)
```

## See also

- [COMBINEVALUES](COMBINEVALUES.md) -- join text with a delimiter
- [LEFT](LEFT.md) -- extract characters from the start of text
- [RIGHT](RIGHT.md) -- extract characters from the end of text
- [SUBSTITUTE](SUBSTITUTE.md) -- replace text within a string
