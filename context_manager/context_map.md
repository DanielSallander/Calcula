I am building "Calcula," an ambitious open-source spreadsheet engine (Excel alternative) built for high performance and extensibility.

## ARCHITECTURE:
1.  **The Brain (Core Logic):** Written in **Rust**. It handles the Cell Dependency Graph, Formula Parsing, and Data Storage. It must be memory-safe and incredibly fast.
    * Modules: `engine` (calculation), `parser` (formulas), `persistence` (file I/O).
2.  **The Face (Frontend):** Written in **TypeScript + React**. It uses HTML5 Canvas/WebGL for rendering the grid to support 1M+ rows (virtualization). It does NOT use HTML tables for the grid.
3.  **The Bridge:** Uses **Tauri** to connect the Rust backend to the WebView frontend.

## TECH STACK:
* OS: Windows 11
* Backend: Rust (Workspace structure)
* Frontend: React, TypeScript, Vite
* Scripting: Python (embedded for users)

## CODING GUIDELINES:
* **No Placeholders:** Write full implementation code.
* **Windows Native:** Assume Windows paths and environment.
* **Clean Output:** Avoid Unicode characters (check marks, etc.) in terminal outputs; use ASCII alternatives.
* **Modularity:** Keep logic isolated. The UI should never calculate; the Backend should never render.
* **When coding Typescript the "Folder-as-Module" pattern is preferred in order to keep the files organized into smaller, manageable sizes.

## NAMING CONVENTIONS (Rust <-> TypeScript API Boundary)

### The Golden Rule
- **TypeScript**: Always use `camelCase` for all properties (textColor, backgroundColor, styleIndex)
- **Rust**: Always use `snake_case` for all fields (text_color, background_color, style_index)
- **Serde handles conversion automatically** via `#[serde(rename_all = "camelCase")]`

### Implementation Pattern

**Rust API types** (in `api_types.rs`):
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]  // <-- This single attribute handles ALL fields
pub struct CellData {
    pub row: u32,
    pub col: u32,
    pub style_index: usize,  // Rust uses snake_case
}
```

**TypeScript types** (in `types.ts`):
```typescript
export interface CellData {
  row: number;
  col: number;
  styleIndex: number;  // TypeScript uses camelCase
}
```

### Rules
1. **Never use manual `#[serde(rename = "...")]` on individual fields** - use struct-level `rename_all` instead
2. **All Tauri API types must live in `api_types.rs`** - this is the single source of truth
3. **TypeScript interfaces must mirror Rust structs** with camelCase property names
4. **When adding new fields**: just add them - serde converts automatically
5. **When accessing properties in TypeScript**: always use camelCase (cell.styleIndex, style.textColor)
6. **When accessing fields in Rust**: always use snake_case (cell.style_index, style.text_color)
7. **Provide the full functional block or file**: (no " // ... rest of code ").

### Common Mistakes to Avoid
- Using `style_index` in TypeScript (should be `styleIndex`)
- Using `text_color` in TypeScript (should be `textColor`)
- Forgetting `#[serde(rename_all = "camelCase")]` on new Rust structs
- Adding `#[serde(rename = "fieldName")]` to individual fields (use struct-level instead)

================================================================================
                                 INSTRUCTIONS
================================================================================
You are an advanced AI Software Engineer. You have been provided with a 
DEPENDENCY MAP of the project below. This DEPENDENCY MAP is however only first or three steps.
Step 2 is a more detailed dependency map, however only of a part of the repository.

1. ANALYZE FIRST: Use the map to understand the project structure and identifying 
   where the business logic resides.
2. RESOLVE AMBIGUITY: If you see a call like "update [? file1, file2]", use the 
   file context to determine which one is relevant.
3. BE SELECTIVE: Do NOT request code for:
   - Standard library functions.
   - Simple getters/setters or wrappers shown in the map.
   - Functions that clearly belong to other domains (e.g., UI formatting when 
     solving a backend logic issue).
4. REQUEST FORMAT: When you are confident about what parts of the repository you 
    need to deep dive into request the detailed dependency map by using the command
    "python generate_context_map_step2.py --include [folder(s)]"
    so for example: "python generate_context_map_step2.py --include app/src/hooks app/src/components"
    **Respond only with this command**
5. ONLY REQUEST EXISTING CONTENT. Never request files or folder that does not exists in the dependecy map.

================================================================================
                                TASK DESCRIPTION
================================================================================

I am building "Calcula," an open-source spreadsheet engine (Excel alternative) using Rust (backend) + TypeScript/React (frontend) via Tauri. We just completed a major refactoring of the Ribbon toolbar component to implement a plugin/registry architecture for better extensibility.

**After the refactoring, the application shows a blank screen on startup.**

### What Was Refactored

We refactored `app/src/components/Ribbon/` from a monolithic structure to a modular registry-based architecture:

**Before (old structure):**
```
app/src/components/Ribbon/
  index.ts
  Ribbon.tsx              # Large file with HomeTabContent embedded
  types.ts
  styles.ts
  constants.ts
  ColorPicker.tsx
  NumberFormatPicker.tsx
  Icons.tsx
  FormulaIcons.tsx
  FormulasTab.tsx
```

**After (new structure):**
```
app/src/components/Ribbon/
  index.ts                    # Updated barrel exports
  Ribbon.tsx                  # Simplified shell using registry
  types.ts                    # Updated with registry type re-exports
  styles.ts                   # Unchanged
  constants.ts                # Unchanged
  
  registry/
    index.ts
    types.ts                  # RibbonContext, RibbonTabDefinition, etc.
    RibbonRegistry.ts         # Singleton registry for tabs/groups
  
  components/
    index.ts
    RibbonGroup.tsx
    RibbonSeparator.tsx
    RibbonButton.tsx
    RibbonDropdownButton.tsx
  
  pickers/
    index.ts
    ColorPicker.tsx           # Moved from root
    NumberFormatPicker.tsx    # Moved from root
  
  tabs/
    index.ts                  # Auto-registers all tabs
    HomeTab/
      index.ts                # Registers HomeTab
      HomeTab.tsx
      FontGroup.tsx
      AlignmentGroup.tsx
      NumberGroup.tsx
      icons.tsx               # Moved from Icons.tsx
    FormulasTab/
      index.ts                # Registers FormulasTab
      FormulasTab.tsx
      FunctionLibraryGroup.tsx
      CalculationGroup.tsx
      icons.tsx               # Moved from FormulaIcons.tsx
    InsertTab/
      index.ts                # Registers InsertTab
      InsertTab.tsx
    ViewTab/
      index.ts                # Registers ViewTab
      ViewTab.tsx
```

### Key Architectural Changes

1. **Registry Pattern**: Tabs now self-register via `RibbonRegistry.registerTab()` when their module is imported
2. **Tab auto-registration**: `Ribbon.tsx` imports `./tabs` which triggers all tab registrations
3. **Context-based props**: All tab/group components receive a `RibbonContext` object instead of individual props
4. **Moved components**: ColorPicker, NumberFormatPicker, and icons moved to subdirectories

### Files That Should Be Deleted (old files)

These old files at the root level should be removed as their content was moved:
- `app/src/components/Ribbon/ColorPicker.tsx` (moved to `pickers/`)
- `app/src/components/Ribbon/NumberFormatPicker.tsx` (moved to `pickers/`)
- `app/src/components/Ribbon/Icons.tsx` (moved to `tabs/HomeTab/icons.tsx`)
- `app/src/components/Ribbon/FormulaIcons.tsx` (moved to `tabs/FormulasTab/icons.tsx`)
- `app/src/components/Ribbon/FormulasTab.tsx` (moved to `tabs/FormulasTab/`)

### Potential Issue Areas

1. **Import paths**: Other parts of the application may still import from old paths like:
   - `import { FormulasTabContent } from "./FormulasTab"` (old export name)
   - `import { ColorPicker } from "./ColorPicker"` (old path)

2. **Export changes**: The old `index.ts` exported `FormulasTabContent`, the new one exports `FormulasTab`

3. **Registry timing**: The registry pattern relies on side-effect imports - if `./tabs` isn't imported before the component renders, no tabs will be registered

4. **Type changes**: Components now expect `{ context: RibbonContext }` props instead of individual props

### Old index.ts exports (for comparison):
```typescript
export { Ribbon, default } from "./Ribbon";
export { FormulasTabContent } from "./FormulasTab";
export type { RibbonProps, FormattingOptions, FunctionInsertRequest } from "./types";
```

### New index.ts exports:
```typescript
export { Ribbon, default } from "./Ribbon";
export { RibbonRegistry } from "./registry";
export type { RibbonContext, RibbonTabDefinition, RibbonGroupDefinition, RibbonPluginRegistration } from "./registry";
export { RibbonGroup, RibbonSeparator, RibbonButton, RibbonDropdownButton } from "./components";
export { ColorPicker, NumberFormatPicker } from "./pickers";
export type { RibbonProps, RibbonTab, FormattingOptions, FunctionInsertRequest } from "./types";
export { COLOR_PALETTE, FUNCTION_CATEGORIES } from "./constants";
export type { FunctionCategory, FunctionDefinition } from "./constants";
export { HomeTab } from "./tabs/HomeTab";
export { InsertTab } from "./tabs/InsertTab";
export { FormulasTab } from "./tabs/FormulasTab";
export { ViewTab } from "./tabs/ViewTab";
```

### Request

Please help me debug why the application shows a blank screen after this refactoring. I need to:

1. Identify what's breaking (likely import errors or missing exports)
2. Check if any other files in the codebase import from the Ribbon module and need updating
3. Verify the registry is being populated correctly

================================================================================
                             PROJECT DEPENDENCY MAP
================================================================================
> Generated automatically. 
> [?] indicates ambiguous calls. 
> `self ::` indicates a local function call.


## DIR: app/src

### App.tsx
   - **App** `fn` (13 loc)
     Sig: function App(): React.ReactElement 

## DIR: app/src-tauri

### build.rs
   - **main** (2 loc) --> tauri_build::build

## DIR: app/src-tauri/src

### api_types.rs [TASK:styles]
   - **CellData** `struct`
   - **StyleData** `struct`
   - **DimensionData** `struct`
   - **FormattingParams** `struct`
   - **FormattingResult** `struct`
   - **StyleEntry** `struct`
   - **FunctionInfo** `struct`
   - **FunctionListResult** `struct`
   - **from** `fn` (30 loc)
     Sig: fn from(style: &CellStyle) -> Self 
       --> TextRotation::Custom
       --> core/engine/src/style.rs :: to_css
       --> self :: format_number_format_name
   - **format_number_format_name** `fn` (30 loc)
     Sig: fn format_number_format_name(format: &NumberFormat) -> String 

### commands.rs [TASK:styles]
   - **get_next_seq** (2 loc) [CMD]
   - **log_frontend** (3 loc) [CMD]
   - **get_viewport_cells** `fn` (31 loc) [CMD]
     Sig: pub fn get_viewport_cells(
       --> app/src-tauri/src/lib.rs :: format_cell_value
       --> core/engine/src/style.rs :: get
       --> core/engine/src/style.rs :: len
       --> self :: get_cell
   - **get_cell** `fn` (20 loc) [CMD]
     Sig: pub fn get_cell(state: State<AppState>, row: u32, col: u32) -> Option<CellData> 
       --> app/src-tauri/src/lib.rs :: format_cell_value
       --> core/engine/src/style.rs :: get
   - **update_cell** `fn` (90 loc) [CMD]
     Sig: pub fn update_cell(
       --> app/src-tauri/src/lib.rs :: evaluate_formula
       --> app/src-tauri/src/lib.rs :: extract_references
       --> app/src-tauri/src/lib.rs :: format_cell_value
       --> app/src-tauri/src/lib.rs :: get_recalculation_order
       --> app/src-tauri/src/lib.rs :: parse_cell_input
       --> app/src-tauri/src/lib.rs :: update_dependencies
       --> core/engine/src/grid.rs :: set_cell
       --> core/engine/src/style.rs :: get
       --> core/engine/src/style.rs :: len
       --> self :: clear_cell
       --> self :: get_cell
   - **clear_cell** `fn` (11 loc) [CMD]
     Sig: pub fn clear_cell(state: State<AppState>, row: u32, col: u32) 
       --> app/src-tauri/src/lib.rs :: update_dependencies
   - **get_grid_bounds** (8 loc) [CMD]
   - **get_cell_count** (8 loc) [CMD] --> core/engine/src/style.rs :: len
   - **set_column_width** (9 loc) [CMD]
   - **get_column_width** (8 loc) [CMD] --> core/engine/src/style.rs :: get
   - **get_all_column_widths** (8 loc) [CMD] --> core/engine/src/style.rs :: len
   - **set_row_height** (9 loc) [CMD]
   - **get_row_height** (8 loc) [CMD] --> core/engine/src/style.rs :: get
   - **get_all_row_heights** (8 loc) [CMD] --> core/engine/src/style.rs :: len
   - **get_style** (8 loc) [CMD] --> [Multiple]
   - **get_all_styles** (8 loc) [CMD] --> [Multiple]
   - **set_cell_style** `fn` (28 loc) [CMD]
     Sig: pub fn set_cell_style(
       --> app/src-tauri/src/lib.rs :: format_cell_value
       --> core/engine/src/grid.rs :: set_cell
       --> core/engine/src/style.rs :: get
       --> self :: get_cell
   - **apply_formatting** `fn` (99 loc) [CMD]
     Sig: pub fn apply_formatting(
       --> Color::from_hex
       --> StyleData::from
       --> app/src-tauri/src/lib.rs :: format_cell_value
       --> core/engine/src/grid.rs :: set_cell
       --> core/engine/src/style.rs :: get
       --> core/engine/src/style.rs :: get_or_create
       --> core/engine/src/style.rs :: len
       --> self :: get_cell
       --> self :: parse_number_format
       --> self :: parse_text_rotation
   - **parse_number_format** `fn` (30 loc)
     Sig: fn parse_number_format(format: &str) -> NumberFormat 
   - **parse_text_rotation** `fn` (19 loc)
     Sig: fn parse_text_rotation(rotation: &str) -> TextRotation 
       --> TextRotation::Custom
       --> app/src/state/gridReducer.ts :: clamp
   - **get_style_count** (8 loc) [CMD] --> core/engine/src/style.rs :: len
   - **sort_log_file** `fn` (49 loc) [CMD]
     Sig: pub fn sort_log_file() -> Result<String, String> 
       --> core/engine/src/style.rs :: is_empty
       --> core/engine/src/style.rs :: len
   - **log_frontend_atomic** (4 loc) [CMD]

### formula.rs
   - **get_functions_by_category** `fn` (179 loc) [CMD]
     Sig: pub fn get_functions_by_category(category: String) -> FunctionListResult 
       --> core/engine/src/style.rs :: len
   - **get_all_functions** `fn` (13 loc) [CMD]
     Sig: pub fn get_all_functions() -> FunctionListResult 
       --> core/engine/src/style.rs :: len
       --> self :: get_functions_by_category
   - **get_function_template** `fn` (53 loc) [CMD]
     Sig: pub fn get_function_template(function_name: String) -> String 

### lib.rs [TASK:styles]
   - **AppState** `struct`
   - **create_app_state** `fn` (10 loc)
     Sig: pub fn create_app_state() -> AppState 
       --> Grid::new
       --> StyleRegistry::new
   - **format_cell_value** `fn` (14 loc)
     Sig: pub fn format_cell_value(value: &CellValue, style: &CellStyle) -> String 
       --> core/engine/src/number_format.rs :: format_number
   - **format_cell_value_simple** (8 loc) --> self :: format_number_simple
   - **format_number_simple** (7 loc)
   - **convert_value** `fn` (6 loc)
     Sig: fn convert_value(v: &ParserValue) -> EngineValue 
       --> EngineValue::Boolean
       --> EngineValue::Number
       --> EngineValue::String
   - **convert_binary_op** `fn` (15 loc)
     Sig: fn convert_binary_op(op: &ParserBinaryOp) -> EngineBinaryOp 
   - **convert_unary_op** (4 loc)
   - **convert_expr** `fn` (33 loc)
     Sig: fn convert_expr(expr: &ParserExpr) -> EngineExpr 
       --> EngineExpr::Literal
       --> self :: convert_binary_op
       --> self :: convert_unary_op
       --> self :: convert_value
   - **col_letter_to_index** (7 loc)
   - **extract_references** (4 loc) --> self :: extract_references_recursive
   - **extract_references_recursive** `fn` (60 loc)
     Sig: fn extract_references_recursive(expr: &ParserExpr, grid: &Grid, refs: &mut HashSet<(u32, u32)>) 
       --> get_cell [? commands.rs, grid.rs]
       --> self :: col_letter_to_index
   - **evaluate_formula** `fn` (17 loc)
     Sig: pub fn evaluate_formula(grid: &Grid, formula: &str) -> CellValue 
       --> Evaluator::new
       --> core/engine/src/evaluator.rs :: evaluate
       --> core/engine/src/evaluator.rs :: to_cell_value
       --> self :: convert_expr
   - **parse_cell_input** `fn` (20 loc)
     Sig: pub fn parse_cell_input(input: &str) -> Cell 
       --> Cell::new
       --> Cell::new_boolean
       --> Cell::new_formula
       --> Cell::new_number
       --> Cell::new_text
       --> core/engine/src/style.rs :: is_empty
       --> self :: parse_number
   - **parse_number** `fn` (16 loc)
     Sig: fn parse_number(s: &str) -> Option<f64> 
   - **update_dependencies** `fn` (29 loc)
     Sig: pub fn update_dependencies(
       --> core/engine/src/style.rs :: is_empty
       --> core/engine/src/style.rs :: len
   - **get_recalculation_order** `fn` (29 loc)
     Sig: pub fn get_recalculation_order(
       --> core/engine/src/style.rs :: get
       --> core/engine/src/style.rs :: is_empty
       --> core/engine/src/style.rs :: len
   - **run** `fn` (44 loc)
     Sig: pub fn run() 
       --> core/parser/src/parser.rs :: expect
       --> self :: create_app_state
       --> tauri_plugin_shell::init

### main.rs
   - **main** (2 loc) --> app_lib::run

## DIR: app/src-tauri/src/utils

### bridge.ts
   - **getTimestamp** (9 loc) --> self :: pad
   - **pad** (2 loc)
   - **log** (5 loc) [async] --> self :: getTimestamp
   - **compactArgs** `fn` (26 loc)
     Sig: function compactArgs(args: InvokeArgs): string 
   - **tracedInvoke** `fn` (37 loc) [async]
     Sig: export async function tracedInvoke<T>(cmd: string, args: InvokeArgs = {}): Promise<T> 
       --> self :: compactArgs
       --> self :: log
   - **logUserAction** (3 loc) [async] --> self :: log
   - **logSystem** (2 loc) [async] --> self :: log
   - **logDebug** (2 loc) [async] --> self :: log
   - **sortLogs** (2 loc) [async] --> self :: tracedInvoke

## DIR: app/src/components

### GridCanvas.tsx [TASK:styles]
   - **GridCanvas** `fn` (281 loc) [mouse]
     Sig: function GridCanvas(props, ref) 
       --> app/src-tauri/src/utils/bridge.ts :: log
       --> app/src/lib/gridRenderer/core.ts :: renderGrid
       --> app/src/lib/gridRenderer/layout/viewport.ts :: calculateVisibleRange
       --> app/src/lib/tauri-api.ts :: getViewportCells
       --> app/src/lib/types.ts :: cellKey
       --> app/src/lib/types.ts :: createEmptyDimensionOverrides
       --> core/engine/src/dependency_graph.rs :: clear
       --> self :: updateSize
   - **updateSize** `fn` (18 loc)
     Sig: const updateSize = () => 

### InlineEditor.tsx [TASK:styles]
   - **getColumnWidth** `fn` (10 loc)
     Sig: function getColumnWidth(
       --> core/engine/src/style.rs :: get
   - **getRowHeight** `fn` (10 loc)
     Sig: function getRowHeight(
       --> core/engine/src/style.rs :: get
   - **calculateColumnX** `fn` (12 loc)
     Sig: function calculateColumnX(
       --> self :: getColumnWidth
   - **calculateRowY** `fn` (12 loc)
     Sig: function calculateRowY(
       --> self :: getRowHeight
   - **calculateEditorPosition** `fn` (39 loc)
     Sig: function calculateEditorPosition(
       --> self :: calculateColumnX
       --> self :: calculateRowY
       --> self :: getColumnWidth
       --> self :: getRowHeight
   - **InlineEditor** `fn` (179 loc) [focus] [input] [keyboard]
     Sig: export function InlineEditor(props: InlineEditorProps): React.ReactElement | null 
       --> app/src/lib/types.ts :: createEmptyDimensionOverrides
       --> app/src/lib/types.ts :: isFormulaExpectingReference
       --> self :: calculateEditorPosition

## DIR: app/src/components/Ribbon

### ColorPicker.tsx [TASK:styles]
   - **ColorPicker** `fn` (40 loc) [mouse]
     Sig: export function ColorPicker(
       --> app/src-tauri/src/utils/bridge.ts :: log

### FormulaIcons.tsx
   - **InsertFunctionIcon** `fn` (15 loc)
     Sig: export function InsertFunctionIcon(): React.ReactElement 
   - **AutoSumIcon** (9 loc)
   - **RecentlyUsedIcon** `fn` (12 loc)
     Sig: export function RecentlyUsedIcon(): React.ReactElement 
   - **FinancialIcon** `fn` (10 loc)
     Sig: export function FinancialIcon(): React.ReactElement 
   - **LogicalIcon** `fn` (17 loc)
     Sig: export function LogicalIcon(): React.ReactElement 
   - **TextIcon** `fn` (17 loc)
     Sig: export function TextIcon(): React.ReactElement 
   - **DateTimeIcon** (7 loc)
   - **LookupIcon** (7 loc)
   - **MathTrigIcon** `fn` (16 loc)
     Sig: export function MathTrigIcon(): React.ReactElement 
   - **MoreFunctionsIcon** (9 loc)

### FormulasTab.tsx [TASK:styles]
   - **CalculatorIcon** `fn` (16 loc)
     Sig: function CalculatorIcon(): React.ReactElement 
   - **FunctionDropdown** `fn` (34 loc) [drag] [mouse]
     Sig: function FunctionDropdown(
   - **CalculationDropdown** `fn` (51 loc) [drag] [mouse]
     Sig: function CalculationDropdown(
   - **FormulaCategoryButton** `fn` (62 loc) [drag] [mouse]
     Sig: function FormulaCategoryButton(
       --> app/src-tauri/src/utils/bridge.ts :: log
   - **library** `fn` (286 loc) [drag] [mouse]
     Sig: * Formulas tab content with function library and calculation buttons.
       --> app/src-tauri/src/utils/bridge.ts :: log
       --> app/src/lib/tauri-api.ts :: calculateNow
       --> app/src/lib/tauri-api.ts :: calculateSheet
       --> app/src/lib/tauri-api.ts :: getCalculationMode
       --> app/src/lib/tauri-api.ts :: setCalculationMode
       --> self :: FormulasTabContent
       --> self :: loadMode
   - **FormulasTabContent** `fn` (284 loc) [drag] [mouse]
     Sig: export function FormulasTabContent(
       --> app/src-tauri/src/utils/bridge.ts :: log
       --> app/src/lib/tauri-api.ts :: calculateNow
       --> app/src/lib/tauri-api.ts :: calculateSheet
       --> app/src/lib/tauri-api.ts :: getCalculationMode
       --> app/src/lib/tauri-api.ts :: setCalculationMode
       --> self :: loadMode
   - **loadMode** (7 loc) [async] --> app/src/lib/tauri-api.ts :: getCalculationMode

### Icons.tsx
   - **AlignLeftIcon** (8 loc)
   - **AlignCenterIcon** (8 loc)
   - **AlignRightIcon** (8 loc)
   - **WrapTextIcon** `fn` (13 loc)
     Sig: export function WrapTextIcon(): React.ReactElement 
   - **RotateUpIcon** `fn` (22 loc)
     Sig: export function RotateUpIcon(): React.ReactElement 
   - **RotateDownIcon** `fn` (22 loc)
     Sig: export function RotateDownIcon(): React.ReactElement 

### NumberFormatPicker.tsx [TASK:styles]
   - **NumberFormatPicker** `fn` (38 loc) [mouse]
     Sig: export function NumberFormatPicker(
       --> app/src-tauri/src/utils/bridge.ts :: log

### Ribbon.tsx [TASK:styles]
   - **useRegistryTabs** `fn` (18 loc)
     Sig: function useRegistryTabs(): RibbonTabDefinition[] 
     Hooks: useRegistryTabs
   - **Ribbon** `fn` (62 loc) [mouse]
     Sig: export function Ribbon(
       --> self :: useRegistryTabs

### constants.ts
   - **definition** (7 loc)
   - **categories** (3 loc)

### styles.ts [TASK:styles]
   - **getFormatButtonStyle** `fn` (11 loc)
     Sig: export function getFormatButtonStyle(
   - **getColorButtonStyle** (7 loc)
   - **getNumberFormatButtonStyle** (9 loc)

## DIR: app/src/components/Ribbon/components

### RibbonButton.tsx [TASK:styles]
   - **RibbonButton** `fn` (44 loc) [mouse]
     Sig: export function RibbonButton(

### RibbonDropdownButton.tsx [TASK:styles]
   - **RibbonDropdownButton** `fn` (80 loc) [drag] [mouse]
     Sig: export function RibbonDropdownButton(
   - **handleClickOutside** (7 loc)

### RibbonGroup.tsx [TASK:styles]
   - **RibbonGroup** `fn` (11 loc)
     Sig: export function RibbonGroup(

### RibbonSeparator.tsx [TASK:styles]
   - **RibbonSeparator** (2 loc)

## DIR: app/src/components/Ribbon/pickers

### ColorPicker.tsx [TASK:styles]
   - **ColorPicker** `fn` (46 loc) [mouse]
     Sig: export function ColorPicker(
       --> app/src-tauri/src/utils/bridge.ts :: log

### NumberFormatPicker.tsx [TASK:styles]
   - **NumberFormatPicker** `fn` (37 loc) [mouse]
     Sig: export function NumberFormatPicker(
       --> app/src-tauri/src/utils/bridge.ts :: log

## DIR: app/src/components/Ribbon/registry

### RibbonRegistry.ts
   - **RibbonRegistryImpl** `class` (132 loc)
       --> app/src-tauri/src/api_types.rs :: from
       --> app/src/hooks/useCellEvents.ts :: listener
       --> core/engine/src/dependency_graph.rs :: clear
       --> core/engine/src/style.rs :: get

## DIR: app/src/components/Ribbon/tabs/FormulasTab

### CalculationGroup.tsx [TASK:styles]
   - **CalculationDropdown** `fn` (51 loc) [drag] [mouse]
     Sig: function CalculationDropdown(
   - **CalculationGroup** `fn` (178 loc) [drag] [mouse]
     Sig: export function CalculationGroup(
       --> app/src-tauri/src/utils/bridge.ts :: log
       --> app/src/lib/tauri-api.ts :: calculateNow
       --> app/src/lib/tauri-api.ts :: calculateSheet
       --> app/src/lib/tauri-api.ts :: getCalculationMode
       --> app/src/lib/tauri-api.ts :: setCalculationMode
       --> self :: loadMode
   - **loadMode** (7 loc) [async] --> app/src/lib/tauri-api.ts :: getCalculationMode

### FormulasTab.tsx [TASK:styles]
   - **FormulasTab** `fn` (19 loc) [mouse]
     Sig: export function FormulasTab({ context }: FormulasTabProps): React.ReactElement 

### FunctionLibraryGroup.tsx [TASK:styles]
   - **FunctionDropdown** `fn` (35 loc) [drag] [mouse]
     Sig: function FunctionDropdown(
   - **FormulaCategoryButton** `fn` (56 loc) [drag] [mouse]
     Sig: function FormulaCategoryButton(
       --> app/src-tauri/src/utils/bridge.ts :: log
   - **FunctionLibraryGroup** `fn` (111 loc) [mouse]
     Sig: export function FunctionLibraryGroup(

### icons.tsx
   - **InsertFunctionIcon** `fn` (15 loc)
     Sig: export function InsertFunctionIcon(): React.ReactElement 
   - **AutoSumIcon** (9 loc)
   - **RecentlyUsedIcon** `fn` (12 loc)
     Sig: export function RecentlyUsedIcon(): React.ReactElement 
   - **FinancialIcon** `fn` (34 loc)
     Sig: export function FinancialIcon(): React.ReactElement 
   - **LogicalIcon** `fn` (26 loc)
     Sig: export function LogicalIcon(): React.ReactElement 
   - **TextIcon** `fn` (26 loc)
     Sig: export function TextIcon(): React.ReactElement 
   - **DateTimeIcon** `fn` (19 loc)
     Sig: export function DateTimeIcon(): React.ReactElement 
   - **LookupIcon** `fn` (19 loc)
     Sig: export function LookupIcon(): React.ReactElement 
   - **MathTrigIcon** `fn` (25 loc)
     Sig: export function MathTrigIcon(): React.ReactElement 
   - **MoreFunctionsIcon** `fn` (18 loc)
     Sig: export function MoreFunctionsIcon(): React.ReactElement 
   - **CalculatorIcon** `fn` (23 loc)
     Sig: export function CalculatorIcon(): React.ReactElement 

## DIR: app/src/components/Ribbon/tabs/HomeTab

### AlignmentGroup.tsx [TASK:styles]
   - **AlignmentGroup** `fn` (122 loc) [mouse]
     Sig: export function AlignmentGroup(
       --> app/src-tauri/src/utils/bridge.ts :: log
       --> app/src/lib/tauri-api.ts :: applyFormatting

### FontGroup.tsx [TASK:styles]
   - **FontGroup** `fn` (191 loc) [mouse]
     Sig: export function FontGroup({ context }: FontGroupProps): React.ReactElement 
       --> app/src-tauri/src/utils/bridge.ts :: log
       --> app/src/components/Ribbon/styles.ts :: getColorButtonStyle
       --> app/src/lib/tauri-api.ts :: applyFormatting

### HomeTab.tsx [TASK:styles]
   - **HomeTab** `fn` (20 loc)
     Sig: export function HomeTab({ context }: HomeTabProps): React.ReactElement 

### NumberGroup.tsx [TASK:styles]
   - **NumberGroup** `fn` (119 loc) [mouse]
     Sig: export function NumberGroup({ context }: NumberGroupProps): React.ReactElement 
       --> app/src-tauri/src/utils/bridge.ts :: log
       --> app/src/lib/tauri-api.ts :: applyFormatting

### icons.tsx
   - **InsertFunctionIcon** `fn` (15 loc)
     Sig: export function InsertFunctionIcon(): React.ReactElement 
   - **AutoSumIcon** (9 loc)
   - **RecentlyUsedIcon** `fn` (12 loc)
     Sig: export function RecentlyUsedIcon(): React.ReactElement 
   - **FinancialIcon** `fn` (34 loc)
     Sig: export function FinancialIcon(): React.ReactElement 
   - **LogicalIcon** `fn` (26 loc)
     Sig: export function LogicalIcon(): React.ReactElement 
   - **TextIcon** `fn` (26 loc)
     Sig: export function TextIcon(): React.ReactElement 
   - **DateTimeIcon** `fn` (19 loc)
     Sig: export function DateTimeIcon(): React.ReactElement 
   - **LookupIcon** `fn` (19 loc)
     Sig: export function LookupIcon(): React.ReactElement 
   - **MathTrigIcon** `fn` (25 loc)
     Sig: export function MathTrigIcon(): React.ReactElement 
   - **MoreFunctionsIcon** `fn` (18 loc)
     Sig: export function MoreFunctionsIcon(): React.ReactElement 
   - **CalculatorIcon** `fn` (23 loc)
     Sig: export function CalculatorIcon(): React.ReactElement 

## DIR: app/src/components/Ribbon/tabs/InsertTab

### InsertTab.tsx [TASK:styles]
   - **InsertTab** (6 loc)

## DIR: app/src/components/Ribbon/tabs/ViewTab

### ViewTab.tsx [TASK:styles]
   - **ViewTab** (6 loc)

## DIR: app/src/components/Spreadsheet

### Spreadsheet.tsx [TASK:styles]
   - **SpreadsheetContent** `fn` (114 loc) [focus] [input] [keyboard] [mouse] [scroll]
     Sig: function SpreadsheetContent({ className }: SpreadsheetContentProps): React.ReactElement 
       --> app/src/components/Spreadsheet/useSpreadsheet.ts :: useSpreadsheet
   - **Spreadsheet** (6 loc)

### useSpreadsheet.ts [TASK:styles]
   - **useSpreadsheet** `fn` (178 loc)
     Sig: export function useSpreadsheet() 
     Hooks: useSpreadsheet, useGridState, useGridContext, useSpreadsheetStyles, useSpreadsheetSelection, useSpreadsheetEditing, useSpreadsheetLayout
       --> app/src-tauri/src/utils/bridge.ts :: log
       --> app/src/components/Spreadsheet/useSpreadsheetEditing.ts :: useSpreadsheetEditing
       --> app/src/components/Spreadsheet/useSpreadsheetLayout.ts :: useSpreadsheetLayout
       --> app/src/components/Spreadsheet/useSpreadsheetSelection.ts :: useSpreadsheetSelection
       --> app/src/components/Spreadsheet/useSpreadsheetStyles.ts :: useSpreadsheetStyles
       --> app/src/state/GridContext.tsx :: useGridContext
       --> app/src/state/GridContext.tsx :: useGridState

### useSpreadsheetEditing.ts
   - **useSpreadsheetEditing** `fn` (205 loc)
     Sig: export function useSpreadsheetEditing(
     Hooks: useSpreadsheetEditing, useEditing
       --> app/src/hooks/useEditing.ts :: useEditing
       --> app/src/state/gridActions.ts :: startEditing

### useSpreadsheetLayout.ts
   - **useSpreadsheetLayout** `fn` (83 loc)
     Sig: export function useSpreadsheetLayout(
     Hooks: useSpreadsheetLayout, useViewport
       --> app/src/hooks/useViewport.ts :: useViewport
       --> app/src/lib/gridRenderer/layout/viewport.ts :: calculateVisibleRange

### useSpreadsheetSelection.ts
   - **useSpreadsheetSelection** `fn` (198 loc) [drag] [input] [scroll]
     Sig: export function useSpreadsheetSelection(
     Hooks: useSpreadsheetSelection, useViewport, useSelection, useEditing, useCellEvents, useMouseSelection, useGridKeyboard
       --> app/src/hooks/useCellEvents.ts :: useCellEvents
       --> app/src/hooks/useEditing.ts :: useEditing
       --> app/src/hooks/useGridKeyboard.ts :: useGridKeyboard
       --> app/src/hooks/useMouseSelection/useMouseSelection.ts :: useMouseSelection
       --> app/src/hooks/useSelection.ts :: useSelection
       --> app/src/hooks/useViewport.ts :: useViewport
       --> app/src/lib/tauri-api.ts :: getCell
       --> app/src/state/gridActions.ts :: startEditing
       --> self :: fetchCellContent
       --> setColumnWidth [? tauri-api.ts, gridActions.ts]
       --> setRowHeight [? tauri-api.ts, gridActions.ts]
   - **fetchCellContent** (9 loc) [async] --> app/src/lib/tauri-api.ts :: getCell

### useSpreadsheetStyles.ts [TASK:styles]
   - **createDefaultStyleCache** (4 loc)
   - **useSpreadsheetStyles** `fn` (107 loc)
     Sig: export function useSpreadsheetStyles(canvasRef: React.RefObject<GridCanvasHandle | null>) 
     Hooks: useSpreadsheetStyles
       --> app/src-tauri/src/utils/bridge.ts :: log
       --> app/src/lib/tauri-api.ts :: getAllStyles
       --> self :: createDefaultStyleCache

## DIR: app/src/hooks

### useCanvas.ts
   - **useCanvas** (2 loc)
   - **handleWindowResize** (2 loc)
   - **handleChange** (2 loc)
   - **to** `fn` (14 loc)
     Sig: * Utility function to set up common canvas text rendering settings.
       --> self :: setupTextRendering
   - **setupTextRendering** (8 loc)
   - **to** `fn` (50 loc)
     Sig: * Utility function to draw text with ellipsis if it exceeds max width.
       --> self :: drawTextWithEllipsis
   - **drawTextWithEllipsis** `fn` (42 loc)
     Sig: export function drawTextWithEllipsis(

### useCellEvents.ts
   - **useCellEvents** `fn` (20 loc)
     Sig: export function useCellEvents(
     Hooks: useCellEvents
   - **listener** (2 loc)
   - **useCellChange** `fn` (13 loc)
     Sig: export function useCellChange(
     Hooks: useCellChange, useCellEvents
       --> self :: useCellEvents

### useEditing.ts
   - **useEditing** `fn` (621 loc)
     Sig: export function useEditing(): UseEditingReturn 
     Hooks: useEditing, useGridContext
       --> app/src/lib/gridRenderer/references/conversion.ts :: columnRangeToReference
       --> app/src/lib/gridRenderer/references/conversion.ts :: columnToReference
       --> app/src/lib/gridRenderer/references/conversion.ts :: rangeToReference
       --> app/src/lib/gridRenderer/references/conversion.ts :: rowRangeToReference
       --> app/src/lib/gridRenderer/references/conversion.ts :: rowToReference
       --> app/src/lib/tauri-api.ts :: getCell
       --> app/src/lib/tauri-api.ts :: updateCell
       --> app/src/lib/types.ts :: isFormulaExpectingReference
       --> app/src/state/GridContext.tsx :: useGridContext
       --> app/src/state/gridActions.ts :: clearFormulaReferences
       --> app/src/state/gridActions.ts :: setFormulaReferences
       --> app/src/state/gridActions.ts :: stopEditing
       --> app/src/state/gridActions.ts :: updateEditing

### useGridKeyboard.ts
   - **useGridKeyboard** `fn` (168 loc) [input] [keyboard]
     Sig: export function useGridKeyboard(options: UseGridKeyboardOptions): void 
     Hooks: useGridKeyboard, useGridContext
       --> app/src/state/GridContext.tsx :: useGridContext
       --> app/src/state/gridActions.ts :: moveSelection

### useSelection.ts
   - **useSelection** `fn` (211 loc)
     Sig: export function useSelection(): UseSelectionReturn 
     Hooks: useSelection, useGridContext
       --> app/src/lib/tauri-api.ts :: indexToCol
       --> app/src/state/GridContext.tsx :: useGridContext
       --> app/src/state/gridActions.ts :: extendSelection
       --> app/src/state/gridActions.ts :: moveSelection
       --> setSelection [? gridActions.ts, gridActions.ts, gridActions.ts]

### useViewport.ts
   - **useViewport** `fn` (298 loc)
     Sig: export function useViewport(): UseViewportReturn 
     Hooks: useViewport, useGridContext
       --> app/src/lib/scrollUtils.ts :: calculateScrollDelta
       --> app/src/lib/scrollUtils.ts :: createThrottledScrollHandler
       --> app/src/lib/scrollUtils.ts :: isCellVisible
       --> app/src/lib/scrollUtils.ts :: scrollToVisibleRange
       --> app/src/state/GridContext.tsx :: useGridContext
       --> app/src/state/gridActions.ts :: expandVirtualBounds
       --> app/src/state/gridActions.ts :: scrollBy
       --> app/src/state/gridActions.ts :: scrollToCell
       --> app/src/state/gridActions.ts :: setViewportDimensions
       --> app/src/state/gridActions.ts :: setViewportSize
       --> app/src/state/gridActions.ts :: updateScroll
   - **normalizeSelection** `fn` (12 loc)
     Sig: export function normalizeSelection(selection: Selection): 
   - **isCellSelected** (7 loc) --> self :: normalizeSelection
   - **isActiveCell** (6 loc)

## DIR: app/src/hooks/useMouseSelection

### useMouseSelection.ts
   - **useMouseSelection** `fn` (458 loc) [drag] [mouse] [scroll]
     Sig: export function useMouseSelection(props: UseMouseSelectionProps): UseMouseSelectionReturn 
     Hooks: useMouseSelection, useAutoScroll
       --> app/src/hooks/useMouseSelection/editing/formulaHandlers.ts :: createFormulaHandlers
       --> app/src/hooks/useMouseSelection/editing/formulaHandlers.ts :: handleFormulaCellMouseUp
       --> app/src/hooks/useMouseSelection/editing/formulaHeaderHandlers.ts :: createFormulaHeaderHandlers
       --> app/src/hooks/useMouseSelection/editing/formulaHeaderHandlers.ts :: handleFormulaHeaderMouseUp
       --> app/src/hooks/useMouseSelection/layout/resizeHandlers.ts :: createResizeHandlers
       --> app/src/hooks/useMouseSelection/selection/cellSelectionHandlers.ts :: createCellSelectionHandlers
       --> app/src/hooks/useMouseSelection/selection/headerSelectionHandlers.ts :: createHeaderSelectionHandlers
       --> app/src/hooks/useMouseSelection/selection/useAutoScroll.ts :: useAutoScroll
       --> app/src/hooks/useMouseSelection/utils/autoScrollUtils.ts :: calculateAutoScrollDelta
       --> app/src/hooks/useMouseSelection/utils/cellUtils.ts :: getCellFromMousePosition
       --> app/src/lib/gridRenderer/interaction/hitTesting.ts :: getCellFromPixel
   - **handleGlobalMouseUp** `fn` (13 loc) [drag]
     Sig: const handleGlobalMouseUp = () => 
   - **handleGlobalMouseMove** `fn` (47 loc)
     Sig: const handleGlobalMouseMove = (event: MouseEvent) => 
       --> app/src/hooks/useMouseSelection/utils/autoScrollUtils.ts :: calculateAutoScrollDelta
       --> app/src/hooks/useMouseSelection/utils/cellUtils.ts :: getCellFromMousePosition

## DIR: app/src/hooks/useMouseSelection/editing

### formulaHandlers.ts
   - **createFormulaHandlers** `fn` (115 loc)
     Sig: export function createFormulaHandlers(deps: FormulaDependencies): FormulaHandlers 
       --> app/src/hooks/useMouseSelection/utils/cellUtils.ts :: getCellFromMousePosition
       --> app/src/lib/gridRenderer/interaction/hitTesting.ts :: getCellFromPixel
   - **handleFormulaCellMouseUp** `fn` (35 loc)
     Sig: const handleFormulaCellMouseUp = (stopAutoScroll: () => void): void => 
       --> app/src/hooks/useMouseSelection/utils/cellUtils.ts :: getCellFromMousePosition

### formulaHeaderHandlers.ts
   - **createFormulaHeaderHandlers** `fn` (162 loc)
     Sig: export function createFormulaHeaderHandlers(deps: FormulaHeaderDependencies): FormulaHeaderHandlers 
       --> app/src/lib/gridRenderer/interaction/hitTesting.ts :: getColumnFromHeader
       --> app/src/lib/gridRenderer/interaction/hitTesting.ts :: getRowFromHeader
   - **handleFormulaHeaderMouseUp** `fn` (50 loc)
     Sig: const handleFormulaHeaderMouseUp = (stopAutoScroll: () => void): void => 
       --> app/src/lib/gridRenderer/interaction/hitTesting.ts :: getColumnFromHeader
       --> app/src/lib/gridRenderer/interaction/hitTesting.ts :: getRowFromHeader

## DIR: app/src/hooks/useMouseSelection/layout

### resizeHandlers.ts
   - **createResizeHandlers** `fn` (122 loc)
     Sig: export function createResizeHandlers(deps: ResizeDependencies): ResizeHandlers 
       --> app/src/hooks/useMouseSelection/utils/cellUtils.ts :: getCurrentDimensionSize
       --> app/src/lib/gridRenderer/interaction/hitTesting.ts :: getColumnResizeHandle
       --> app/src/lib/gridRenderer/interaction/hitTesting.ts :: getRowResizeHandle

## DIR: app/src/hooks/useMouseSelection/selection

### cellSelectionHandlers.ts
   - **createCellSelectionHandlers** `fn` (60 loc)
     Sig: export function createCellSelectionHandlers(deps: CellSelectionDependencies): CellSelectionHandlers 
       --> app/src/lib/gridRenderer/interaction/hitTesting.ts :: getCellFromPixel

### headerSelectionHandlers.ts
   - **createHeaderSelectionHandlers** `fn` (139 loc)
     Sig: export function createHeaderSelectionHandlers(deps: HeaderSelectionDependencies): HeaderSelection...
       --> app/src/lib/gridRenderer/interaction/hitTesting.ts :: getColumnFromHeader
       --> app/src/lib/gridRenderer/interaction/hitTesting.ts :: getRowFromHeader

### useAutoScroll.ts
   - **useAutoScroll** `fn` (86 loc) [scroll]
     Sig: export function useAutoScroll(props: UseAutoScrollProps): UseAutoScrollReturn 
     Hooks: useAutoScroll
       --> app/src/hooks/useMouseSelection/utils/autoScrollUtils.ts :: calculateAutoScrollDelta
       --> app/src/hooks/useMouseSelection/utils/cellUtils.ts :: getCellFromMousePosition

## DIR: app/src/hooks/useMouseSelection/utils

### autoScrollUtils.ts
   - **calculateAutoScrollDelta** `fn` (44 loc)
     Sig: export function calculateAutoScrollDelta(

### cellUtils.ts
   - **getCellFromMousePosition** `fn` (13 loc)
     Sig: export function getCellFromMousePosition(
       --> app/src/lib/gridRenderer/interaction/hitTesting.ts :: getCellFromPixel
   - **getCurrentDimensionSize** `fn` (13 loc)
     Sig: export function getCurrentDimensionSize(
       --> core/engine/src/style.rs :: get

## DIR: app/src/lib

### cellEvents.ts
   - **CellEventEmitter** `class` (42 loc)
       --> app/src/hooks/useCellEvents.ts :: listener
       --> core/engine/src/dependency_graph.rs :: clear
   - **to** (8 loc)

### scrollUtils.ts
   - **calculateMaxScroll** `fn` (20 loc)
     Sig: export function calculateMaxScroll(
   - **clampScroll** `fn` (23 loc)
     Sig: export function clampScroll(
       --> self :: calculateMaxScroll
   - **scrollToVisibleRange** `fn` (44 loc)
     Sig: export function scrollToVisibleRange(
   - **cellToScroll** (7 loc)
   - **cellToCenteredScroll** `fn` (22 loc)
     Sig: export function cellToCenteredScroll(
   - **calculateScrollDelta** `fn` (47 loc)
     Sig: export function calculateScrollDelta(
   - **isCellVisible** `fn` (22 loc)
     Sig: export function isCellVisible(
       --> self :: scrollToVisibleRange
   - **scrollToMakeVisible** `fn` (51 loc)
     Sig: export function scrollToMakeVisible(
       --> self :: clampScroll
   - **createThrottledScrollHandler** `fn` (18 loc)
     Sig: export function createThrottledScrollHandler(
   - **calculateScrollbarMetrics** `fn` (45 loc)
     Sig: export function calculateScrollbarMetrics(
   - **thumbPositionToScroll** `fn` (15 loc)
     Sig: export function thumbPositionToScroll(

### tauri-api.ts [TASK:styles]
   - **indexToCol** (7 loc)
   - **colToIndex** (6 loc)
   - **getViewportCells** `fn` (12 loc) [async]
     Sig: export async function getViewportCells(
   - **getCell** (2 loc) [async]
   - **updateCell** (9 loc) [async] --> app/src-tauri/src/utils/bridge.ts :: log
   - **clearCell** (2 loc) [async]
   - **getGridBounds** (2 loc) [async]
   - **getCellCount** (2 loc) [async]
   - **setColumnWidth** (2 loc) [async]
   - **getColumnWidth** (2 loc) [async]
   - **getAllColumnWidths** (2 loc) [async]
   - **setRowHeight** (2 loc) [async]
   - **getRowHeight** (2 loc) [async]
   - **getAllRowHeights** (2 loc) [async]
   - **getStyle** (2 loc) [async]
   - **getAllStyles** (2 loc) [async]
   - **setCellStyle** (6 loc) [async]
   - **applyFormatting** `fn` (37 loc) [async]
     Sig: export async function applyFormatting(
       --> app/src-tauri/src/utils/bridge.ts :: log
   - **getStyleCount** (2 loc) [async]
   - **getFunctionsByCategory** (6 loc) [async]
   - **getAllFunctions** (2 loc) [async]
   - **getFunctionTemplate** (2 loc) [async]
   - **setCalculationMode** (2 loc) [async]
   - **getCalculationMode** (2 loc) [async]
   - **calculateNow** (5 loc) [async] --> app/src-tauri/src/utils/bridge.ts :: log
   - **calculateSheet** (5 loc) [async] --> app/src-tauri/src/utils/bridge.ts :: log
### types.ts [Collapsed: 9 items]

## DIR: app/src/lib/gridRenderer

### core.ts [TASK:styles]
   - **renderGrid** `fn` (72 loc)
     Sig: export function renderGrid(
       --> app/src/lib/gridRenderer/rendering/cells.ts :: drawCellText
       --> app/src/lib/gridRenderer/rendering/grid.ts :: drawCellBackgrounds
       --> app/src/lib/gridRenderer/rendering/grid.ts :: drawGridLines
       --> app/src/lib/gridRenderer/rendering/headers.ts :: drawColumnHeaders
       --> app/src/lib/gridRenderer/rendering/headers.ts :: drawCorner
       --> app/src/lib/gridRenderer/rendering/headers.ts :: drawRowHeaders
       --> app/src/lib/gridRenderer/rendering/references.ts :: drawFormulaReferences
       --> app/src/lib/gridRenderer/rendering/selection.ts :: drawActiveCell
       --> app/src/lib/gridRenderer/rendering/selection.ts :: drawActiveCellBackground
       --> app/src/lib/gridRenderer/rendering/selection.ts :: drawSelection
       --> app/src/lib/gridRenderer/styles/styleUtils.ts :: ensureDimensions
       --> app/src/lib/gridRenderer/styles/styleUtils.ts :: ensureStyleCache

## DIR: app/src/lib/gridRenderer/interaction

### hitTesting.ts [TASK:styles]
   - **getCellFromPixel** `fn` (51 loc)
     Sig: export function getCellFromPixel(
       --> app/src/lib/gridRenderer/styles/styleUtils.ts :: ensureDimensions
       --> getColumnWidth [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
       --> getRowHeight [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
   - **getColumnResizeHandle** `fn` (33 loc)
     Sig: export function getColumnResizeHandle(
       --> app/src/lib/gridRenderer/layout/viewport.ts :: calculateVisibleRange
       --> app/src/lib/gridRenderer/styles/styleUtils.ts :: ensureDimensions
       --> getColumnWidth [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
   - **getRowResizeHandle** `fn` (33 loc)
     Sig: export function getRowResizeHandle(
       --> app/src/lib/gridRenderer/layout/viewport.ts :: calculateVisibleRange
       --> app/src/lib/gridRenderer/styles/styleUtils.ts :: ensureDimensions
       --> getRowHeight [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
   - **getColumnFromHeader** `fn` (32 loc)
     Sig: export function getColumnFromHeader(
       --> app/src/lib/gridRenderer/styles/styleUtils.ts :: ensureDimensions
       --> getColumnWidth [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
   - **getRowFromHeader** `fn` (32 loc)
     Sig: export function getRowFromHeader(
       --> app/src/lib/gridRenderer/styles/styleUtils.ts :: ensureDimensions
       --> getRowHeight [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]

## DIR: app/src/lib/gridRenderer/layout

### dimensions.ts [TASK:styles]
   - **getColumnWidth** `fn` (11 loc)
     Sig: export function getColumnWidth(
       --> app/src/lib/gridRenderer/styles/styleUtils.ts :: ensureDimensions
       --> core/engine/src/style.rs :: get
   - **getRowHeight** `fn` (11 loc)
     Sig: export function getRowHeight(
       --> app/src/lib/gridRenderer/styles/styleUtils.ts :: ensureDimensions
       --> core/engine/src/style.rs :: get
   - **getColumnX** `fn` (13 loc)
     Sig: export function getColumnX(
       --> app/src/lib/gridRenderer/styles/styleUtils.ts :: ensureDimensions
       --> self :: getColumnWidth
   - **getRowY** `fn` (13 loc)
     Sig: export function getRowY(
       --> app/src/lib/gridRenderer/styles/styleUtils.ts :: ensureDimensions
       --> self :: getRowHeight

### viewport.ts [TASK:styles]
   - **for** `fn` (102 loc)
     Sig: * This is the core function for virtual scrolling - it maps scroll pixels
       --> app/src/lib/gridRenderer/styles/styleUtils.ts :: ensureDimensions
       --> getColumnWidth [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
       --> getRowHeight [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
       --> self :: calculateVisibleRange
   - **calculateVisibleRange** `fn` (99 loc)
     Sig: export function calculateVisibleRange(
       --> app/src/lib/gridRenderer/styles/styleUtils.ts :: ensureDimensions
       --> getColumnWidth [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
       --> getRowHeight [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]

## DIR: app/src/lib/gridRenderer/references

### conversion.ts
   - **cellToReference** (2 loc) --> app/src/lib/types.ts :: columnToLetter
   - **rangeToReference** `fn` (15 loc)
     Sig: export function rangeToReference(
       --> self :: cellToReference
   - **columnToReference** (3 loc) --> app/src/lib/types.ts :: columnToLetter
   - **columnRangeToReference** (8 loc) --> [Multiple]
   - **rowToReference** (3 loc)
   - **rowRangeToReference** (8 loc) --> self :: rowToReference

## DIR: app/src/lib/gridRenderer/rendering

### cells.ts [TASK:styles]
   - **drawTextWithTruncation** `fn` (47 loc)
     Sig: export function drawTextWithTruncation(
   - **drawCellText** `fn` (237 loc)
     Sig: export function drawCellText(state: RenderState): void 
       --> app/src-tauri/src/utils/bridge.ts :: log
       --> app/src/lib/gridRenderer/layout/viewport.ts :: calculateVisibleRange
       --> app/src/lib/gridRenderer/styles/cellFormatting.ts :: isErrorValue
       --> app/src/lib/gridRenderer/styles/cellFormatting.ts :: isNumericValue
       --> app/src/lib/gridRenderer/styles/styleUtils.ts :: getStyleFromCache
       --> app/src/lib/gridRenderer/styles/styleUtils.ts :: isDefaultBackgroundColor
       --> app/src/lib/gridRenderer/styles/styleUtils.ts :: isDefaultTextColor
       --> app/src/lib/gridRenderer/styles/styleUtils.ts :: isValidColor
       --> app/src/lib/types.ts :: cellKey
       --> core/engine/src/style.rs :: get
       --> getColumnWidth [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
       --> getRowHeight [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
       --> self :: drawTextWithTruncation

### grid.ts [TASK:styles]
   - **drawGridLines** `fn` (36 loc)
     Sig: export function drawGridLines(state: RenderState): void 
       --> app/src/lib/gridRenderer/layout/viewport.ts :: calculateVisibleRange
       --> getColumnWidth [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
       --> getRowHeight [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
   - **drawCellBackgrounds** `fn` (13 loc)
     Sig: export function drawCellBackgrounds(state: RenderState): void 

### headers.ts
   - **drawCorner** `fn` (13 loc)
     Sig: export function drawCorner(state: RenderState): void 
   - **drawColumnHeaders** `fn` (74 loc)
     Sig: export function drawColumnHeaders(state: RenderState): void 
       --> app/src/lib/gridRenderer/layout/viewport.ts :: calculateVisibleRange
       --> app/src/lib/types.ts :: columnToLetter
       --> getColumnWidth [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
   - **drawRowHeaders** `fn` (72 loc)
     Sig: export function drawRowHeaders(state: RenderState): void 
       --> app/src/lib/gridRenderer/layout/viewport.ts :: calculateVisibleRange
       --> getRowHeight [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]

### references.ts
   - **drawFormulaReferences** `fn` (61 loc)
     Sig: export function drawFormulaReferences(state: RenderState): void 
       --> app/src/lib/gridRenderer/layout/dimensions.ts :: getColumnX
       --> app/src/lib/gridRenderer/layout/dimensions.ts :: getRowY
       --> app/src/lib/gridRenderer/layout/viewport.ts :: calculateVisibleRange
       --> getColumnWidth [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
       --> getRowHeight [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]

### selection.ts
   - **drawSelection** `fn` (53 loc)
     Sig: export function drawSelection(state: RenderState): void 
       --> app/src/lib/gridRenderer/layout/dimensions.ts :: getColumnX
       --> app/src/lib/gridRenderer/layout/dimensions.ts :: getRowY
       --> app/src/lib/gridRenderer/layout/viewport.ts :: calculateVisibleRange
       --> getColumnWidth [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
       --> getRowHeight [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
   - **drawActiveCell** `fn` (57 loc)
     Sig: export function drawActiveCell(state: RenderState): void 
       --> app/src/lib/gridRenderer/layout/dimensions.ts :: getColumnX
       --> app/src/lib/gridRenderer/layout/dimensions.ts :: getRowY
       --> app/src/lib/gridRenderer/layout/viewport.ts :: calculateVisibleRange
       --> getColumnWidth [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
       --> getRowHeight [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
   - **drawActiveCellBackground** `fn` (37 loc)
     Sig: export function drawActiveCellBackground(state: RenderState): void 
       --> app/src/lib/gridRenderer/layout/dimensions.ts :: getColumnX
       --> app/src/lib/gridRenderer/layout/dimensions.ts :: getRowY
       --> app/src/lib/gridRenderer/layout/viewport.ts :: calculateVisibleRange
       --> getColumnWidth [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]
       --> getRowHeight [? InlineEditor.tsx, tauri-api.ts, dimensions.ts]

## DIR: app/src/lib/gridRenderer/styles

### cellFormatting.ts [TASK:styles]
   - **isNumericValue** (9 loc)
   - **isErrorValue** (4 loc)

### styleUtils.ts [TASK:styles]
   - **ensureDimensions** (5 loc) --> app/src/lib/types.ts :: createEmptyDimensionOverrides
   - **ensureStyleCache** (7 loc)
   - **getStyleFromCache** (7 loc) --> core/engine/src/style.rs :: get
   - **isValidColor** `fn` (14 loc)
     Sig: export function isValidColor(color: string | undefined | null): boolean 
   - **isDefaultTextColor** (8 loc)
   - **isDefaultBackgroundColor** (8 loc)

## DIR: app/src/state

### GridContext.tsx
   - **GridProvider** `fn` (13 loc)
     Sig: export function GridProvider({ children, initialState }: GridProviderProps): React.ReactElement 
       --> app/src/state/gridReducer.ts :: getInitialState
   - **useGridContext** (8 loc)
   - **useGridState** (3 loc) --> self :: useGridContext
   - **useGridDispatch** (3 loc) --> self :: useGridContext

### gridActions.ts
   - **setSelection** `fn` (40 loc)
     Sig: export function setSelection(payload: SetSelectionPayload): SetSelectionAction;
   - **setSelection** `fn` (39 loc)
     Sig: export function setSelection(
   - **setSelection** `fn` (32 loc)
     Sig: export function setSelection(
   - **clearSelection** (4 loc)
   - **extendSelection** (5 loc)
   - **moveSelection** (9 loc)
   - **setViewport** (5 loc)
   - **updateScroll** (5 loc)
   - **scrollBy** (5 loc)
   - **scrollToCell** (5 loc)
   - **scrollToPosition** (5 loc)
   - **startEditing** (5 loc)
   - **updateEditing** (5 loc)
   - **stopEditing** (4 loc)
   - **updateConfig** (5 loc)
   - **setViewportSize** (5 loc)
   - **setViewportDimensions** (5 loc)
   - **expandVirtualBounds** (5 loc)
   - **setVirtualBounds** (5 loc)
   - **resetVirtualBounds** (4 loc)
   - **setFormulaReferences** (5 loc)
   - **clearFormulaReferences** (4 loc)
   - **setColumnWidth** (5 loc)
   - **setRowHeight** (5 loc)
   - **setAllDimensions** (8 loc)

### gridReducer.ts
   - **clamp** (2 loc)
   - **calculateMaxScrollForBounds** (1 loc)
   - **calculateExpandedBounds** (1 loc)
   - **calculateScrollState** `fn` (23 loc)
     Sig: function calculateScrollState(
       --> app/src/lib/scrollUtils.ts :: clampScroll
   - **gridReducer** `fn` (480 loc)
     Sig: export function gridReducer(state: GridState, action: GridAction): GridState 
       --> app/src/lib/scrollUtils.ts :: cellToCenteredScroll
       --> app/src/lib/scrollUtils.ts :: scrollToMakeVisible
       --> self :: calculateExpandedBounds
       --> self :: calculateMaxScrollForBounds
       --> self :: calculateScrollState
       --> self :: clamp
   - **getInitialState** (2 loc) --> app/src/lib/types.ts :: createInitialGridState

## DIR: core/engine/src

### cell.rs
   - **CellError** `enum`
   - **CellValue** `enum`
   - **Cell** `struct`
   - **new** (6 loc)
   - **new_number** (6 loc)
   - **new_text** (6 loc)
   - **new_formula** (6 loc)
   - **new_boolean** (6 loc)

### coord.rs
   - **col_to_index** (7 loc)
   - **index_to_col** `fn` (11 loc)
     Sig: pub fn index_to_col(mut col_index: u32) -> String 
   - **a1_to_coord** (4 loc) --> self :: col_to_index
   - **coord_to_a1** (5 loc) --> self :: index_to_col

### dependency_extractor.rs
   - **Expression** `enum`
   - **Value** `enum`
   - **BinaryOperator** `enum`
   - **UnaryOperator** `enum`
   - **GridBounds** `struct`
   - **default** (6 loc)
   - **extract_dependencies** (2 loc) --> [Multiple]
   - **extract_dependencies_with_bounds** (7 loc) --> self :: extract_recursive
   - **extract_recursive** `fn` (91 loc)
     Sig: fn extract_recursive(expr: &Expression, deps: &mut HashSet<CellCoord>, bounds: GridBounds) 
       --> core/engine/src/coord.rs :: col_to_index
   - **set_of** (2 loc)

### dependency_graph.rs
   - **CycleError** `struct`
   - **fmt** (9 loc)
   - **DependencyGraph** `struct`
   - **new** (5 loc)
   - **set_dependencies** `fn` (17 loc)
     Sig: pub fn set_dependencies(&mut self, cell: CellCoord, new_precedents: HashSet<CellCoord>) 
       --> core/engine/src/style.rs :: is_empty
       --> self :: clear_dependencies
   - **clear_dependencies** `fn` (14 loc)
     Sig: pub fn clear_dependencies(&mut self, cell: CellCoord) 
       --> core/engine/src/style.rs :: is_empty
   - **get_precedents** (2 loc) --> core/engine/src/style.rs :: get
   - **get_dependents** (2 loc) --> core/engine/src/style.rs :: get
   - **would_create_cycle** `fn` (15 loc)
     Sig: pub fn would_create_cycle(&self, cell: CellCoord, new_precedents: &HashSet<CellCoord>) -> bool 
       --> self :: can_reach
   - **can_reach** `fn` (25 loc)
     Sig: fn can_reach(&self, start: CellCoord, target: CellCoord) -> bool 
       --> core/engine/src/style.rs :: get
   - **get_recalc_order** `fn` (10 loc)
     Sig: pub fn get_recalc_order(&self, changed: CellCoord) -> Result<Vec<CellCoord>, CycleError> 
       --> core/engine/src/style.rs :: is_empty
       --> self :: get_all_dependents
       --> self :: topological_sort
   - **get_all_dependents** `fn` (28 loc)
     Sig: fn get_all_dependents(&self, cell: CellCoord) -> HashSet<CellCoord> 
       --> core/engine/src/style.rs :: get
   - **topological_sort** `fn` (58 loc)
     Sig: fn topological_sort(&self, cells: &HashSet<CellCoord>) -> Result<Vec<CellCoord>, CycleError> 
       --> core/engine/src/style.rs :: get
       --> core/engine/src/style.rs :: len
       --> self :: find_cycle_path
   - **find_cycle_path** `fn` (37 loc)
     Sig: fn find_cycle_path(&self, cycle_cells: &[CellCoord]) -> Vec<CellCoord> 
       --> core/engine/src/style.rs :: get
       --> core/engine/src/style.rs :: is_empty
       --> core/engine/src/style.rs :: len
   - **formula_cell_count** (2 loc) --> core/engine/src/style.rs :: len
   - **dependency_count** (2 loc) --> core/engine/src/style.rs :: len
   - **clear** (3 loc)
   - **coord** (2 loc)
   - **set_of** (2 loc)

### evaluator.rs
   - [20 evaluation helpers (eval_add, eval_multiply, ...)] (298 loc total)
   - [33 formula functions (fn_sum, fn_average, fn_if, ...)] (451 loc total)
   - **EvalResult** `enum`
   - **to_cell_value** `fn` (15 loc)
     Sig: pub fn to_cell_value(&self) -> CellValue 
   - **as_number** (7 loc)
   - **as_boolean** `fn` (16 loc)
     Sig: pub fn as_boolean(&self) -> Option<bool> 
   - **as_text** `fn` (27 loc)
     Sig: pub fn as_text(&self) -> String 
   - **is_error** (2 loc)
   - **flatten** `fn` (11 loc)
     Sig: pub fn flatten(&self) -> Vec<EvalResult> 
   - **Evaluator** `struct`
   - **new** (2 loc)
   - **evaluate** `fn` (13 loc)
     Sig: pub fn evaluate(&self, expr: &Expression) -> EvalResult 
       --> self :: eval_binary_op
       --> self :: eval_cell_ref
       --> self :: eval_column_ref
       --> self :: eval_function
       --> self :: eval_literal
       --> self :: eval_range
       --> self :: eval_row_ref
       --> self :: eval_unary_op
   - **cell_value_to_result** (8 loc)
   - **collect_numbers** `fn` (17 loc)
     Sig: fn collect_numbers(&self, args: &[Expression]) -> Result<Vec<f64>, CellError> 
       --> self :: as_number
       --> self :: evaluate
       --> self :: flatten
   - **collect_values** `fn` (14 loc)
     Sig: fn collect_values(&self, args: &[Expression]) -> Result<Vec<EvalResult>, CellError> 
       --> self :: evaluate
       --> self :: flatten
   - **make_grid** `fn` (12 loc)
     Sig: fn make_grid() -> Grid 
       --> Cell::new_number
       --> Cell::new_text
       --> Grid::new
       --> core/engine/src/grid.rs :: set_cell

### grid.rs
   - **Grid** `struct`
   - **new** (6 loc)
   - **set_cell** (8 loc)
   - **get_cell** (2 loc) --> core/engine/src/style.rs :: get
   - **clear_cell** (4 loc)

### number_format.rs
   - [13 format constructors] (54 loc total)
   - [9 format helpers] (141 loc total)
   - **add_thousands_separator** `fn` (28 loc)
     Sig: fn add_thousands_separator(s: &str) -> String 
       --> core/engine/src/style.rs :: get
       --> core/engine/src/style.rs :: len
   - **chrono_lite_date** `fn` (35 loc)
     Sig: fn chrono_lite_date(days: i64) -> Option<(i32, u32, u32)> 
       --> self :: is_leap_year
   - **is_leap_year** (2 loc)

### style.rs [TASK:styles]
   - **TextAlign** `enum`
   - **VerticalAlign** `enum`
   - **TextRotation** `enum`
   - **NumberFormat** `enum`
   - **CurrencyPosition** `enum`
   - **Color** `struct`
   - **new** (2 loc)
   - **with_alpha** (2 loc)
   - **black** (2 loc)
   - **white** (2 loc)
   - **transparent** (2 loc)
   - **to_css** `fn` (12 loc)
     Sig: pub fn to_css(&self) -> String 
   - **from_hex** `fn` (16 loc)
     Sig: pub fn from_hex(hex: &str) -> Option<Self> 
       --> self :: len
       --> u8::from_str_radix
   - **default** (2 loc)
   - **BorderStyle** `struct`
   - **BorderLineStyle** `enum`
   - **Borders** `struct`
   - **FontStyle** `struct`
   - **default** (10 loc)
   - **CellStyle** `struct`
   - **new** (12 loc) --> [Multiple]
   - **with_bold** (3 loc)
   - **with_italic** (3 loc)
   - **with_text_color** (3 loc)
   - **with_background** (3 loc)
   - **with_text_align** (3 loc)
   - **with_number_format** (3 loc)
   - **with_wrap_text** (3 loc)
   - **with_text_rotation** (3 loc)
   - **StyleRegistry** `struct`
   - **new** (9 loc) --> CellStyle::new
   - **get_or_create** (9 loc) --> [Multiple]
   - **get** (2 loc)
   - **default_style** (2 loc)
   - **len** (2 loc)
   - **is_empty** (2 loc) --> self :: len
   - **rebuild_index** (5 loc) --> core/engine/src/dependency_graph.rs :: clear
   - **all_styles** (2 loc)
   - **default** (2 loc) --> StyleRegistry::new

## DIR: core/parser/src
### ast.rs [Collapsed: 7 items]

### lexer.rs
   - **Lexer** `struct`
   - **new** (4 loc)
   - **next_token** `fn` (39 loc)
     Sig: pub fn next_token(&mut self) -> Token 
       --> self :: is_letter
       --> self :: read_greater_than_operator
       --> self :: read_identifier
       --> self :: read_less_than_operator
       --> self :: read_number
       --> self :: read_string
       --> self :: skip_whitespace
   - **skip_whitespace** (7 loc)
   - **read_less_than_operator** `fn` (12 loc)
     Sig: fn read_less_than_operator(&mut self) -> Token 
   - **read_greater_than_operator** (8 loc)
   - **read_string** `fn` (14 loc)
     Sig: fn read_string(&mut self) -> Token 
   - **read_number** `fn` (23 loc)
     Sig: fn read_number(&mut self, first_char: char) -> Token 
   - **read_identifier** `fn` (17 loc)
     Sig: fn read_identifier(&mut self, first_char: char) -> Token 
       --> self :: is_letter
   - **is_letter** (2 loc)

### parser.rs
   - **ParseError** `struct`
   - **new** (4 loc)
   - **fmt** (2 loc)
   - **Parser** `struct`
   - **new** (8 loc) --> [Multiple]
   - **parse** `fn` (23 loc)
     Sig: pub fn parse(&mut self) -> ParseResult<Expression> 
       --> self :: advance
       --> self :: parse_expression
   - **advance** (2 loc) --> core/parser/src/lexer.rs :: next_token
   - **expect** `fn` (10 loc)
     Sig: fn expect(&mut self, expected: Token) -> ParseResult<()> 
       --> self :: advance
   - **parse_expression** (2 loc) --> self :: parse_comparison
   - **parse_comparison** `fn` (25 loc)
     Sig: fn parse_comparison(&mut self) -> ParseResult<Expression> 
       --> self :: advance
       --> self :: parse_concatenation
   - **parse_concatenation** `fn` (15 loc)
     Sig: fn parse_concatenation(&mut self) -> ParseResult<Expression> 
       --> self :: advance
       --> self :: parse_additive
   - **parse_additive** `fn` (21 loc)
     Sig: fn parse_additive(&mut self) -> ParseResult<Expression> 
       --> self :: advance
       --> self :: parse_multiplicative
   - **parse_multiplicative** `fn` (21 loc)
     Sig: fn parse_multiplicative(&mut self) -> ParseResult<Expression> 
       --> self :: advance
       --> self :: parse_unary
   - **parse_unary** `fn` (11 loc)
     Sig: fn parse_unary(&mut self) -> ParseResult<Expression> 
       --> self :: advance
       --> self :: parse_power
   - **parse_power** `fn` (16 loc)
     Sig: fn parse_power(&mut self) -> ParseResult<Expression> 
       --> self :: advance
       --> self :: parse_primary
       --> self :: parse_unary
   - **parse_primary** `fn` (59 loc)
     Sig: fn parse_primary(&mut self) -> ParseResult<Expression> 
       --> self :: advance
       --> self :: expect
       --> self :: parse_cell_ref
       --> self :: parse_expression
       --> self :: parse_function_call
       --> self :: parse_range_or_column_ref
       --> self :: parse_row_reference
   - **parse_cell_ref** (3 loc) --> self :: split_cell_reference
   - **parse_range_or_column_ref** `fn` (44 loc)
     Sig: fn parse_range_or_column_ref(&mut self, start_identifier: String) -> ParseResult<Expression> 
       --> self :: advance
       --> self :: split_cell_reference
   - **parse_row_reference** `fn` (25 loc)
     Sig: fn parse_row_reference(&mut self, start_num: f64) -> ParseResult<Expression> 
       --> self :: advance
   - **parse_function_call** `fn` (25 loc)
     Sig: fn parse_function_call(&mut self, name: String) -> ParseResult<Expression> 
       --> self :: advance
       --> self :: expect
       --> self :: parse_expression
   - **split_cell_reference** `fn` (53 loc)
     Sig: fn split_cell_reference(&self, identifier: &str) -> ParseResult<(String, u32)> 
       --> core/engine/src/style.rs :: is_empty
       --> self :: parse
   - **parse** (3 loc) --> Parser::new
### token.rs [Collapsed: 2 items]

## DIR: core/persistence/src

### lib.rs
   - **SavedCell** `struct`
   - **SavedSheet** `struct`

================================================================================
                            CONFIGURATION FILES FOUND
================================================================================
- app\package.json
- app\src-tauri\Cargo.toml
- app\tsconfig.json
- core\Cargo.toml
- core\engine\Cargo.toml
- core\parser\Cargo.toml
- core\persistence\Cargo.toml
