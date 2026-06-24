# CUBEMEMBERPROPERTY function

## Introduction

The CUBEMEMBERPROPERTY function returns the value of a property of a member in a Calcula BI model — that is, another column's value for the row identified by a member. For example, given a Country member you might read its Region, or given a Product you might read its Category.

Use CUBEMEMBERPROPERTY to enrich a report with attributes that travel with a member, without building a separate lookup.

## Syntax

```
=CUBEMEMBERPROPERTY(connection, member_expression, property)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| connection | Required | The name of a Calcula BI connection (e.g. `"Sales"`). Unknown name returns `#NAME?`. |
| member_expression | Required | The member whose property to read (`Table[Column]=Value`), or a reference to a CUBEMEMBER cell. |
| property | Required | The property to return: another column on the member's table (e.g. `"Geo[Region]"`), or the special properties `CAPTION` / `MEMBER_VALUE`. |

## Remarks

- A column property (`Table[Column]`) is resolved with a filtered lookup against the member's table.
- The special properties `CAPTION` and `MEMBER_VALUE` are answered locally from the member itself (no extra query).
- The member argument may be a literal member expression or a reference to a CUBEMEMBER cell.
- A disconnected model returns `#N/A`; a malformed expression returns `#VALUE!`.

## Example

| | A | B |
|---|---|---|
| 1 | =CUBEMEMBER("Sales", "Geo[Country]=Sweden") | =CUBEMEMBERPROPERTY("Sales", A1, "Geo[Region]") |

**Result:** A1 displays "Sweden"; B1 returns Sweden's Region (e.g. "Europe").

A1 resolves the Country member; B1 reads the Region column for that same member.
