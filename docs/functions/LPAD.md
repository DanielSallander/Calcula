# LPAD

Left-pads a text string to a specified length.

## Syntax

```
LPAD(text, length [, pad])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text expression to pad. |
| `length` | The desired total length of the result. |
| `pad` | *(Optional)* The text to use for padding. Default is a single space `' '`. |

## Return value

The input text padded on the left to the specified length. If the input is longer than `length`, it is truncated to `length`.

## Remarks

- LPAD is not part of standard DAX. It is a Calcula extension (available in Snowflake SQL).
- When `pad` is omitted, spaces are used for padding.
- If the pad string is longer than one character, it repeats as needed and excess characters are truncated.
- If the input text is already longer than `length`, the result is truncated to `length` characters.
- LPAD generates SQL as `LPAD(text, length)` or `LPAD(text, length, pad)`.

## Example 1: Pad with spaces (default)

```
DEFINE PaddedName = LPAD(t[name], 20)
```

## Example 2: Pad with zeros

```
DEFINE PaddedId = LPAD(t[id], 5, "0")
```

If `id` is `"42"`, the result is `"00042"`.

## Example 3: Truncation

If `name` is `"Hello World"` and length is `5`, the result is `"Hello"`.

## See also

- [RPAD](RPAD.md) — right-pads a text string
- [LEFT](LEFT.md) — returns characters from the start of a text string
- [RIGHT](RIGHT.md) — returns characters from the end of a text string
