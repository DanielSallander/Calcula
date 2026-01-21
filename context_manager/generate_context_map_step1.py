import os
import re
import sys
import pyperclip
from collections import defaultdict
from typing import List, Dict, Set, Optional, Tuple

# ==============================================================================
# CONFIGURATION
# ==============================================================================
PROJECT_ROOT = r"C:\Dropbox\Projekt\Calcula"

# 1. EXCLUDE PATTERNS: Files matching these regexes are completely ignored.
EXCLUDE_PATTERNS = [
    r".*log.*",
    r".*test.*",
    r".*spec.*",
    r".*stories.*"
]

# 2. EXCLUDE DIRECTORIES: Entire directories to skip (in addition to DEFAULT_IGNORE_DIRS)
EXCLUDE_DIRECTORIES = {
    "context_manager",  # Build tooling, not application code
    "z_archive",
}

# 3. EXCLUDE FUNCTIONS: Functions matching these patterns are hidden
EXCLUDE_FUNCTION_PATTERNS = [
    r"^test_.*",
    r"^it_.*",              # Rust test convention: it_does_something
    r"^integration_test.*", # Integration tests
    r"^bench_.*",
    r"^mod test$",
    r"^lexer_.*",           # Parser tests
    r"^parser_.*",          # Parser tests
]

# 4. FOLD PATTERNS: Files shown as collapsed single line
FOLD_PATTERNS = [
    r".*types\.ts",
    r".*dto\.ts",
    r".*interfaces\.ts",
    r".*token\.rs",         # Token definitions are just enums
    r".*ast\.rs",           # AST is just data structures
]

# 5. GROUP PATTERNS: Functions matching these are grouped into a single line
#    Format: (file_pattern, function_pattern, group_name)
GROUP_PATTERNS = [
    (r"evaluator\.rs", r"^fn_.*", "formula functions (fn_sum, fn_average, fn_if, ...)"),
    (r"evaluator\.rs", r"^eval_.*", "evaluation helpers (eval_add, eval_multiply, ...)"),
    (r"number_format\.rs", r"^format_.*", "format helpers"),
    (r"number_format\.rs", r"^(general|number|currency|percentage|scientific|date|time).*", "format constructors"),
]

# 6. TRIVIAL FUNCTION THRESHOLDS
TRIVIAL_LOC_THRESHOLD = 10
MAX_CALLS_FOR_TRIVIAL = 2

# 7. TRIVIAL NAMES: Common methods that are almost always trivial wrappers
TRIVIAL_METHOD_NAMES = {
    "new", "default", "clone", "fmt", "from", "into",
    "get", "set", "len", "is_empty", "clear",
    "with_bold", "with_italic", "with_text_color", "with_background",
    "with_text_align", "with_number_format",
}

# 8. HIDE THESE CALLS: Standard library / enum constructors to filter out
HIDDEN_CALLS = {
    # Rust std
    "Vec::new", "Vec::with_capacity", "HashMap::new", "HashSet::new",
    "String::new", "String::from", "VecDeque::new", "Box::new",
    "Mutex::new", "Arc::new", "Rc::new",
    "SeekFrom::Start", "SeekFrom::End",
    # Common enum variants (noise when shown as calls)
    "CellValue::Boolean", "CellValue::Number", "CellValue::Text",
    "EvalResult::Array", "EvalResult::Boolean", "EvalResult::Number", "EvalResult::Text",
    "Expression::Literal", "Value::Boolean", "Value::Number", "Value::String",
    "Token::Boolean", "Token::Number", "Token::String", "Token::Identifier", "Token::Illegal",
    "ParserExpr::Literal", "ParserValue::Boolean", "ParserValue::Number", "ParserValue::String",
    "Color::new", "Color::black", "Color::white", "Color::with_alpha",
}

# ==============================================================================
# LOG ANALYSIS CONFIGURATION
# ==============================================================================
LOG_FILE = "log.log"
HIGHLIGHT_FROM_LOG = True

# Pattern to extract function/command names from log entries
LOG_FUNCTION_PATTERNS = [
    r"(?:ENTER|EXIT)\s+([a-zA-Z_][a-zA-Z0-9_]*)",           # CMD: ENTER get_cell
    r"ACTION\|([a-zA-Z_][a-zA-Z0-9_.]+)",                    # ACTION|Selection.selectCell
    r"ENTER\s+([a-zA-Z_][a-zA-Z0-9_.]+)",                    # Nested: ENTER Editing.startEdit
]

# ==============================================================================
# EVENT DETECTION CONFIGURATION
# ==============================================================================
# React/TypeScript event handler patterns
EVENT_HANDLER_PATTERNS = [
    (r'on(Click|DoubleClick|MouseDown|MouseUp|MouseMove|MouseEnter|MouseLeave)', 'mouse'),
    (r'on(KeyDown|KeyUp|KeyPress)', 'keyboard'),
    (r'on(Focus|Blur)', 'focus'),
    (r'on(Change|Input|Submit)', 'input'),
    (r'on(Scroll|Wheel)', 'scroll'),
    (r'on(Drag|DragStart|DragEnd|Drop)', 'drag'),
    (r'on(TouchStart|TouchMove|TouchEnd)', 'touch'),
]

# ==============================================================================
# TASK KEYWORD EXTRACTION
# ==============================================================================
# Words to ignore when extracting task keywords
TASK_STOPWORDS = {
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "must", "shall", "can", "need", "dare",
    "ought", "used", "to", "of", "in", "for", "on", "with", "at", "by",
    "from", "as", "into", "through", "during", "before", "after", "above",
    "below", "between", "under", "again", "further", "then", "once",
    "here", "there", "when", "where", "why", "how", "all", "each", "few",
    "more", "most", "other", "some", "such", "no", "nor", "not", "only",
    "own", "same", "so", "than", "too", "very", "just", "and", "but",
    "if", "or", "because", "until", "while", "although", "though",
    "that", "this", "these", "those", "what", "which", "who", "whom",
    "want", "like", "notice", "addition", "current", "solution", "aiming",
    "same", "feel", "order", "able", "soon", "applied", "visible", "user",
    "change", "changes", "currently", "however", "also", "using", "used",
}

# Technical terms that are relevant for code matching - weighted higher
TASK_HIGH_VALUE_TERMS = {
    "edit", "editing", "editor", "select", "selection", "selected", "deselect",
    "click", "double", "doubleclick", "single", "singleclick",
    "style", "styling", "styles", "format", "formatting",
    "render", "refresh", "update", "redraw", "repaint",
    "keyboard", "keydown", "keypress", "mouse", "mousedown",
    "focus", "blur", "input", "canvas", "grid", "viewport",
    "scroll", "apply", "applied", "inline", "formula",
    "immediate", "instantly", "realtime",
}

# Lower value - common but less discriminating
TASK_LOW_VALUE_TERMS = {
    "cell", "cells", "row", "column", "value", "data",
}

# Minimum score for a file to be considered task-relevant
TASK_RELEVANCE_THRESHOLD = 2

# ==============================================================================
# OUTPUT CONFIGURATION
# ==============================================================================
TEMPLATE_FILE = "template_dependency.txt"
INTRO_FILE = "intro.txt"
TASK_FILE = "task.txt"

# Summary mode settings
SUMMARY_MODE = True  # Generate summary section at top
SUMMARY_TOP_FILES_COUNT = 15  # Show top N files by complexity
SUMMARY_TOP_FUNCTIONS_COUNT = 20  # Show top N functions by size

DEFAULT_TEMPLATE = """{<intro>}

================================================================================
                                 INSTRUCTIONS
================================================================================
You are an advanced AI Software Engineer. You have been provided with a 
DEPENDENCY MAP of the project below.

1. ANALYZE FIRST: Use the map to understand the project structure and identifying 
   where the business logic resides.
2. RESOLVE AMBIGUITY: If you see a call like "update [? file1, file2]", use the 
   file context to determine which one is relevant.
3. BE SELECTIVE: Do NOT request code for:
   - Standard library functions.
   - Simple getters/setters or wrappers shown in the map.
   - Functions that clearly belong to other domains (e.g., UI formatting when 
     solving a backend logic issue).
4. REQUEST FORMAT: When you need to see the implementation details, request 
   them using the filenames found in the map.

{<legend>}
================================================================================
                                TASK DESCRIPTION
================================================================================

{<task>}

{<task_files>}{<summary>}{<hooks>}{<trace>}================================================================================
                             PROJECT DEPENDENCY MAP
================================================================================
> Generated automatically. 
> [?] indicates ambiguous calls. 
> `self ::` indicates a local function call.

{<content>}

================================================================================
                            CONFIGURATION FILES FOUND
================================================================================
{<configs>}
"""

# Import Filtering
IGNORED_IMPORTS = {
    ".rs": ["std::", "serde::", "tauri::", "super::", "crate::", "println!", "format!", "vec!", "Ok", "Err", "Some", "None", "Box::", "Rc::", "Arc::"],
    ".ts": ["react", "fs", "path", "console.", "JSON.", "Math.", "Array.", "Promise.", "Object."],
    ".tsx": ["react", "console.", "JSON.", "Math.", "Array."],
    ".js": ["react", "fs", "path", "console."],
    ".jsx": ["react", "console."],
    ".py": ["os.", "sys.", "re.", "json.", "subprocess.", "print(", "len(", "str(", "int(", "float(", "list(", "dict(", "set("]
}

DEFAULT_IGNORE_DIRS = {
    "node_modules", ".git", "__pycache__", "venv", ".venv", "env", "target",
    ".idea", ".vscode", "dist", "build", "__tests__", ".next", "coverage", "general_stuff"
}

IGNORE_FILES = {
    ".DS_Store", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "Cargo.lock", "scopes.json", "*.png", "*.jpg", "*.svg"
}

CRITICAL_CONFIGS = ["package.json", "Cargo.toml", "tsconfig.json", "pyproject.toml"]
SOURCE_EXTENSIONS = ('.rs', '.ts', '.tsx', '.js', '.jsx', '.py')


# ==============================================================================
# DATA STRUCTURES
# ==============================================================================

class CodeEntity:
    def __init__(self, name, kind, signature, line_start, line_end, file_path, rel_path):
        self.name = name
        self.kind = kind
        self.signature = signature
        self.line_start = line_start
        self.line_end = line_end
        self.file_path = file_path
        self.rel_path = rel_path
        self.raw_calls: Set[str] = set()
        self.resolved_calls: List[str] = []
        self.is_async: bool = False
        self.is_tauri_command: bool = False
        self.is_exported: bool = False
        self.event_handlers: Set[str] = set()  # e.g., {'onClick', 'onKeyDown'}
        self.event_types: Set[str] = set()      # e.g., {'mouse', 'keyboard'}
        self.reducer_actions: Set[str] = set()  # For reducer functions
        self.hook_dependencies: List[str] = []  # Hooks this hook uses (direct deps only)

    @property
    def line_count(self):
        return self.line_end - self.line_start


class SourceFile:
    def __init__(self, path, rel_path):
        self.path = path
        self.rel_path = rel_path
        self.extension = os.path.splitext(path)[1]
        self.entities: List[CodeEntity] = []
        self.content = ""
        self.imports: List[str] = []
        self.exports: List[str] = []
        self.reducer_actions: Set[str] = set()  # Actions defined in this file
        self.task_relevance_score: int = 0      # Weighted relevance score
        self.task_keyword_matches: Set[str] = set()  # Keywords from task that match

    @property
    def total_loc(self):
        return sum(e.line_count for e in self.entities)

    @property
    def function_count(self):
        return sum(1 for e in self.entities if e.kind in ["fn", "def", "function"])


# ==============================================================================
# UTILS & PARSERS
# ==============================================================================

def read_file_safe(path):
    try:
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            return f.read()
    except Exception:
        return ""


def should_ignore_dir(dirname):
    return dirname in DEFAULT_IGNORE_DIRS or dirname in EXCLUDE_DIRECTORIES


def should_ignore_file(filename):
    if filename in IGNORE_FILES:
        return True
    for ignore in IGNORE_FILES:
        if ignore.startswith("*") and filename.endswith(ignore[1:]):
            return True
    for pattern in EXCLUDE_PATTERNS:
        if re.match(pattern, filename):
            return True
    return False


def find_closing_brace(lines, start_index, open_char='{', close_char='}'):
    balance = 0
    started = False
    for i in range(start_index, len(lines)):
        line = lines[i]
        if "//" in line:
            line = line.split("//")[0]
        if "#" in line:
            line = line.split("#")[0]
        balance += line.count(open_char)
        balance -= line.count(close_char)
        if open_char in line:
            started = True
        if started and balance <= 0:
            return i
    return len(lines)


def extract_event_handlers(body: str) -> Tuple[Set[str], Set[str]]:
    """Extract event handler names and their types from function body."""
    handlers: Set[str] = set()
    event_types: Set[str] = set()
    
    # Check for event handler props/assignments
    for pattern, etype in EVENT_HANDLER_PATTERNS:
        matches = re.findall(pattern, body)
        if matches:
            for match in matches:
                handlers.add("on" + match)
                event_types.add(etype)
    
    # Check for addEventListener calls
    listener_matches = re.findall(r'addEventListener\s*\(\s*[\'"](\w+)[\'"]', body)
    for event_name in listener_matches:
        handlers.add(event_name)
        # Map to event type
        if event_name in ['click', 'dblclick', 'mousedown', 'mouseup', 'mousemove']:
            event_types.add('mouse')
        elif event_name in ['keydown', 'keyup', 'keypress']:
            event_types.add('keyboard')
        elif event_name in ['focus', 'blur']:
            event_types.add('focus')
        elif event_name in ['scroll', 'wheel']:
            event_types.add('scroll')
    
    return handlers, event_types


def extract_reducer_actions(body: str) -> Set[str]:
    """Extract action types from reducer-style switch/case statements."""
    actions: Set[str] = set()
    
    # Pattern for case "ACTION_NAME": or case 'ACTION_NAME':
    case_matches = re.findall(r'case\s+[\'"]([A-Z][A-Z0-9_]*)[\'"]', body)
    actions.update(case_matches)
    
    # Pattern for action.type === "ACTION_NAME"
    type_matches = re.findall(r'action\.type\s*===?\s*[\'"]([A-Z][A-Z0-9_]*)[\'"]', body)
    actions.update(type_matches)
    
    # Pattern for type: "ACTION_NAME" in action creators
    creator_matches = re.findall(r'type:\s*[\'"]([A-Z][A-Z0-9_]*)[\'"]', body)
    actions.update(creator_matches)
    
    return actions


def extract_hook_dependencies(body: str, all_hook_names: Set[str]) -> List[str]:
    """Extract which custom hooks this hook directly calls."""
    deps = []
    seen = set()
    # Look for useXxx( calls - only custom hooks (in our codebase)
    hook_calls = re.findall(r'\b(use[A-Z][a-zA-Z0-9]*)\s*\(', body)
    for hook in hook_calls:
        if hook in all_hook_names and hook not in seen:
            deps.append(hook)
            seen.add(hook)
    return deps


def parse_rust(file_obj: SourceFile):
    lines = file_obj.content.splitlines()
    fn_pattern = re.compile(r'(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)\s*(?:<[^>]+>)?\s*\(')
    struct_pattern = re.compile(r'(?:pub\s+)?(struct|enum|trait)\s+([a-zA-Z0-9_]+)')
    call_pattern = re.compile(r'([a-zA-Z0-9_]+(?:::[a-zA-Z0-9_]+)*)\s*\(')
    tauri_cmd_pattern = re.compile(r'#\[tauri::command\]')

    pending_tauri_command = False

    for i, line in enumerate(lines):
        stripped = line.strip()
        
        # Check for tauri::command attribute
        if tauri_cmd_pattern.search(stripped):
            pending_tauri_command = True
            continue
            
        if stripped.startswith("//"):
            continue

        match_fn = fn_pattern.search(line)
        if match_fn:
            name = match_fn.group(1)
            sig = line.strip().rstrip('{')
            end_line = find_closing_brace(lines, i)
            ent = CodeEntity(name, "fn", sig, i + 1, end_line + 1, file_obj.path, file_obj.rel_path)
            
            # Check for async
            ent.is_async = 'async fn' in line or 'async fn' in sig
            
            # Check for pub (exported)
            ent.is_exported = line.strip().startswith('pub ')
            
            # Check if this was marked as tauri command
            if pending_tauri_command:
                ent.is_tauri_command = True
                pending_tauri_command = False
            
            body = "\n".join(lines[i:end_line])
            calls = call_pattern.findall(body)
            calls = [c for c in calls if c != name and c not in ["if", "for", "while", "match"]]
            ent.raw_calls = set(calls)
            file_obj.entities.append(ent)
            continue

        match_struct = struct_pattern.search(line)
        if match_struct:
            kind = match_struct.group(1)
            name = match_struct.group(2)
            ent = CodeEntity(name, kind, "{} {}".format(kind, name), i + 1, i + 1, file_obj.path, file_obj.rel_path)
            ent.is_exported = line.strip().startswith('pub ')
            file_obj.entities.append(ent)
            pending_tauri_command = False


def parse_typescript(file_obj: SourceFile):
    lines = file_obj.content.splitlines()
    ts_fn = re.compile(
        r'(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)|'
        r'(?:export\s+)?const\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>'
    )
    ts_class = re.compile(r'(?:export\s+)?class\s+([a-zA-Z0-9_]+)')
    call_pattern = re.compile(r'([a-zA-Z0-9_]+)\(')
    export_pattern = re.compile(r'^export\s+')

    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("//") or stripped.startswith("/*"):
            continue

        match_fn = ts_fn.search(line)
        match_class = ts_class.search(line)
        ent = None

        if match_fn:
            name = match_fn.group(1) or match_fn.group(2)
            if not name:
                continue
            end_line = find_closing_brace(lines, i)
            sig = line.strip().rstrip('{').rstrip('=>')
            ent = CodeEntity(name, "fn", sig, i + 1, end_line + 1, file_obj.path, file_obj.rel_path)
            ent.is_async = 'async ' in line
            ent.is_exported = export_pattern.search(stripped) is not None
        elif match_class:
            name = match_class.group(1)
            end_line = find_closing_brace(lines, i)
            ent = CodeEntity(name, "class", "class {}".format(name), i + 1, end_line + 1, file_obj.path, file_obj.rel_path)
            ent.is_exported = export_pattern.search(stripped) is not None

        if ent:
            body = "\n".join(lines[i:ent.line_end])
            calls = call_pattern.findall(body)
            calls = [c for c in calls if c != ent.name and c not in ["if", "for", "switch", "catch", "while", "super"]]
            ent.raw_calls = set(calls)
            
            # Extract event handlers
            handlers, event_types = extract_event_handlers(body)
            ent.event_handlers = handlers
            ent.event_types = event_types
            
            # Extract reducer actions - check filename AND content
            filename_lower = os.path.basename(file_obj.rel_path).lower()
            if 'reducer' in filename_lower or 'reducer' in ent.name.lower() or 'switch' in body:
                actions = extract_reducer_actions(body)
                if actions:
                    ent.reducer_actions = actions
                    file_obj.reducer_actions.update(actions)
            
            file_obj.entities.append(ent)


def parse_python(file_obj: SourceFile):
    lines = file_obj.content.splitlines()
    py_def = re.compile(r'^\s*(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(')
    py_class = re.compile(r'^\s*class\s+([a-zA-Z0-9_]+)')
    call_pattern = re.compile(r'([a-zA-Z0-9_]+)\(')

    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue

        match_def = py_def.match(line)
        match_class = py_class.match(line)
        ent = None

        if match_def:
            name = match_def.group(1)
            ent = CodeEntity(name, "def", stripped.rstrip(':'), i + 1, i + 20, file_obj.path, file_obj.rel_path)
            ent.is_async = 'async def' in line
        elif match_class:
            name = match_class.group(1)
            ent = CodeEntity(name, "class", stripped.rstrip(':'), i + 1, i + 20, file_obj.path, file_obj.rel_path)

        if ent:
            current_indent = len(line) - len(line.lstrip())
            for j in range(i + 1, len(lines)):
                next_line = lines[j]
                if not next_line.strip():
                    continue
                next_indent = len(next_line) - len(next_line.lstrip())
                if next_indent <= current_indent:
                    ent.line_end = j
                    break
            else:
                ent.line_end = len(lines)

            body = "\n".join(lines[i:ent.line_end])
            calls = call_pattern.findall(body)
            calls = [c for c in calls if c != ent.name and c not in ["if", "for", "while", "with", "elif"]]
            ent.raw_calls = set(calls)
            file_obj.entities.append(ent)


def is_call_ignored(call_str, extension):
    if call_str in HIDDEN_CALLS:
        return True
    ignore_list = IGNORED_IMPORTS.get(extension, [])
    for ignore in ignore_list:
        if ignore in call_str:
            return True
    return False


def resolve_graph(files: List[SourceFile]):
    symbol_table = defaultdict(list)
    for f in files:
        for ent in f.entities:
            symbol_table[ent.name].append(ent)

    for f in files:
        for ent in f.entities:
            for call in ent.raw_calls:
                if is_call_ignored(call, f.extension):
                    continue
                if "::" in call:
                    if call not in HIDDEN_CALLS:
                        ent.resolved_calls.append(call)
                    continue

                candidates = symbol_table.get(call)
                if not candidates:
                    continue

                if len(candidates) == 1:
                    target = candidates[0]
                    if target.file_path == f.path:
                        ent.resolved_calls.append("self :: {}".format(target.name))
                    else:
                        ent.resolved_calls.append("{} :: {}".format(target.rel_path, target.name))
                else:
                    same_file = [c for c in candidates if c.file_path == f.path]
                    if same_file:
                        ent.resolved_calls.append("self :: {}".format(call))
                    else:
                        sources = [os.path.basename(c.file_path) for c in candidates[:3]]
                        if len(candidates) > 3:
                            sources.append("...")
                        ent.resolved_calls.append("{} [? {}]".format(call, ', '.join(sources)))


def resolve_hook_dependencies(files: List[SourceFile]):
    """Second pass: resolve hook dependencies after all files are parsed."""
    # Collect all custom hook names (hooks defined in our codebase)
    all_hooks: Set[str] = set()
    for f in files:
        for ent in f.entities:
            if ent.name.startswith('use') and len(ent.name) > 3 and ent.name[3].isupper():
                all_hooks.add(ent.name)
    
    # Now resolve dependencies
    for f in files:
        if f.extension not in ['.ts', '.tsx', '.js', '.jsx']:
            continue
        lines = f.content.splitlines()
        for ent in f.entities:
            if ent.name.startswith('use') and len(ent.name) > 3 and ent.name[3].isupper():
                body = "\n".join(lines[ent.line_start-1:ent.line_end])
                ent.hook_dependencies = extract_hook_dependencies(body, all_hooks)


def should_exclude_function(name: str) -> bool:
    for pattern in EXCLUDE_FUNCTION_PATTERNS:
        if re.match(pattern, name):
            return True
    return False


def get_function_group(filename: str, func_name: str) -> Optional[str]:
    for file_pattern, func_pattern, group_name in GROUP_PATTERNS:
        if re.search(file_pattern, filename) and re.match(func_pattern, func_name):
            return group_name
    return None


def is_trivial_by_name(name: str) -> bool:
    return name in TRIVIAL_METHOD_NAMES


# ==============================================================================
# TASK KEYWORD EXTRACTION
# ==============================================================================

def extract_task_keywords(task_content: str) -> Tuple[Set[str], Set[str]]:
    """Extract relevant keywords from the task description.
    Returns (high_value_keywords, low_value_keywords)."""
    if not task_content:
        return set(), set()
    
    # Normalize and tokenize
    content_lower = task_content.lower()
    words = re.findall(r'\b([a-zA-Z]{3,})\b', content_lower)
    
    high_value = set()
    low_value = set()
    
    for word in words:
        if word in TASK_STOPWORDS:
            continue
        if word in TASK_HIGH_VALUE_TERMS:
            high_value.add(word)
        elif word in TASK_LOW_VALUE_TERMS:
            low_value.add(word)
    
    # Also extract compound terms from the task
    # e.g., "double click" -> "doubleclick"
    if 'double' in content_lower and 'click' in content_lower:
        high_value.add('doubleclick')
        high_value.add('double')
    if 'single' in content_lower and 'click' in content_lower:
        high_value.add('singleclick')
    
    # Extract camelCase identifiers
    camel_matches = re.findall(r'\b([a-z]+[A-Z][a-zA-Z]*)\b', task_content)
    for match in camel_matches:
        # Split camelCase into parts
        parts = re.findall(r'[a-z]+|[A-Z][a-z]*', match)
        for part in parts:
            part_lower = part.lower()
            if part_lower in TASK_HIGH_VALUE_TERMS:
                high_value.add(part_lower)
            elif part_lower in TASK_LOW_VALUE_TERMS:
                low_value.add(part_lower)
    
    return high_value, low_value


def score_file_relevance(file_obj: SourceFile, high_kw: Set[str], low_kw: Set[str]) -> Tuple[int, Set[str]]:
    """Score a file's relevance to the task. Returns (score, matched_keywords)."""
    if not high_kw and not low_kw:
        return 0, set()
    
    score = 0
    matches = set()
    content_lower = file_obj.content.lower()
    filename_lower = os.path.basename(file_obj.rel_path).lower()
    
    # High-value keywords: 3 points each, 5 if in filename
    for kw in high_kw:
        if kw in filename_lower:
            score += 5
            matches.add(kw)
        elif kw in content_lower:
            score += 3
            matches.add(kw)
    
    # Low-value keywords: 1 point each, 2 if in filename
    for kw in low_kw:
        if kw in filename_lower:
            score += 2
            matches.add(kw)
        elif kw in content_lower:
            score += 1
            matches.add(kw)
    
    return score, matches


def generate_task_relevant_files(files: List[SourceFile], task_content: str) -> str:
    """Generate a section showing files most relevant to the task."""
    high_kw, low_kw = extract_task_keywords(task_content)
    all_keywords = high_kw | low_kw
    
    if not all_keywords:
        return ""
    
    # Score all files
    scored_files: List[Tuple[SourceFile, int, Set[str]]] = []
    
    for f in files:
        score, matches = score_file_relevance(f, high_kw, low_kw)
        f.task_relevance_score = score
        f.task_keyword_matches = matches
        if score >= TASK_RELEVANCE_THRESHOLD:
            scored_files.append((f, score, matches))
    
    if not scored_files:
        return ""
    
    # Sort by score descending
    scored_files.sort(key=lambda x: -x[1])
    
    lines = [
        "================================================================================",
        "                          TASK-RELEVANT FILES",
        "================================================================================",
        "> Keywords: HIGH[{}] LOW[{}]".format(
            ", ".join(sorted(high_kw)) if high_kw else "none",
            ", ".join(sorted(low_kw)) if low_kw else "none"
        ),
        "> Showing files with relevance score >= {}".format(TASK_RELEVANCE_THRESHOLD),
        ""
    ]
    
    for f, score, matches in scored_files[:20]:
        # Highlight high-value matches
        high_matches = matches & high_kw
        low_matches = matches & low_kw
        match_str = ""
        if high_matches:
            match_str = ", ".join(sorted(high_matches)[:4])
        if low_matches and len(match_str) < 30:
            if match_str:
                match_str += " +" + str(len(low_matches))
            else:
                match_str = ", ".join(sorted(low_matches)[:3])
        lines.append("  {:4} {:50} [{}]".format(
            "(" + str(score) + ")",
            f.rel_path[:50],
            match_str
        ))
    
    if len(scored_files) > 20:
        lines.append("  ... and {} more files".format(len(scored_files) - 20))
    
    lines.append("")
    return "\n".join(lines)


# ==============================================================================
# HOOK COMPOSITION ANALYSIS
# ==============================================================================

def generate_hook_composition(files: List[SourceFile]) -> str:
    """Generate a tree view of React hook composition."""
    # Find all hooks and their dependencies
    hooks: Dict[str, Tuple[CodeEntity, SourceFile]] = {}
    
    for f in files:
        if f.extension not in ['.ts', '.tsx', '.js', '.jsx']:
            continue
        for ent in f.entities:
            if ent.name.startswith('use') and len(ent.name) > 3 and ent.name[3].isupper():
                hooks[ent.name] = (ent, f)
    
    if not hooks:
        return ""
    
    # Find root hooks (hooks that are not dependencies of other hooks)
    all_deps = set()
    for name, (ent, _) in hooks.items():
        all_deps.update(ent.hook_dependencies)
    
    root_hooks = [name for name in hooks if name not in all_deps]
    
    # If no clear roots, show all hooks with their deps
    if not root_hooks:
        root_hooks = sorted(hooks.keys())
    
    # Build tree output
    lines = [
        "================================================================================",
        "                           HOOK COMPOSITION",
        "================================================================================",
        "> Shows which custom hooks depend on other custom hooks.",
        ""
    ]
    
    def render_hook_tree(hook_name: str, indent: int = 0, visited: Set[str] = None) -> List[str]:
        if visited is None:
            visited = set()
        
        if hook_name in visited:
            return ["{}  (circular: {})".format("  " * indent, hook_name)]
        
        if hook_name not in hooks:
            return []
        
        visited = visited | {hook_name}
        result = []
        
        ent, src = hooks[hook_name]
        prefix = "  " * indent
        
        # Format: hookName (filename) -> dep1, dep2, dep3
        deps = ent.hook_dependencies
        if deps:
            dep_str = " -> " + ", ".join(deps)
        else:
            dep_str = ""
        
        result.append("{}{}{}".format(prefix, hook_name, dep_str))
        
        # Render children (indented)
        for dep in deps:
            if dep in hooks and dep not in visited:
                child_lines = render_hook_tree(dep, indent + 1, visited)
                result.extend(child_lines)
        
        return result
    
    # Render each root hook tree
    rendered = set()
    for root in sorted(root_hooks):
        if root not in rendered:
            tree_lines = render_hook_tree(root, 0, set())
            lines.extend(tree_lines)
            # Mark all rendered hooks
            for line in tree_lines:
                hook_match = re.search(r'\b(use[A-Z][a-zA-Z0-9]*)', line)
                if hook_match:
                    rendered.add(hook_match.group(1))
    
    lines.append("")
    return "\n".join(lines)


# ==============================================================================
# LOG ANALYSIS
# ==============================================================================

def parse_log_file(log_path: str) -> Set[str]:
    """Extract function names from runtime log file."""
    if not os.path.exists(log_path):
        return set()
    
    content = read_file_safe(log_path)
    if not content:
        return set()
    
    called_functions: Set[str] = set()
    
    for pattern in LOG_FUNCTION_PATTERNS:
        regex = re.compile(pattern)
        for match in regex.finditer(content):
            func_name = match.group(1)
            if '.' in func_name:
                parts = func_name.split('.')
                called_functions.add(parts[-1])
                called_functions.add(func_name)
            else:
                called_functions.add(func_name)
    
    return called_functions


def count_log_occurrences(log_path: str) -> Dict[str, int]:
    """Count how many times each function appears in the log."""
    if not os.path.exists(log_path):
        return {}
    
    content = read_file_safe(log_path)
    if not content:
        return {}
    
    counts: Dict[str, int] = defaultdict(int)
    
    for pattern in LOG_FUNCTION_PATTERNS:
        regex = re.compile(pattern)
        for match in regex.finditer(content):
            func_name = match.group(1)
            if '.' in func_name:
                parts = func_name.split('.')
                counts[parts[-1]] += 1
            else:
                counts[func_name] += 1
    
    return dict(counts)


def generate_execution_trace(log_path: str, max_entries: int = 30) -> List[str]:
    """Generate a simplified execution trace from log."""
    if not os.path.exists(log_path):
        return []
    
    content = read_file_safe(log_path)
    lines = content.splitlines()
    
    trace: List[str] = []
    last_func = None
    
    for line in lines:
        # Extract ENTER commands (function entries)
        match = re.search(r'ENTER\s+([a-zA-Z_][a-zA-Z0-9_.]+)', line)
        if match:
            func = match.group(1)
            # Skip consecutive duplicates
            if func != last_func:
                trace.append(func)
                last_func = func
                if len(trace) >= max_entries:
                    break
    
    return trace


def format_execution_trace(trace: List[str]) -> str:
    """Format execution trace for output."""
    if not trace:
        return ""
    
    lines = [
        "================================================================================",
        "                              EXECUTION TRACE",
        "================================================================================",
        "> Derived from log.log - shows actual call sequence during test session.",
        ""
    ]
    
    # Format as a flow with arrows, wrapping at ~80 chars
    current_line = ""
    for i, func in enumerate(trace):
        if i == 0:
            current_line = func
        else:
            addition = " -> {}".format(func)
            if len(current_line) + len(addition) > 78:
                lines.append(current_line + " ->")
                current_line = "  " + func
            else:
                current_line += addition
    
    if current_line:
        lines.append(current_line)
    
    lines.append("")
    return "\n".join(lines)


# ==============================================================================
# SUMMARY GENERATION
# ==============================================================================

def generate_legend(log_functions: Set[str]) -> str:
    """Generate the legend section based on what features are active."""
    lines = ["LEGEND:"]
    
    if log_functions:
        lines.extend([
            "  [ACTIVE]   = File contains functions called during test session",
            "  [HOT xN]   = Function called N times (N > 5) during test",
            "  [xN]       = Function called N times during test",
            "  [CALLED]   = Function called once during test",
            "  [*]        = Called function is also in the hot path",
        ])
    
    lines.extend([
        "  [CMD]      = Tauri command (frontend can invoke this)",
        "  [async]    = Asynchronous function",
        "  [mouse]    = Has mouse event handlers (onClick, onMouseDown, etc.)",
        "  [keyboard] = Has keyboard event handlers (onKeyDown, onKeyUp, etc.)",
        "  [input]    = Has input event handlers (onChange, onSubmit, etc.)",
        "  [TASK:...] = File matches task keywords (higher score = more relevant)",
        "",
    ])
    
    return "\n".join(lines)


def generate_summary(files: List[SourceFile], log_functions: Set[str], 
                     log_counts: Dict[str, int]) -> str:
    """Generate a high-level summary for initial orientation."""
    if not SUMMARY_MODE:
        return ""
    
    lines = [
        "================================================================================",
        "                              PROJECT SUMMARY",
        "================================================================================",
        ""
    ]
    
    # 1. Architecture Overview
    lines.append("## ARCHITECTURE OVERVIEW")
    
    # Group files by top-level directory
    dir_stats: Dict[str, Dict] = defaultdict(lambda: {
        'files': 0, 'loc': 0, 'functions': 0, 'commands': 0, 'hot': 0
    })
    
    for f in files:
        parts = f.rel_path.split('/')
        top_dir = parts[0] if len(parts) > 1 else '(root)'
        dir_stats[top_dir]['files'] += 1
        dir_stats[top_dir]['loc'] += f.total_loc
        dir_stats[top_dir]['functions'] += f.function_count
        for e in f.entities:
            if e.is_tauri_command:
                dir_stats[top_dir]['commands'] += 1
            if e.name in log_functions:
                dir_stats[top_dir]['hot'] += 1
    
    for dir_name in sorted(dir_stats.keys()):
        stats = dir_stats[dir_name]
        hot_marker = " [ACTIVE]" if stats['hot'] > 0 else ""
        cmd_info = ", {} cmds".format(stats['commands']) if stats['commands'] > 0 else ""
        lines.append("  {:20} {:3} files, {:5} loc, {:3} fns{}{}".format(
            dir_name + ":", stats['files'], stats['loc'], stats['functions'], cmd_info, hot_marker))
    
    lines.append("")
    
    # 2. Entry Points (Tauri Commands)
    lines.append("## ENTRY POINTS (Tauri Commands)")
    commands = []
    for f in files:
        for e in f.entities:
            if e.is_tauri_command:
                hot_marker = ""
                if e.name in log_functions:
                    count = log_counts.get(e.name, 1)
                    hot_marker = " [HOT x{}]".format(count) if count > 5 else " [CALLED]"
                commands.append((e.name, f.rel_path, e.line_count, hot_marker))
    
    commands.sort(key=lambda x: (-1 if x[3] else 0, x[0]))  # Hot first, then alphabetical
    
    for name, path, loc, hot in commands[:15]:
        lines.append("  {:30} {:40} ({} loc){}".format(name, path, loc, hot))
    
    if len(commands) > 15:
        lines.append("  ... and {} more commands".format(len(commands) - 15))
    
    lines.append("")
    
    # 3. Reducer Actions (State Management)
    all_actions: Set[str] = set()
    for f in files:
        all_actions.update(f.reducer_actions)
    
    if all_actions:
        lines.append("## STATE ACTIONS (from reducers)")
        # Group by prefix
        action_groups: Dict[str, List[str]] = defaultdict(list)
        for action in sorted(all_actions):
            prefix = action.split('_')[0] if '_' in action else action
            action_groups[prefix].append(action)
        
        for prefix in sorted(action_groups.keys()):
            actions = action_groups[prefix]
            if len(actions) <= 3:
                lines.append("  {}: {}".format(prefix, ", ".join(actions)))
            else:
                lines.append("  {}: {} (+{} more)".format(
                    prefix, ", ".join(actions[:3]), len(actions) - 3))
        lines.append("")
    
    # 4. Largest Functions (complexity indicators)
    lines.append("## LARGEST FUNCTIONS (potential complexity)")
    all_fns: List[Tuple[CodeEntity, SourceFile]] = []
    for f in files:
        for e in f.entities:
            if e.kind in ["fn", "def", "function"] and not should_exclude_function(e.name):
                all_fns.append((e, f))
    
    all_fns.sort(key=lambda x: -x[0].line_count)
    
    for ent, src in all_fns[:SUMMARY_TOP_FUNCTIONS_COUNT]:
        hot_marker = ""
        if ent.name in log_functions:
            count = log_counts.get(ent.name, 1)
            hot_marker = " [HOT]" if count > 5 else " [CALLED]" if count > 0 else ""
        async_marker = " async" if ent.is_async else ""
        event_marker = ""
        if ent.event_types:
            event_marker = " [{}]".format(",".join(sorted(ent.event_types)))
        lines.append("  {:30} {:4} loc{:6}{}  {}".format(
            ent.name, ent.line_count, async_marker, event_marker, 
            os.path.basename(src.rel_path) + hot_marker))
    
    lines.append("")
    
    # 5. Hot Path Summary (if log available)
    if log_functions:
        lines.append("## HOT PATH (from test session)")
        
        # Find hot files
        hot_files: List[Tuple[str, int, int]] = []
        for f in files:
            hot_count = sum(1 for e in f.entities if e.name in log_functions)
            if hot_count > 0:
                total_calls = sum(log_counts.get(e.name, 0) for e in f.entities)
                hot_files.append((f.rel_path, hot_count, total_calls))
        
        hot_files.sort(key=lambda x: -x[2])  # Sort by total calls
        
        for path, fn_count, call_count in hot_files[:10]:
            lines.append("  {:50} {} fns, {} calls".format(path, fn_count, call_count))
        
        lines.append("")
    
    # 6. Cross-Module Dependencies
    lines.append("## KEY CROSS-MODULE DEPENDENCIES")
    
    # Find files that are called from many other files
    incoming_deps: Dict[str, Set[str]] = defaultdict(set)
    for f in files:
        for e in f.entities:
            for call in e.resolved_calls:
                if "::" in call and "self ::" not in call:
                    # Extract target file
                    parts = call.split(" :: ")
                    if len(parts) >= 1:
                        target_path = parts[0]
                        if target_path != f.rel_path:
                            incoming_deps[target_path].add(f.rel_path)
    
    # Sort by number of dependents
    dep_list = [(path, len(deps)) for path, deps in incoming_deps.items()]
    dep_list.sort(key=lambda x: -x[1])
    
    for path, dep_count in dep_list[:10]:
        if dep_count > 1:
            lines.append("  {:50} <- {} files depend on this".format(path, dep_count))
    
    lines.append("")
    
    return "\n".join(lines)


# ==============================================================================
# MAIN WORKFLOW
# ==============================================================================

def main():
    if not os.path.exists(PROJECT_ROOT):
        print("Error: Project root '{}' does not exist.".format(PROJECT_ROOT), file=sys.stderr)
        sys.exit(1)

    # 1. PREPARE TEMPLATES
    template_content = DEFAULT_TEMPLATE
    if os.path.exists(TEMPLATE_FILE):
        custom_template = read_file_safe(TEMPLATE_FILE)
        if custom_template.strip():
            template_content = custom_template

    intro_content = read_file_safe(INTRO_FILE) if os.path.exists(INTRO_FILE) else ""
    task_content = read_file_safe(TASK_FILE) if os.path.exists(TASK_FILE) else "No specific task provided."

    # 2. PARSE LOG FILE
    log_functions: Set[str] = set()
    log_counts: Dict[str, int] = {}
    execution_trace: List[str] = []
    log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), LOG_FILE)
    
    if HIGHLIGHT_FROM_LOG:
        if os.path.exists(log_path):
            log_functions = parse_log_file(log_path)
            log_counts = count_log_occurrences(log_path)
            execution_trace = generate_execution_trace(log_path)
            print("Loaded {} unique functions from log".format(len(log_functions)), file=sys.stderr)
        else:
            print("Log file not found: {}".format(log_path), file=sys.stderr)

    # 3. SCAN & PARSE
    all_files: List[SourceFile] = []
    print("Scanning {}...".format(PROJECT_ROOT), file=sys.stderr)

    for root, dirs, files in os.walk(PROJECT_ROOT):
        dirs[:] = [d for d in dirs if not should_ignore_dir(d)]

        for file in files:
            if should_ignore_file(file):
                continue

            if any(file.endswith(ext) for ext in SOURCE_EXTENSIONS):
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, PROJECT_ROOT).replace("\\", "/")

                s_file = SourceFile(full_path, rel_path)
                s_file.content = read_file_safe(full_path)
                all_files.append(s_file)

    print("Parsed {} files. Analyzing...".format(len(all_files)), file=sys.stderr)

    for f in all_files:
        if f.extension == ".rs":
            parse_rust(f)
        elif f.extension in [".ts", ".tsx", ".js", ".jsx"]:
            parse_typescript(f)
        elif f.extension == ".py":
            parse_python(f)

    resolve_graph(all_files)
    resolve_hook_dependencies(all_files)

    # 4. GENERATE LEGEND
    legend_content = generate_legend(log_functions)

    # 5. GENERATE TASK-RELEVANT FILES (also scores files for later use)
    task_files_content = generate_task_relevant_files(all_files, task_content)

    # 6. GENERATE SUMMARY
    summary_content = generate_summary(all_files, log_functions, log_counts)
    
    # 7. GENERATE HOOK COMPOSITION
    hooks_content = generate_hook_composition(all_files)
    
    # 8. GENERATE TRACE
    trace_content = format_execution_trace(execution_trace) if execution_trace else ""

    # ==============================================================================
    # 9. GENERATE MAP (LITE VERSION)
    # ==============================================================================
    map_lines = []
    files_by_dir = defaultdict(list)
    for f in all_files:
        if f.entities:
            d = os.path.dirname(f.rel_path)
            files_by_dir[d].append(f)

    hot_file_count = 0
    hot_function_count = 0

    # Helper to clean signatures for Lite mode
    def clean_signature(sig):
        # Remove common prefixes to save space
        return re.sub(r'^(?:pub\s+|export\s+|async\s+|fn\s+|function\s+|const\s+)+', '', sig).strip()

    for directory in sorted(files_by_dir.keys()):
        map_lines.append("\n## DIR: {}".format(directory))

        for f in sorted(files_by_dir[directory], key=lambda x: x.rel_path):
            filename = os.path.basename(f.rel_path)

            # --- FOLD CHECK ---
            should_fold = False
            for pattern in FOLD_PATTERNS:
                if re.match(pattern, filename):
                    should_fold = True
                    break

            if should_fold:
                visible_count = sum(1 for e in f.entities if not should_exclude_function(e.name))
                map_lines.append("### {} [Collapsed: {} items]".format(filename, visible_count))
                continue

            # --- GROUP COLLECTION & VISIBILITY FILTER ---
            grouped_funcs: Dict[str, List[CodeEntity]] = defaultdict(list)
            data_structures: List[str] = []
            logic_entities: List[CodeEntity] = []

            for ent in f.entities:
                if should_exclude_function(ent.name):
                    continue
                
                # VISIBILITY FILTER: Skip private entities (except Python which is permissive)
                if not ent.is_exported and f.extension != '.py':
                    continue

                # DATA STRUCTURE FILTER: Collapse data types
                # Note: We treat TS classes as Logic, but Rust Structs as Data
                is_data = ent.kind in ["struct", "enum", "trait", "interface", "type"]
                if is_data:
                    data_structures.append(ent.name)
                    continue

                # GROUPING
                group = get_function_group(filename, ent.name)
                if group:
                    grouped_funcs[group].append(ent)
                else:
                    logic_entities.append(ent)

            # Check if file is "empty" after filtering
            if not logic_entities and not grouped_funcs and not data_structures:
                continue

            # --- FILE HEADER ---
            # Check if any entity in this file is hot
            file_has_hot = any(e.name in log_functions for e in logic_entities)
            file_marker = " [ACTIVE]" if (HIGHLIGHT_FROM_LOG and file_has_hot) else ""
            if file_has_hot:
                hot_file_count += 1

            # Check for task relevance
            task_marker = ""
            if f.task_relevance_score >= TASK_RELEVANCE_THRESHOLD and f.task_keyword_matches:
                high_kw, _ = extract_task_keywords(task_content)
                high_matches = f.task_keyword_matches & high_kw
                if high_matches:
                    task_marker = " [TASK:{}]".format(",".join(sorted(high_matches)[:3]))

            map_lines.append("\n### {}{}{}".format(filename, file_marker, task_marker))

            # Show reducer actions if present
            if f.reducer_actions:
                actions_str = ", ".join(sorted(f.reducer_actions)[:8])
                if len(f.reducer_actions) > 8:
                    actions_str += ", ..."
                map_lines.append("   Actions: {}".format(actions_str))

            # --- PRINT DATA STRUCTURES (COLLAPSED) ---
            if data_structures:
                # Wrap lines if too long
                data_str = ", ".join(sorted(data_structures))
                if len(data_str) > 100:
                    data_str = data_str[:97] + "..."
                map_lines.append("   [Data]: {}".format(data_str))

            # --- PRINT GROUPED FUNCTIONS ---
            for group_name, funcs in sorted(grouped_funcs.items()):
                total_loc = sum(e.line_count for e in funcs)
                hot_in_group = sum(1 for e in funcs if e.name in log_functions)
                group_marker = ""
                if HIGHLIGHT_FROM_LOG and hot_in_group > 0:
                    group_marker = " [{}x CALLED]".format(hot_in_group)
                map_lines.append("   - [{} {}] ({} loc total){}".format(
                    len(funcs), group_name, total_loc, group_marker))

            # --- PRINT LOGIC ENTITIES (COMPACT FORMAT) ---
            entities = sorted(logic_entities, key=lambda x: x.line_start)
            for ent in entities:
                loc = ent.line_end - ent.line_start
                
                # Build markers
                markers = []
                if ent.is_tauri_command: markers.append("[CMD]")
                if ent.is_async: markers.append("[async]")
                
                # Event handler markers
                if ent.event_types:
                    for etype in sorted(ent.event_types):
                        markers.append("[{}]".format(etype))
                
                # Hot marker
                is_hot = ent.name in log_functions
                call_count = log_counts.get(ent.name, 0)
                if HIGHLIGHT_FROM_LOG and is_hot:
                    hot_function_count += 1
                    if call_count > 5: markers.append("[HOT x{}]".format(call_count))
                    elif call_count > 1: markers.append("[x{}]".format(call_count))
                    else: markers.append("[CALLED]")
                
                marker_str = " " + " ".join(markers) if markers else ""

                # --- COMPACT SIGNATURE GENERATION ---
                # Strategy: Use the cleaned signature. If clean signature matches name, just print name.
                # If signature adds value (args/types), print that instead of name.
                
                clean_sig = clean_signature(ent.signature).replace("\n", " ")
                # Truncate long signatures
                if len(clean_sig) > 85:
                    clean_sig = clean_sig[:82] + "..."

                # Decide on display format:
                # 1. Trivial: - name (LOC) [Markers]
                # 2. Detailed: - signature (LOC) [Markers]
                
                display_str = clean_sig if clean_sig else ent.name

                map_lines.append("   - {} ({} loc){}".format(display_str, loc, marker_str))

    # Add log analysis summary
    if HIGHLIGHT_FROM_LOG and log_functions:
        map_lines.append("\n## LOG ANALYSIS SUMMARY")
        map_lines.append("- Functions detected in log: {}".format(len(log_functions)))
        map_lines.append("- Hot files: {}".format(hot_file_count))
        map_lines.append("- Hot functions shown: {}".format(hot_function_count))

    map_content = "\n".join(map_lines)

    # 10. GENERATE CONFIGS
    config_lines = []
    found_configs = []
    for root, dirs, files in os.walk(PROJECT_ROOT):
        dirs[:] = [d for d in dirs if not should_ignore_dir(d)]
        for f in files:
            if f in CRITICAL_CONFIGS:
                rel = os.path.relpath(os.path.join(root, f), PROJECT_ROOT)
                found_configs.append(rel)

    if found_configs:
        for c in sorted(found_configs):
            config_lines.append("- {}".format(c))
    else:
        config_lines.append("(None found)")

    configs_content = "\n".join(config_lines)

    # 11. ASSEMBLE OUTPUT
    final_output = template_content.replace("{<intro>}", intro_content)
    final_output = final_output.replace("{<legend>}", legend_content)
    final_output = final_output.replace("{<task>}", task_content)
    final_output = final_output.replace("{<task_files>}", task_files_content)
    final_output = final_output.replace("{<summary>}", summary_content)
    final_output = final_output.replace("{<hooks>}", hooks_content)
    final_output = final_output.replace("{<trace>}", trace_content)
    final_output = final_output.replace("{<content>}", map_content)
    final_output = final_output.replace("{<configs>}", configs_content)

    # 12. COPY TO CLIPBOARD
    try:
        pyperclip.copy(final_output)
        print("Success! Output copied to clipboard.", file=sys.stderr)
    except Exception as e:
        print("Error copying to clipboard: {}".format(str(e)), file=sys.stderr)
        print("Falling back to stdout output...", file=sys.stderr)
        print(final_output)


if __name__ == "__main__":
    main()