import os
import re
import sys
from dataclasses import dataclass, field
from typing import Set, Dict, List, Optional, Tuple
from enum import Enum

# ==============================================================================
# CONFIGURATION
# ==============================================================================
LOG_FILE_PATH = r"C:\Dropbox\Projekt\Calcula\context_manager\log.log"
PROJECT_ROOT = r"C:\Dropbox\Projekt\Calcula"
OUTPUT_FILE = "ai_context_smart_bundle_v3.txt"
TEMPLATE_FILE = "template_extractor.txt"
INTRO_FILE = "intro.txt"
TASK_FILE = "task.txt"

MAX_DEPTH = 1

# Output mode: "full" or "summarized"
# - full: Include complete impl blocks (current behavior)
# - summarized: Include only called methods with full bodies, signatures for others
OUTPUT_MODE = "summarized"

# Only applies when OUTPUT_MODE = "summarized"
IMPL_SUMMARIZE_THRESHOLD = 50  # Summarize impl blocks larger than this many lines

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
    ".DS_Store", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "scopes.json", "*.png"
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
            
            # Handle string literals - only double quotes (single quote is lifetime in Rust)
            if not in_string and ch == '"':
                in_string = True
                string_char = ch
            elif in_string and ch == string_char:
                # Check for escape
                num_backslashes = 0
                k = j - 1
                while k >= 0 and line[k] == '\\':
                    num_backslashes += 1
                    k -= 1
                if num_backslashes % 2 == 0:
                    in_string = False
                    string_char = None
            elif not in_string:
                # Handle single-line comments
                if ch == '/' and j + 1 < len(line) and line[j+1] == '/':
                    break  # Rest of line is comment
                
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
    
    # PascalCase names (likely types/structs/interfaces)
    pascal_pattern = r'\b([A-Z][a-zA-Z0-9]*)\b'
    matches = re.findall(pascal_pattern, content)
    
    # Filter out common non-type words
    noise = {'None', 'True', 'False', 'Some', 'Ok', 'Err', 'Self', 'String', 
             'Vec', 'Option', 'Result', 'Box', 'Rc', 'Arc', 'HashMap', 'HashSet',
             'Promise', 'Array', 'Object', 'Error', 'Map', 'Set', 'Date', 'JSON',
             'Console', 'Math', 'Number', 'Boolean', 'Function', 'RegExp',
             'Default', 'Clone', 'Debug', 'Display', 'From', 'Into', 'Iterator',
             'Send', 'Sync', 'Sized', 'Copy', 'Drop', 'Fn', 'FnMut', 'FnOnce',
             'Serialize', 'Deserialize', 'PartialEq', 'Eq', 'Hash', 'Ord', 'PartialOrd'}
    
    for m in matches:
        if m not in noise and len(m) > 1:
            types.add(m)
    
    return types


def extract_function_calls(content: str, known_funcs: Set[str]) -> Set[str]:
    """Extract function names being called, including method calls."""
    calls = set()
    
    # Regular function calls: func_name(
    pattern = r'\b([a-z_][a-zA-Z0-9_]*)\s*\('
    matches = re.findall(pattern, content)
    
    for m in matches:
        if m in known_funcs:
            calls.add(m)
    
    # Static method calls: TypeName::method_name(
    static_pattern = r'\b([A-Z][a-zA-Z0-9_]*)\s*::\s*([a-z_][a-zA-Z0-9_]*)\s*\('
    static_matches = re.findall(static_pattern, content)
    
    for type_name, method_name in static_matches:
        if method_name in known_funcs:
            calls.add(method_name)
        qualified = f"{type_name}::{method_name}"
        if qualified in known_funcs:
            calls.add(qualified)
    
    # Instance method calls: variable.method_name(
    instance_pattern = r'\.([a-z_][a-zA-Z0-9_]*)\s*\('
    instance_matches = re.findall(instance_pattern, content)
    
    for method_name in instance_matches:
        if method_name in known_funcs:
            calls.add(method_name)
    
    return calls


def extract_method_signature(lines: List[str], start_idx: int) -> str:
    """
    Extract complete method signature, handling multi-line signatures.
    Returns the signature string without the body.
    """
    signature_parts = []
    paren_depth = 0
    angle_depth = 0  # Track generic brackets
    found_fn = False
    
    for i in range(start_idx, min(start_idx + 20, len(lines))):
        line = lines[i].rstrip()
        
        # Process character by character, tracking nesting
        j = 0
        in_string = False
        while j < len(line):
            ch = line[j]
            
            # Handle string literals
            if ch == '"' and (j == 0 or line[j-1] != '\\'):
                in_string = not in_string
            
            if not in_string:
                # Handle single-line comments
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
                    # Found the body start
                    signature_parts.append(line[:j])
                    full_sig = ' '.join(part.strip() for part in signature_parts if part.strip())
                    return clean_signature(full_sig)
            
            j += 1
        
        signature_parts.append(line)
        
        # Check for fn keyword
        if 'fn ' in line:
            found_fn = True
    
    # Fallback: join what we have
    full_sig = ' '.join(part.strip() for part in signature_parts if part.strip())
    return clean_signature(full_sig)


def clean_signature(sig: str) -> str:
    """Clean up a method signature for display."""
    # Remove opening brace if present
    if '{' in sig:
        sig = sig[:sig.index('{')]
    
    # Normalize whitespace
    sig = ' '.join(sig.split())
    
    # Truncate very long where clauses
    if ' where ' in sig:
        where_idx = sig.index(' where ')
        where_clause = sig[where_idx:]
        if len(where_clause) > 60:
            sig = sig[:where_idx]
    
    return sig.strip()

def extract_methods_from_impl(impl_content: str) -> List[MethodInfo]:
    """
    Extract method definitions from an impl block.
    Returns list of MethodInfo objects.
    """
    methods = []
    lines = impl_content.split('\n')
    
    # Pattern for method definitions inside impl
    method_pattern = re.compile(r'^(\s*)(pub\s+)?(async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)')
    
    i = 0
    while i < len(lines):
        line = lines[i]
        match = method_pattern.match(line)
        if match:
            method_name = match.group(4)
            
            # Look backwards for attributes and doc comments
            start_line = i
            for j in range(i - 1, max(i - 15, -1), -1):
                stripped = lines[j].strip()
                if stripped.startswith('#[') or stripped.startswith('///') or stripped.startswith('//!'):
                    start_line = j
                elif stripped == '' or stripped.startswith('//'):
                    continue
                else:
                    break
            
            # Extract full signature (handles multi-line)
            signature = extract_method_signature(lines, i)
            
            # Validate signature - if it looks malformed, try simpler extraction
            if not signature or signature.endswith('(') or ';' in signature:
                # Fallback: just grab the first line
                sig_line = line.strip()
                if '{' in sig_line:
                    sig_line = sig_line[:sig_line.index('{')]
                signature = sig_line.strip()
            
            # Find the opening brace
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
    """
    Extract type name and optional trait name from impl block header.
    Returns (type_name, trait_name) where trait_name is None for inherent impls.
    """
    # Collect all lines from impl to opening brace
    header_lines = lines[start_line:brace_line + 1]
    header = ' '.join(line.strip() for line in header_lines)
    
    # Remove the opening brace and everything after
    if '{' in header:
        header = header[:header.index('{')]
    
    # Check for "for" keyword indicating trait impl
    if ' for ' in header:
        parts = header.split(' for ')
        if len(parts) == 2:
            type_part = parts[1].strip()
            trait_part = parts[0].strip()
            
            # Extract type name (first PascalCase identifier, ignoring generics)
            type_match = re.search(r'([A-Z][a-zA-Z0-9_]*)', type_part)
            type_name = type_match.group(1) if type_match else None
            
            # Extract trait name - remove 'impl' and generics
            trait_part = re.sub(r'^impl\s*', '', trait_part)
            trait_part = re.sub(r'<[^>]*>', '', trait_part).strip()
            trait_match = re.search(r'([A-Z][a-zA-Z0-9_]*)', trait_part)
            trait_name = trait_match.group(1) if trait_match else None
            
            return type_name, trait_name
    else:
        # Inherent impl: impl TypeName or impl<...> TypeName<...>
        cleaned = re.sub(r'^impl\s*', '', header)
        # Remove generic parameters
        cleaned = re.sub(r'<[^>]*>', '', cleaned).strip()
        # Handle where clauses
        if ' where ' in cleaned:
            cleaned = cleaned[:cleaned.index(' where ')]
        
        type_match = re.search(r'([A-Z][a-zA-Z0-9_]*)', cleaned)
        type_name = type_match.group(1) if type_match else None
        
        return type_name, None
    
    return None, None


def infer_instance_method_calls(content: str) -> Dict[str, Set[str]]:
    """
    Analyze code to infer which methods are called on which types.
    Returns dict of type_name -> set of method names called on that type.
    """
    type_to_methods: Dict[str, Set[str]] = {}
    
    # Find variable declarations with type info
    var_type_patterns = [
        # let evaluator = Evaluator::new(grid)
        (r'let\s+(\w+)\s*=\s*([A-Z][a-zA-Z0-9_]*)\s*::\s*\w+\s*\(', 1, 2),
        # let evaluator: Evaluator = ...
        (r'let\s+(\w+)\s*:\s*([A-Z][a-zA-Z0-9_]*)', 1, 2),
        # let mut grid = Grid::new()
        (r'let\s+mut\s+(\w+)\s*=\s*([A-Z][a-zA-Z0-9_]*)\s*::\s*\w+\s*\(', 1, 2),
        # let result: Result<Type, _> = ... (extract inner type)
        (r'let\s+(\w+)\s*:\s*(?:Result|Option)<([A-Z][a-zA-Z0-9_]*)', 1, 2),
    ]
    
    var_to_type: Dict[str, str] = {}
    
    for pattern, var_group, type_group in var_type_patterns:
        for match in re.finditer(pattern, content):
            var_name = match.group(var_group)
            type_name = match.group(type_group)
            var_to_type[var_name] = type_name
    
    # Find method calls on known variables
    for var_name, type_name in var_to_type.items():
        # Standard method call: var.method(
        method_call_pattern = rf'\b{re.escape(var_name)}\.([a-z_][a-zA-Z0-9_]*)\s*\('
        for match in re.finditer(method_call_pattern, content):
            method_name = match.group(1)
            if type_name not in type_to_methods:
                type_to_methods[type_name] = set()
            type_to_methods[type_name].add(method_name)
    
    # Chained calls: TypeName::new(...).method(...) or TypeName::new(...)?.method(...)
    chain_pattern = r'([A-Z][a-zA-Z0-9_]*)\s*::\s*\w+\s*\([^)]*\)\s*[?]?\s*\.([a-z_][a-zA-Z0-9_]*)\s*\('
    for match in re.finditer(chain_pattern, content):
        type_name = match.group(1)
        method_name = match.group(2)
        if type_name not in type_to_methods:
            type_to_methods[type_name] = set()
        type_to_methods[type_name].add(method_name)
    
    # Result/Option unwrap chains: result.unwrap().method()
    # Track the type through .unwrap(), .ok(), .expect(), etc.
    unwrap_chain = r'(\w+)\.(unwrap|ok|expect|unwrap_or|unwrap_or_else)\s*\([^)]*\)\s*\.([a-z_][a-zA-Z0-9_]*)\s*\('
    for match in re.finditer(unwrap_chain, content):
        var_name = match.group(1)
        method_name = match.group(3)
        if var_name in var_to_type:
            type_name = var_to_type[var_name]
            if type_name not in type_to_methods:
                type_to_methods[type_name] = set()
            type_to_methods[type_name].add(method_name)
    
    return type_to_methods

def create_summarized_impl(
    impl_def: Definition,
    called_methods: Set[str],
    type_name: str
) -> Tuple[str, int, int]:
    """
    Create a summarized version of an impl block:
    - Full bodies for called methods
    - Signatures only for other methods
    
    Returns (summarized_content, included_count, signature_only_count)
    """
    lines = impl_def.content.split('\n')
    all_methods = extract_methods_from_impl(impl_def.content)
    
    # Find impl header (everything before first method)
    header_end = len(lines)
    method_pattern = re.compile(r'^\s*(pub\s+)?(async\s+)?fn\s+')
    for i, line in enumerate(lines):
        if method_pattern.match(line):
            header_end = i
            break
    
    # Get header lines, but remove trailing empty lines
    header_lines = lines[:header_end]
    while header_lines and not header_lines[-1].strip():
        header_lines.pop()
    
    output_lines = header_lines.copy()
    
    # Separate called and uncalled methods
    called_list = []
    uncalled_list = []
    
    for method in all_methods:
        # Check if this method was called (by simple name or qualified name)
        is_called = (method.name in called_methods or 
                     f"{type_name}::{method.name}" in called_methods)
        if is_called:
            called_list.append(method)
        else:
            uncalled_list.append(method)
    
    # Add called methods with full bodies
    if called_list:
        output_lines.append('')
        output_lines.append('    // === CALLED METHODS (full implementation) ===')
        for method in called_list:
            output_lines.append('')
            for line in method.content.split('\n'):
                output_lines.append(line)
    
    # Add signatures for non-called methods
    if uncalled_list:
        output_lines.append('')
        output_lines.append(f'    // === OTHER METHODS ({len(uncalled_list)} signatures) ===')
        for method in uncalled_list:
            # Clean up signature
            sig = method.signature.strip()
            if not sig.endswith(';'):
                sig += ';'
            output_lines.append(f'    {sig}')
    
    output_lines.append('}')
    
    return '\n'.join(output_lines), len(called_list), len(uncalled_list)


# ==============================================================================
# LANGUAGE-SPECIFIC PARSERS
# ==============================================================================

def parse_rust_file(filepath: str, lines: List[str]) -> FileIndex:
    """Parse Rust file and extract definitions."""
    index = FileIndex(filepath=filepath, raw_lines=lines)
    
    # Track impl block counts per type for unique naming
    impl_counts: Dict[str, int] = {}
    
    # Extract imports (handle multi-line use statements)
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped.startswith('use '):
            if '{' in stripped and '}' not in stripped:
                # Multi-line import
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
    
    # Track which line ranges are inside impl blocks
    impl_ranges: List[Tuple[int, int]] = []
    
    # First pass: find all impl blocks
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
    
    # Patterns for Rust definitions
    patterns = [
        (DefKind.FUNCTION, re.compile(r'^(\s*)(pub\s+)?(async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)')),
        (DefKind.STRUCT, re.compile(r'^(\s*)(pub\s+)?struct\s+([a-zA-Z_][a-zA-Z0-9_]*)')),
        (DefKind.ENUM, re.compile(r'^(\s*)(pub\s+)?enum\s+([a-zA-Z_][a-zA-Z0-9_]*)')),
        (DefKind.TYPE_ALIAS, re.compile(r'^(\s*)(pub\s+)?type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=')),
        (DefKind.IMPL_BLOCK, re.compile(r'^(\s*)impl\b')),
    ]
    
    def is_inside_impl(line_num: int) -> bool:
        """Check if a line is inside an impl block (but not the impl line itself)."""
        for start, end in impl_ranges:
            if start < line_num <= end:
                return True
        return False
    
    def find_definition_start(line_num: int) -> int:
        """Look backwards to find attributes that belong to this definition."""
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
        
        # Skip attribute-only or comment-only lines
        if stripped.startswith('#[') or stripped.startswith('//'):
            i += 1
            continue
        
        for kind, pattern in patterns:
            match = pattern.match(line)
            if match:
                groups = match.groups()
                
                # Skip standalone functions inside impl blocks
                if kind == DefKind.FUNCTION and is_inside_impl(i):
                    break
                
                name = None
                end_line = i
                actual_start = find_definition_start(i)
                
                if kind == DefKind.FUNCTION:
                    name = groups[3]
                    # Find brace
                    brace_line = None
                    for j in range(i, min(i + 15, len(lines))):
                        if '{' in lines[j]:
                            brace_line = j
                            break
                    if brace_line is not None:
                        end_line = find_matching_brace(lines, brace_line)
                    
                elif kind == DefKind.IMPL_BLOCK:
                    # Find the opening brace
                    brace_line = None
                    for j in range(i, min(i + 25, len(lines))):
                        if '{' in lines[j]:
                            brace_line = j
                            break
                    
                    if brace_line is None:
                        i += 1
                        break
                    
                    # Extract type and trait names
                    type_name, trait_name = extract_impl_type_name(lines, i, brace_line)
                    
                    if type_name is None:
                        i += 1
                        break
                    
                    # Generate unique name
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
                    # Could be unit struct (no brace) or regular struct
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
    
    # Extract imports
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('import '):
            index.imports.append(line)
    
    patterns = [
        # export function funcName or function funcName
        (DefKind.FUNCTION, r'^(\s*)(export\s+)?(async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]'),
        # export const funcName = (...) => or = function
        (DefKind.FUNCTION, r'^(\s*)(export\s+)?const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(async\s+)?\([^)]*\)\s*[=:]'),
        # interface InterfaceName
        (DefKind.INTERFACE, r'^(\s*)(export\s+)?interface\s+([a-zA-Z_][a-zA-Z0-9_]*)'),
        # type TypeName =
        (DefKind.TYPE_ALIAS, r'^(\s*)(export\s+)?type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*='),
        # class ClassName
        (DefKind.CLASS, r'^(\s*)(export\s+)?class\s+([a-zA-Z_][a-zA-Z0-9_]*)'),
        # export const CONST_NAME (all caps - likely constant)
        (DefKind.CONST, r'^(\s*)(export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*='),
    ]
    
    i = 0
    while i < len(lines):
        line = lines[i]
        
        for kind, pattern in patterns:
            match = re.match(pattern, line)
            if match:
                groups = match.groups()
                
                if kind == DefKind.FUNCTION:
                    if len(groups) == 4:
                        name = groups[3]
                    else:
                        name = groups[2]
                else:
                    name = groups[2]
                
                # Find end of definition
                if '{' in line:
                    end_line = find_matching_brace(lines, i)
                else:
                    found_brace = False
                    for j in range(i, min(i + 5, len(lines))):
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
    
    return index


def parse_python_file(filepath: str, lines: List[str]) -> FileIndex:
    """Parse Python file and extract definitions."""
    index = FileIndex(filepath=filepath, raw_lines=lines)
    
    # Extract imports
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
# INDEXING AND RESOLUTION
# ==============================================================================

def get_all_source_files(root_path: str) -> Tuple[List[str], List[str]]:
    """Get all source and config files."""
    source_files = []
    config_files = []
    
    print(f"[INFO] Indexing source files in {root_path}...")
    
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


def get_all_repo_files(root_path: str) -> List[str]:
    """Get all files in the repo (excluding ignored ones) for the file list."""
    all_files = []
    
    for root, dirs, files in os.walk(root_path):
        dirs[:] = [d for d in dirs if d not in DEFAULT_IGNORE_DIRS]
        
        for file in files:
            if file in IGNORE_FILES:
                continue
            
            full_path = os.path.join(root, file)
            rel_path = full_path.replace(root_path, "").lstrip(os.sep)
            all_files.append(rel_path)
    
    return sorted(all_files)


def build_definition_index(source_files: List[str]) -> Tuple[
    Dict[str, FileIndex], 
    Dict[str, List[Definition]], 
    Dict[str, List[str]],
    Dict[str, str]
]:
    """
    Build index of all definitions across files.
    
    Returns:
        - file_indices: filepath -> FileIndex
        - def_lookup: name -> [definitions]
        - type_to_impls: type_name -> [impl block names]
        - impl_to_type: impl_name -> type_name
    """
    file_indices: Dict[str, FileIndex] = {}
    def_lookup: Dict[str, List[Definition]] = {}
    type_to_impls: Dict[str, List[str]] = {}
    impl_to_type: Dict[str, str] = {}
    
    for filepath in source_files:
        index = parse_file(filepath)
        if index:
            file_indices[filepath] = index
            
            for name, definition in index.definitions.items():
                if not name:
                    continue
                    
                if name not in def_lookup:
                    def_lookup[name] = []
                def_lookup[name].append(definition)
                
                # Build type-to-impl mapping and extract methods
                if definition.kind == DefKind.IMPL_BLOCK:
                    # Extract the type name from impl block name
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
                        
                        # Extract and index individual methods
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
                            
                            # Also index by just method name
                            if method.name not in def_lookup:
                                def_lookup[method.name] = []
                            if not any(d.filepath == filepath and d.start_line == method_def.start_line 
                                      for d in def_lookup[method.name]):
                                def_lookup[method.name].append(method_def)
    
    return file_indices, def_lookup, type_to_impls, impl_to_type


def parse_log_roots(log_path: str) -> Set[str]:
    """Parse log file for root function names."""
    roots = set()
    if not os.path.exists(log_path):
        print(f"[WARN] Log file not found: {log_path}")
        return roots
    
    # Match: |CMD|funcName or |API|funcName
    pattern = re.compile(r"\|(CMD|API)\|([a-zA-Z_][a-zA-Z0-9_]*)")
    
    try:
        with open(log_path, 'r', encoding='utf-8') as f:
            for line in f:
                m = pattern.search(line)
                if m:
                    roots.add(m.group(2))
    except Exception as e:
        print(f"[WARN] Could not read log: {e}")
    
    return roots

def find_module_entry_points(project_root: str, def_lookup: Dict[str, List[Definition]]) -> Set[str]:
    """
    Find functions in lib.rs files that might be entry points.
    These are often re-exports or wrapper functions.
    """
    entry_points = set()
    
    for filepath, definitions in [(k, v) for k, v in def_lookup.items() if v]:
        for definition in definitions:
            # Check if this is a lib.rs file
            if definition.filepath.endswith('lib.rs'):
                if definition.kind == DefKind.FUNCTION:
                    # Extract just the function name (not qualified)
                    name = definition.name
                    if '::' in name:
                        name = name.split('::')[-1]
                    entry_points.add(name)
    
    return entry_points

def resolve_dependencies(
    roots: Set[str],
    def_lookup: Dict[str, List[Definition]],
    file_indices: Dict[str, FileIndex],
    type_to_impls: Dict[str, List[str]],
    max_depth: int
) -> Tuple[Dict[Tuple[str, str], Definition], Set[str], List[str]]:
    """
    Resolve all definitions needed.
    
    Returns: 
        - dict of (filepath, name) -> Definition
        - set of all called function/method names (for summarization)
        - list of validation warnings
    """
    all_func_names = set(k for k in def_lookup.keys() if k is not None)
    
    needed_defs: Dict[Tuple[str, str], Definition] = {}
    needed_types: Set[str] = set()
    called_methods: Set[str] = set()  # Track all method calls for summarization
    warnings: List[str] = []
    
    processed_funcs: Set[str] = set()
    processed_types: Set[str] = set()
    
    func_queue = list(roots)
    
    # Track unresolved function calls for validation
    unresolved_calls: Set[str] = set()
    
    for depth in range(max_depth + 1):
        print(f"[INFO] Resolving depth {depth}: {len(func_queue)} functions...")
        next_queue = []
        
        for func_name in func_queue:
            if func_name is None or func_name in processed_funcs:
                continue
            processed_funcs.add(func_name)
            called_methods.add(func_name)
            
            if func_name not in def_lookup:
                if func_name in roots:
                    unresolved_calls.add(func_name)
                continue
            
            for definition in def_lookup[func_name]:
                key = (definition.filepath, definition.name)
                needed_defs[key] = definition
                
                # Add type references
                for type_ref in definition.type_refs:
                    if type_ref and type_ref not in processed_types:
                        needed_types.add(type_ref)
                
                # ALWAYS analyze content for method calls (needed for summarization)
                # This is separate from queuing which respects max_depth
                calls = extract_function_calls(definition.content, all_func_names)
                for call in calls:
                    if call:
                        called_methods.add(call)
                
                # Static method calls: TypeName::method_name(
                static_pattern = r'\b([A-Z][a-zA-Z0-9_]*)\s*::\s*([a-z_][a-zA-Z0-9_]*)\s*\('
                static_matches = re.findall(static_pattern, definition.content)
                for type_name, method_name in static_matches:
                    if type_name not in processed_types:
                        needed_types.add(type_name)
                    qualified = f"{type_name}::{method_name}"
                    called_methods.add(qualified)
                    called_methods.add(method_name)
                
                # Instance method calls with type inference
                type_method_calls = infer_instance_method_calls(definition.content)
                for type_name, methods in type_method_calls.items():
                    if type_name not in processed_types:
                        needed_types.add(type_name)
                    for method_name in methods:
                        qualified = f"{type_name}::{method_name}"
                        called_methods.add(qualified)
                        called_methods.add(method_name)
                
                # Simple instance method calls (without type inference)
                instance_pattern = r'\.([a-z_][a-zA-Z0-9_]*)\s*\('
                instance_matches = re.findall(instance_pattern, definition.content)
                for method_name in instance_matches:
                    called_methods.add(method_name)
                
                # Only queue new functions if we haven't reached max depth
                if depth < max_depth:
                    for call in calls:
                        if call and call not in processed_funcs:
                            next_queue.append(call)
                    
                    for type_name, method_name in static_matches:
                        qualified = f"{type_name}::{method_name}"
                        if qualified not in processed_funcs:
                            next_queue.append(qualified)
                    
                    for type_name, methods in type_method_calls.items():
                        for method_name in methods:
                            qualified = f"{type_name}::{method_name}"
                            if qualified not in processed_funcs:
                                next_queue.append(qualified)
                    
                    for method_name in instance_matches:
                        if method_name not in processed_funcs and method_name in all_func_names:
                            next_queue.append(method_name)
        
        func_queue = next_queue
    
    # Resolve type definitions and their impl blocks
    print(f"[INFO] Resolving {len(needed_types)} type references...")
    type_queue = list(needed_types)
    
    while type_queue:
        type_name = type_queue.pop(0)
        if not type_name or type_name in processed_types:
            continue
        processed_types.add(type_name)
        
        lookup_names = [type_name]
        
        # Add all impl blocks for this type
        if type_name in type_to_impls:
            lookup_names.extend(type_to_impls[type_name])
        
        # Search for any impl blocks we might have missed
        for def_name in def_lookup.keys():
            if def_name is None:
                continue
            if def_name.startswith(f"impl_{type_name}") or def_name.endswith(f"_for_{type_name}"):
                if def_name not in lookup_names:
                    lookup_names.append(def_name)
        
        for lookup_name in lookup_names:
            if lookup_name and lookup_name in def_lookup:
                for definition in def_lookup[lookup_name]:
                    if definition.kind in (DefKind.STRUCT, DefKind.ENUM, DefKind.INTERFACE, 
                                           DefKind.TYPE_ALIAS, DefKind.CLASS, DefKind.IMPL_BLOCK):
                        key = (definition.filepath, definition.name)
                        needed_defs[key] = definition
                        
                        for nested_type in definition.type_refs:
                            if nested_type and nested_type not in processed_types:
                                type_queue.append(nested_type)
    
    # Validation warnings
    if unresolved_calls:
        warnings.append(f"Unresolved root functions: {', '.join(sorted(unresolved_calls))}")
    
    return needed_defs, called_methods, warnings

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


def detect_duplicates(defs_by_file: Dict[str, List[Definition]]) -> List[str]:
    """Detect duplicate definitions across files."""
    name_to_files: Dict[str, List[str]] = {}
    duplicates = []
    
    for filepath, definitions in defs_by_file.items():
        for d in definitions:
            if d.kind in (DefKind.STRUCT, DefKind.ENUM, DefKind.INTERFACE):
                if d.name not in name_to_files:
                    name_to_files[d.name] = []
                name_to_files[d.name].append(filepath)
    
    for name, files in name_to_files.items():
        if len(files) > 1:
            short_files = [f.split(os.sep)[-1] for f in files]
            duplicates.append(f"{name}: {', '.join(short_files)}")
    
    return duplicates


# ==============================================================================
# HELPER FUNCTIONS FOR TEMPLATE
# ==============================================================================

def read_file_safe(filepath: str, default: str = "") -> str:
    """Safely read a file, return default if not found."""
    if not os.path.exists(filepath):
        print(f"[WARN] File not found: {filepath}, using empty string")
        return default
    
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        print(f"[WARN] Could not read {filepath}: {e}, using empty string")
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


# ==============================================================================
# OUTPUT GENERATION
# ==============================================================================

def write_legend(out, output_mode: str):
    """Write the legend/introduction explaining the format."""
    out.write("""================================================================================
                        AI CONTEXT BUNDLE - USAGE GUIDE
================================================================================

PURPOSE: This bundle provides extracted source code context for AI analysis.
It contains only the code definitions relevant to a traced execution path,
reducing noise while preserving the information needed to understand the system.

EXTRACTION METHOD:
- Root functions identified from application logs (CMD|funcName, API|funcName)
- Dependencies traced to MAX_DEPTH levels of function calls
- Type definitions (structs, enums, interfaces) included for referenced types
- Impl blocks included for all referenced types

""")
    
    if output_mode == "summarized":
        out.write("""OUTPUT MODE: SUMMARIZED
- Large impl blocks show FULL BODIES only for methods actually called
- Other methods show SIGNATURES ONLY (name + parameters + return type)
- This significantly reduces size while preserving the critical execution path

READING SUMMARIZED IMPL BLOCKS:
```
// [IMPL] impl_TypeName (lines X-Y)
// [SUMMARIZED: N methods with bodies, M signatures only]
impl TypeName {
    // === CALLED METHODS (full implementation) ===
    // These methods are in the traced call chain - read carefully
    pub fn called_method(&self) -> Result { ... full body ... }

    // === OTHER METHODS (M signatures) ===
    // These exist but weren't called - signatures for reference only
    pub fn other_method(&self, param: Type) -> ReturnType;
}
```

""")
    else:
        out.write("""OUTPUT MODE: FULL
- All impl blocks included with complete method bodies
- No summarization applied - maximum detail for deep analysis

""")
    
    out.write("""DEFINITION MARKERS:
  // [FUNCTION] name (lines X-Y)     - Standalone function
  // [STRUCT] name (lines X-Y)       - Struct definition  
  // [ENUM] name (lines X-Y)         - Enum definition
  // [INTERFACE] name (lines X-Y)    - TypeScript interface
  // [IMPL] impl_Type (lines X-Y)    - Rust impl block
  // [TYPE] name (lines X-Y)         - Type alias
  // [CLASS] name (lines X-Y)        - Class definition

IMPORTS:
  "// Relevant imports:" shows filtered imports (framework noise like std::, 
  serde::, react removed for clarity)

DUPLICATE DETECTION:
  Types appearing in multiple files listed in EXTRACTION NOTES section.
  Common pattern: Backend (Rust) and Frontend (TypeScript) share API types
  for serialization boundaries.

CONFIGURATION FILES:
  Cargo.toml, package.json, tsconfig.json provide dependency and build context.

HOW TO USE THIS BUNDLE:
1. Start with the root functions (from logs) to understand entry points
2. Follow the call chain through included function bodies
3. Reference type definitions when encountering unfamiliar structs/enums
4. Use impl blocks to understand available methods on types
5. Check config files for dependency versions and project structure

================================================================================

""")


def generate_code_content(
    needed_defs: Dict[Tuple[str, str], Definition],
    file_indices: Dict[str, FileIndex],
    config_files: List[str],
    called_methods: Set[str],
    project_root: str,
    warnings: List[str],
    impl_to_type: Dict[str, str],
    output_mode: str
) -> Tuple[str, Dict]:
    """
    Generate the code content portion (what goes in {<content>}).
    Returns (content_string, stats_dict)
    """
    from io import StringIO
    
    out = StringIO()
    
    # Group definitions by file
    defs_by_file: Dict[str, List[Definition]] = {}
    for key, definition in needed_defs.items():
        filepath = definition.filepath
        if filepath not in defs_by_file:
            defs_by_file[filepath] = []
        defs_by_file[filepath].append(definition)
    
    # Sort definitions within each file by line number
    for filepath in defs_by_file:
        defs_by_file[filepath].sort(key=lambda x: x.start_line)
    
    # Remove definitions that are fully contained within other definitions
    for filepath in defs_by_file:
        definitions = defs_by_file[filepath]
        filtered = []
        for d in definitions:
            is_contained = False
            for other in definitions:
                if d is not other:
                    if (other.start_line <= d.start_line and 
                        d.end_line <= other.end_line and
                        not (other.start_line == d.start_line and other.end_line == d.end_line)):
                        is_contained = True
                        break
            if not is_contained:
                filtered.append(d)
        defs_by_file[filepath] = filtered
    
    # Detect duplicates
    duplicates = detect_duplicates(defs_by_file)
    
    # Calculate stats
    total_defs = sum(len(defs) for defs in defs_by_file.values())
    
    # Track summarization stats
    summarized_count = 0
    total_methods_included = 0
    total_methods_signature_only = 0
    
    # Build type -> methods map for summary section
    type_calls: Dict[str, Set[str]] = {}
    for m in called_methods:
        if '::' in m:
            t, method = m.rsplit('::', 1)
            if t not in type_calls:
                type_calls[t] = set()
            type_calls[t].add(method)
    
    # Write legend first
    write_legend(out, output_mode)
    
    # Write header
    out.write(f"SMART CONTEXT BUNDLE (Function-Level Extraction)\n")
    out.write(f"Mode: {output_mode.upper()} | Max Depth: {MAX_DEPTH} | Files: {len(defs_by_file)} | ")
    out.write(f"Definitions: {total_defs}\n")
    out.write("=" * 60 + "\n\n")
    
    # Write warnings and duplicates
    if warnings or duplicates:
        out.write("### EXTRACTION NOTES ###\n\n")
        for w in warnings:
            out.write(f"[WARN] {w}\n")
        if duplicates:
            out.write(f"[INFO] Duplicate definitions found in multiple files:\n")
            for dup in duplicates:
                out.write(f"  - {dup}\n")
        out.write("\n")
    
    # Write method call summary for summarized mode
    if output_mode == "summarized" and type_calls:
        out.write("### METHOD CALL SUMMARY ###\n\n")
        out.write("Methods detected as called (full bodies in impl blocks):\n\n")
        for type_name in sorted(type_calls.keys()):
            methods = sorted(type_calls[type_name])
            out.write(f"  {type_name}: {', '.join(methods)}\n")
        out.write("\n")
    
    # Write Critical Configs
    out.write("### CRITICAL CONFIGURATION FILES ###\n\n")
    for conf_path in config_files:
        rel_path = conf_path.replace(project_root, "").lstrip(os.sep)
        out.write(f"FILE: {rel_path}\n")
        out.write("-" * 50 + "\n")
        try:
            with open(conf_path, 'r', encoding='utf-8') as f:
                out.write(f.read())
        except:
            out.write("[Error reading file]")
        out.write(f"\n\n")
    
    out.write("=" * 60 + "\n\n")
    
    # Write Extracted Definitions
    out.write("### EXTRACTED DEFINITIONS ###\n\n")
    
    for filepath in sorted(defs_by_file.keys()):
        definitions = defs_by_file[filepath]
        rel_path = filepath.replace(project_root, "").lstrip(os.sep)
        ext = os.path.splitext(filepath)[1]
        
        out.write(f"FILE: {rel_path}\n")
        out.write("-" * 50 + "\n")
        
        # Write relevant imports
        if filepath in file_indices:
            file_index = file_indices[filepath]
            needed_names = set(d.name for d in definitions)
            for d in definitions:
                needed_names.update(d.type_refs)
            
            filtered_imports = filter_imports(file_index.imports, ext, needed_names)
            if filtered_imports:
                out.write("// Relevant imports:\n")
                for imp in filtered_imports:
                    out.write(imp + "\n")
                out.write("\n")
        
        # Write each definition
        for definition in definitions:
            kind_label = definition.kind.value.upper()
            line_count = definition.end_line - definition.start_line + 1
            
            # Check if this is a large impl block that should be summarized
            should_summarize = (
                output_mode == "summarized" and
                definition.kind == DefKind.IMPL_BLOCK and 
                line_count > IMPL_SUMMARIZE_THRESHOLD and
                definition.name in impl_to_type
            )
            
            if should_summarize:
                type_name = impl_to_type[definition.name]
                summarized_content, included, sig_only = create_summarized_impl(
                    definition, called_methods, type_name
                )
                
                summarized_count += 1
                total_methods_included += included
                total_methods_signature_only += sig_only
                
                out.write(f"// [{kind_label}] {definition.name} (lines {definition.start_line + 1}-{definition.end_line + 1})\n")
                out.write(f"// [SUMMARIZED: {included} methods with bodies, {sig_only} signatures only]\n")
                out.write(summarized_content)
                out.write("\n\n")
            else:
                # Normal output
                out.write(f"// [{kind_label}] {definition.name} (lines {definition.start_line + 1}-{definition.end_line + 1})\n")
                out.write(definition.content)
                out.write("\n\n")
        
        out.write("=" * 60 + "\n\n")
    
    stats = {
        'files': len(defs_by_file),
        'definitions': total_defs,
        'summarized_count': summarized_count,
        'total_methods_included': total_methods_included,
        'total_methods_signature_only': total_methods_signature_only,
        'warnings': len(warnings),
        'duplicates': len(duplicates)
    }
    
    return out.getvalue(), stats


def generate_output(
    needed_defs: Dict[Tuple[str, str], Definition],
    file_indices: Dict[str, FileIndex],
    config_files: List[str],
    called_methods: Set[str],
    project_root: str,
    output_file: str,
    warnings: List[str],
    impl_to_type: Dict[str, str],
    output_mode: str
):
    """Generate the optimized context bundle using template."""
    
    # Get script directory
    script_dir = os.path.dirname(os.path.abspath(__file__))
    
    # Read template
    template_path = os.path.join(script_dir, TEMPLATE_FILE)
    template = read_file_safe(template_path, "# SELECTED CODE TERRITORY\n{<content>}")
    
    # Read intro and task
    intro_path = os.path.join(script_dir, INTRO_FILE)
    task_path = os.path.join(script_dir, TASK_FILE)
    
    intro_content = read_file_safe(intro_path, "")
    task_content = read_file_safe(task_path, "")
    
    # Generate file list
    all_files = get_all_repo_files(project_root)
    files_content = ", ".join(all_files)
    
    # Generate code content
    code_content, stats = generate_code_content(
        needed_defs, file_indices, config_files, called_methods,
        project_root, warnings, impl_to_type, output_mode
    )
    
    # Inject into template
    final_output = template
    final_output = final_output.replace("{<intro>}", intro_content)
    final_output = final_output.replace("{<files>}", files_content)
    final_output = final_output.replace("{<task>}", task_content)
    final_output = final_output.replace("{<content>}", code_content)
    
    # Write to file
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(final_output)
    
    # Calculate final line count
    total_lines = final_output.count('\n')
    
    print(f"\n[SUCCESS] Saved context bundle to: {output_file}")
    print(f"[STATS] {stats['files']} files, {stats['definitions']} definitions, {total_lines} lines")
    print(f"[MODE] {output_mode.upper()}")
    
    if output_mode == "summarized" and stats['summarized_count'] > 0:
        print(f"[SUMMARY] {stats['summarized_count']} impl blocks summarized:")
        print(f"          {stats['total_methods_included']} methods with full bodies")
        print(f"          {stats['total_methods_signature_only']} methods as signatures only")
    
    if stats['warnings']:
        print(f"[WARN] {stats['warnings']} warning(s) - check output file header")
    if stats['duplicates']:
        print(f"[INFO] {stats['duplicates']} duplicate definition(s) found across files")
    
    # Copy to clipboard
    copy_to_clipboard(final_output)


# ==============================================================================
# MAIN
# ==============================================================================

def main():
    global OUTPUT_MODE
    
    # Check for command-line mode override
    if len(sys.argv) > 1:
        if sys.argv[1] in ("full", "summarized"):
            OUTPUT_MODE = sys.argv[1]
        elif sys.argv[1] in ("-h", "--help"):
            print("Smart Context Extractor V3")
            print()
            print("Usage: python context_extractor_v3.py [mode]")
            print()
            print("Modes:")
            print("  full        Include complete impl blocks with all method bodies")
            print("  summarized  Include only called methods, signatures for others (default)")
            print()
            print("Configuration (edit script to change):")
            print(f"  LOG_FILE_PATH: {LOG_FILE_PATH}")
            print(f"  PROJECT_ROOT:  {PROJECT_ROOT}")
            print(f"  OUTPUT_FILE:   {OUTPUT_FILE}")
            print(f"  MAX_DEPTH:     {MAX_DEPTH}")
            return
    
    print("--> Starting Smart Context Extractor V3 (Function-Level)")
    print(f"    Project: {PROJECT_ROOT}")
    print(f"    Log: {LOG_FILE_PATH}")
    print(f"    Max Depth: {MAX_DEPTH}")
    print(f"    Output Mode: {OUTPUT_MODE}")
    print()
    
    # 1. Index all source files
    source_files, config_files = get_all_source_files(PROJECT_ROOT)
    print(f"[INFO] Found {len(source_files)} source files, {len(config_files)} config files")
    
    # 2. Parse and index all definitions
    file_indices, def_lookup, type_to_impls, impl_to_type = build_definition_index(source_files)
    total_defs = sum(len(defs) for defs in def_lookup.values())
    print(f"[INFO] Indexed {total_defs} definitions across {len(file_indices)} files")
    print(f"[INFO] Found {len(type_to_impls)} types with impl blocks")
    
    # Show some impl block stats
    impl_types = list(type_to_impls.keys())[:5]
    if impl_types:
        print(f"[INFO] Types with impls: {', '.join(impl_types)}{'...' if len(type_to_impls) > 5 else ''}")
    
    # 3. Parse log for root functions
    log_roots = parse_log_roots(LOG_FILE_PATH)
    if log_roots:
        roots_preview = list(log_roots)[:8]
        print(f"[INFO] Log roots ({len(log_roots)}): {', '.join(roots_preview)}{'...' if len(log_roots) > 8 else ''}")
    else:
        print("[WARN] No root functions found in log!")
        return
    
    # 4. Resolve all needed definitions
    needed_defs, called_methods, warnings = resolve_dependencies(
        log_roots, def_lookup, file_indices, type_to_impls, MAX_DEPTH
    )
    print(f"[INFO] Resolved {len(needed_defs)} definitions to extract")
    print(f"[INFO] Tracked {len(called_methods)} method calls for summarization")
    
    # Enhanced debug output
    if OUTPUT_MODE == "summarized":
        # Show qualified method calls (Type::method)
        qualified = sorted([m for m in called_methods if '::' in m])
        if qualified:
            print(f"[DEBUG] Qualified method calls ({len(qualified)}):")
            for q in qualified[:15]:
                print(f"         - {q}")
            if len(qualified) > 15:
                print(f"         ... and {len(qualified) - 15} more")
        
        # Show which types have tracked method calls
        type_calls: Dict[str, Set[str]] = {}
        for m in called_methods:
            if '::' in m:
                t, method = m.rsplit('::', 1)
                if t not in type_calls:
                    type_calls[t] = set()
                type_calls[t].add(method)
        
        if type_calls:
            print(f"[DEBUG] Methods by type:")
            for t in sorted(type_calls.keys())[:10]:
                methods = sorted(type_calls[t])[:5]
                more = f" +{len(type_calls[t]) - 5}" if len(type_calls[t]) > 5 else ""
                print(f"         {t}: {', '.join(methods)}{more}")
    
    # 5. Generate output
    generate_output(
        needed_defs, file_indices, config_files, called_methods,
        PROJECT_ROOT, OUTPUT_FILE, warnings, impl_to_type, OUTPUT_MODE
    )


if __name__ == "__main__":
    main()