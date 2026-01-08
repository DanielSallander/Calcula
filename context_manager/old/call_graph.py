"""
call_graph.py - Call Graph Generator for AI Code Analysis

Generates a structured outline of code execution paths for AI to review,
then allows requesting specific code definitions on demand.

Usage:
    python call_graph.py                    # Generate outline (default)
    python call_graph.py outline            # Same as above
    python call_graph.py request "name1,name2,name3"  # Get specific code
    python call_graph.py request-file requests.txt    # Get code from file list
    python call_graph.py status             # Show current session info
    python call_graph.py reset              # Reset session state
"""

import os
import re
import sys
import json
from dataclasses import dataclass, field
from typing import Set, Dict, List, Optional, Tuple
from enum import Enum
from io import StringIO
from datetime import datetime

# ==============================================================================
# CONFIGURATION
# ==============================================================================
LOG_FILE_PATH = r"C:\Dropbox\Projekt\Calcula\context_manager\log.log"
PROJECT_ROOT = r"C:\Dropbox\Projekt\Calcula"
OUTPUT_FILE = "ai_call_graph.txt"
REQUEST_OUTPUT_FILE = "ai_requested_code.txt"
TEMPLATE_FILE = "template_call_graph.txt"
INTRO_FILE = "intro.txt"
TASK_FILE = "task.txt"
STATE_FILE = "ai_request_state.json"

# Tracing depth - can go deeper since we're only outputting signatures
MAX_DEPTH = 10

# Complexity thresholds
COMPLEX_LINES = 50      # Mark as [COMPLEX] if more lines
VERY_COMPLEX_LINES = 150  # Mark as [VERY COMPLEX]

IGNORED_IMPORTS = {
    ".rs": ["std::", "serde::", "tauri::", "super::", "crate::"],
    ".ts": ["react", "fs", "path"],
    ".tsx": ["react"],
    ".js": ["react", "fs", "path"],
    ".jsx": ["react"],
    ".py": ["os", "sys", "re", "json", "subprocess"]
}

DEFAULT_IGNORE_DIRS = {
    "node_modules", ".git", "__pycache__", "venv", ".venv", "env", "target",
    ".idea", ".vscode", "dist", "build", "__tests__", ".next", "coverage", "general_stuff"
}

IGNORE_FILES = {
    ".DS_Store", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", 
    "Cargo.lock", "scopes.json", "*.png"
}

CRITICAL_CONFIGS = ["package.json", "Cargo.toml", "tsconfig.json", "pyproject.toml"]

SOURCE_EXTENSIONS = ('.rs', '.ts', '.tsx', '.js', '.jsx', '.py')


# ==============================================================================
# DATA STRUCTURES
# ==============================================================================

class DefKind(Enum):
    FUNCTION = "function"
    STRUCT = "struct"
    ENUM = "enum"
    INTERFACE = "interface"
    TYPE_ALIAS = "type"
    CLASS = "class"
    CONST = "const"
    IMPL_BLOCK = "impl"


@dataclass
class Definition:
    kind: DefKind
    name: str
    filepath: str
    start_line: int
    end_line: int
    content: str
    type_refs: Set[str] = field(default_factory=set)
    func_calls: Set[str] = field(default_factory=set)


@dataclass
class MethodInfo:
    name: str
    start_offset: int
    end_offset: int
    content: str
    signature: str


@dataclass
class FileIndex:
    filepath: str
    definitions: Dict[str, Definition] = field(default_factory=dict)
    imports: List[str] = field(default_factory=list)
    raw_lines: List[str] = field(default_factory=list)
    namespaced_functions: Dict[str, str] = field(default_factory=dict)


@dataclass
class CallGraphNode:
    """Represents a function/method in the call graph."""
    name: str
    qualified_name: str
    signature: str
    filepath: str
    start_line: int
    end_line: int
    line_count: int
    complexity: str  # "", "COMPLEX", "VERY_COMPLEX"
    calls: List[str] = field(default_factory=list)
    called_by: List[str] = field(default_factory=list)
    depth: int = 0


@dataclass
class TypeOutline:
    """Represents a type definition in the outline."""
    kind: DefKind
    name: str
    filepath: str
    start_line: int
    end_line: int
    line_count: int
    fields_summary: str
    impl_blocks: List[Tuple[str, int, int]] = field(default_factory=list)


# ==============================================================================
# STATE MANAGEMENT
# ==============================================================================

def load_request_state() -> Dict:
    """Load the request state from file."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    state_path = os.path.join(script_dir, STATE_FILE)
    
    if not os.path.exists(state_path):
        return {
            "session_id": None,
            "outline_generated": None,
            "requested_items": [],
            "request_count": 0
        }
    
    try:
        with open(state_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {
            "session_id": None,
            "outline_generated": None,
            "requested_items": [],
            "request_count": 0
        }


def save_request_state(state: Dict):
    """Save the request state to file."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    state_path = os.path.join(script_dir, STATE_FILE)
    
    try:
        with open(state_path, 'w', encoding='utf-8') as f:
            json.dump(state, f, indent=2)
    except Exception as e:
        print(f"[WARN] Could not save state: {e}")


def reset_request_state():
    """Reset the request state (new session)."""
    state = {
        "session_id": datetime.now().isoformat(),
        "outline_generated": datetime.now().isoformat(),
        "requested_items": [],
        "request_count": 0
    }
    save_request_state(state)
    return state


def add_to_request_history(items: Set[str]):
    """Add items to the request history."""
    state = load_request_state()
    
    for item in items:
        if item not in state["requested_items"]:
            state["requested_items"].append(item)
    
    state["request_count"] += 1
    save_request_state(state)
    return state


# ==============================================================================
# PARSING UTILITIES
# ==============================================================================

def find_matching_brace(lines: List[str], start_line: int, open_char='{', close_char='}') -> int:
    """Find the line where the brace block closes."""
    balance = 0
    started = False
    in_string = False
    string_char = None
    
    for i in range(start_line, len(lines)):
        line = lines[i]
        j = 0
        while j < len(line):
            ch = line[j]
            
            if not in_string and ch in ('"', "'", '`'):
                in_string = True
                string_char = ch
            elif in_string and ch == string_char:
                num_backslashes = 0
                k = j - 1
                while k >= 0 and line[k] == '\\':
                    num_backslashes += 1
                    k -= 1
                if num_backslashes % 2 == 0:
                    in_string = False
                    string_char = None
            elif not in_string:
                if ch == '/' and j + 1 < len(line) and line[j+1] == '/':
                    break
                if ch == open_char:
                    balance += 1
                    started = True
                elif ch == close_char:
                    balance -= 1
            j += 1
        
        if started and balance == 0:
            return i
    
    return len(lines) - 1


def find_python_block_end(lines: List[str], start_line: int) -> int:
    """Find where a Python indented block ends."""
    if start_line >= len(lines):
        return start_line
    
    first_line = lines[start_line]
    base_indent = len(first_line) - len(first_line.lstrip())
    
    body_indent = None
    for i in range(start_line + 1, len(lines)):
        line = lines[i]
        stripped = line.strip()
        
        if not stripped or stripped.startswith('#'):
            continue
        
        current_indent = len(line) - len(line.lstrip())
        
        if body_indent is None:
            if current_indent > base_indent:
                body_indent = current_indent
            else:
                return start_line
        else:
            if current_indent < body_indent and stripped:
                return i - 1
    
    return len(lines) - 1


def extract_type_references(content: str, ext: str) -> Set[str]:
    """Extract type names referenced in code."""
    types = set()
    
    pascal_pattern = r'\b([A-Z][a-zA-Z0-9]*)\b'
    matches = re.findall(pascal_pattern, content)
    
    noise = {'None', 'True', 'False', 'Some', 'Ok', 'Err', 'Self', 'String', 
             'Vec', 'Option', 'Result', 'Box', 'Rc', 'Arc', 'HashMap', 'HashSet',
             'Promise', 'Array', 'Object', 'Error', 'Map', 'Set', 'Date', 'JSON',
             'Console', 'Math', 'Number', 'Boolean', 'Function', 'RegExp',
             'Default', 'Clone', 'Debug', 'Display', 'From', 'Into', 'Iterator',
             'Send', 'Sync', 'Sized', 'Copy', 'Drop', 'Fn', 'FnMut', 'FnOnce',
             'Serialize', 'Deserialize', 'PartialEq', 'Eq', 'Hash', 'Ord', 'PartialOrd',
             'React', 'Component', 'Fragment', 'FC', 'FunctionComponent', 'HTMLElement',
             'MouseEvent', 'KeyboardEvent', 'ChangeEvent', 'FormEvent', 'RefObject',
             'MutableRefObject', 'Dispatch', 'SetStateAction', 'Context', 'Provider'}
    
    for m in matches:
        if m not in noise and len(m) > 1:
            types.add(m)
    
    return types


def extract_function_calls(content: str, known_funcs: Set[str]) -> Set[str]:
    """Extract function names being called from Rust code."""
    calls = set()
    
    pattern = r'\b([a-z_][a-zA-Z0-9_]*)\s*\('
    matches = re.findall(pattern, content)
    
    for m in matches:
        if m in known_funcs:
            calls.add(m)
    
    static_pattern = r'\b([A-Z][a-zA-Z0-9_]*)\s*::\s*([a-z_][a-zA-Z0-9_]*)\s*\('
    static_matches = re.findall(static_pattern, content)
    
    for type_name, method_name in static_matches:
        if method_name in known_funcs:
            calls.add(method_name)
        qualified = f"{type_name}::{method_name}"
        if qualified in known_funcs:
            calls.add(qualified)
    
    instance_pattern = r'\.([a-z_][a-zA-Z0-9_]*)\s*\('
    instance_matches = re.findall(instance_pattern, content)
    
    for method_name in instance_matches:
        if method_name in known_funcs:
            calls.add(method_name)
    
    return calls


def extract_ts_function_calls(content: str, known_funcs: Set[str]) -> Set[str]:
    """Extract function calls from TypeScript/JavaScript code."""
    calls = set()
    
    # Standard function calls: funcName(
    pattern = r'\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\('
    matches = re.findall(pattern, content)
    
    # Filter to known functions and exclude common non-functions
    noise = {'if', 'for', 'while', 'switch', 'catch', 'function', 'async', 'await',
             'return', 'throw', 'new', 'typeof', 'instanceof', 'const', 'let', 'var',
             'useCallback', 'useMemo', 'useEffect', 'useState', 'useRef', 'useContext',
             'useReducer', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue',
             'forwardRef', 'memo', 'lazy', 'Suspense', 'createContext', 'createRef',
             'require', 'import', 'export', 'default', 'from', 'as', 'is'}
    
    for m in matches:
        if m in known_funcs and m not in noise:
            calls.add(m)
    
    # Method calls on objects: obj.method(
    method_pattern = r'\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\('
    method_matches = re.findall(method_pattern, content)
    
    for m in method_matches:
        if m in known_funcs and m not in noise:
            calls.add(m)
    
    # Await calls: await funcName(
    await_pattern = r'await\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\('
    await_matches = re.findall(await_pattern, content)
    
    for m in await_matches:
        if m in known_funcs:
            calls.add(m)
    
    return calls


def extract_jsx_component_calls(content: str, known_components: Set[str]) -> Set[str]:
    """Extract JSX component usage from TSX/JSX code."""
    calls = set()
    
    # Pattern for JSX components: <ComponentName or <ComponentName>
    jsx_pattern = r'<([A-Z][a-zA-Z0-9_]*)'
    matches = re.findall(jsx_pattern, content)
    
    for m in matches:
        if m in known_components:
            calls.add(m)
    
    return calls


def extract_method_signature(lines: List[str], start_idx: int) -> str:
    """Extract complete method signature, handling multi-line signatures."""
    signature_parts = []
    paren_depth = 0
    angle_depth = 0
    
    for i in range(start_idx, min(start_idx + 20, len(lines))):
        line = lines[i].rstrip()
        
        j = 0
        in_string = False
        while j < len(line):
            ch = line[j]
            
            if ch == '"' and (j == 0 or line[j-1] != '\\'):
                in_string = not in_string
            
            if not in_string:
                if ch == '/' and j + 1 < len(line) and line[j+1] == '/':
                    break
                if ch == '<':
                    angle_depth += 1
                elif ch == '>':
                    angle_depth = max(0, angle_depth - 1)
                elif ch == '(':
                    paren_depth += 1
                elif ch == ')':
                    paren_depth -= 1
                elif ch == '{' and paren_depth == 0 and angle_depth == 0:
                    signature_parts.append(line[:j])
                    full_sig = ' '.join(part.strip() for part in signature_parts if part.strip())
                    return clean_signature(full_sig)
            j += 1
        
        signature_parts.append(line)
    
    full_sig = ' '.join(part.strip() for part in signature_parts if part.strip())
    return clean_signature(full_sig)


def clean_signature(sig: str) -> str:
    """Clean up a method signature for display."""
    if '{' in sig:
        sig = sig[:sig.index('{')]
    sig = ' '.join(sig.split())
    if ' where ' in sig:
        where_idx = sig.index(' where ')
        where_clause = sig[where_idx:]
        if len(where_clause) > 80:
            sig = sig[:where_idx] + " where ..."
    return sig.strip()


def extract_methods_from_impl(impl_content: str) -> List[MethodInfo]:
    """Extract method definitions from an impl block."""
    methods = []
    lines = impl_content.split('\n')
    
    method_pattern = re.compile(r'^(\s*)(pub\s+)?(async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)')
    
    i = 0
    while i < len(lines):
        line = lines[i]
        match = method_pattern.match(line)
        if match:
            method_name = match.group(4)
            
            start_line = i
            for j in range(i - 1, max(i - 15, -1), -1):
                stripped = lines[j].strip()
                if stripped.startswith('#[') or stripped.startswith('///') or stripped.startswith('//!'):
                    start_line = j
                elif stripped == '' or stripped.startswith('//'):
                    continue
                else:
                    break
            
            signature = extract_method_signature(lines, i)
            
            if not signature or signature.endswith('(') or ';' in signature:
                sig_line = line.strip()
                if '{' in sig_line:
                    sig_line = sig_line[:sig_line.index('{')]
                signature = sig_line.strip()
            
            brace_line = None
            for j in range(i, min(i + 15, len(lines))):
                if '{' in lines[j]:
                    brace_line = j
                    break
            
            if brace_line is not None:
                end_line = find_matching_brace(lines, brace_line)
                method_content = '\n'.join(lines[start_line:end_line + 1])
                methods.append(MethodInfo(
                    name=method_name,
                    start_offset=start_line,
                    end_offset=end_line,
                    content=method_content,
                    signature=signature
                ))
                i = end_line + 1
            else:
                i += 1
        else:
            i += 1
    
    return methods


def extract_impl_type_name(lines: List[str], start_line: int, brace_line: int) -> Tuple[Optional[str], Optional[str]]:
    """Extract type name and optional trait name from impl block header."""
    header_lines = lines[start_line:brace_line + 1]
    header = ' '.join(line.strip() for line in header_lines)
    
    if '{' in header:
        header = header[:header.index('{')]
    
    if ' for ' in header:
        parts = header.split(' for ')
        if len(parts) == 2:
            type_part = parts[1].strip()
            trait_part = parts[0].strip()
            
            type_match = re.search(r'([A-Z][a-zA-Z0-9_]*)', type_part)
            type_name = type_match.group(1) if type_match else None
            
            trait_part = re.sub(r'^impl\s*', '', trait_part)
            trait_part = re.sub(r'<[^>]*>', '', trait_part).strip()
            trait_match = re.search(r'([A-Z][a-zA-Z0-9_]*)', trait_part)
            trait_name = trait_match.group(1) if trait_match else None
            
            return type_name, trait_name
    else:
        cleaned = re.sub(r'^impl\s*', '', header)
        cleaned = re.sub(r'<[^>]*>', '', cleaned).strip()
        if ' where ' in cleaned:
            cleaned = cleaned[:cleaned.index(' where ')]
        
        type_match = re.search(r'([A-Z][a-zA-Z0-9_]*)', cleaned)
        type_name = type_match.group(1) if type_match else None
        
        return type_name, None
    
    return None, None


def infer_instance_method_calls(content: str) -> Dict[str, Set[str]]:
    """Analyze code to infer which methods are called on which types."""
    type_to_methods: Dict[str, Set[str]] = {}
    
    var_type_patterns = [
        (r'let\s+(\w+)\s*=\s*([A-Z][a-zA-Z0-9_]*)\s*::\s*\w+\s*\(', 1, 2),
        (r'let\s+(\w+)\s*:\s*([A-Z][a-zA-Z0-9_]*)', 1, 2),
        (r'let\s+mut\s+(\w+)\s*=\s*([A-Z][a-zA-Z0-9_]*)\s*::\s*\w+\s*\(', 1, 2),
        (r'let\s+(\w+)\s*:\s*(?:Result|Option)<([A-Z][a-zA-Z0-9_]*)', 1, 2),
    ]
    
    var_to_type: Dict[str, str] = {}
    
    for pattern, var_group, type_group in var_type_patterns:
        for match in re.finditer(pattern, content):
            var_name = match.group(var_group)
            type_name = match.group(type_group)
            var_to_type[var_name] = type_name
    
    for var_name, type_name in var_to_type.items():
        method_call_pattern = rf'\b{re.escape(var_name)}\.([a-z_][a-zA-Z0-9_]*)\s*\('
        for match in re.finditer(method_call_pattern, content):
            method_name = match.group(1)
            if type_name not in type_to_methods:
                type_to_methods[type_name] = set()
            type_to_methods[type_name].add(method_name)
    
    chain_pattern = r'([A-Z][a-zA-Z0-9_]*)\s*::\s*\w+\s*\([^)]*\)\s*[?]?\s*\.([a-z_][a-zA-Z0-9_]*)\s*\('
    for match in re.finditer(chain_pattern, content):
        type_name = match.group(1)
        method_name = match.group(2)
        if type_name not in type_to_methods:
            type_to_methods[type_name] = set()
        type_to_methods[type_name].add(method_name)
    
    return type_to_methods


def extract_fields_summary(content: str, kind: DefKind, ext: str) -> str:
    """Extract a brief summary of struct/class fields."""
    if ext == '.rs':
        if kind == DefKind.STRUCT:
            match = re.search(r'\{([^}]+)\}', content, re.DOTALL)
            if match:
                fields_block = match.group(1)
                field_pattern = r'(\w+)\s*:\s*([^,\n]+)'
                fields = re.findall(field_pattern, fields_block)
                if fields:
                    field_strs = [f"{name}: {typ.strip()}" for name, typ in fields[:4]]
                    if len(fields) > 4:
                        field_strs.append(f"(+{len(fields) - 4} more)")
                    return ", ".join(field_strs)
        elif kind == DefKind.ENUM:
            match = re.search(r'\{([^}]+)\}', content, re.DOTALL)
            if match:
                variants_block = match.group(1)
                variant_pattern = r'^\s*(\w+)'
                variants = re.findall(variant_pattern, variants_block, re.MULTILINE)
                if variants:
                    variant_strs = variants[:5]
                    if len(variants) > 5:
                        variant_strs.append(f"(+{len(variants) - 5} more)")
                    return ", ".join(variant_strs)
    
    elif ext in ('.ts', '.tsx'):
        if kind == DefKind.INTERFACE:
            match = re.search(r'\{([^}]+)\}', content, re.DOTALL)
            if match:
                props_block = match.group(1)
                prop_pattern = r'(\w+)\s*[?]?\s*:\s*([^;\n]+)'
                props = re.findall(prop_pattern, props_block)
                if props:
                    prop_strs = [f"{name}: {typ.strip()}" for name, typ in props[:4]]
                    if len(props) > 4:
                        prop_strs.append(f"(+{len(props) - 4} more)")
                    return ", ".join(prop_strs)
    
    return ""


# ==============================================================================
# LANGUAGE-SPECIFIC PARSERS
# ==============================================================================

def parse_rust_file(filepath: str, lines: List[str]) -> FileIndex:
    """Parse Rust file and extract definitions."""
    index = FileIndex(filepath=filepath, raw_lines=lines)
    
    impl_counts: Dict[str, int] = {}
    
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped.startswith('use '):
            if '{' in stripped and '}' not in stripped:
                import_lines = [lines[i]]
                j = i + 1
                while j < len(lines):
                    import_lines.append(lines[j])
                    if '}' in lines[j]:
                        break
                    j += 1
                index.imports.append('\n'.join(import_lines))
                i = j
            else:
                index.imports.append(lines[i])
        i += 1
    
    impl_ranges: List[Tuple[int, int]] = []
    
    impl_detect_pattern = re.compile(r'^(\s*)impl\b')
    for i, line in enumerate(lines):
        match = impl_detect_pattern.match(line)
        if match:
            brace_line = None
            for j in range(i, min(i + 25, len(lines))):
                if '{' in lines[j]:
                    brace_line = j
                    break
            if brace_line is not None:
                end_line = find_matching_brace(lines, brace_line)
                impl_ranges.append((i, end_line))
    
    patterns = [
        (DefKind.FUNCTION, re.compile(r'^(\s*)(pub\s+)?(async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)')),
        (DefKind.STRUCT, re.compile(r'^(\s*)(pub\s+)?struct\s+([a-zA-Z_][a-zA-Z0-9_]*)')),
        (DefKind.ENUM, re.compile(r'^(\s*)(pub\s+)?enum\s+([a-zA-Z_][a-zA-Z0-9_]*)')),
        (DefKind.TYPE_ALIAS, re.compile(r'^(\s*)(pub\s+)?type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=')),
        (DefKind.IMPL_BLOCK, re.compile(r'^(\s*)impl\b')),
    ]
    
    def is_inside_impl(line_num: int) -> bool:
        for start, end in impl_ranges:
            if start < line_num <= end:
                return True
        return False
    
    def find_definition_start(line_num: int) -> int:
        start = line_num
        for j in range(line_num - 1, max(line_num - 15, -1), -1):
            stripped = lines[j].strip()
            if stripped.startswith('#[') or stripped.startswith('///') or stripped.startswith('//!'):
                start = j
            elif stripped == '' or stripped.startswith('//'):
                continue
            else:
                break
        return start
    
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        
        if stripped.startswith('#[') or stripped.startswith('//'):
            i += 1
            continue
        
        for kind, pattern in patterns:
            match = pattern.match(line)
            if match:
                groups = match.groups()
                
                if kind == DefKind.FUNCTION and is_inside_impl(i):
                    break
                
                name = None
                end_line = i
                actual_start = find_definition_start(i)
                
                if kind == DefKind.FUNCTION:
                    name = groups[3]
                    brace_line = None
                    for j in range(i, min(i + 15, len(lines))):
                        if '{' in lines[j]:
                            brace_line = j
                            break
                    if brace_line is not None:
                        end_line = find_matching_brace(lines, brace_line)
                    
                elif kind == DefKind.IMPL_BLOCK:
                    brace_line = None
                    for j in range(i, min(i + 25, len(lines))):
                        if '{' in lines[j]:
                            brace_line = j
                            break
                    
                    if brace_line is None:
                        i += 1
                        break
                    
                    type_name, trait_name = extract_impl_type_name(lines, i, brace_line)
                    
                    if type_name is None:
                        i += 1
                        break
                    
                    if trait_name:
                        base_name = f"impl_{trait_name}_for_{type_name}"
                    else:
                        base_name = f"impl_{type_name}"
                    
                    if base_name not in impl_counts:
                        impl_counts[base_name] = 0
                    impl_counts[base_name] += 1
                    
                    if impl_counts[base_name] > 1:
                        name = f"{base_name}_{impl_counts[base_name]}"
                    else:
                        name = base_name
                    
                    end_line = find_matching_brace(lines, brace_line)
                    
                elif kind == DefKind.TYPE_ALIAS:
                    name = groups[2]
                    for j in range(i, min(i + 10, len(lines))):
                        if ';' in lines[j]:
                            end_line = j
                            break
                    
                elif kind in (DefKind.STRUCT, DefKind.ENUM):
                    name = groups[2]
                    brace_line = None
                    for j in range(i, min(i + 10, len(lines))):
                        if '{' in lines[j]:
                            brace_line = j
                            break
                        if ';' in lines[j]:
                            end_line = j
                            break
                    if brace_line is not None:
                        end_line = find_matching_brace(lines, brace_line)
                
                if not name:
                    break
                
                def_content = '\n'.join(lines[actual_start:end_line + 1])
                
                definition = Definition(
                    kind=kind,
                    name=name,
                    filepath=filepath,
                    start_line=actual_start,
                    end_line=end_line,
                    content=def_content,
                    type_refs=extract_type_references(def_content, '.rs')
                )
                
                index.definitions[name] = definition
                i = end_line
                break
        
        i += 1
    
    return index


def parse_typescript_file(filepath: str, lines: List[str]) -> FileIndex:
    """Parse TypeScript/JavaScript file and extract definitions."""
    index = FileIndex(filepath=filepath, raw_lines=lines)
    
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('import '):
            index.imports.append(line)
    
    # Top-level patterns - ORDER MATTERS (more specific first)
    patterns = [
        # Standard function declarations
        (DefKind.FUNCTION, r'^(\s*)(export\s+)?(async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]', 4),
        # React.forwardRef components
        (DefKind.FUNCTION, r'^(\s*)(export\s+)?const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:React\.)?forwardRef', 3),
        # React.memo components  
        (DefKind.FUNCTION, r'^(\s*)(export\s+)?const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:React\.)?memo', 3),
        # Typed React components: const Name: React.FC<Props> =
        (DefKind.FUNCTION, r'^(\s*)(export\s+)?const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*React\.(?:FC|FunctionComponent)', 3),
        # Arrow function assigned to const with params
        (DefKind.FUNCTION, r'^(\s*)(export\s+)?const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(async\s+)?\([^)]*\)\s*[=:]', 3),
        # Arrow function assigned to const (function keyword)
        (DefKind.FUNCTION, r'^(\s*)(export\s+)?const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(async\s+)?function', 3),
        # Arrow function with generic type parameter
        (DefKind.FUNCTION, r'^(\s*)(export\s+)?const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*<[^>]+>\s*\(', 3),
        # Factory function pattern: export function createXxx(
        (DefKind.FUNCTION, r'^(\s*)(export\s+)?function\s+(create[a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]', 3),
        # Interface
        (DefKind.INTERFACE, r'^(\s*)(export\s+)?interface\s+([a-zA-Z_][a-zA-Z0-9_]*)', 3),
        # Type alias
        (DefKind.TYPE_ALIAS, r'^(\s*)(export\s+)?type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[=<]', 3),
        # Class
        (DefKind.CLASS, r'^(\s*)(export\s+)?class\s+([a-zA-Z_][a-zA-Z0-9_]*)', 3),
        # SCREAMING_CASE const
        (DefKind.CONST, r'^(\s*)(export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=', 3),
    ]
    
    i = 0
    while i < len(lines):
        line = lines[i]
        
        for kind, pattern, name_group in patterns:
            match = re.match(pattern, line)
            if match:
                groups = match.groups()
                name = groups[name_group - 1] if len(groups) >= name_group else None
                
                if not name:
                    continue
                
                # Find end of definition
                if '{' in line:
                    end_line = find_matching_brace(lines, i)
                else:
                    found_brace = False
                    for j in range(i, min(i + 10, len(lines))):
                        if '{' in lines[j]:
                            end_line = find_matching_brace(lines, j)
                            found_brace = True
                            break
                    
                    if not found_brace:
                        end_line = i
                        for j in range(i, len(lines)):
                            if ';' in lines[j]:
                                end_line = j
                                break
                
                def_content = '\n'.join(lines[i:end_line + 1])
                
                definition = Definition(
                    kind=kind,
                    name=name,
                    filepath=filepath,
                    start_line=i,
                    end_line=end_line,
                    content=def_content,
                    type_refs=extract_type_references(def_content, '.ts')
                )
                
                index.definitions[name] = definition
                i = end_line
                break
        
        i += 1
    
    # Second pass: extract useCallback/useMemo/useEffect functions from hooks
    extract_hook_inner_functions(index, filepath, lines)
    
    return index


def extract_hook_inner_functions(index: FileIndex, filepath: str, lines: List[str]):
    """
    Extract functions defined inside hooks using useCallback/useMemo.
    Also extracts useEffect blocks and parses fnLog.enter() calls to discover logging namespaces.
    """
    
    # Patterns for hook-based function definitions
    hook_patterns = [
        # useCallback: const funcName = useCallback(
        (re.compile(r'^(\s+)const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*useCallback\s*\('), 'callback'),
        # useMemo with function: const funcName = useMemo(() =>
        (re.compile(r'^(\s+)const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*useMemo\s*\('), 'memo'),
    ]
    
    # Pattern for useEffect (named as parent.effect)
    use_effect_pattern = re.compile(r'^(\s+)useEffect\s*\(\s*(?:async\s*)?\(\s*\)\s*=>')
    
    # Pattern for fnLog.enter to extract logging namespace
    fnlog_pattern = re.compile(
        r'''fnLog\.enter\s*\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)['"]'''
    )
    
    # Also check for simple log patterns
    simple_log_pattern = re.compile(
        r'''(?:log_enter|console\.log|logger\.)\w*\s*\(\s*['"]([a-zA-Z_][a-zA-Z0-9_.]+)['"]'''
    )
    
    # Collect all known function names for call extraction
    all_func_names = set(index.definitions.keys())
    
    # Track which simple names have namespaced versions
    namespaced_functions: Dict[str, str] = {}  # simple_name -> namespaced_name
    
    for parent_name, parent_def in list(index.definitions.items()):
        if parent_def.kind != DefKind.FUNCTION:
            continue
        
        inner_lines = parent_def.content.split('\n')
        
        # First, collect all fnLog.enter mappings in this function
        log_namespace_map: Dict[str, str] = {}
        
        for inner_line in inner_lines:
            fnlog_match = fnlog_pattern.search(inner_line)
            if fnlog_match:
                namespace = fnlog_match.group(1)
                func_name = fnlog_match.group(2)
                log_namespace_map[func_name] = f"{namespace}.{func_name}"
        
        # Track effect counter for multiple useEffects
        effect_counter = 0
        
        # Now extract useCallback/useMemo definitions
        j = 0
        while j < len(inner_lines):
            inner_line = inner_lines[j]
            
            inner_name = None
            hook_type = None
            
            # Check for useCallback/useMemo
            for pattern, htype in hook_patterns:
                match = pattern.match(inner_line)
                if match:
                    inner_name = match.group(2)
                    hook_type = htype
                    break
            
            # Check for useEffect
            if not inner_name:
                effect_match = use_effect_pattern.match(inner_line)
                if effect_match:
                    effect_counter += 1
                    if effect_counter == 1:
                        inner_name = "effect"
                    else:
                        inner_name = f"effect_{effect_counter}"
                    hook_type = 'effect'
            
            if inner_name:
                # Find the end of this hook block
                inner_start = j
                
                # Find opening brace of the callback function
                brace_line = None
                paren_depth = 0
                found_arrow_or_function = False
                
                for k in range(j, min(j + 15, len(inner_lines))):
                    line_to_check = inner_lines[k]
                    
                    for ch in line_to_check:
                        if ch == '(':
                            paren_depth += 1
                        elif ch == ')':
                            paren_depth -= 1
                    
                    if '=>' in line_to_check or 'function' in line_to_check:
                        found_arrow_or_function = True
                    
                    if found_arrow_or_function and '{' in line_to_check:
                        brace_line = k
                        break
                
                if brace_line is not None:
                    inner_end = find_matching_brace(inner_lines, brace_line)
                    
                    # Look for the closing );
                    for k in range(inner_end, min(inner_end + 10, len(inner_lines))):
                        if ');' in inner_lines[k]:
                            inner_end = k
                            break
                else:
                    inner_end = j
                    for k in range(j, min(j + 20, len(inner_lines))):
                        if re.search(r'\]\s*\)\s*;', inner_lines[k]):
                            inner_end = k
                            break
                
                inner_content = '\n'.join(inner_lines[inner_start:inner_end + 1])
                
                # Extract function calls from the inner content
                func_calls = extract_ts_function_calls(inner_content, all_func_names)
                
                # Determine the primary name
                # Priority: fnLog namespace > parent.name format
                if inner_name in log_namespace_map:
                    primary_name = log_namespace_map[inner_name]
                    namespaced_functions[inner_name] = primary_name
                else:
                    # Use parent.innerName format for effects and all inner functions
                    primary_name = f"{parent_name}.{inner_name}"
                
                # Create definition
                inner_def = Definition(
                    kind=DefKind.FUNCTION,
                    name=primary_name,
                    filepath=filepath,
                    start_line=parent_def.start_line + inner_start,
                    end_line=parent_def.start_line + inner_end,
                    content=inner_content,
                    type_refs=extract_type_references(inner_content, '.ts'),
                    func_calls=func_calls
                )
                
                # Register with primary name (namespaced)
                index.definitions[primary_name] = inner_def
                
                # Also register with simple name for resolution
                if inner_name != primary_name:
                    if inner_name not in index.definitions:
                        index.definitions[inner_name] = inner_def
                    namespaced_functions[inner_name] = primary_name
                
                # Update the all_func_names set for subsequent extractions
                all_func_names.add(inner_name)
                all_func_names.add(primary_name)
                
                j = inner_end + 1
                continue
            
            j += 1
    
    # Store namespaced mapping in the index for later use
    index.namespaced_functions.update(namespaced_functions)


def parse_python_file(filepath: str, lines: List[str]) -> FileIndex:
    """Parse Python file and extract definitions."""
    index = FileIndex(filepath=filepath, raw_lines=lines)
    
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('import ') or stripped.startswith('from '):
            index.imports.append(line)
    
    patterns = [
        (DefKind.FUNCTION, r'^(\s*)(async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\('),
        (DefKind.CLASS, r'^(\s*)class\s+([a-zA-Z_][a-zA-Z0-9_]*)'),
    ]
    
    i = 0
    while i < len(lines):
        line = lines[i]
        
        for kind, pattern in patterns:
            match = re.match(pattern, line)
            if match:
                groups = match.groups()
                
                if kind == DefKind.FUNCTION:
                    name = groups[2]
                else:
                    name = groups[1]
                
                end_line = find_python_block_end(lines, i)
                def_content = '\n'.join(lines[i:end_line + 1])
                
                definition = Definition(
                    kind=kind,
                    name=name,
                    filepath=filepath,
                    start_line=i,
                    end_line=end_line,
                    content=def_content,
                    type_refs=extract_type_references(def_content, '.py')
                )
                
                index.definitions[name] = definition
                i = end_line
                break
        
        i += 1
    
    return index


def parse_file(filepath: str) -> Optional[FileIndex]:
    """Parse a source file based on its extension."""
    ext = os.path.splitext(filepath)[1]
    
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            lines = f.read().split('\n')
    except Exception as e:
        print(f"[WARN] Could not read {filepath}: {e}")
        return None
    
    if ext == '.rs':
        return parse_rust_file(filepath, lines)
    elif ext in ('.ts', '.tsx', '.js', '.jsx'):
        return parse_typescript_file(filepath, lines)
    elif ext == '.py':
        return parse_python_file(filepath, lines)
    
    return None


# ==============================================================================
# INDEXING
# ==============================================================================

def get_all_source_files(root_path: str) -> Tuple[List[str], List[str]]:
    """Get all source and config files."""
    source_files = []
    config_files = []
    
    for root, dirs, files in os.walk(root_path):
        dirs[:] = [d for d in dirs if d not in DEFAULT_IGNORE_DIRS]
        
        for file in files:
            if file in IGNORE_FILES:
                continue
            
            full_path = os.path.join(root, file)
            
            if file in CRITICAL_CONFIGS:
                config_files.append(full_path)
            elif file.endswith(SOURCE_EXTENSIONS):
                source_files.append(full_path)
    
    return source_files, config_files


def build_definition_index(source_files: List[str]) -> Tuple[
    Dict[str, FileIndex],
    Dict[str, List[Definition]],
    Dict[str, List[str]],
    Dict[str, str],
    Dict[str, str]
]:
    """Build index of all definitions across files."""
    file_indices: Dict[str, FileIndex] = {}
    def_lookup: Dict[str, List[Definition]] = {}
    type_to_impls: Dict[str, List[str]] = {}
    impl_to_type: Dict[str, str] = {}
    namespaced_functions: Dict[str, str] = {}  # simple_name -> namespaced_name
    
    for filepath in source_files:
        index = parse_file(filepath)
        if index:
            file_indices[filepath] = index
            
            # Collect namespaced function mappings
            if index.namespaced_functions:
                namespaced_functions.update(index.namespaced_functions)
            
            for name, definition in index.definitions.items():
                if not name:
                    continue
                
                if name not in def_lookup:
                    def_lookup[name] = []
                def_lookup[name].append(definition)
                
                if definition.kind == DefKind.IMPL_BLOCK:
                    if '_for_' in name:
                        type_name = name.split('_for_')[-1]
                        type_name = re.sub(r'_\d+$', '', type_name)
                    elif name.startswith('impl_'):
                        type_name = name[5:]
                        type_name = re.sub(r'_\d+$', '', type_name)
                    else:
                        type_name = None
                    
                    if type_name:
                        impl_to_type[name] = type_name
                        
                        if type_name not in type_to_impls:
                            type_to_impls[type_name] = []
                        if name not in type_to_impls[type_name]:
                            type_to_impls[type_name].append(name)
                        
                        methods = extract_methods_from_impl(definition.content)
                        for method in methods:
                            qualified_name = f"{type_name}::{method.name}"
                            
                            method_def = Definition(
                                kind=DefKind.FUNCTION,
                                name=qualified_name,
                                filepath=filepath,
                                start_line=definition.start_line + method.start_offset,
                                end_line=definition.start_line + method.end_offset,
                                content=method.content,
                                type_refs=extract_type_references(method.content, '.rs')
                            )
                            
                            if qualified_name not in def_lookup:
                                def_lookup[qualified_name] = []
                            def_lookup[qualified_name].append(method_def)
                            
                            if method.name not in def_lookup:
                                def_lookup[method.name] = []
                            if not any(d.filepath == filepath and d.start_line == method_def.start_line
                                       for d in def_lookup[method.name]):
                                def_lookup[method.name].append(method_def)
    
    return file_indices, def_lookup, type_to_impls, impl_to_type, namespaced_functions


def parse_log_roots(log_path: str) -> Set[str]:
    """Parse log file for root function names.
    
    Expected log format:
        <num>|<level>|CMD|ENTER <func_name> [args...]
        <num>|<level>|CMD|EXIT <func_name> [args...]
        <num>|<level>|API|ENTER <func_name> [args...]
        <num>|<level>|API|EXIT <func_name> [args...]
    
    Function names may contain dots for namespaced calls (e.g., Editing.startEdit)
    """
    roots = set()
    if not os.path.exists(log_path):
        print(f"[WARN] Log file not found: {log_path}")
        return roots
    
    # Pattern matches: |CMD|ENTER func_name or |API|EXIT func_name etc.
    # Function names can include dots (e.g., Editing.startEditing, useGridKeyboard.effect)
    # The function name ends at whitespace or end of line
    pattern = re.compile(r"\|(CMD|API)\|(ENTER|EXIT)\s+([a-zA-Z_][a-zA-Z0-9_.]*)")
    
    try:
        with open(log_path, 'r', encoding='utf-8') as f:
            for line in f:
                m = pattern.search(line)
                if m:
                    roots.add(m.group(3))  # Group 3 is the function name
    except Exception as e:
        print(f"[WARN] Could not read log: {e}")
    
    return roots


def resolve_namespaced_roots(roots: Set[str], def_lookup: Dict[str, List[Definition]]) -> Set[str]:
    """Resolve namespaced function names to their actual definitions.
    
    Handles cases like:
        - 'Editing.startEdit' -> look for exact match (from fnLog parsing)
        - 'Editing.startEdit' -> look for 'startEdit' 
        - 'useGridKeyboard.effect' -> look for 'useGridKeyboard.effect'
    """
    resolved = set()
    unresolved = []
    
    for root in roots:
        # Direct match first
        if root in def_lookup:
            resolved.add(root)
            continue
        
        # Try dot-notation resolution
        if '.' in root:
            parts = root.split('.')
            namespace = parts[0]
            method = parts[-1]
            
            # Try exact match with different namespace patterns
            patterns_to_try = [
                root,                           # Editing.startEdit
                method,                         # startEdit
                f"use{namespace}.{method}",     # useEditing.startEdit
                f"use{namespace}",              # useEditing
                f"{namespace}::{method}",       # Rust-style: Editing::startEdit
            ]
            
            # Also try the hook name if namespace looks like it could be a hook abbreviation
            if not namespace.startswith('use'):
                hook_name = f"use{namespace}"
                patterns_to_try.extend([
                    hook_name,
                    f"{hook_name}.{method}",
                ])
            
            found = False
            for pattern in patterns_to_try:
                if pattern in def_lookup:
                    resolved.add(pattern)
                    print(f"[INFO] Resolved '{root}' -> '{pattern}'")
                    found = True
                    break
            
            if found:
                continue
            
            # Try snake_case conversion
            snake_case = re.sub(r'([a-z])([A-Z])', r'\1_\2', method).lower()
            if snake_case in def_lookup:
                resolved.add(snake_case)
                print(f"[INFO] Resolved '{root}' -> '{snake_case}'")
                continue
            
            # Try to find any definition containing the method name (suffix match)
            for def_name in def_lookup.keys():
                if def_name.endswith(f".{method}") or def_name.endswith(f"::{method}"):
                    resolved.add(def_name)
                    print(f"[INFO] Resolved '{root}' -> '{def_name}' (suffix match)")
                    found = True
                    break
            
            if found:
                continue
        
        # No resolution found
        unresolved.append(root)
        resolved.add(root)  # Still add for [NOT FOUND] display
    
    if unresolved:
        print(f"[WARN] Could not resolve: {', '.join(sorted(unresolved))}")
    
    return resolved


# ==============================================================================
# CALL GRAPH BUILDING
# ==============================================================================

def get_complexity_label(line_count: int) -> str:
    """Get complexity label based on line count."""
    if line_count >= VERY_COMPLEX_LINES:
        return "VERY_COMPLEX"
    elif line_count >= COMPLEX_LINES:
        return "COMPLEX"
    return ""


def build_call_graph(
    roots: Set[str],
    def_lookup: Dict[str, List[Definition]],
    type_to_impls: Dict[str, List[str]],
    impl_to_type: Dict[str, str],
    max_depth: int
) -> Tuple[Dict[str, CallGraphNode], Dict[str, TypeOutline], Set[str]]:
    """Build a call graph starting from root functions."""
    all_func_names = set(k for k in def_lookup.keys() if k is not None)
    
    call_graph: Dict[str, CallGraphNode] = {}
    type_outlines: Dict[str, TypeOutline] = {}
    needed_types: Set[str] = set()
    all_called: Set[str] = set()
    
    # Track caller relationships
    called_by: Dict[str, Set[str]] = {}
    
    processed_funcs: Set[str] = set()
    
    queue: List[Tuple[str, int, Optional[str]]] = [(root, 0, None) for root in roots]
    
    while queue:
        func_name, depth, caller = queue.pop(0)
        
        if func_name is None:
            continue
        if depth > max_depth:
            continue
        
        # Track caller relationship
        if caller and func_name:
            if func_name not in called_by:
                called_by[func_name] = set()
            called_by[func_name].add(caller)
        
        if func_name in processed_funcs:
            continue
        
        processed_funcs.add(func_name)
        all_called.add(func_name)
        
        if func_name not in def_lookup:
            continue
        
        for definition in def_lookup[func_name]:
            if func_name in call_graph:
                continue
            
            lines = definition.content.split('\n')
            signature = extract_method_signature(lines, 0) if lines else func_name
            
            line_count = definition.end_line - definition.start_line + 1
            complexity = get_complexity_label(line_count)
            
            # Use pre-extracted func_calls if available, otherwise extract
            if definition.func_calls:
                calls = definition.func_calls.copy()
            else:
                ext = os.path.splitext(definition.filepath)[1]
                if ext in ('.ts', '.tsx', '.js', '.jsx'):
                    calls = extract_ts_function_calls(definition.content, all_func_names)
                    # Also extract JSX component calls for TSX/JSX files
                    if ext in ('.tsx', '.jsx'):
                        jsx_calls = extract_jsx_component_calls(definition.content, all_func_names)
                        calls.update(jsx_calls)
                else:
                    calls = extract_function_calls(definition.content, all_func_names)
            
            static_pattern = r'\b([A-Z][a-zA-Z0-9_]*)\s*::\s*([a-z_][a-zA-Z0-9_]*)\s*\('
            static_matches = re.findall(static_pattern, definition.content)
            for type_name, method_name in static_matches:
                qualified = f"{type_name}::{method_name}"
                calls.add(qualified)
                needed_types.add(type_name)
            
            type_method_calls = infer_instance_method_calls(definition.content)
            for type_name, methods in type_method_calls.items():
                needed_types.add(type_name)
                for method_name in methods:
                    qualified = f"{type_name}::{method_name}"
                    calls.add(qualified)
            
            for type_ref in definition.type_refs:
                if type_ref:
                    needed_types.add(type_ref)
            
            node = CallGraphNode(
                name=func_name.split('::')[-1] if '::' in func_name else func_name.split('.')[-1] if '.' in func_name else func_name,
                qualified_name=func_name,
                signature=signature,
                filepath=definition.filepath,
                start_line=definition.start_line,
                end_line=definition.end_line,
                line_count=line_count,
                complexity=complexity,
                calls=sorted(calls),
                depth=depth
            )
            
            call_graph[func_name] = node
            
            if depth < max_depth:
                for call in calls:
                    if call not in processed_funcs:
                        queue.append((call, depth + 1, func_name))
    
    # Add called_by info to nodes
    for func_name, callers in called_by.items():
        if func_name in call_graph:
            call_graph[func_name].called_by = sorted(callers)
    
    # Build type outlines
    processed_types: Set[str] = set()
    type_queue = list(needed_types)
    
    while type_queue:
        type_name = type_queue.pop(0)
        if not type_name or type_name in processed_types:
            continue
        processed_types.add(type_name)
        
        if type_name in def_lookup:
            for definition in def_lookup[type_name]:
                if definition.kind in (DefKind.STRUCT, DefKind.ENUM, DefKind.INTERFACE,
                                       DefKind.TYPE_ALIAS, DefKind.CLASS):
                    ext = os.path.splitext(definition.filepath)[1]
                    fields_summary = extract_fields_summary(definition.content, definition.kind, ext)
                    
                    impl_blocks = []
                    if type_name in type_to_impls:
                        for impl_name in type_to_impls[type_name]:
                            if impl_name in def_lookup:
                                for impl_def in def_lookup[impl_name]:
                                    methods = extract_methods_from_impl(impl_def.content)
                                    method_count = len(methods)
                                    impl_lines = impl_def.end_line - impl_def.start_line + 1
                                    impl_blocks.append((impl_name, method_count, impl_lines))
                    
                    outline = TypeOutline(
                        kind=definition.kind,
                        name=type_name,
                        filepath=definition.filepath,
                        start_line=definition.start_line,
                        end_line=definition.end_line,
                        line_count=definition.end_line - definition.start_line + 1,
                        fields_summary=fields_summary,
                        impl_blocks=impl_blocks
                    )
                    
                    type_outlines[type_name] = outline
                    
                    for nested_type in definition.type_refs:
                        if nested_type and nested_type not in processed_types:
                            type_queue.append(nested_type)
                    
                    break
    
    return call_graph, type_outlines, all_called


# ==============================================================================
# OUTPUT FORMATTING (AI-OPTIMIZED)
# ==============================================================================

def relative_path(filepath: str, project_root: str) -> str:
    """Convert absolute path to relative."""
    return filepath.replace(project_root, "").lstrip(os.sep).replace("\\", "/")


def format_call_graph_ai_optimized(
    call_graph: Dict[str, CallGraphNode],
    roots: Set[str],
    project_root: str
) -> str:
    """
    Format call graph in a structured, AI-readable format.
    Uses clear sections and consistent formatting instead of ASCII trees.
    """
    out = StringIO()
    
    # Group by depth for hierarchical understanding
    by_depth: Dict[int, List[CallGraphNode]] = {}
    for node in call_graph.values():
        if node.depth not in by_depth:
            by_depth[node.depth] = []
        by_depth[node.depth].append(node)
    
    # Sort each depth level
    for depth in by_depth:
        by_depth[depth].sort(key=lambda n: n.qualified_name)
    
    # Entry points section
    out.write("ENTRY POINTS (from application logs):\n")
    for root in sorted(roots):
        if root in call_graph:
            node = call_graph[root]
            complexity_mark = f" [{node.complexity}]" if node.complexity else ""
            out.write(f"  - {root}{complexity_mark}\n")
        else:
            out.write(f"  - {root} [NOT FOUND]\n")
    out.write("\n")
    
    # Function details section
    out.write("FUNCTION DETAILS:\n")
    out.write("-" * 60 + "\n\n")
    
    for depth in sorted(by_depth.keys()):
        nodes = by_depth[depth]
        
        depth_label = "ROOT" if depth == 0 else f"DEPTH {depth}"
        out.write(f"[{depth_label}]\n\n")
        
        for node in nodes:
            # Function header
            complexity_mark = f" [{node.complexity}]" if node.complexity else ""
            out.write(f"FUNCTION: {node.qualified_name}{complexity_mark}\n")
            
            # Location
            rel_path = relative_path(node.filepath, project_root)
            out.write(f"  Location: {rel_path}:{node.start_line + 1}-{node.end_line + 1} ({node.line_count} lines)\n")
            
            # Signature
            out.write(f"  Signature: {node.signature}\n")
            
            # Called by (if not root)
            if node.called_by:
                out.write(f"  Called by: {', '.join(node.called_by)}\n")
            
            # Calls (what this function calls)
            if node.calls:
                # Group calls into found and not found
                found_calls = [c for c in node.calls if c in call_graph]
                unknown_calls = [c for c in node.calls if c not in call_graph]
                
                if found_calls:
                    out.write(f"  Calls: {', '.join(found_calls)}\n")
                if unknown_calls:
                    out.write(f"  External calls: {', '.join(unknown_calls)}\n")
            else:
                out.write(f"  Calls: (none - leaf function)\n")
            
            out.write("\n")
        
        out.write("\n")
    
    return out.getvalue()


def format_type_outlines_ai_optimized(
    type_outlines: Dict[str, TypeOutline],
    project_root: str
) -> str:
    """Format type definitions in a structured, AI-readable format."""
    out = StringIO()
    
    # Group by kind
    structs = []
    enums = []
    interfaces = []
    others = []
    
    for outline in type_outlines.values():
        if outline.kind == DefKind.STRUCT:
            structs.append(outline)
        elif outline.kind == DefKind.ENUM:
            enums.append(outline)
        elif outline.kind == DefKind.INTERFACE:
            interfaces.append(outline)
        else:
            others.append(outline)
    
    def write_type_list(type_list: List[TypeOutline], label: str):
        if not type_list:
            return
        out.write(f"{label}:\n")
        for outline in sorted(type_list, key=lambda x: x.name):
            rel_path = relative_path(outline.filepath, project_root)
            out.write(f"\n  TYPE: {outline.name}\n")
            out.write(f"    Location: {rel_path}:{outline.start_line + 1}-{outline.end_line + 1} ({outline.line_count} lines)\n")
            
            if outline.fields_summary:
                out.write(f"    Fields: {outline.fields_summary}\n")
            
            if outline.impl_blocks:
                impl_strs = []
                for impl_name, method_count, impl_lines in outline.impl_blocks:
                    complexity = get_complexity_label(impl_lines)
                    complexity_mark = f" [{complexity}]" if complexity else ""
                    impl_strs.append(f"{impl_name} ({method_count} methods, {impl_lines} lines){complexity_mark}")
                out.write(f"    Impl blocks: {', '.join(impl_strs)}\n")
        out.write("\n")
    
    write_type_list(structs, "STRUCTS")
    write_type_list(enums, "ENUMS")
    write_type_list(interfaces, "INTERFACES")
    write_type_list(others, "OTHER TYPES")
    
    return out.getvalue()


def deduplicate_function_names(
    func_names: Set[str],
    namespaced_functions: Dict[str, str]
) -> List[str]:
    """
    Remove simple names that have namespaced versions.
    E.g., if we have both 'startEdit' and 'Editing.startEdit', only keep 'Editing.startEdit'.
    """
    # Build reverse mapping: namespaced -> simple
    simple_names_with_namespace = set(namespaced_functions.keys())
    
    deduplicated = []
    for name in sorted(func_names):
        # Skip simple names that have a namespaced version
        if name in simple_names_with_namespace:
            continue
        deduplicated.append(name)
    
    return deduplicated


def generate_ai_instructions(
    call_graph: Dict[str, CallGraphNode],
    type_outlines: Dict[str, TypeOutline],
    type_to_impls: Dict[str, List[str]],
    namespaced_functions: Dict[str, str]
) -> str:
    """Generate instructions for AI on how to request code."""
    out = StringIO()
    
    out.write("HOW TO REQUEST CODE\n")
    out.write("=" * 60 + "\n\n")
    
    out.write("After reviewing this outline, respond with the exact command to run.\n")
    out.write("The user will copy-paste your command directly into their terminal.\n\n")
    
    out.write("FORMAT YOUR RESPONSE EXACTLY LIKE THIS:\n\n")
    out.write("```\n")
    out.write('python call_graph.py request "item1,item2,item3"\n')
    out.write("```\n\n")
    
    out.write("EXAMPLE RESPONSES:\n\n")
    out.write("```\n")
    out.write('python call_graph.py request "update_cell,Grid,impl_Grid"\n')
    out.write("```\n\n")
    out.write("```\n")
    out.write('python call_graph.py request "apply_formatting,StyleManager::get_or_create_style,CellStyle"\n')
    out.write("```\n\n")
    
    out.write("WHAT YOU CAN REQUEST:\n")
    out.write("  - Functions: get_cell, update_cell, apply_formatting\n")
    out.write("  - Hook functions: useEditing.startEdit, useGridKeyboard.effect\n")
    out.write("  - Methods (qualified): Grid::set_cell, Evaluator::evaluate\n")
    out.write("  - Types (struct/enum): Grid, CellValue, CellStyle\n")
    out.write("  - Impl blocks: impl_Grid, impl_Evaluator\n")
    out.write("  - Trait impls: impl_Default_for_CellStyle\n\n")
    
    out.write("AVAILABLE ITEMS:\n\n")
    
    # List available functions (deduplicated)
    func_names_set = set(call_graph.keys())
    func_names = deduplicate_function_names(func_names_set, namespaced_functions)
    
    out.write(f"  Functions ({len(func_names)}):\n")
    for i in range(0, len(func_names), 5):
        chunk = func_names[i:i+5]
        out.write(f"    {', '.join(chunk)}\n")
    out.write("\n")
    
    # List available types
    type_names = sorted(type_outlines.keys())
    out.write(f"  Types ({len(type_names)}):\n")
    for i in range(0, len(type_names), 5):
        chunk = type_names[i:i+5]
        out.write(f"    {', '.join(chunk)}\n")
    out.write("\n")
    
    # List available impl blocks
    impl_names = set()
    for outline in type_outlines.values():
        for impl_name, _, _ in outline.impl_blocks:
            impl_names.add(impl_name)
    impl_names = sorted(impl_names)
    if impl_names:
        out.write(f"  Impl blocks ({len(impl_names)}):\n")
        for i in range(0, len(impl_names), 3):
            chunk = impl_names[i:i+3]
            out.write(f"    {', '.join(chunk)}\n")
        out.write("\n")
    
    out.write("TIPS:\n")
    out.write("  - Start with entry point functions and the types they use\n")
    out.write("  - Request impl blocks to see all methods on a type\n")
    out.write("  - Items marked [COMPLEX] or [VERY_COMPLEX] have many lines\n")
    out.write("  - Keep requests focused - you can request more code later\n\n")
    
    out.write("IF YOU NEED MORE CODE LATER:\n\n")
    out.write("After receiving code, if you need additional definitions, respond with:\n\n")
    out.write("```\n")
    out.write('python call_graph.py request "additional_item1,additional_item2"\n')
    out.write("```\n\n")
    
    out.write("IMPORTANT:\n")
    out.write("  - Respond ONLY with the command in a code block\n")
    out.write("  - Do NOT attempt to solve the task until you have the actual code\n")
    out.write("  - Do NOT explain what you plan to request - just give the command\n")
    
    return out.getvalue()


# ==============================================================================
# OUTPUT GENERATION
# ==============================================================================

def read_file_safe(filepath: str, default: str = "") -> str:
    """Safely read a file, return default if not found."""
    if not os.path.exists(filepath):
        return default
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception:
        return default


def copy_to_clipboard(text: str):
    """Copy text to clipboard using Windows clip command."""
    try:
        import subprocess
        process = subprocess.Popen(['clip'], stdin=subprocess.PIPE, shell=True)
        process.communicate(text.encode('utf-16le'))
        print("[INFO] Content copied to clipboard")
    except Exception as e:
        print(f"[WARN] Could not copy to clipboard: {e}")


def filter_imports(imports: List[str], ext: str, needed_names: Set[str]) -> List[str]:
    """Filter imports to only those that might be relevant."""
    if ext not in IGNORED_IMPORTS:
        return imports
    
    ignored = IGNORED_IMPORTS[ext]
    filtered = []
    
    for imp in imports:
        stripped = imp.strip()
        should_ignore = False
        
        for prefix in ignored:
            if ext == '.rs':
                if f"use {prefix}" in stripped:
                    should_ignore = True
                    break
            else:
                if f'from "{prefix}"' in stripped or f"from '{prefix}'" in stripped:
                    should_ignore = True
                    break
                if f"import {prefix}" in stripped:
                    should_ignore = True
                    break
        
        if not should_ignore:
            filtered.append(imp)
    
    return filtered


def generate_outline_output(
    call_graph: Dict[str, CallGraphNode],
    type_outlines: Dict[str, TypeOutline],
    roots: Set[str],
    config_files: List[str],
    project_root: str,
    output_file: str,
    type_to_impls: Dict[str, List[str]],
    namespaced_functions: Dict[str, str]
):
    """Generate the outline output optimized for AI reading."""
    
    # Reset request state for new session
    reset_request_state()
    
    script_dir = os.path.dirname(os.path.abspath(__file__))
    
    # Read template if exists
    template_path = os.path.join(script_dir, TEMPLATE_FILE)
    template = read_file_safe(template_path)
    
    # Read intro and task
    intro_path = os.path.join(script_dir, INTRO_FILE)
    task_path = os.path.join(script_dir, TASK_FILE)
    intro_content = read_file_safe(intro_path, "")
    task_content = read_file_safe(task_path, "")
    
    out = StringIO()
    
    # Header
    out.write("=" * 70 + "\n")
    out.write("                    CODE STRUCTURE OUTLINE\n")
    out.write("              For AI Analysis - Request Specific Code\n")
    out.write("=" * 70 + "\n\n")
    
    # Stats
    out.write("SUMMARY:\n")
    out.write(f"  Trace depth: {MAX_DEPTH}\n")
    out.write(f"  Functions traced: {len(call_graph)}\n")
    out.write(f"  Types referenced: {len(type_outlines)}\n")
    out.write(f"  Entry points: {len(roots)}\n")
    out.write("\n")
    
    # Call graph
    out.write("=" * 70 + "\n")
    out.write("                        CALL GRAPH\n")
    out.write("=" * 70 + "\n\n")
    
    call_graph_text = format_call_graph_ai_optimized(call_graph, roots, project_root)
    out.write(call_graph_text)
    
    # Type definitions
    out.write("=" * 70 + "\n")
    out.write("                     TYPE DEFINITIONS\n")
    out.write("=" * 70 + "\n\n")
    
    type_text = format_type_outlines_ai_optimized(type_outlines, project_root)
    out.write(type_text)
    
    # Config files summary
    out.write("=" * 70 + "\n")
    out.write("                   CONFIGURATION FILES\n")
    out.write("=" * 70 + "\n\n")
    
    for conf_path in config_files:
        rel_path = relative_path(conf_path, project_root)
        out.write(f"  - {rel_path}\n")
    out.write("\n(Request 'CONFIG:filename' to see contents)\n\n")
    
    # AI Instructions
    out.write("=" * 70 + "\n")
    instructions = generate_ai_instructions(call_graph, type_outlines, type_to_impls, namespaced_functions)
    out.write(instructions)
    
    content = out.getvalue()
    
    # Apply template if exists
    if template:
        final_output = template
        final_output = final_output.replace("{<intro>}", intro_content)
        final_output = final_output.replace("{<task>}", task_content)
        final_output = final_output.replace("{<content>}", content)
    else:
        # No template - build default structure
        final_output = ""
        if intro_content:
            final_output += intro_content + "\n\n"
        if task_content:
            final_output += "=" * 70 + "\n"
            final_output += "                         TASK DESCRIPTION\n"
            final_output += "=" * 70 + "\n\n"
            final_output += task_content + "\n\n"
        final_output += content
    
    # Write to file
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(final_output)
    
    line_count = final_output.count('\n')
    
    print(f"\n[SUCCESS] Saved outline to: {output_file}")
    print(f"[STATS] {len(call_graph)} functions, {len(type_outlines)} types, {line_count} lines")
    
    copy_to_clipboard(final_output)


def generate_requested_code(
    requested_names: Set[str],
    def_lookup: Dict[str, List[Definition]],
    file_indices: Dict[str, FileIndex],
    type_to_impls: Dict[str, List[str]],
    project_root: str,
    output_file: str,
    is_followup: bool = False
):
    """Generate full code for specifically requested definitions."""
    out = StringIO()
    
    # Load state to check what was already provided
    state = load_request_state()
    previously_requested = set(state.get("requested_items", []))
    request_num = state.get("request_count", 0) + 1
    
    # Identify new vs already-provided items
    new_items = requested_names - previously_requested
    repeated_items = requested_names & previously_requested
    
    # Header - shorter for follow-up requests
    if is_followup or request_num > 1:
        out.write(f"// CODE REQUEST #{request_num}\n")
        out.write(f"// Items: {', '.join(sorted(requested_names))}\n")
        if repeated_items:
            out.write(f"// Note: Already provided earlier: {', '.join(sorted(repeated_items))}\n")
        out.write("\n")
    else:
        out.write("=" * 70 + "\n")
        out.write("                    REQUESTED CODE\n")
        out.write("=" * 70 + "\n\n")
        out.write(f"Requested items: {', '.join(sorted(requested_names))}\n\n")
    
    found_count = 0
    not_found = []
    
    defs_by_file: Dict[str, List[Definition]] = {}
    
    # Only process items that weren't already provided (unless explicitly re-requested)
    items_to_process = requested_names if not is_followup else new_items
    if not items_to_process:
        items_to_process = requested_names  # Process all if explicitly requested
    
    for name in items_to_process:
        found = False
        
        # Direct lookup
        if name in def_lookup:
            for definition in def_lookup[name]:
                filepath = definition.filepath
                if filepath not in defs_by_file:
                    defs_by_file[filepath] = []
                defs_by_file[filepath].append(definition)
                found_count += 1
                found = True
        
        # Check if it's a type with impl blocks
        if name in type_to_impls and not found:
            for impl_name in type_to_impls[name]:
                if impl_name in def_lookup:
                    for definition in def_lookup[impl_name]:
                        filepath = definition.filepath
                        if filepath not in defs_by_file:
                            defs_by_file[filepath] = []
                        defs_by_file[filepath].append(definition)
                        found_count += 1
                        found = True
        
        if not found:
            not_found.append(name)
    
    if not_found:
        out.write(f"[NOT FOUND] {', '.join(not_found)}\n")
        out.write("  Try: qualified names (Type::method), hook functions (useHook.callback), or impl blocks (impl_Type)\n\n")
    
    # Output definitions grouped by file
    for filepath in sorted(defs_by_file.keys()):
        definitions = defs_by_file[filepath]
        rel_path = relative_path(filepath, project_root)
        ext = os.path.splitext(filepath)[1]
        
        out.write("-" * 60 + "\n")
        out.write(f"FILE: {rel_path}\n")
        out.write("-" * 60 + "\n\n")
        
        # Write relevant imports (condensed)
        if filepath in file_indices:
            file_index = file_indices[filepath]
            needed_names_set = set(d.name for d in definitions)
            for d in definitions:
                needed_names_set.update(d.type_refs)
            
            filtered_imports = filter_imports(file_index.imports, ext, needed_names_set)
            if filtered_imports and len(filtered_imports) <= 10:
                out.write("// Imports:\n")
                for imp in filtered_imports:
                    out.write(imp.strip() + "\n")
                out.write("\n")
        
        # Deduplicate and sort
        seen_ranges = set()
        unique_defs = []
        for d in sorted(definitions, key=lambda x: x.start_line):
            range_key = (d.start_line, d.end_line)
            if range_key not in seen_ranges:
                seen_ranges.add(range_key)
                unique_defs.append(d)
        
        for definition in unique_defs:
            kind_label = definition.kind.value.upper()
            out.write(f"// [{kind_label}] {definition.name} ")
            out.write(f"(lines {definition.start_line + 1}-{definition.end_line + 1})\n")
            out.write(definition.content)
            out.write("\n\n")
    
    # Minimal footer - only for first request
    if request_num == 1:
        out.write("-" * 60 + "\n")
        out.write("// Need more? Run: python call_graph.py request \"item1,item2\"\n")
    
    content = out.getvalue()
    
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(content)
    
    # Update state
    add_to_request_history(requested_names)
    
    line_count = content.count('\n')
    
    print(f"\n[SUCCESS] Saved to: {output_file}")
    print(f"[STATS] Found {found_count}, not found {len(not_found)}, {line_count} lines")
    if repeated_items:
        print(f"[NOTE] Previously provided: {', '.join(sorted(repeated_items))}")
    
    copy_to_clipboard(content)


# ==============================================================================
# MAIN
# ==============================================================================

def main():
    if len(sys.argv) > 1:
        arg = sys.argv[1]
        
        if arg == "request":
            if len(sys.argv) < 3:
                print("Usage: python call_graph.py request \"name1,name2,name3\"")
                print("Example: python call_graph.py request \"update_cell,Grid,impl_Grid\"")
                return
            
            requested = set(name.strip() for name in sys.argv[2].split(",") if name.strip())
            
            # Check if this is a follow-up request
            state = load_request_state()
            is_followup = state.get("request_count", 0) > 0
            
            if is_followup:
                print(f"[INFO] Follow-up request #{state['request_count'] + 1}")
            print(f"[INFO] Requesting: {', '.join(sorted(requested))}")
            
            source_files, _ = get_all_source_files(PROJECT_ROOT)
            file_indices, def_lookup, type_to_impls, _, _ = build_definition_index(source_files)
            
            generate_requested_code(
                requested, def_lookup, file_indices, type_to_impls,
                PROJECT_ROOT, REQUEST_OUTPUT_FILE, is_followup
            )
            return
        
        elif arg == "request-file":
            if len(sys.argv) < 3:
                print("Usage: python call_graph.py request-file requests.txt")
                return
            
            request_file = sys.argv[2]
            if not os.path.exists(request_file):
                print(f"[ERROR] File not found: {request_file}")
                return
            
            with open(request_file, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Parse REQUEST_CODE: or REQUEST_MORE: lines
            pattern = r'(?:REQUEST_CODE|REQUEST_MORE):\s*(.+)'
            matches = re.findall(pattern, content)
            
            requested = set()
            for match in matches:
                for name in match.split(','):
                    name = name.strip()
                    if name:
                        requested.add(name)
            
            if not requested:
                print("[ERROR] No REQUEST_CODE or REQUEST_MORE found in file")
                return
            
            print(f"[INFO] Requesting code for: {', '.join(sorted(requested))}")
            
            source_files, _ = get_all_source_files(PROJECT_ROOT)
            file_indices, def_lookup, type_to_impls, _, _ = build_definition_index(source_files)
            
            # Check if this is a follow-up request
            state = load_request_state()
            is_followup = state.get("request_count", 0) > 0
            
            generate_requested_code(
                requested, def_lookup, file_indices, type_to_impls,
                PROJECT_ROOT, REQUEST_OUTPUT_FILE, is_followup
            )
            return
        
        elif arg == "reset":
            reset_request_state()
            print("[INFO] Request state reset. Ready for new session.")
            return
        
        elif arg == "status":
            state = load_request_state()
            print(f"Session started: {state.get('outline_generated', 'N/A')}")
            print(f"Requests made: {state.get('request_count', 0)}")
            print(f"Items provided: {len(state.get('requested_items', []))}")
            if state.get('requested_items'):
                items = state['requested_items']
                print(f"  {', '.join(items[:10])}")
                if len(items) > 10:
                    print(f"  ... and {len(items) - 10} more")
            return
        
        elif arg == "list":
            # New command: list all definitions
            print("[INFO] Listing all definitions...")
            source_files, _ = get_all_source_files(PROJECT_ROOT)
            _, def_lookup, _, _, _ = build_definition_index(source_files)
            
            print(f"\nTotal definitions: {len(def_lookup)}")
            print("\nAll definition names:")
            for name in sorted(def_lookup.keys()):
                defs = def_lookup[name]
                locations = [relative_path(d.filepath, PROJECT_ROOT) for d in defs]
                print(f"  {name} ({defs[0].kind.value}) - {locations[0]}")
            return
        
        elif arg == "search":
            if len(sys.argv) < 3:
                print("Usage: python call_graph.py search \"pattern\"")
                return
            
            pattern = sys.argv[2].lower()
            print(f"[INFO] Searching for: {pattern}")
            
            source_files, _ = get_all_source_files(PROJECT_ROOT)
            _, def_lookup, _, _, _ = build_definition_index(source_files)
            
            matches = []
            for name in def_lookup.keys():
                if pattern in name.lower():
                    matches.append(name)
            
            print(f"\nFound {len(matches)} matches:")
            for name in sorted(matches):
                defs = def_lookup[name]
                print(f"  {name} ({defs[0].kind.value})")
            return
        
        elif arg in ("-h", "--help"):
            print("Call Graph Generator for AI Code Analysis")
            print()
            print("Usage:")
            print("  python call_graph.py                  Generate outline (default)")
            print("  python call_graph.py outline          Same as above")
            print('  python call_graph.py request "a,b,c"  Get code for specific items')
            print("  python call_graph.py request-file f   Get code from request file")
            print("  python call_graph.py status           Show current session info")
            print("  python call_graph.py reset            Reset session state")
            print("  python call_graph.py list             List all definitions")
            print('  python call_graph.py search "pattern" Search for definitions')
            print()
            print("Workflow:")
            print("  1. Run 'python call_graph.py' to generate outline")
            print("  2. Give outline to AI with your task")
            print("  3. AI responds with 'python call_graph.py request \"item1,item2\"'")
            print("  4. Run the command")
            print("  5. Give code to AI")
            print("  6. If AI needs more, repeat steps 3-5")
            print()
            print(f"Configuration (edit script):")
            print(f"  LOG_FILE_PATH: {LOG_FILE_PATH}")
            print(f"  PROJECT_ROOT:  {PROJECT_ROOT}")
            print(f"  MAX_DEPTH:     {MAX_DEPTH}")
            return
        
        elif arg != "outline":
            print(f"[ERROR] Unknown argument: {arg}")
            print("Run 'python call_graph.py --help' for usage")
            return
    
    # Default: generate outline
    print("--> Call Graph Generator")
    print(f"    Project: {PROJECT_ROOT}")
    print(f"    Log: {LOG_FILE_PATH}")
    print(f"    Max Depth: {MAX_DEPTH}")
    print()
    
    # 1. Index source files
    source_files, config_files = get_all_source_files(PROJECT_ROOT)
    print(f"[INFO] Found {len(source_files)} source files")
    
    # 2. Parse and index
    file_indices, def_lookup, type_to_impls, impl_to_type, namespaced_functions = build_definition_index(source_files)
    total_defs = sum(len(defs) for defs in def_lookup.values())
    print(f"[INFO] Indexed {total_defs} definitions")
    
    # 3. Parse log for roots
    log_roots = parse_log_roots(LOG_FILE_PATH)
    if log_roots:
        print(f"[INFO] Found {len(log_roots)} entry points from log: {', '.join(list(log_roots)[:5])}...")
        
        # Resolve namespaced names to actual definitions
        log_roots = resolve_namespaced_roots(log_roots, def_lookup)
        print(f"[INFO] After resolution: {len(log_roots)} entry points")
    else:
        print("[WARN] No entry points found in log!")
        return
    
    # 4. Build call graph
    call_graph, type_outlines, _ = build_call_graph(
        log_roots, def_lookup, type_to_impls, impl_to_type, MAX_DEPTH
    )
    print(f"[INFO] Built call graph: {len(call_graph)} functions, {len(type_outlines)} types")
    
    # 5. Generate outline
    generate_outline_output(
        call_graph, type_outlines, log_roots, config_files,
        PROJECT_ROOT, OUTPUT_FILE, type_to_impls, namespaced_functions
    )


if __name__ == "__main__":
    main()