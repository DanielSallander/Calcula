# LISTAGG

Concatenates values from a column into a single string, separated by a delimiter.

## Syntax

```
LISTAGG(table[column], delimiter)
```

The alias `STRING_AGG` can also be used:

```
STRING_AGG(table[column], delimiter)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | The column whose values to concatenate. Values are cast to text before concatenation. |
| `delimiter` | A string literal used to separate the concatenated values (e.g., `", "`). |

## Return value

A single string containing all values from the column, separated by the specified delimiter.

## Remarks

- LISTAGG generates SQL `STRING_AGG(col, delimiter)` internally.
- This is an aggregate function and can be used directly as a measure definition.
- NULL values are excluded from the concatenation.
- The order of values in the result depends on the data source's implementation. No guaranteed ordering unless the source provides one.
- The delimiter is typically a string literal enclosed in double quotes.
- Context operations can be passed as additional arguments: `LISTAGG(table[column], delimiter, KEEP(...))`.
- When used without context operations, LISTAGG is pushed down to the data source for maximum performance.
- For very large groups, the resulting string may be long. Consider using filters to limit the number of values.

## Example 1: List all product colors

Concatenate all distinct product colors into a comma-separated string.

```
DEFINE All Colors = LISTAGG(dim_product[color], ", ")
```

| All Colors |
|------------|
| Black, Blue, Grey, Multi, Red, Silver, Silver/Black, White, Yellow |

## Example 2: List products per category

Show a semicolon-separated list of subcategories for each product category.

```
DEFINE Subcategories = LISTAGG(dim_product[subcategoryname], "; ")
QUERY: Subcategories BY dim_product[categoryname]
```

| categoryname | Subcategories |
|-------------|---------------|
| Bikes | Mountain Bikes; Road Bikes; Touring Bikes |
| Clothing | Caps; Gloves; Jerseys; Shorts; Socks; Vests |
| Accessories | Bike Racks; Bottles and Cages; Cleaners; Fenders; Helmets; Hydration Packs; Lights; Locks; Panniers; Pumps; Tires and Tubes |

## Example 3: With context filter

List colors available in the Bikes category only.

```
DEFINE Bike Colors = LISTAGG(
  dim_product[color], ", ",
  KEEP(dim_product[categoryname] = "Bikes")
)
```

Returns a comma-separated list of colors available for bikes, regardless of any other product filters in the query context.

## See also

- [CONCATENATE](CONCATENATE.md) -- concatenates two strings
- [COMBINEVALUES](COMBINEVALUES.md) -- combines values with a delimiter
- [COUNT](COUNT.md) -- counts non-null values
