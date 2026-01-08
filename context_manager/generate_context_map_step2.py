import os
import re
import sys
import json
import argparse
import pyperclip
from collections import defaultdict
from dataclasses import dataclass, field
from typing import List, Dict, Set, Optional, Tuple, Any
from pathlib import Path
from enum import Enum, auto

# ==============================================================================
# CONFIGURATION
# ==============================================================================
DEFAULT_PROJECT_ROOT = r"C:\Dropbox\Projekt\Calcula"

# Directories to always exclude
EXCLUDE_DIRECTORIES = {
    "node_modules", ".git", "__pycache__", "venv", ".venv", "env", "target",
    ".idea", ".vscode", "dist", "build", "__tests__", ".next", "coverage",
    "general_stuff", "context_manager"
}

# File patterns to exclude
EXCLUDE_PATTERNS = [
    r".*\.test\.(ts|tsx|js|jsx)$",
    r".*\.spec\.(ts|tsx|js|jsx)$",
    r".*\.stories\.(ts|tsx|js|jsx)$",
    r".*log.*",
]

# Source extensions to process
SOURCE_EXTENSIONS = (".ts", ".tsx", ".js", ".jsx", ".rs")

# Files to ignore
IGNORE_FILES = {
    ".DS_Store", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "Cargo.lock", "scopes.json"
}

# Config file patterns to find
CONFIG_FILE_PATTERNS = [
    "package.json",
    "Cargo.toml",
    "tsconfig.json",
    "tsconfig.*.json",
    "vite.config.*",
    "tailwind.config.*",
    "postcss.config.*",
]

# Standard React hooks to exclude from display (keep for analysis, hide from output)
STANDARD_REACT_HOOKS = {
    "useState", "useEffect", "useCallback", "useMemo", "useRef",
    "useContext", "useReducer", "useLayoutEffect", "useImperativeHandle",
    "useDebugValue", "useDeferredValue", "useTransition", "useId",
    "useSyncExternalStore", "useInsertionEffect"
}

# Output configuration
OUTPUT_FILE = "enhanced_map.txt"
JSON_OUTPUT_FILE = "enhanced_map.json"
OUTPUT_JSON = False

# Template configuration
DEFAULT_TEMPLATE_FILE = "template_dependency_step2.txt"
DEFAULT_INTRO_FILE = "intro.txt"
DEFAULT_TASK_FILE = "task.txt"


# ==============================================================================
# DATA STRUCTURES
# ==============================================================================

class StateMarker(Enum):
    READ = auto()
    WRITE = auto()
    DISPATCH = auto()
    CONTEXT = auto()


class EffectMarker(Enum):
    RENDER_TRIGGER = auto()
    BACKEND_SYNC = auto()
    SIDE_EFFECT = auto()
    EVENT_LISTENER = auto()


class EventType(Enum):
    CLICK = "click"
    MOUSEDOWN = "mousedown"
    MOUSEUP = "mouseup"
    MOUSEMOVE = "mousemove"
    DOUBLECLICK = "doubleclick"
    KEYDOWN = "keydown"
    KEYUP = "keyup"
    KEYPRESS = "keypress"
    SCROLL = "scroll"
    WHEEL = "wheel"
    FOCUS = "focus"
    BLUR = "blur"
    CHANGE = "change"
    INPUT = "input"
    SUBMIT = "submit"
    DRAG = "drag"
    DRAGSTART = "dragstart"
    DRAGEND = "dragend"
    DROP = "drop"


# Event type groupings for consolidated display
EVENT_TYPE_GROUPS = {
    "mouse": {EventType.CLICK, EventType.MOUSEDOWN, EventType.MOUSEUP, 
              EventType.MOUSEMOVE, EventType.DOUBLECLICK},
    "keyboard": {EventType.KEYDOWN, EventType.KEYUP, EventType.KEYPRESS},
    "focus": {EventType.FOCUS, EventType.BLUR},
    "form": {EventType.CHANGE, EventType.INPUT, EventType.SUBMIT},
    "drag": {EventType.DRAG, EventType.DRAGSTART, EventType.DRAGEND, EventType.DROP},
    "scroll": {EventType.SCROLL, EventType.WHEEL},
}


@dataclass
class Parameter:
    name: str
    type_annotation: str = ""
    default_value: str = ""
    
    def __str__(self):
        result = self.name
        if self.type_annotation:
            result = result + ": " + self.type_annotation
        if self.default_value:
            result = result + " = " + self.default_value
        return result


@dataclass
class ReturnType:
    raw_type: str = ""
    is_promise: bool = False
    is_void: bool = False
    properties: Dict[str, str] = field(default_factory=dict)
    
    def __str__(self):
        if self.is_void:
            return "void"
        if self.properties:
            props = ", ".join(k + ": " + v for k, v in self.properties.items())
            return "{ " + props + " }"
        return self.raw_type


@dataclass
class CodeEntity:
    name: str
    kind: str
    signature: str
    line_start: int
    line_end: int
    file_path: str
    rel_path: str
    body: str = ""
    
    # Enhanced fields
    parameters: List[Parameter] = field(default_factory=list)
    return_type: ReturnType = field(default_factory=ReturnType)
    
    # Markers
    state_markers: Set[StateMarker] = field(default_factory=set)
    effect_markers: Set[EffectMarker] = field(default_factory=set)
    event_types: Set[EventType] = field(default_factory=set)
    
    # Relationships
    raw_calls: Set[str] = field(default_factory=set)
    resolved_calls: List[str] = field(default_factory=list)
    hooks_used: List[str] = field(default_factory=list)
    hooks_provided: Dict[str, str] = field(default_factory=dict)
    
    # Special flags
    is_async: bool = False
    is_exported: bool = False
    is_tauri_command: bool = False
    is_hook: bool = False
    is_event_handler: bool = False
    is_integration_layer: bool = False
    
    # Data flow
    consumes_from: Dict[str, List[str]] = field(default_factory=dict)
    provides_to: Dict[str, List[str]] = field(default_factory=dict)
    triggers: List[str] = field(default_factory=list)
    
    @property
    def line_count(self):
        return self.line_end - self.line_start

    def get_markers_str(self) -> str:
        """Generate consolidated marker string."""
        markers = []
        
        if self.is_hook:
            markers.append("[HOOK]")
        if self.is_tauri_command:
            markers.append("[CMD]")
        if self.is_async:
            markers.append("[async]")
        if self.is_integration_layer:
            markers.append("[INTEGRATION]")
            
        for sm in sorted(self.state_markers, key=lambda x: x.name):
            markers.append("[STATE:" + sm.name.lower() + "]")
            
        for em in sorted(self.effect_markers, key=lambda x: x.name):
            if em == EffectMarker.RENDER_TRIGGER:
                markers.append("[RENDER:trigger]")
            elif em == EffectMarker.BACKEND_SYNC:
                markers.append("[BACKEND:sync]")
            elif em == EffectMarker.SIDE_EFFECT:
                markers.append("[EFFECT]")
            elif em == EffectMarker.EVENT_LISTENER:
                markers.append("[LISTENER]")
        
        # Consolidate event types by group
        if self.event_types:
            event_groups_found = set()
            ungrouped_events = set()
            
            for et in self.event_types:
                found_group = False
                for group_name, group_events in EVENT_TYPE_GROUPS.items():
                    if et in group_events:
                        event_groups_found.add(group_name)
                        found_group = True
                        break
                if not found_group:
                    ungrouped_events.add(et)
            
            # Show consolidated groups
            for group in sorted(event_groups_found):
                markers.append("[" + group.upper() + "]")
                
            # Show any ungrouped events individually
            for et in sorted(ungrouped_events, key=lambda x: x.value):
                markers.append("[EVENT:" + et.value + "]")
            
        return " ".join(markers)
    
    def get_custom_hooks_used(self) -> List[str]:
        """Get only custom hooks (not standard React hooks)."""
        return [h for h in self.hooks_used if h not in STANDARD_REACT_HOOKS]


@dataclass
class SourceFile:
    path: str
    rel_path: str
    extension: str
    content: str = ""
    entities: List[CodeEntity] = field(default_factory=list)
    imports: List[Tuple[str, str]] = field(default_factory=list)
    exports: List[str] = field(default_factory=list)
    
    is_integration_layer: bool = False
    integration_description: str = ""
    
    @property
    def total_loc(self):
        return sum(e.line_count for e in self.entities)
    
    @property
    def function_count(self):
        return sum(1 for e in self.entities if e.kind in ["fn", "def", "function", "hook"])


@dataclass
class HookComposition:
    name: str
    file_path: str
    uses_hooks: List[str] = field(default_factory=list)
    returns: Dict[str, str] = field(default_factory=dict)
    purpose: str = ""
    params_summary: str = ""


@dataclass
class IntegrationPoint:
    name: str
    file_path: str
    source_system: str
    target_system: str
    flow_description: List[str] = field(default_factory=list)


@dataclass 
class CriticalPath:
    name: str
    description: str
    steps: List[Dict[str, Any]] = field(default_factory=list)


# ==============================================================================
# UTILITY FUNCTIONS
# ==============================================================================

def read_file_safe(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read()
    except Exception:
        return ""


def should_ignore_dir(dirname: str) -> bool:
    return dirname in EXCLUDE_DIRECTORIES or dirname.startswith(".")


def should_ignore_file(filename: str) -> bool:
    if filename in IGNORE_FILES:
        return True
    for pattern in EXCLUDE_PATTERNS:
        if re.match(pattern, filename, re.IGNORECASE):
            return True
    return False


def is_path_in_include_list(rel_path: str, include_paths: List[str]) -> bool:
    """Check if a path is within one of the include paths."""
    if not include_paths:
        return True
    
    rel_path_normalized = rel_path.replace("\\", "/").lower()
    
    for inc_path in include_paths:
        inc_normalized = inc_path.replace("\\", "/").lower().strip("/")
        
        if rel_path_normalized.startswith(inc_normalized + "/"):
            return True
        if rel_path_normalized == inc_normalized:
            return True
        if rel_path_normalized.startswith(inc_normalized):
            return True
            
    return False


def find_closing_brace(lines: List[str], start_index: int, 
                       open_char: str = "{", close_char: str = "}") -> int:
    """Find the line index where the brace closes."""
    balance = 0
    started = False
    in_string = False
    string_char = None
    
    for i in range(start_index, len(lines)):
        line = lines[i]
        j = 0
        while j < len(line):
            char = line[j]
            
            if j > 0 and line[j-1] == "\\":
                j += 1
                continue
                
            if char in "\"'`" and not in_string:
                in_string = True
                string_char = char
            elif char == string_char and in_string:
                in_string = False
                string_char = None
            elif not in_string:
                if j < len(line) - 1 and line[j:j+2] == "//":
                    break
                    
                if char == open_char:
                    balance += 1
                    started = True
                elif char == close_char:
                    balance -= 1
                    
            j += 1
            
        if started and balance <= 0:
            return i
            
    return len(lines) - 1


def clean_type_annotation(type_str: str) -> str:
    """Clean up a type annotation for display."""
    type_str = re.sub(r"\s+", " ", type_str.strip())
    if len(type_str) > 100:
        type_str = type_str[:97] + "..."
    return type_str


def format_hooks_used(hooks_used: List[str], show_standard_count: bool = True) -> str:
    """Format hooks list, filtering standard React hooks."""
    if not hooks_used:
        return ""
    
    custom_hooks = []
    standard_count = 0
    seen_custom = set()
    
    for hook in hooks_used:
        if hook in STANDARD_REACT_HOOKS:
            standard_count += 1
        else:
            if hook not in seen_custom:
                custom_hooks.append(hook)
                seen_custom.add(hook)
    
    parts = []
    
    if custom_hooks:
        parts.extend(custom_hooks[:6])
        if len(custom_hooks) > 6:
            remaining = len(custom_hooks) - 6
            parts.append("...(+" + str(remaining) + ")")
    
    if show_standard_count and standard_count > 0:
        parts.append("[+" + str(standard_count) + " React]")
    
    return ", ".join(parts)


def find_config_files(project_root: str) -> List[str]:
    """Find configuration files in the project."""
    config_files = []
    
    for root, dirs, files in os.walk(project_root):
        dirs[:] = [d for d in dirs if not should_ignore_dir(d)]
        
        for filename in files:
            # Check against config patterns
            for pattern in CONFIG_FILE_PATTERNS:
                # Convert glob-like pattern to regex
                pattern_regex = pattern.replace(".", r"\.").replace("*", ".*")
                if re.match(pattern_regex + "$", filename):
                    full_path = os.path.join(root, filename)
                    rel_path = os.path.relpath(full_path, project_root).replace("\\", "/")
                    config_files.append(rel_path)
                    break
    
    return sorted(config_files)


def format_config_files_section(config_files: List[str]) -> str:
    """Format the configuration files section."""
    if not config_files:
        return "(No configuration files found)"
    
    lines = []
    for config_file in config_files:
        lines.append("- " + config_file)
    
    return "\n".join(lines)


# ==============================================================================
# TYPESCRIPT/TSX PARSING
# ==============================================================================

class TypeScriptParser:
    """Enhanced parser for TypeScript/TSX files."""
    
    FUNC_PATTERNS = [
        re.compile(
            r"(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*"
            r"(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?::\s*([^{]+?))?\s*\{",
            re.MULTILINE | re.DOTALL
        ),
        re.compile(
            r"(?:export\s+)?const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*"
            r"(?::\s*[^=]+)?\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*([^=>{]+?))?\s*=>",
            re.MULTILINE | re.DOTALL
        ),
        re.compile(
            r"(?:export\s+)?const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*"
            r"async\s+\(([^)]*)\)\s*(?::\s*([^=>{]+?))?\s*=>",
            re.MULTILINE | re.DOTALL
        ),
    ]
    
    HOOK_PATTERN = re.compile(r"^use[A-Z][a-zA-Z0-9]*$")
    
    EVENT_HANDLER_NAME_PATTERN = re.compile(
        r"^(handle|on)[A-Z][a-zA-Z]*(Click|MouseDown|MouseUp|MouseMove|"
        r"DoubleClick|KeyDown|KeyUp|KeyPress|Scroll|Focus|Blur|Change|"
        r"Input|Submit|Drag|Drop|Wheel|Touch).*$",
        re.IGNORECASE
    )
    
    EVENT_PARAM_PATTERNS = {
        EventType.CLICK: re.compile(r"React\.MouseEvent|MouseEvent"),
        EventType.MOUSEDOWN: re.compile(r"React\.MouseEvent|MouseEvent"),
        EventType.MOUSEUP: re.compile(r"React\.MouseEvent|MouseEvent"),
        EventType.MOUSEMOVE: re.compile(r"React\.MouseEvent|MouseEvent"),
        EventType.DOUBLECLICK: re.compile(r"React\.MouseEvent|MouseEvent"),
        EventType.KEYDOWN: re.compile(r"React\.KeyboardEvent|KeyboardEvent"),
        EventType.KEYUP: re.compile(r"React\.KeyboardEvent|KeyboardEvent"),
        EventType.KEYPRESS: re.compile(r"React\.KeyboardEvent|KeyboardEvent"),
        EventType.SCROLL: re.compile(r"React\.UIEvent|UIEvent|WheelEvent"),
        EventType.WHEEL: re.compile(r"WheelEvent"),
        EventType.FOCUS: re.compile(r"React\.FocusEvent|FocusEvent"),
        EventType.BLUR: re.compile(r"React\.FocusEvent|FocusEvent"),
        EventType.CHANGE: re.compile(r"React\.ChangeEvent|ChangeEvent"),
        EventType.INPUT: re.compile(r"React\.FormEvent|FormEvent|InputEvent"),
        EventType.SUBMIT: re.compile(r"React\.FormEvent|FormEvent"),
        EventType.DRAG: re.compile(r"React\.DragEvent|DragEvent"),
        EventType.DROP: re.compile(r"React\.DragEvent|DragEvent"),
    }
    
    EVENT_NAME_MAPPING = {
        "click": EventType.CLICK,
        "mousedown": EventType.MOUSEDOWN,
        "mouseup": EventType.MOUSEUP,
        "mousemove": EventType.MOUSEMOVE,
        "doubleclick": EventType.DOUBLECLICK,
        "dblclick": EventType.DOUBLECLICK,
        "keydown": EventType.KEYDOWN,
        "keyup": EventType.KEYUP,
        "keypress": EventType.KEYPRESS,
        "scroll": EventType.SCROLL,
        "wheel": EventType.WHEEL,
        "focus": EventType.FOCUS,
        "blur": EventType.BLUR,
        "change": EventType.CHANGE,
        "input": EventType.INPUT,
        "submit": EventType.SUBMIT,
        "drag": EventType.DRAG,
        "drop": EventType.DROP,
    }
    
    def __init__(self, file_obj: SourceFile):
        self.file = file_obj
        self.lines = file_obj.content.splitlines()
        self.all_hook_names: Set[str] = set()
        
    def parse(self) -> None:
        """Main parsing entry point."""
        self._parse_imports()
        self._parse_exports()
        self._parse_entities()
        self._analyze_entities()
        
    def _parse_imports(self) -> None:
        """Extract import statements."""
        import_pattern = re.compile(
            r"import\s+(?:type\s+)?(?:\{([^}]+)\}|([a-zA-Z_$][a-zA-Z0-9_$]*))\s+"
            r"from\s+['\"]([^'\"]+)['\"]",
            re.MULTILINE
        )
        
        for match in import_pattern.finditer(self.file.content):
            named_imports = match.group(1)
            default_import = match.group(2)
            source = match.group(3)
            
            if named_imports:
                for name in named_imports.split(","):
                    name = name.strip().split(" as ")[0].strip()
                    if name:
                        self.file.imports.append((name, source))
            if default_import:
                self.file.imports.append((default_import, source))
                
    def _parse_exports(self) -> None:
        """Extract export statements."""
        export_pattern = re.compile(
            r"export\s+(?:const|function|class|interface|type|enum)\s+"
            r"([a-zA-Z_$][a-zA-Z0-9_$]*)"
        )
        for match in export_pattern.finditer(self.file.content):
            self.file.exports.append(match.group(1))
            
        reexport_pattern = re.compile(r"export\s+\{([^}]+)\}")
        for match in reexport_pattern.finditer(self.file.content):
            for name in match.group(1).split(","):
                name = name.strip().split(" as ")[-1].strip()
                if name:
                    self.file.exports.append(name)
                    
    def _parse_entities(self) -> None:
        """Parse functions, classes, hooks, etc."""
        for i, line in enumerate(self.lines):
            stripped = line.strip()
            
            if stripped.startswith("//") or stripped.startswith("/*"):
                continue
                
            for pattern in self.FUNC_PATTERNS:
                match = pattern.search(line)
                if match:
                    self._create_function_entity(match, i)
                    break
                    
            class_match = re.search(
                r"(?:export\s+)?class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)", 
                line
            )
            if class_match:
                self._create_class_entity(class_match, i)
                
    def _create_function_entity(self, match: re.Match, line_idx: int) -> None:
        """Create a CodeEntity for a function."""
        name = match.group(1)
        params_str = match.group(2) if len(match.groups()) > 1 else ""
        return_type_str = match.group(3) if len(match.groups()) > 2 else ""
        
        end_line = find_closing_brace(self.lines, line_idx)
        body = "\n".join(self.lines[line_idx:end_line + 1])
        
        is_hook = bool(self.HOOK_PATTERN.match(name))
        if is_hook:
            self.all_hook_names.add(name)
            
        is_event_handler = bool(self.EVENT_HANDLER_NAME_PATTERN.match(name))
        
        full_line = self.lines[line_idx]
        is_exported = "export " in full_line
        is_async = "async " in full_line or "async(" in full_line
        
        sig = self._build_signature(name, params_str, return_type_str, is_async)
        
        entity = CodeEntity(
            name=name,
            kind="hook" if is_hook else "fn",
            signature=sig,
            line_start=line_idx + 1,
            line_end=end_line + 1,
            file_path=self.file.path,
            rel_path=self.file.rel_path,
            body=body,
            is_async=is_async,
            is_exported=is_exported,
            is_hook=is_hook,
            is_event_handler=is_event_handler,
        )
        
        entity.parameters = self._parse_parameters(params_str)
        entity.return_type = self._parse_return_type(return_type_str, body, is_hook)
        
        self.file.entities.append(entity)
        
    def _build_signature(self, name: str, params: str, return_type: str, 
                         is_async: bool) -> str:
        """Build a clean signature string."""
        sig_parts = []
        if is_async:
            sig_parts.append("async")
        sig_parts.append("function " + name + "(")
        
        params = re.sub(r"\s+", " ", params.strip())
        if len(params) > 60:
            params = params[:57] + "..."
        sig_parts.append(params)
        sig_parts.append(")")
        
        if return_type:
            return_type = clean_type_annotation(return_type)
            sig_parts.append(": " + return_type)
            
        return "".join(sig_parts)
        
    def _parse_parameters(self, params_str: str) -> List[Parameter]:
        """Parse function parameters."""
        params = []
        if not params_str.strip():
            return params
            
        if params_str.strip().startswith("{"):
            content = params_str.strip()[1:].split("}")[0]
            truncated = content.strip()[:50]
            if len(content) > 50:
                truncated = truncated + " ..."
            param = Parameter(
                name="{ " + truncated + " }",
                type_annotation=""
            )
            params.append(param)
            return params
            
        depth = 0
        current = ""
        for char in params_str:
            if char in "({<[":
                depth += 1
            elif char in ")}]>":
                depth -= 1
            elif char == "," and depth == 0:
                if current.strip():
                    params.append(self._parse_single_param(current.strip()))
                current = ""
                continue
            current += char
            
        if current.strip():
            params.append(self._parse_single_param(current.strip()))
            
        return params
        
    def _parse_single_param(self, param_str: str) -> Parameter:
        """Parse a single parameter."""
        parts = param_str.split("=", 1)
        default = parts[1].strip() if len(parts) > 1 else ""
        
        main_part = parts[0].strip()
        
        if ":" in main_part:
            # Find the first colon that's not inside angle brackets
            depth = 0
            colon_pos = -1
            for i, char in enumerate(main_part):
                if char in "<([{":
                    depth += 1
                elif char in ">)]}":
                    depth -= 1
                elif char == ":" and depth == 0:
                    colon_pos = i
                    break
            
            if colon_pos > 0:
                name = main_part[:colon_pos].strip()
                type_ann = main_part[colon_pos + 1:].strip()
                return Parameter(
                    name=name,
                    type_annotation=clean_type_annotation(type_ann),
                    default_value=default
                )
        
        return Parameter(name=main_part, default_value=default)
            
    def _parse_return_type(self, type_str: str, body: str, 
                           is_hook: bool) -> ReturnType:
        """Parse and analyze return type."""
        ret = ReturnType()
        
        if type_str:
            type_str = type_str.strip()
            ret.raw_type = clean_type_annotation(type_str)
            ret.is_promise = "Promise<" in type_str
            ret.is_void = type_str == "void" or type_str == ": void"
            
        if is_hook:
            ret.properties = self._extract_hook_return_properties(body)
            
        if not ret.raw_type and not ret.properties:
            ret = self._infer_return_type(body)
            
        return ret
        
    def _extract_hook_return_properties(self, body: str) -> Dict[str, str]:
        """Extract properties from hook return statement."""
        props = {}
        
        # Look for return { ... } pattern - try multiline first
        return_match = re.search(
            r"return\s*\{\s*\n([^}]+)\}\s*;?\s*\}?\s*$",
            body,
            re.MULTILINE | re.DOTALL
        )
        
        if not return_match:
            # Try simpler single-line return
            return_match = re.search(
                r"return\s*\{\s*([^}]{1,500})\s*\}\s*;",
                body
            )
        
        if return_match:
            content = return_match.group(1)
            
            lines = content.split("\n")
            for line in lines:
                line = line.strip().rstrip(",")
                if not line or line.startswith("//"):
                    continue
                
                # Handle spread: ...something
                prop_match = re.match(r"^\.\.\.([a-zA-Z_$][a-zA-Z0-9_$]*)", line)
                if prop_match:
                    props[prop_match.group(1)] = "spread"
                    continue
                
                # Handle: propName or propName: value
                prop_match = re.match(r"^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:,|:|$)", line)
                if prop_match:
                    prop_name = prop_match.group(1)
                    
                    # Skip if it looks like a value
                    if prop_name in ("true", "false", "null", "undefined"):
                        continue
                    if prop_name[0].isdigit():
                        continue
                    
                    prop_type = self._infer_property_type(prop_name, body)
                    props[prop_name] = prop_type
                    
        return props
        
    def _infer_property_type(self, prop_name: str, body: str) -> str:
        """Try to infer the type of a property from the body."""
        escaped_name = re.escape(prop_name)
        pattern_str = (
            r"const\s+" + escaped_name + r"\s*:\s*([^=]+?)\s*=|"
            r"const\s+" + escaped_name + r"\s*=\s*(?:async\s*)?\([^)]*\)\s*:\s*([^=>{]+?)\s*=>"
        )
        type_pattern = re.compile(pattern_str)
        
        match = type_pattern.search(body)
        if match:
            type_str = match.group(1) or match.group(2)
            if type_str:
                return clean_type_annotation(type_str)
                
        if prop_name.startswith("handle") or prop_name.startswith("on"):
            return "(...) => void"
        if prop_name.startswith("is") or prop_name.startswith("has"):
            return "boolean"
        if prop_name.endswith("Ref"):
            return "RefObject"
        if prop_name.endswith("State") or prop_name == "state":
            return "State"
        if prop_name.startswith("set"):
            return "setter"
            
        return "unknown"
        
    def _infer_return_type(self, body: str) -> ReturnType:
        """Infer return type from return statements."""
        ret = ReturnType()
        
        if "return " not in body:
            ret.is_void = True
            return ret
            
        if re.search(r"return\s*\{", body):
            ret.raw_type = "object"
        elif re.search(r"return\s+true|return\s+false", body):
            ret.raw_type = "boolean"
        elif re.search(r"return\s+\d+", body):
            ret.raw_type = "number"
        elif re.search(r"return\s+['\"`]", body):
            ret.raw_type = "string"
        elif re.search(r"return\s+null", body):
            ret.raw_type = "null"
            
        return ret
        
    def _create_class_entity(self, match: re.Match, line_idx: int) -> None:
        """Create a CodeEntity for a class."""
        name = match.group(1)
        end_line = find_closing_brace(self.lines, line_idx)
        body = "\n".join(self.lines[line_idx:end_line + 1])
        
        is_exported = "export " in self.lines[line_idx]
        
        entity = CodeEntity(
            name=name,
            kind="class",
            signature="class " + name,
            line_start=line_idx + 1,
            line_end=end_line + 1,
            file_path=self.file.path,
            rel_path=self.file.rel_path,
            body=body,
            is_exported=is_exported,
        )
        
        self.file.entities.append(entity)
        
    def _analyze_entities(self) -> None:
        """Analyze entities for markers and relationships."""
        for entity in self.file.entities:
            self._analyze_state_markers(entity)
            self._analyze_effect_markers(entity)
            self._analyze_event_types(entity)
            self._analyze_calls(entity)
            self._analyze_hooks_used(entity)
            self._analyze_data_flow(entity)
            
    def _analyze_state_markers(self, entity: CodeEntity) -> None:
        """Detect state-related patterns."""
        body = entity.body
        
        if re.search(r"useGridContext|useContext|useSelector|\.getState\(\)", body):
            entity.state_markers.add(StateMarker.READ)
            
        if re.search(r"setState|useState|setSelection|setEditing", body):
            entity.state_markers.add(StateMarker.WRITE)
            
        if re.search(r"dispatch\s*\(|useDispatch", body):
            entity.state_markers.add(StateMarker.DISPATCH)
            
        if re.search(r"useGridContext|useContext", body):
            entity.state_markers.add(StateMarker.CONTEXT)
            
    def _analyze_effect_markers(self, entity: CodeEntity) -> None:
        """Detect effect-related patterns."""
        body = entity.body
        
        if re.search(r"setState|forceUpdate|dispatch\s*\(", body):
            entity.effect_markers.add(EffectMarker.RENDER_TRIGGER)
            
        if re.search(r"invoke\s*\(|invoke<|tracedInvoke|fetch\s*\(|axios\.", body):
            entity.effect_markers.add(EffectMarker.BACKEND_SYNC)
            
        if re.search(r"useEffect|useLayoutEffect|addEventListener|setTimeout|setInterval", body):
            entity.effect_markers.add(EffectMarker.SIDE_EFFECT)
            
        if re.search(r"addEventListener|removeEventListener", body):
            entity.effect_markers.add(EffectMarker.EVENT_LISTENER)
            
    def _analyze_event_types(self, entity: CodeEntity) -> None:
        """Detect event handler types."""
        body = entity.body
        params_str = " ".join(str(p) for p in entity.parameters)
        
        for event_type, pattern in self.EVENT_PARAM_PATTERNS.items():
            if pattern.search(params_str) or pattern.search(body):
                entity.event_types.add(event_type)
                
        name_lower = entity.name.lower()
        for keyword, event_type in self.EVENT_NAME_MAPPING.items():
            if keyword in name_lower:
                entity.event_types.add(event_type)
                
        listener_matches = re.findall(r"addEventListener\s*\(\s*['\"](\w+)['\"]", body)
        for event_name in listener_matches:
            if event_name.lower() in self.EVENT_NAME_MAPPING:
                entity.event_types.add(self.EVENT_NAME_MAPPING[event_name.lower()])
                
        if entity.event_types:
            entity.is_event_handler = True
            
    def _analyze_calls(self, entity: CodeEntity) -> None:
        """Extract function calls from body."""
        body = entity.body
        
        call_pattern = re.compile(r"([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(")
        
        excluded = {
            "if", "for", "while", "switch", "catch", "super", "return",
            "await", "typeof", "instanceof", "new", "throw", "delete",
            "function", "const", "let", "var", "class", "import", "export"
        }
        
        for match in call_pattern.finditer(body):
            call_name = match.group(1)
            if call_name not in excluded and call_name != entity.name:
                entity.raw_calls.add(call_name)
                
    def _analyze_hooks_used(self, entity: CodeEntity) -> None:
        """Extract hooks used by this entity."""
        body = entity.body
        
        hook_pattern = re.compile(r"(?:const|let)\s+\{?[^}]*\}?\s*=\s*(use[A-Z][a-zA-Z0-9]*)\s*\(")
        
        for match in hook_pattern.finditer(body):
            hook_name = match.group(1)
            if hook_name != entity.name:
                entity.hooks_used.append(hook_name)
                
        direct_pattern = re.compile(r"(?<![a-zA-Z_$])(use[A-Z][a-zA-Z0-9]*)\s*\(")
        for match in direct_pattern.finditer(body):
            hook_name = match.group(1)
            if hook_name != entity.name and hook_name not in entity.hooks_used:
                entity.hooks_used.append(hook_name)
                    
    def _analyze_data_flow(self, entity: CodeEntity) -> None:
        """Analyze data flow patterns."""
        body = entity.body
        
        dispatch_pattern = re.compile(r"dispatch\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(")
        for match in dispatch_pattern.finditer(body):
            action_name = match.group(1)
            trigger_str = "dispatch(" + action_name + ")"
            if trigger_str not in entity.triggers:
                entity.triggers.append(trigger_str)
        
        # Check if integration layer: uses 2+ custom hooks and has triggers
        custom_hooks_count = len([h for h in entity.hooks_used if h not in STANDARD_REACT_HOOKS])
        if custom_hooks_count >= 2 and entity.triggers:
            entity.is_integration_layer = True
        elif custom_hooks_count >= 1 and len(entity.triggers) >= 2:
            entity.is_integration_layer = True
            
        for hook in entity.hooks_used:
            escaped_hook = re.escape(hook)
            destruct_pattern = re.compile(
                r"const\s*\{\s*([^}]+)\}\s*=\s*" + escaped_hook + r"\s*\("
            )
            match = destruct_pattern.search(body)
            if match:
                props = [p.strip().split(":")[0].strip() 
                        for p in match.group(1).split(",")]
                entity.consumes_from[hook] = props


# ==============================================================================
# RUST PARSING
# ==============================================================================

class RustParser:
    """Enhanced parser for Rust files."""
    
    def __init__(self, file_obj: SourceFile):
        self.file = file_obj
        self.lines = file_obj.content.splitlines()
        
    def parse(self) -> None:
        """Main parsing entry point."""
        self._parse_entities()
        self._analyze_entities()
        
    def _parse_entities(self) -> None:
        """Parse functions, structs, enums, etc."""
        fn_pattern = re.compile(
            r"(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)\s*"
            r"(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?:->\s*([^{]+?))?\s*\{"
        )
        struct_pattern = re.compile(r"(?:pub\s+)?(struct|enum|trait)\s+([a-zA-Z0-9_]+)")
        tauri_cmd_pattern = re.compile(r"#\[tauri::command\]")
        
        pending_tauri_command = False
        
        for i, line in enumerate(self.lines):
            stripped = line.strip()
            
            if tauri_cmd_pattern.search(stripped):
                pending_tauri_command = True
                continue
                
            if stripped.startswith("//"):
                continue
                
            fn_match = fn_pattern.search(line)
            if fn_match:
                entity = self._create_function_entity(fn_match, i, pending_tauri_command)
                self.file.entities.append(entity)
                pending_tauri_command = False
                continue
                
            struct_match = struct_pattern.search(line)
            if struct_match:
                entity = self._create_struct_entity(struct_match, i)
                self.file.entities.append(entity)
                pending_tauri_command = False
                
    def _create_function_entity(self, match: re.Match, line_idx: int,
                                 is_tauri_cmd: bool) -> CodeEntity:
        """Create a CodeEntity for a Rust function."""
        name = match.group(1)
        params_str = match.group(2)
        return_type_str = match.group(3) or ""
        
        end_line = find_closing_brace(self.lines, line_idx)
        body = "\n".join(self.lines[line_idx:end_line + 1])
        
        line = self.lines[line_idx]
        is_async = "async fn" in line
        is_exported = line.strip().startswith("pub ")
        
        sig = self._build_rust_signature(name, params_str, return_type_str, is_async)
        
        entity = CodeEntity(
            name=name,
            kind="fn",
            signature=sig,
            line_start=line_idx + 1,
            line_end=end_line + 1,
            file_path=self.file.path,
            rel_path=self.file.rel_path,
            body=body,
            is_async=is_async,
            is_exported=is_exported,
            is_tauri_command=is_tauri_cmd,
        )
        
        entity.parameters = self._parse_rust_params(params_str)
        entity.return_type = self._parse_rust_return_type(return_type_str)
        
        return entity
        
    def _build_rust_signature(self, name: str, params: str, 
                               return_type: str, is_async: bool) -> str:
        """Build a clean Rust signature string."""
        parts = []
        if is_async:
            parts.append("async ")
        parts.append("fn " + name + "(")
        
        params = re.sub(r"\s+", " ", params.strip())
        if len(params) > 60:
            params = params[:57] + "..."
        parts.append(params)
        parts.append(")")
        
        if return_type:
            return_type = clean_type_annotation(return_type)
            parts.append(" -> " + return_type)
            
        return "".join(parts)
        
    def _parse_rust_params(self, params_str: str) -> List[Parameter]:
        """Parse Rust function parameters."""
        params = []
        if not params_str.strip():
            return params
            
        depth = 0
        current = ""
        for char in params_str:
            if char in "<([{":
                depth += 1
            elif char in ">)]}":
                depth -= 1
            elif char == "," and depth == 0:
                if current.strip():
                    params.append(self._parse_rust_param(current.strip()))
                current = ""
                continue
            current += char
            
        if current.strip():
            params.append(self._parse_rust_param(current.strip()))
            
        return params
        
    def _parse_rust_param(self, param_str: str) -> Parameter:
        """Parse a single Rust parameter."""
        if param_str in ["self", "&self", "&mut self", "mut self"]:
            return Parameter(name=param_str)
            
        if ":" in param_str:
            name, type_ann = param_str.split(":", 1)
            return Parameter(
                name=name.strip(),
                type_annotation=clean_type_annotation(type_ann)
            )
            
        return Parameter(name=param_str)
        
    def _parse_rust_return_type(self, type_str: str) -> ReturnType:
        """Parse Rust return type."""
        ret = ReturnType()
        
        if not type_str or type_str.strip() == "":
            ret.is_void = True
        else:
            type_str = type_str.strip()
            ret.raw_type = clean_type_annotation(type_str)
            ret.is_void = type_str == "()"
            
            if "Result<" in type_str:
                inner = self._extract_generic_inner(type_str, "Result")
                ret.raw_type = "Result<" + inner + ">"
            elif "Option<" in type_str:
                inner = self._extract_generic_inner(type_str, "Option")
                ret.raw_type = "Option<" + inner + ">"
                
        return ret
        
    def _extract_generic_inner(self, type_str: str, wrapper: str) -> str:
        """Extract the inner type from a generic wrapper."""
        start = type_str.find(wrapper + "<")
        if start == -1:
            return "..."
        start += len(wrapper) + 1
        
        depth = 1
        end = start
        while end < len(type_str) and depth > 0:
            if type_str[end] == "<":
                depth += 1
            elif type_str[end] == ">":
                depth -= 1
            end += 1
            
        inner = type_str[start:end-1]
        if len(inner) > 40:
            inner = inner[:37] + "..."
        return inner
        
    def _create_struct_entity(self, match: re.Match, line_idx: int) -> CodeEntity:
        """Create a CodeEntity for a struct/enum/trait."""
        kind = match.group(1)
        name = match.group(2)
        
        line = self.lines[line_idx]
        is_exported = line.strip().startswith("pub ")
        
        end_line = line_idx
        if "{" in line:
            end_line = find_closing_brace(self.lines, line_idx)
            
        return CodeEntity(
            name=name,
            kind=kind,
            signature=kind + " " + name,
            line_start=line_idx + 1,
            line_end=end_line + 1,
            file_path=self.file.path,
            rel_path=self.file.rel_path,
            is_exported=is_exported,
        )
        
    def _analyze_entities(self) -> None:
        """Analyze entities for markers and calls."""
        for entity in self.file.entities:
            if entity.kind == "fn":
                self._analyze_rust_calls(entity)
                self._analyze_rust_markers(entity)
                
    def _analyze_rust_calls(self, entity: CodeEntity) -> None:
        """Extract function calls from Rust body."""
        body = entity.body
        
        call_pattern = re.compile(r"([a-zA-Z_][a-zA-Z0-9_]*)\s*\(")
        method_pattern = re.compile(r"\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(")
        qualified_pattern = re.compile(r"([a-zA-Z_][a-zA-Z0-9_]*)::\s*([a-zA-Z_][a-zA-Z0-9_]*)")
        
        excluded = {
            "if", "for", "while", "match", "loop", "return", "Some", "None",
            "Ok", "Err", "println", "format", "vec", "panic", "assert",
            "async", "await", "fn", "let", "mut", "const", "pub", "use"
        }
        
        for match in call_pattern.finditer(body):
            call_name = match.group(1)
            if call_name not in excluded and call_name != entity.name:
                entity.raw_calls.add(call_name)
                
        for match in method_pattern.finditer(body):
            method_name = match.group(1)
            if method_name not in excluded:
                entity.raw_calls.add(method_name)
                
        for match in qualified_pattern.finditer(body):
            type_name = match.group(1)
            method_name = match.group(2)
            if type_name not in excluded:
                entity.raw_calls.add(type_name + "::" + method_name)
                
    def _analyze_rust_markers(self, entity: CodeEntity) -> None:
        """Analyze Rust-specific markers."""
        body = entity.body
        
        if entity.is_tauri_command:
            entity.effect_markers.add(EffectMarker.BACKEND_SYNC)
            
        if re.search(r"\.lock\(\)|Mutex|RwLock|State<", body):
            entity.state_markers.add(StateMarker.WRITE)


# ==============================================================================
# DEPENDENCY RESOLUTION
# ==============================================================================

def resolve_dependencies(files: List[SourceFile]) -> None:
    """Resolve call targets across files."""
    symbol_table: Dict[str, List[CodeEntity]] = defaultdict(list)
    
    for f in files:
        for entity in f.entities:
            symbol_table[entity.name].append(entity)
            
    for f in files:
        for entity in f.entities:
            for call in entity.raw_calls:
                if "::" in call or "." in call:
                    entity.resolved_calls.append(call)
                    continue
                    
                candidates = symbol_table.get(call, [])
                
                if not candidates:
                    continue
                    
                if len(candidates) == 1:
                    target = candidates[0]
                    if target.file_path == f.path:
                        entity.resolved_calls.append("self :: " + call)
                    else:
                        entity.resolved_calls.append(target.rel_path + " :: " + call)
                else:
                    same_file = [c for c in candidates if c.file_path == f.path]
                    if same_file:
                        entity.resolved_calls.append("self :: " + call)
                    else:
                        sources = [os.path.basename(c.file_path) for c in candidates[:3]]
                        if len(candidates) > 3:
                            sources.append("...")
                        entity.resolved_calls.append(call + " [? " + ", ".join(sources) + "]")


# ==============================================================================
# HOOK COMPOSITION ANALYSIS
# ==============================================================================

def build_hook_compositions(files: List[SourceFile]) -> List[HookComposition]:
    """Build hook composition hierarchy."""
    compositions: List[HookComposition] = []
    
    hooks: Dict[str, Tuple[CodeEntity, SourceFile]] = {}
    for f in files:
        for entity in f.entities:
            if entity.is_hook:
                hooks[entity.name] = (entity, f)
                
    for hook_name, (entity, src_file) in hooks.items():
        # Only include custom hooks in uses_hooks
        custom_hooks_used = [h for h in entity.hooks_used 
                           if h not in STANDARD_REACT_HOOKS]
        
        comp = HookComposition(
            name=hook_name,
            file_path=src_file.rel_path,
            uses_hooks=custom_hooks_used,
            returns=entity.return_type.properties,
            purpose=_infer_hook_purpose(entity),
            params_summary=_summarize_params(entity.parameters),
        )
        compositions.append(comp)
        
    return compositions


def _infer_hook_purpose(entity: CodeEntity) -> str:
    """Try to infer what a hook does from its name and content."""
    name = entity.name
    
    if "Selection" in name:
        return "Manages selection state and interactions"
    if "Editing" in name:
        return "Manages cell editing state and commits"
    if "Viewport" in name:
        return "Manages viewport and scrolling"
    if "Style" in name:
        return "Manages style cache and updates"
    if "Mouse" in name:
        return "Handles mouse events and interactions"
    if "Keyboard" in name:
        return "Handles keyboard events"
    if "Layout" in name:
        return "Manages layout and dimensions"
    if "Canvas" in name:
        return "Manages canvas rendering"
    if "Scroll" in name:
        return "Handles scrolling behavior"
    if "Grid" in name:
        return "Grid state management"
        
    return ""


def _summarize_params(params: List[Parameter]) -> str:
    """Create a brief summary of parameters."""
    if not params:
        return "()"
    names = [p.name.split(":")[0].strip() for p in params[:5]]
    if len(params) > 5:
        names.append("...")
    return "(" + ", ".join(names) + ")"


def generate_hook_composition_tree(compositions: List[HookComposition]) -> str:
    """Generate a tree view of hook compositions."""
    lines = [
        "================================================================================",
        "                          HOOK COMPOSITION OVERVIEW",
        "================================================================================",
        ""
    ]
    
    if not compositions:
        lines.append("No custom hooks found.")
        return "\n".join(lines)
    
    all_used: Set[str] = set()
    for comp in compositions:
        all_used.update(comp.uses_hooks)
        
    roots = [c for c in compositions if c.name not in all_used]
    
    lookup = {c.name: c for c in compositions}
    
    def render_tree(comp: HookComposition, indent: int, visited: Set[str]) -> List[str]:
        result = []
        prefix = "  " * indent
        connector = "|-- " if indent > 0 else ""
        
        result.append(prefix + connector + comp.name)
        
        if comp.uses_hooks:
            result.append(prefix + "    Uses: " + ", ".join(comp.uses_hooks))
            
        if comp.returns:
            ret_keys = list(comp.returns.keys())[:5]
            ret_str = ", ".join(ret_keys)
            if len(comp.returns) > 5:
                ret_str = ret_str + ", ..."
            result.append(prefix + "    Returns: { " + ret_str + " }")
            
        if comp.purpose:
            result.append(prefix + "    Purpose: " + comp.purpose)
            
        result.append("")
        
        for used in comp.uses_hooks:
            if used in lookup and used not in visited:
                visited.add(used)
                child_lines = render_tree(lookup[used], indent + 1, visited)
                result.extend(child_lines)
                
        return result
        
    for root in sorted(roots, key=lambda x: x.name):
        tree_lines = render_tree(root, 0, {root.name})
        lines.extend(tree_lines)
        
    return "\n".join(lines)


# ==============================================================================
# INTEGRATION POINT DETECTION
# ==============================================================================

def find_integration_points(files: List[SourceFile]) -> List[IntegrationPoint]:
    """Find where different subsystems connect."""
    points: List[IntegrationPoint] = []
    
    for f in files:
        for entity in f.entities:
            if entity.is_integration_layer:
                point = IntegrationPoint(
                    name=entity.name,
                    file_path=f.rel_path,
                    source_system=_identify_source_system(entity),
                    target_system=_identify_target_system(entity),
                    flow_description=_describe_flow(entity),
                )
                points.append(point)
                
    return points


def _identify_source_system(entity: CodeEntity) -> str:
    """Identify what system provides data to this entity."""
    sources = set()
    
    for hook in entity.hooks_used:
        if hook in STANDARD_REACT_HOOKS:
            continue
        if "Mouse" in hook:
            sources.add("Mouse Events")
        elif "Keyboard" in hook:
            sources.add("Keyboard Events")
        elif "Selection" in hook:
            sources.add("Selection System")
        elif "Editing" in hook:
            sources.add("Editing System")
        elif "Viewport" in hook:
            sources.add("Viewport System")
        elif "Style" in hook:
            sources.add("Style System")
        elif "Canvas" in hook:
            sources.add("Canvas System")
        elif "Grid" in hook:
            sources.add("Grid State")
        elif "AutoScroll" in hook or "Scroll" in hook:
            sources.add("Auto-Scroll")
            
    for source in entity.consumes_from.keys():
        if source in STANDARD_REACT_HOOKS:
            continue
        if "Context" in source:
            sources.add("Grid State")
        elif "Mouse" in source:
            sources.add("Mouse Events")
        elif "Selection" in source:
            sources.add("Selection System")
        elif "Editing" in source:
            sources.add("Editing System")
        elif "Viewport" in source:
            sources.add("Viewport System")
            
    mouse_events = {EventType.CLICK, EventType.MOUSEDOWN, EventType.MOUSEUP, 
                   EventType.MOUSEMOVE, EventType.DOUBLECLICK}
    keyboard_events = {EventType.KEYDOWN, EventType.KEYUP, EventType.KEYPRESS}
    
    if entity.event_types & mouse_events:
        sources.add("Mouse Events")
    if entity.event_types & keyboard_events:
        sources.add("Keyboard Events")
            
    return ", ".join(sorted(sources)) if sources else "External Input"


def _identify_target_system(entity: CodeEntity) -> str:
    """Identify what system this entity writes to."""
    targets = set()
    
    for trigger in entity.triggers:
        trigger_lower = trigger.lower()
        if "editing" in trigger_lower or "startediting" in trigger_lower:
            targets.add("Editing System")
        elif "selection" in trigger_lower or "setselection" in trigger_lower:
            targets.add("Selection System")
        elif "scroll" in trigger_lower:
            targets.add("Viewport System")
        elif "formula" in trigger_lower:
            targets.add("Formula System")
        elif "style" in trigger_lower:
            targets.add("Style System")
        elif "move" in trigger_lower:
            targets.add("Navigation")
        elif "expand" in trigger_lower or "bounds" in trigger_lower:
            targets.add("Virtual Bounds")
            
    return ", ".join(sorted(targets)) if targets else "State Update"


def _describe_flow(entity: CodeEntity) -> List[str]:
    """Describe the data flow through this entity."""
    flow = []
    
    # Custom hooks consumed
    custom_consumes = {k: v for k, v in entity.consumes_from.items() 
                       if k not in STANDARD_REACT_HOOKS}
    
    if custom_consumes:
        sources = list(custom_consumes.keys())[:3]
        flow.append("1. [IN] Consumes from: " + ", ".join(sources))
        
    if entity.triggers:
        unique_triggers = list(dict.fromkeys(entity.triggers))[:3]
        flow.append("2. [OUT] Triggers: " + ", ".join(unique_triggers))
        
    return flow


def generate_integration_section(points: List[IntegrationPoint]) -> str:
    """Generate integration points section."""
    if not points:
        return ""
        
    lines = [
        "================================================================================",
        "                           INTEGRATION LAYERS",
        "================================================================================",
        ""
    ]
    
    for point in points:
        basename = os.path.basename(point.file_path)
        lines.append("### " + point.name + " (" + basename + ")")
        lines.append("    Integrates: " + point.source_system + " --> " + point.target_system)
        for step in point.flow_description:
            lines.append("    " + step)
        lines.append("")
        
    return "\n".join(lines)


# ==============================================================================
# CRITICAL PATH GENERATION
# ==============================================================================

CRITICAL_PATH_DEFINITIONS = [
    {
        "name": "Double-Click Cell to Start Editing",
        "trigger": "doubleclick",
        "key_functions": ["handleDoubleClick", "startEditing", "useEditing"],
        "description": "User double-clicks a cell to enter edit mode"
    },
    {
        "name": "Apply Cell Formatting",
        "trigger": "applyFormatting",
        "key_functions": ["applyFormatting", "apply_formatting", "handleCellsUpdated"],
        "description": "User applies formatting from ribbon to selected cells"
    },
    {
        "name": "Keyboard Navigation",
        "trigger": "keydown",
        "key_functions": ["useGridKeyboard", "moveSelection", "scrollToCell"],
        "description": "User navigates grid with arrow keys"
    },
    {
        "name": "Mouse Cell Selection",
        "trigger": "mousedown",
        "key_functions": ["useMouseSelection", "handleMouseDown", "createCellSelectionHandlers"],
        "description": "User clicks to select a cell"
    },
]


def generate_critical_paths(files: List[SourceFile]) -> List[CriticalPath]:
    """Generate critical path traces."""
    paths: List[CriticalPath] = []
    
    entity_lookup: Dict[str, Tuple[CodeEntity, SourceFile]] = {}
    for f in files:
        for e in f.entities:
            entity_lookup[e.name] = (e, f)
            
    for path_def in CRITICAL_PATH_DEFINITIONS:
        path = CriticalPath(
            name=path_def["name"],
            description=path_def["description"],
        )
        
        step_num = 1
        
        for func_name in path_def["key_functions"]:
            if func_name in entity_lookup:
                entity, src_file = entity_lookup[func_name]
                
                markers = entity.get_markers_str()
                
                calls_list = []
                for call in entity.resolved_calls:
                    # Filter out standard React hook calls
                    if not any(h in call for h in STANDARD_REACT_HOOKS):
                        calls_list.append(call)
                        if len(calls_list) >= 3:
                            break
                
                step = {
                    "num": step_num,
                    "file": src_file.rel_path,
                    "function": func_name,
                    "markers": markers,
                    "calls": calls_list,
                }
                
                path.steps.append(step)
                step_num += 1
                
        if path.steps:
            paths.append(path)
            
    return paths


def format_critical_paths(paths: List[CriticalPath]) -> str:
    """Format critical paths for output."""
    if not paths:
        return ""
        
    lines = [
        "================================================================================",
        "                            CRITICAL PATHS",
        "================================================================================",
        ""
    ]
    
    for path in paths:
        lines.append("CRITICAL PATH: " + path.name)
        lines.append("  Description: " + path.description)
        lines.append("")
        
        for step in path.steps:
            basename = os.path.basename(step["file"])
            lines.append("  " + str(step["num"]) + ". " + basename + " :: " + step["function"])
            if step["markers"]:
                lines.append("     " + step["markers"])
            if step["calls"]:
                for call in step["calls"]:
                    lines.append("       --> " + call)
        lines.append("")
        lines.append("---")
        lines.append("")
        
    return "\n".join(lines)


# ==============================================================================
# OUTPUT GENERATION
# ==============================================================================

def format_entity_enhanced(entity: CodeEntity, indent: str = "   ") -> List[str]:
    """Format a single entity with all enhancements."""
    lines = []
    
    markers = entity.get_markers_str()
    header = indent + "- **" + entity.name + "** `" + entity.kind + "` (" + str(entity.line_count) + " loc)"
    if markers:
        header = header + " " + markers
    lines.append(header)
    
    # Parameters
    if entity.parameters and entity.line_count > 10:
        param_strs = [str(p) for p in entity.parameters[:5]]
        params_str = ", ".join(param_strs)
        if len(entity.parameters) > 5:
            params_str = params_str + ", ..."
        if len(params_str) < 100:
            lines.append(indent + "  Params: (" + params_str + ")")
            
    # Return type
    if entity.return_type and not entity.return_type.is_void:
        if entity.return_type.properties:
            props = list(entity.return_type.properties.items())[:5]
            ret_parts = [k + ": " + v for k, v in props]
            ret_str = "{ " + ", ".join(ret_parts)
            if len(entity.return_type.properties) > 5:
                ret_str = ret_str + ", ..."
            ret_str = ret_str + " }"
            lines.append(indent + "  Returns: " + ret_str)
        elif entity.return_type.raw_type:
            lines.append(indent + "  Returns: " + entity.return_type.raw_type)
    
    # Hooks used - only custom hooks
    custom_hooks = entity.get_custom_hooks_used()
    if custom_hooks:
        hooks_str = format_hooks_used(entity.hooks_used, show_standard_count=True)
        if hooks_str:
            lines.append(indent + "  Hooks: " + hooks_str)
        
    # Data flow - only from custom hooks
    custom_consumes = {k: v for k, v in entity.consumes_from.items() 
                       if k not in STANDARD_REACT_HOOKS}
    if custom_consumes:
        items = list(custom_consumes.items())[:3]
        for source, props in items:
            props_list = props[:4]
            props_str = ", ".join(props_list)
            if len(props) > 4:
                props_str = props_str + "..."
            lines.append(indent + "  Consumes from " + source + ": " + props_str)
            
    # Triggers - deduplicated
    if entity.triggers:
        unique_triggers = list(dict.fromkeys(entity.triggers))[:4]
        triggers_str = ", ".join(unique_triggers)
        if len(entity.triggers) > 4:
            triggers_str = triggers_str + ", ..."
        lines.append(indent + "  Triggers: " + triggers_str)
        
    # Resolved calls - filter out standard React hooks
    if entity.resolved_calls:
        filtered_calls = [c for c in entity.resolved_calls 
                         if not any(h in c for h in STANDARD_REACT_HOOKS)]
        for call in filtered_calls[:8]:
            lines.append(indent + "    --> " + call)
        if len(filtered_calls) > 8:
            remaining = len(filtered_calls) - 8
            lines.append(indent + "    --> ... (+" + str(remaining) + " more)")
            
    return lines


def generate_file_details(files: List[SourceFile]) -> str:
    """Generate detailed file section."""
    lines = [
        "================================================================================",
        "                             FILE DETAILS",
        "================================================================================",
        "> Enhanced dependency information with markers and data flow.",
        ""
    ]
    
    files_by_dir: Dict[str, List[SourceFile]] = defaultdict(list)
    for f in files:
        if f.entities:
            d = os.path.dirname(f.rel_path)
            files_by_dir[d].append(f)
            
    for directory in sorted(files_by_dir.keys()):
        lines.append("")
        lines.append("## DIR: " + directory)
        
        for f in sorted(files_by_dir[directory], key=lambda x: x.rel_path):
            filename = os.path.basename(f.rel_path)
            
            file_markers = []
            if f.is_integration_layer:
                file_markers.append("[INTEGRATION]")
            if any(e.is_tauri_command for e in f.entities):
                file_markers.append("[HAS_COMMANDS]")
                
            marker_str = " ".join(file_markers)
            lines.append("")
            lines.append("### " + filename + " " + marker_str)
            
            for entity in sorted(f.entities, key=lambda x: x.line_start):
                entity_lines = format_entity_enhanced(entity)
                lines.extend(entity_lines)
                
    return "\n".join(lines)


def generate_data_flow_summary(files: List[SourceFile]) -> str:
    """Generate data flow summary."""
    lines = [
        "================================================================================",
        "                           DATA FLOW SUMMARY",
        "================================================================================",
        ""
    ]
    
    flows: Dict[str, Dict[str, List[str]]] = defaultdict(lambda: defaultdict(list))
    
    for f in files:
        for entity in f.entities:
            for source, props in entity.consumes_from.items():
                # Only show custom hooks
                if source not in STANDARD_REACT_HOOKS:
                    flows[source][entity.name] = props
                
    if not flows:
        lines.append("No significant data flows detected.")
        return "\n".join(lines)
        
    for source, consumers in sorted(flows.items()):
        lines.append("## " + source)
        lines.append("   Consumed by:")
        for consumer, props in sorted(consumers.items()):
            props_list = props[:4]
            props_str = ", ".join(props_list)
            if len(props) > 4:
                props_str = props_str + "..."
            lines.append("     - " + consumer + ": " + props_str)
        lines.append("")
        
    return "\n".join(lines)


def generate_dependency_map_content(files: List[SourceFile], 
                                     hook_compositions: List[HookComposition],
                                     integration_points: List[IntegrationPoint],
                                     critical_paths: List[CriticalPath],
                                     project_root: str,
                                     include_paths: List[str]) -> str:
    """Generate the dependency map content (without template wrapper)."""
    sections = []
    
    sections.append(generate_hook_composition_tree(hook_compositions))
    
    integration_section = generate_integration_section(integration_points)
    if integration_section:
        sections.append(integration_section)
    
    critical_section = format_critical_paths(critical_paths)
    if critical_section:
        sections.append(critical_section)
    
    sections.append(generate_file_details(files))
    
    sections.append(generate_data_flow_summary(files))
    
    return "\n".join(sections)


def apply_template(template_content: str, 
                   intro_content: str,
                   task_content: str,
                   dependency_map_content: str,
                   configs_content: str) -> str:
    """Apply the template and replace placeholders."""
    output = template_content
    
    # Replace placeholders
    output = output.replace("{<intro>}", intro_content.strip())
    output = output.replace("{<task>}", task_content.strip())
    output = output.replace("{<content>}", dependency_map_content.strip())
    output = output.replace("{<configs>}", configs_content.strip())
    
    return output


def generate_full_output(files: List[SourceFile], 
                         hook_compositions: List[HookComposition],
                         integration_points: List[IntegrationPoint],
                         critical_paths: List[CriticalPath],
                         project_root: str,
                         include_paths: List[str],
                         config_files: List[str],
                         template_file: Optional[str],
                         intro_file: Optional[str],
                         task_file: Optional[str]) -> str:
    """Generate the complete enhanced dependency map."""
    
    # Generate the core dependency map content
    dependency_map_content = generate_dependency_map_content(
        files, hook_compositions, integration_points, critical_paths,
        project_root, include_paths
    )
    
    # Generate config files section
    configs_content = format_config_files_section(config_files)
    
    # Check if we should use template
    if template_file and os.path.exists(template_file):
        # Read template
        template_content = read_file_safe(template_file)
        
        # Read intro and task files
        intro_content = ""
        if intro_file and os.path.exists(intro_file):
            intro_content = read_file_safe(intro_file)
        
        task_content = ""
        if task_file and os.path.exists(task_file):
            task_content = read_file_safe(task_file)
        
        # Apply template
        return apply_template(
            template_content,
            intro_content,
            task_content,
            dependency_map_content,
            configs_content
        )
    else:
        # No template, return standard output
        sections = [
            "================================================================================",
            "                        ENHANCED DEPENDENCY MAP",
            "================================================================================",
            "> Generated for: " + project_root,
            "> Files analyzed: " + str(len(files)),
            "> Hooks found: " + str(len(hook_compositions)),
        ]
        
        if include_paths:
            sections.append("> Include filter: " + ", ".join(include_paths))
            
        sections.append("")
        sections.append(dependency_map_content)
        sections.append("")
        sections.append("================================================================================")
        sections.append("                            CONFIGURATION FILES FOUND")
        sections.append("================================================================================")
        sections.append(configs_content)
        
        return "\n".join(sections)


def generate_json_output(files: List[SourceFile],
                         hook_compositions: List[HookComposition],
                         integration_points: List[IntegrationPoint],
                         critical_paths: List[CriticalPath]) -> dict:
    """Generate JSON-serializable output."""
    return {
        "files": [
            {
                "path": f.rel_path,
                "entities": [
                    {
                        "name": e.name,
                        "kind": e.kind,
                        "line_start": e.line_start,
                        "line_end": e.line_end,
                        "is_hook": e.is_hook,
                        "is_event_handler": e.is_event_handler,
                        "is_integration_layer": e.is_integration_layer,
                        "state_markers": [m.name for m in e.state_markers],
                        "effect_markers": [m.name for m in e.effect_markers],
                        "event_types": [t.value for t in e.event_types],
                        "hooks_used": e.hooks_used,
                        "triggers": e.triggers,
                        "calls": e.resolved_calls,
                        "return_properties": e.return_type.properties if e.return_type else {},
                    }
                    for e in f.entities
                ]
            }
            for f in files
        ],
        "hook_compositions": [
            {
                "name": h.name,
                "file": h.file_path,
                "uses": h.uses_hooks,
                "returns": h.returns,
                "purpose": h.purpose,
            }
            for h in hook_compositions
        ],
        "integration_points": [
            {
                "name": p.name,
                "file": p.file_path,
                "source": p.source_system,
                "target": p.target_system,
            }
            for p in integration_points
        ],
        "critical_paths": [
            {
                "name": p.name,
                "description": p.description,
                "steps": p.steps,
            }
            for p in critical_paths
        ],
    }


# ==============================================================================
# ARGUMENT PARSING
# ==============================================================================

def parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Generate enhanced dependency map for TypeScript/React + Rust/Tauri projects",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Analyze entire project with template (copies to clipboard)
  python enhanced_dependency_map.py

  # Analyze specific folders
  python enhanced_dependency_map.py --include app/src/hooks app/src/components

  # Use custom template and content files
  python enhanced_dependency_map.py --template my_template.txt --intro my_intro.txt --task my_task.txt

  # Analyze with custom project root
  python enhanced_dependency_map.py --root C:\\Projects\\MyApp --include src/features

  # Output to file instead of clipboard
  python enhanced_dependency_map.py --output my_map.txt

  # Also generate JSON
  python enhanced_dependency_map.py --json
        """
    )
    
    parser.add_argument(
        "--root", "-r",
        type=str,
        default=DEFAULT_PROJECT_ROOT,
        help="Project root directory (default: " + DEFAULT_PROJECT_ROOT + ")"
    )
    
    parser.add_argument(
        "--include", "-i",
        type=str,
        nargs="+",
        default=[],
        help="Folders to include (relative to project root). If not specified, analyzes all."
    )
    
    parser.add_argument(
        "--output", "-o",
        type=str,
        default=None,
        help="Output file path (if specified, writes to file instead of clipboard)"
    )
    
    parser.add_argument(
        "--json", "-j",
        action="store_true",
        help="Also output JSON format"
    )
    
    parser.add_argument(
        "--template", "-t",
        type=str,
        default=None,
        help="Template file path (default: " + DEFAULT_TEMPLATE_FILE + " if exists)"
    )
    
    parser.add_argument(
        "--intro",
        type=str,
        default=None,
        help="Intro file path (default: " + DEFAULT_INTRO_FILE + " if exists)"
    )
    
    parser.add_argument(
        "--task",
        type=str,
        default=None,
        help="Task file path (default: " + DEFAULT_TASK_FILE + " if exists)"
    )
    
    parser.add_argument(
        "--no-template",
        action="store_true",
        help="Do not use template even if it exists"
    )
    
    return parser.parse_args()


# ==============================================================================
# MAIN
# ==============================================================================

def main():
    args = parse_arguments()
    
    project_root = args.root
    include_paths = args.include
    output_file = args.output
    output_json = args.json
    
    # Determine template file paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    
    template_file = None
    intro_file = None
    task_file = None
    
    if not args.no_template:
        if args.template:
            template_file = args.template
        else:
            default_template = os.path.join(script_dir, DEFAULT_TEMPLATE_FILE)
            if os.path.exists(default_template):
                template_file = default_template
        
        if template_file:
            if args.intro:
                intro_file = args.intro
            else:
                default_intro = os.path.join(script_dir, DEFAULT_INTRO_FILE)
                if os.path.exists(default_intro):
                    intro_file = default_intro
            
            if args.task:
                task_file = args.task
            else:
                default_task = os.path.join(script_dir, DEFAULT_TASK_FILE)
                if os.path.exists(default_task):
                    task_file = default_task
    
    if not os.path.exists(project_root):
        print("Error: Project root '" + project_root + "' does not exist.", file=sys.stderr)
        sys.exit(1)
        
    print("Scanning " + project_root + "...", file=sys.stderr)
    if include_paths:
        print("Include filter: " + ", ".join(include_paths), file=sys.stderr)
    if template_file:
        print("Using template: " + template_file, file=sys.stderr)
    
    all_files: List[SourceFile] = []
    
    for root, dirs, files in os.walk(project_root):
        dirs[:] = [d for d in dirs if not should_ignore_dir(d)]
        
        for filename in files:
            if should_ignore_file(filename):
                continue
                
            if any(filename.endswith(ext) for ext in SOURCE_EXTENSIONS):
                full_path = os.path.join(root, filename)
                rel_path = os.path.relpath(full_path, project_root).replace("\\", "/")
                
                if not is_path_in_include_list(rel_path, include_paths):
                    continue
                
                ext = os.path.splitext(filename)[1]
                content = read_file_safe(full_path)
                
                src_file = SourceFile(
                    path=full_path,
                    rel_path=rel_path,
                    extension=ext,
                    content=content,
                )
                all_files.append(src_file)
                
    print("Found " + str(len(all_files)) + " source files.", file=sys.stderr)
    
    if not all_files:
        print("No files found matching criteria.", file=sys.stderr)
        sys.exit(0)
    
    print("Parsing...", file=sys.stderr)
    for f in all_files:
        if f.extension in [".ts", ".tsx", ".js", ".jsx"]:
            parser = TypeScriptParser(f)
            parser.parse()
        elif f.extension == ".rs":
            parser = RustParser(f)
            parser.parse()
            
    print("Resolving dependencies...", file=sys.stderr)
    resolve_dependencies(all_files)
    
    print("Analyzing hook compositions...", file=sys.stderr)
    hook_compositions = build_hook_compositions(all_files)
    
    print("Finding integration points...", file=sys.stderr)
    integration_points = find_integration_points(all_files)
    
    for f in all_files:
        for e in f.entities:
            if e.is_integration_layer:
                f.is_integration_layer = True
                break
                
    print("Generating critical paths...", file=sys.stderr)
    critical_paths = generate_critical_paths(all_files)
    
    print("Finding configuration files...", file=sys.stderr)
    config_files = find_config_files(project_root)
    
    print("Generating output...", file=sys.stderr)
    output = generate_full_output(
        all_files, 
        hook_compositions, 
        integration_points,
        critical_paths,
        project_root,
        include_paths,
        config_files,
        template_file,
        intro_file,
        task_file
    )
    
    # Output handling
    if output_file:
        # Write to file
        output_path = os.path.join(script_dir, output_file)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(output)
        print("Written to " + output_path, file=sys.stderr)
    else:
        # Copy to clipboard
        try:
            pyperclip.copy(output)
            print("Output copied to clipboard!", file=sys.stderr)
        except Exception as e:
            print("Error copying to clipboard: " + str(e), file=sys.stderr)
            print("Falling back to printing output...", file=sys.stderr)
            print(output)
    
    if output_json:
        json_output = generate_json_output(
            all_files,
            hook_compositions,
            integration_points,
            critical_paths
        )
        json_path = os.path.join(script_dir, JSON_OUTPUT_FILE)
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(json_output, f, indent=2)
        print("JSON written to " + json_path, file=sys.stderr)
        
    print("Done!", file=sys.stderr)


if __name__ == "__main__":
    main()