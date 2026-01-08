"""
diagnose_ts_parsing.py - Diagnostic tool for TypeScript/React parsing

This script analyzes TypeScript/TSX files and shows exactly what definitions
are being extracted, helping identify parsing gaps.

Usage:
    python diagnose_ts_parsing.py                    # Analyze all TS/TSX files
    python diagnose_ts_parsing.py path/to/file.tsx  # Analyze specific file
    python diagnose_ts_parsing.py --hooks           # Focus on hook analysis
    python diagnose_ts_parsing.py --summary         # Just show summary stats
"""

import os
import re
import sys
from dataclasses import dataclass, field
from typing import Set, Dict, List, Optional, Tuple
from enum import Enum


# ==============================================================================
# CONFIGURATION - Update these paths for your project
# ==============================================================================
PROJECT_ROOT = r"C:\Dropbox\Projekt\Calcula"

DEFAULT_IGNORE_DIRS = {
    "node_modules", ".git", "__pycache__", "venv", ".venv", "env", "target",
    ".idea", ".vscode", "dist", "build", "__tests__", ".next", "coverage"
}

SOURCE_EXTENSIONS = ('.ts', '.tsx', '.js', '.jsx')


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
    HOOK_CALLBACK = "hook_callback"
    HOOK_MEMO = "hook_memo"
    HOOK_EFFECT = "hook_effect"
    REACT_COMPONENT = "react_component"


@dataclass
class Definition:
    kind: DefKind
    name: str
    filepath: str
    start_line: int
    end_line: int
    content: str
    parent: Optional[str] = None
    namespaced_name: Optional[str] = None
    type_refs: Set[str] = field(default_factory=set)
    func_calls: Set[str] = field(default_factory=set)


@dataclass 
class FileAnalysis:
    filepath: str
    definitions: List[Definition] = field(default_factory=list)
    imports: List[str] = field(default_factory=list)
    hooks_found: List[str] = field(default_factory=list)
    components_found: List[str] = field(default_factory=list)
    issues: List[str] = field(default_factory=list)


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


def is_react_component(name: str, content: str) -> bool:
    """Check if a function appears to be a React component."""
    # Name starts with uppercase (React convention)
    if not name[0].isupper():
        return False
    
    # Contains JSX
    if re.search(r'<[A-Z][a-zA-Z]*|<div|<span|<button|<input', content):
        return True
    
    # Returns JSX
    if re.search(r'return\s*\(?\s*<', content):
        return True
    
    return False


# ==============================================================================
# MAIN PARSER
# ==============================================================================

def analyze_typescript_file(filepath: str) -> FileAnalysis:
    """Analyze a TypeScript/TSX file and extract all definitions."""
    
    analysis = FileAnalysis(filepath=filepath)
    
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
            lines = content.split('\n')
    except Exception as e:
        analysis.issues.append(f"Could not read file: {e}")
        return analysis
    
    # Extract imports
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('import '):
            analysis.imports.append(stripped)
    
    # Top-level patterns
    patterns = [
        # Standard function declarations
        (DefKind.FUNCTION, r'^(\s*)(export\s+)?(async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]', 4),
        # React.forwardRef components
        (DefKind.REACT_COMPONENT, r'^(\s*)(export\s+)?const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:React\.)?forwardRef', 3),
        # React.memo components  
        (DefKind.REACT_COMPONENT, r'^(\s*)(export\s+)?const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:React\.)?memo', 3),
        # Typed React components: const Name: React.FC<Props> =
        (DefKind.REACT_COMPONENT, r'^(\s*)(export\s+)?const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*React\.(?:FC|FunctionComponent)', 3),
        # Arrow function assigned to const
        (DefKind.FUNCTION, r'^(\s*)(export\s+)?const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(async\s+)?\([^)]*\)\s*[=:]', 3),
        (DefKind.FUNCTION, r'^(\s*)(export\s+)?const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(async\s+)?function', 3),
        # Arrow function with generic type parameter
        (DefKind.FUNCTION, r'^(\s*)(export\s+)?const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*<[^>]+>\s*\(', 3),
        # Interface
        (DefKind.INTERFACE, r'^(\s*)(export\s+)?interface\s+([a-zA-Z_][a-zA-Z0-9_]*)', 3),
        # Type alias
        (DefKind.TYPE_ALIAS, r'^(\s*)(export\s+)?type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[=<]', 3),
        # Class
        (DefKind.CLASS, r'^(\s*)(export\s+)?class\s+([a-zA-Z_][a-zA-Z0-9_]*)', 3),
        # SCREAMING_CASE const
        (DefKind.CONST, r'^(\s*)(export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=', 3),
    ]
    
    definitions_by_name: Dict[str, Definition] = {}
    
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
                
                # Check if this is actually a React component
                actual_kind = kind
                if kind == DefKind.FUNCTION and is_react_component(name, def_content):
                    actual_kind = DefKind.REACT_COMPONENT
                    analysis.components_found.append(name)
                
                definition = Definition(
                    kind=actual_kind,
                    name=name,
                    filepath=filepath,
                    start_line=i,
                    end_line=end_line,
                    content=def_content
                )
                
                definitions_by_name[name] = definition
                analysis.definitions.append(definition)
                
                i = end_line
                break
        
        i += 1
    
    # Second pass: Extract hook inner functions
    extract_hook_definitions(analysis, definitions_by_name, lines)
    
    return analysis


def extract_hook_definitions(analysis: FileAnalysis, definitions: Dict[str, Definition], lines: List[str]):
    """Extract useCallback, useMemo, useEffect definitions from hooks."""
    
    # Patterns for hook-based function definitions
    hook_patterns = [
        (re.compile(r'^(\s+)const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*useCallback\s*\('), DefKind.HOOK_CALLBACK),
        (re.compile(r'^(\s+)const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*useMemo\s*\('), DefKind.HOOK_MEMO),
    ]
    
    use_effect_pattern = re.compile(r'^(\s+)useEffect\s*\(\s*(?:async\s*)?\(\s*\)\s*=>')
    
    # fnLog pattern for namespace detection
    fnlog_pattern = re.compile(r'''fnLog\.enter\s*\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)['"]''')
    
    for parent_name, parent_def in list(definitions.items()):
        if parent_def.kind not in (DefKind.FUNCTION, DefKind.REACT_COMPONENT):
            continue
        
        # Check if this looks like a hook
        if parent_name.startswith('use') and parent_name[3:4].isupper():
            analysis.hooks_found.append(parent_name)
        
        inner_lines = parent_def.content.split('\n')
        
        # Collect fnLog namespace mappings
        log_namespace_map: Dict[str, str] = {}
        for inner_line in inner_lines:
            fnlog_match = fnlog_pattern.search(inner_line)
            if fnlog_match:
                namespace = fnlog_match.group(1)
                func_name = fnlog_match.group(2)
                log_namespace_map[func_name] = f"{namespace}.{func_name}"
        
        effect_counter = 0
        
        j = 0
        while j < len(inner_lines):
            inner_line = inner_lines[j]
            
            inner_name = None
            hook_kind = None
            
            # Check for useCallback/useMemo
            for pattern, kind in hook_patterns:
                match = pattern.match(inner_line)
                if match:
                    inner_name = match.group(2)
                    hook_kind = kind
                    break
            
            # Check for useEffect
            if not inner_name:
                effect_match = use_effect_pattern.match(inner_line)
                if effect_match:
                    effect_counter += 1
                    inner_name = f"effect" if effect_counter == 1 else f"effect_{effect_counter}"
                    hook_kind = DefKind.HOOK_EFFECT
            
            if inner_name and hook_kind:
                # Find end of hook
                inner_start = j
                brace_line = None
                
                for k in range(j, min(j + 15, len(inner_lines))):
                    if '{' in inner_lines[k]:
                        brace_line = k
                        break
                
                if brace_line is not None:
                    inner_end = find_matching_brace(inner_lines, brace_line)
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
                
                # Determine namespaced name
                if inner_name in log_namespace_map:
                    namespaced = log_namespace_map[inner_name]
                else:
                    namespaced = f"{parent_name}.{inner_name}"
                
                inner_def = Definition(
                    kind=hook_kind,
                    name=inner_name,
                    filepath=parent_def.filepath,
                    start_line=parent_def.start_line + inner_start,
                    end_line=parent_def.start_line + inner_end,
                    content=inner_content,
                    parent=parent_name,
                    namespaced_name=namespaced
                )
                
                analysis.definitions.append(inner_def)
                
                j = inner_end + 1
                continue
            
            j += 1


# ==============================================================================
# OUTPUT FORMATTING
# ==============================================================================

def print_file_analysis(analysis: FileAnalysis, verbose: bool = True):
    """Print analysis results for a single file."""
    
    rel_path = analysis.filepath.replace(PROJECT_ROOT, "").lstrip(os.sep)
    
    print(f"\n{'='*70}")
    print(f"FILE: {rel_path}")
    print(f"{'='*70}")
    
    if analysis.issues:
        print("\n[ISSUES]")
        for issue in analysis.issues:
            print(f"  - {issue}")
    
    # Group definitions by kind
    by_kind: Dict[DefKind, List[Definition]] = {}
    for d in analysis.definitions:
        if d.kind not in by_kind:
            by_kind[d.kind] = []
        by_kind[d.kind].append(d)
    
    # Print summary
    print(f"\n[SUMMARY]")
    print(f"  Total definitions: {len(analysis.definitions)}")
    for kind in DefKind:
        if kind in by_kind:
            print(f"  - {kind.value}: {len(by_kind[kind])}")
    
    if analysis.hooks_found:
        print(f"  Hooks detected: {', '.join(analysis.hooks_found)}")
    
    if analysis.components_found:
        print(f"  React components: {', '.join(analysis.components_found)}")
    
    if verbose:
        # Print each definition
        print(f"\n[DEFINITIONS]")
        
        for kind in [DefKind.REACT_COMPONENT, DefKind.FUNCTION, DefKind.HOOK_CALLBACK, 
                     DefKind.HOOK_MEMO, DefKind.HOOK_EFFECT, DefKind.INTERFACE,
                     DefKind.TYPE_ALIAS, DefKind.CLASS, DefKind.CONST]:
            if kind not in by_kind:
                continue
            
            print(f"\n  {kind.value.upper()}S:")
            for d in sorted(by_kind[kind], key=lambda x: x.start_line):
                line_info = f"L{d.start_line + 1}-{d.end_line + 1}"
                
                if d.parent:
                    print(f"    - {d.name} ({line_info}) [parent: {d.parent}]")
                    if d.namespaced_name:
                        print(f"      --> Namespaced: {d.namespaced_name}")
                else:
                    print(f"    - {d.name} ({line_info})")


def print_summary(all_analyses: List[FileAnalysis]):
    """Print overall summary of all files."""
    
    print(f"\n{'='*70}")
    print("OVERALL SUMMARY")
    print(f"{'='*70}")
    
    total_defs = 0
    total_by_kind: Dict[DefKind, int] = {}
    all_hooks: Set[str] = set()
    all_components: Set[str] = set()
    files_with_issues: List[str] = []
    
    for analysis in all_analyses:
        total_defs += len(analysis.definitions)
        all_hooks.update(analysis.hooks_found)
        all_components.update(analysis.components_found)
        
        if analysis.issues:
            files_with_issues.append(analysis.filepath)
        
        for d in analysis.definitions:
            total_by_kind[d.kind] = total_by_kind.get(d.kind, 0) + 1
    
    print(f"\nFiles analyzed: {len(all_analyses)}")
    print(f"Total definitions: {total_defs}")
    
    print(f"\nBy type:")
    for kind in DefKind:
        if kind in total_by_kind:
            print(f"  - {kind.value}: {total_by_kind[kind]}")
    
    print(f"\nHooks found ({len(all_hooks)}):")
    for hook in sorted(all_hooks):
        print(f"  - {hook}")
    
    print(f"\nReact components found ({len(all_components)}):")
    for comp in sorted(all_components)[:20]:
        print(f"  - {comp}")
    if len(all_components) > 20:
        print(f"  ... and {len(all_components) - 20} more")
    
    if files_with_issues:
        print(f"\nFiles with issues ({len(files_with_issues)}):")
        for f in files_with_issues:
            print(f"  - {f}")


def find_missing_patterns(all_analyses: List[FileAnalysis]):
    """Analyze files to find patterns that might be missed."""
    
    print(f"\n{'='*70}")
    print("POTENTIAL MISSING PATTERNS")
    print(f"{'='*70}")
    
    # Patterns that might indicate missed definitions
    suspicious_patterns = [
        (r'export\s+default\s+function\s+(\w+)', "Default exported function"),
        (r'export\s+default\s+(\w+)', "Default export"),
        (r'const\s+(\w+)\s*=\s*\(\s*\{[^}]+\}\s*\)\s*=>', "Destructured arrow function"),
        (r'const\s+(\w+)\s*=\s*styled\.\w+', "Styled component"),
        (r'const\s+(\w+)\s*=\s*createContext', "React context"),
        (r'const\s+(\w+)\s*=\s*createSlice', "Redux slice"),
        (r'export\s+const\s+(\w+)\s*=\s*\(\s*\)', "Zero-param arrow function"),
    ]
    
    for analysis in all_analyses:
        try:
            with open(analysis.filepath, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
        except:
            continue
        
        defined_names = {d.name for d in analysis.definitions}
        rel_path = analysis.filepath.replace(PROJECT_ROOT, "").lstrip(os.sep)
        
        found_suspicious = []
        for pattern, desc in suspicious_patterns:
            matches = re.findall(pattern, content)
            for match in matches:
                if match not in defined_names and not match.startswith('_'):
                    found_suspicious.append((match, desc))
        
        if found_suspicious:
            print(f"\n{rel_path}:")
            for name, desc in found_suspicious[:5]:
                print(f"  ? {name} - {desc}")
            if len(found_suspicious) > 5:
                print(f"  ... and {len(found_suspicious) - 5} more")


# ==============================================================================
# MAIN
# ==============================================================================

def get_all_ts_files(root_path: str) -> List[str]:
    """Get all TypeScript/TSX files in the project."""
    files = []
    
    for root, dirs, filenames in os.walk(root_path):
        dirs[:] = [d for d in dirs if d not in DEFAULT_IGNORE_DIRS]
        
        for filename in filenames:
            if filename.endswith(SOURCE_EXTENSIONS):
                files.append(os.path.join(root, filename))
    
    return files


def main():
    args = sys.argv[1:]
    
    # Parse arguments
    verbose = '--summary' not in args
    hooks_only = '--hooks' in args
    specific_file = None
    
    for arg in args:
        if not arg.startswith('--') and os.path.exists(arg):
            specific_file = arg
            break
    
    print("TypeScript/React Parsing Diagnostic Tool")
    print(f"Project root: {PROJECT_ROOT}")
    print()
    
    if specific_file:
        # Analyze single file
        print(f"Analyzing: {specific_file}")
        analysis = analyze_typescript_file(specific_file)
        print_file_analysis(analysis, verbose=True)
    else:
        # Analyze all files
        files = get_all_ts_files(PROJECT_ROOT)
        print(f"Found {len(files)} TypeScript/TSX files")
        
        all_analyses = []
        for filepath in files:
            analysis = analyze_typescript_file(filepath)
            all_analyses.append(analysis)
            
            # Filter for hooks if requested
            if hooks_only:
                if analysis.hooks_found or any(d.kind in (DefKind.HOOK_CALLBACK, DefKind.HOOK_MEMO, DefKind.HOOK_EFFECT) for d in analysis.definitions):
                    print_file_analysis(analysis, verbose=verbose)
            elif verbose:
                # Only print files with definitions
                if analysis.definitions:
                    print_file_analysis(analysis, verbose=True)
        
        # Print summary
        print_summary(all_analyses)
        
        # Find missing patterns
        find_missing_patterns(all_analyses)


if __name__ == "__main__":
    main()