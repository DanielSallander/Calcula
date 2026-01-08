import os
import sys
import argparse
import re
import subprocess
from collections import defaultdict

# --- CONFIGURATION ---

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
    ".DS_Store", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "scopes.json"
}

CRITICAL_CONFIGS = [
    "package.json", "Cargo.toml", "tsconfig.json", "pyproject.toml"
]

VALID_EXTENSIONS = {
    ".py", ".js", ".ts", ".jsx", ".tsx", ".md", ".rs", ".css", 
    ".json", ".toml", ".yaml", ".yml"
}

# File role classification patterns
FILE_ROLES = {
    "component": [r"components?/", r"\.tsx$", r"\.jsx$"],
    "hook": [r"hooks?/", r"^use[A-Z]"],
    "utility": [r"utils?/", r"helpers?/", r"lib/"],
    "types": [r"types?\.ts$", r"\.d\.ts$", r"interfaces?/"],
    "api": [r"api/", r"services?/", r"commands?\.rs$"],
    "state": [r"store/", r"state/", r"redux/", r"zustand"],
    "config": [r"config", r"\.toml$", r"\.json$"],
    "test": [r"test", r"spec", r"\.test\.", r"\.spec\."],
}

# --- TEMPLATES ---

DEFAULT_SCAN_TEMPLATE = """# PROJECT CONTEXT
{intro}

# CURRENT TASK
{task}

# PROJECT SKELETON
Below is a mapped summary of the codebase.
Format: FilePath [Role] -> Description | Exports: [...] | Imports: [...] | UsedBy: [...] | Signatures

Legend:
- [Role]: component, hook, utility, types, api, state, config
- Exports: What this file exposes to others (types, functions, components)
- Imports: What this file depends on (local project files only)
- UsedBy: Which files import THIS file (reverse dependencies)
- Signatures: Key function/class/struct definitions with types

---------------------------------------------------------
{content}
---------------------------------------------------------

# TYPE DEFINITION INDEX
Quick reference for where types/interfaces are defined:
{type_index}

# INSTRUCTIONS
1. Analyze the "Project Skeleton" above. Pay attention to:
   - "UsedBy" to understand impact of changes
   - "Exports" to find where types/functions are defined
   - "Type Definition Index" for quick type lookups
2. Based on the Current Task, identify ALL files that need to be read or modified.
   - Include files in "UsedBy" if you are changing exports
   - Include files in "Imports" if you need their type definitions
3. Return the build command with the comma-separated list of these files.
   Format: "python context_manager.py build --files path/to/file1.ts,path/to/file2.rs"
"""

DEFAULT_BUILD_TEMPLATE = """# PROJECT CONTEXT
{intro}

# CURRENT TASK
{task}

# SELECTED CODE TERRITORY
Below is the content of the files selected for this task.
(Note: Critical config files are auto-included if present).
---------------------------------------------------------
{content}
---------------------------------------------------------

# FULL PROJECT INDEX
Below is a list of every file in the repository for reference.
Use this to check for missing dependencies or relative import paths.
---------------------------------------------------------
{files}
---------------------------------------------------------

# INSTRUCTIONS
**STEP 1: SANITY CHECK**
Before writing any code, ask yourself: "Do I see all the file definitions needed to solve the task?"
* Check for missing Type definitions (look at the Index).
* Check for missing API calls (look at the Index).

**STEP 2: DECISION**
* **IF files are missing:**
    STOP immediately. Return ONLY the build command with the *combined* list of current files plus the missing ones.
    Format: "python context_manager.py build --files <current_files>,<missing_file_1>"

* **IF context is complete:**
    Proceed to implement the requested changes.
    1. If you modify a file, you MUST update its top-level docstring/comment.
    2. Provide the full functional block or file (no " // ... rest of code ").
"""

# --- UTILS ---

def get_script_dir():
    return os.path.dirname(os.path.abspath(__file__))

def get_project_root():
    return os.path.abspath(os.path.join(get_script_dir(), ".."))

def get_ignore_dirs():
    ignore = DEFAULT_IGNORE_DIRS.copy()
    ignore.add(os.path.basename(get_script_dir()))
    return ignore

def copy_to_clipboard(text):
    try:
        process = subprocess.Popen('clip', stdin=subprocess.PIPE, shell=True)
        process.communicate(input=text.encode('utf-16'))
        print("--> [OK] Output copied to clipboard.")
    except Exception:
        print("--> [Note] Could not copy to clipboard.")

def read_text_file(filename):
    filepath = os.path.join(get_script_dir(), filename)
    if os.path.exists(filepath):
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                return f.read().strip()
        except:
            pass
    return ""

def load_template(template_name, default_content):
    return read_text_file(template_name) or default_content

def render_template(template_name, default_content, **kwargs):
    template = load_template(template_name, default_content)
    
    intro = read_text_file("intro.txt")
    task = read_text_file("task.txt")
    
    if "{roadmap}" in template:
        roadmap = read_text_file("roadmap.txt") or "(No roadmap provided)"
        template = template.replace("{roadmap}", roadmap)
    
    final_output = template.replace("{intro}", intro).replace("{task}", task)
    
    for key, value in kwargs.items():
        final_output = final_output.replace(f"{{{key}}}", str(value))
        
    return final_output

def read_file_content(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return f.readlines()
    except Exception as e:
        return [f"[ERROR reading file: {str(e)}]"]

# --- FILE ROLE CLASSIFICATION ---

def classify_file_role(filepath, extension):
    """Determine the semantic role of a file based on path and extension."""
    filepath_lower = filepath.lower()
    
    for role, patterns in FILE_ROLES.items():
        for pattern in patterns:
            if re.search(pattern, filepath_lower):
                return role
    
    # Fallback based on extension
    if extension in [".tsx", ".jsx"]:
        return "component"
    elif extension == ".rs":
        return "module"
    elif extension == ".py":
        return "module"
    elif extension in [".ts", ".js"]:
        return "module"
    
    return "file"

# --- PARSERS ---

def extract_docstring(lines, extension):
    comments = []
    markers = ["//!","///", "/**", "//", "/*", "*/", "*", '"""', "'''", "#"]

    for line in lines:
        s = line.strip()
        if not s: continue 
        
        is_comment = False
        if extension in [".ts", ".js", ".tsx", ".jsx", ".rs"]:
            if s.startswith("//") or s.startswith("/*") or s.startswith("*"): is_comment = True
        elif extension in [".py", ".sh", ".yaml", ".yml", ".toml"]:
            if s.startswith("#") or s.startswith('"""') or s.startswith("'''"): is_comment = True
        else:
            if s.startswith("//") or s.startswith("#") or s.startswith("/*"): is_comment = True

        if is_comment:
            clean = s
            for marker in markers:
                if clean.startswith(marker):
                    clean = clean[len(marker):].strip()
                    break
            if clean:
                comments.append(clean)
        else:
            break

    for c in comments:
        if c.upper().startswith("PURPOSE:"):
            return c.split(":", 1)[1].strip()

    if comments:
        first = comments[0]
        if not first.upper().startswith("FILENAME:") and not first.upper().startswith("CONTEXT:"):
            return first

    return ""

def is_ignored_import(path_str, extension):
    path_str = path_str.strip().strip("'").strip('"')
    if extension in IGNORED_IMPORTS:
        for prefix in IGNORED_IMPORTS[extension]:
            if path_str.startswith(prefix):
                return True
    return False

def extract_imports(lines, extension):
    """Extracts module dependencies with more detail."""
    deps = []
    
    js_import = re.compile(r"(?:import|export)\s+(?:type\s+)?.*?\s+from\s+['\"]([^'\"]+)['\"]")
    js_require = re.compile(r"require\s*\(\s*['\"]([^'\"]+)['\"]\s*\)")
    js_dynamic = re.compile(r"import\s*\(\s*['\"]([^'\"]+)['\"]\s*\)")
    
    py_from = re.compile(r"^from\s+([\w\.]+)\s+import")
    py_import = re.compile(r"^import\s+([\w\.]+)")
    
    rs_use = re.compile(r"^use\s+([\w:]+)")

    for line in lines:
        line = line.strip()
        if not line: continue
        
        found = None
        
        if extension in [".ts", ".tsx", ".js", ".jsx"]:
            m = js_import.search(line)
            if m: found = m.group(1)
            else:
                m = js_require.search(line)
                if m: found = m.group(1)
                else:
                    m = js_dynamic.search(line)
                    if m: found = m.group(1)
        
        elif extension == ".py":
            m = py_from.search(line)
            if m: found = m.group(1)
            else:
                m = py_import.search(line)
                if m: found = m.group(1)

        elif extension == ".rs":
            m = rs_use.search(line)
            if m: found = m.group(1)

        if found and not is_ignored_import(found, extension):
            deps.append(found)

    return deps

def extract_exports(lines, extension):
    """Extract what a file exports (types, functions, components, etc.)."""
    exports = []
    
    # JS/TS patterns
    js_export_named = re.compile(r"export\s+(?:type\s+|interface\s+|const\s+|let\s+|function\s+|class\s+|enum\s+|async\s+function\s+)([A-Za-z_][A-Za-z0-9_]*)")
    js_export_default = re.compile(r"export\s+default\s+(?:function\s+|class\s+)?([A-Za-z_][A-Za-z0-9_]*)?")
    js_export_type = re.compile(r"export\s+type\s+\{([^}]+)\}")
    js_export_braces = re.compile(r"export\s+\{([^}]+)\}")
    
    # Rust patterns
    rs_pub = re.compile(r"^pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\s+([A-Za-z_][A-Za-z0-9_]*)")
    
    # Python patterns  
    py_def = re.compile(r"^def\s+([a-zA-Z_][a-zA-Z0-9_]*)")
    py_class = re.compile(r"^class\s+([a-zA-Z_][a-zA-Z0-9_]*)")
    
    for line in lines:
        stripped = line.strip()
        
        if extension in [".ts", ".tsx", ".js", ".jsx"]:
            # Named exports
            m = js_export_named.search(stripped)
            if m:
                exports.append(m.group(1))
                continue
            
            # Default export
            m = js_export_default.search(stripped)
            if m and m.group(1):
                exports.append(f"default:{m.group(1)}")
                continue
            
            # Export { ... }
            m = js_export_braces.search(stripped)
            if m:
                names = [n.strip().split(' as ')[0].strip() for n in m.group(1).split(',')]
                exports.extend([n for n in names if n])
                continue
                
            # Export type { ... }
            m = js_export_type.search(stripped)
            if m:
                names = [n.strip().split(' as ')[0].strip() for n in m.group(1).split(',')]
                exports.extend([f"type:{n}" for n in names if n])
                continue
        
        elif extension == ".rs":
            m = rs_pub.match(stripped)
            if m:
                exports.append(m.group(1))
        
        elif extension == ".py":
            # For Python, we export top-level defs and classes (no indentation)
            if not line.startswith(" ") and not line.startswith("\t"):
                m = py_def.match(stripped)
                if m and not m.group(1).startswith("_"):
                    exports.append(m.group(1))
                    continue
                m = py_class.match(stripped)
                if m and not m.group(1).startswith("_"):
                    exports.append(m.group(1))
    
    # Deduplicate while preserving order
    seen = set()
    unique = []
    for e in exports:
        if e not in seen:
            seen.add(e)
            unique.append(e)
    
    return unique

def extract_type_definitions(lines, extension):
    """Extract type/interface definitions for the type index."""
    types = []
    
    ts_interface = re.compile(r"(?:export\s+)?interface\s+([A-Za-z_][A-Za-z0-9_]*)")
    ts_type = re.compile(r"(?:export\s+)?type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=")
    ts_enum = re.compile(r"(?:export\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)")
    
    rs_struct = re.compile(r"(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)")
    rs_enum = re.compile(r"(?:pub\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)")
    rs_trait = re.compile(r"(?:pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)")
    rs_type = re.compile(r"(?:pub\s+)?type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=")
    
    py_class = re.compile(r"^class\s+([A-Za-z_][A-Za-z0-9_]*)")
    
    for line in lines:
        stripped = line.strip()
        
        if extension in [".ts", ".tsx"]:
            for pattern in [ts_interface, ts_type, ts_enum]:
                m = pattern.search(stripped)
                if m:
                    types.append(m.group(1))
                    break
        
        elif extension == ".rs":
            for pattern in [rs_struct, rs_enum, rs_trait, rs_type]:
                m = pattern.search(stripped)
                if m:
                    types.append(m.group(1))
                    break
        
        elif extension == ".py":
            if not line.startswith(" ") and not line.startswith("\t"):
                m = py_class.match(stripped)
                if m:
                    types.append(m.group(1))
    
    return list(set(types))

def compress_signature(line):
    if '(' not in line or ')' not in line:
        return line
    if len(line) > 80:
        # Keep function name and return type hint if present
        parts = line.split('(', 1)
        name_part = parts[0]
        rest = parts[1] if len(parts) > 1 else ""
        
        # Try to extract return type
        return_match = re.search(r'\)\s*(?:->|:)\s*([^{]+)', rest)
        if return_match:
            return f"{name_part}(...) -> {return_match.group(1).strip().rstrip('{').strip()}"
        return name_part + "(...)" 
    return line

def parse_code_structure(lines, extension):
    """Extract signatures with better type preservation."""
    signatures = []
    
    rs_sig = re.compile(r"^\s*(pub(\(.*\))?\s+)?(async\s+)?(unsafe\s+)?(fn|struct|enum|trait|impl|type|const|static|mod)\b")
    js_sig = re.compile(r"^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum)\s+([a-zA-Z0-9_]+)")
    js_export_var = re.compile(r"^\s*export\s+(const|let|var)\s+([a-zA-Z0-9_]+)")
    js_arrow_fn = re.compile(r"^\s*(?:export\s+)?(?:const|let)\s+([a-zA-Z0-9_]+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(")
    py_sig = re.compile(r"^\s*(def|class)\s+([a-zA-Z0-9_]+)")

    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        stripped = line.strip()
        
        if stripped.startswith("import ") or stripped.startswith("use ") or stripped.startswith("from "):
            i += 1
            continue

        if extension == ".rs":
            if rs_sig.match(stripped) and not stripped.startswith("pub use"):
                raw_sig = stripped.rstrip(" {")
                signatures.append(compress_signature(raw_sig))
        
        elif extension in [".ts", ".tsx", ".js", ".jsx"]:
            if js_sig.match(stripped) and "return" not in stripped:
                raw_sig = stripped.rstrip(" {(=>")
                signatures.append(compress_signature(raw_sig))
            elif js_export_var.match(stripped):
                # Try to get type annotation
                type_match = re.search(r":\s*([^=]+)\s*=", stripped)
                if type_match:
                    base = stripped.split("=")[0].strip()
                    signatures.append(base)
                else:
                    signatures.append(stripped.split("=")[0].strip())
            elif js_arrow_fn.match(stripped):
                m = js_arrow_fn.match(stripped)
                if m:
                    name = m.group(1)
                    # Try to extract full signature from line
                    type_match = re.search(rf"{name}\s*:\s*([^=]+)\s*=", stripped)
                    if type_match:
                        signatures.append(f"const {name}: {type_match.group(1).strip()}")
                    else:
                        signatures.append(f"const {name} = (...) => ...")

        elif extension == ".py":
            if py_sig.match(stripped):
                raw_sig = stripped.rstrip(" :")
                signatures.append(compress_signature(raw_sig))

        i += 1
    return signatures

# --- DEPENDENCY GRAPH ---

def resolve_import_to_file(import_path, current_file, all_files):
    """
    Try to resolve an import path to an actual file in the project.
    Returns the normalized file path or None if not resolvable.
    """
    if not import_path.startswith("."):
        # Non-relative import - could be from node_modules or absolute
        # Try to find a matching file anyway
        for f in all_files:
            if import_path in f or f.endswith(import_path.replace("/", os.sep)):
                return f
        return None
    
    # Relative import
    current_dir = os.path.dirname(current_file)
    
    # Handle ./ and ../
    resolved = os.path.normpath(os.path.join(current_dir, import_path))
    resolved = resolved.replace("\\", "/")
    
    # Try common extensions
    extensions = [".ts", ".tsx", ".js", ".jsx", ".rs", ".py", "/index.ts", "/index.tsx", "/index.js", "/mod.rs"]
    
    for ext in extensions:
        candidate = resolved + ext
        if candidate in all_files:
            return candidate
        # Also try without extension if import already has one
        if resolved in all_files:
            return resolved
    
    return None

def build_dependency_graph(root_path, file_data):
    """
    Build a graph of dependencies and reverse dependencies.
    file_data: dict of {filepath: {"imports": [...], ...}}
    Returns: dict of {filepath: {"imports_resolved": [...], "used_by": [...]}}
    """
    all_files = set(file_data.keys())
    
    # First pass: resolve imports to actual files
    for filepath, data in file_data.items():
        resolved = []
        for imp in data.get("imports", []):
            resolved_file = resolve_import_to_file(imp, filepath, all_files)
            if resolved_file and resolved_file != filepath:
                resolved.append(resolved_file)
        data["imports_resolved"] = list(set(resolved))
        data["used_by"] = []
    
    # Second pass: build reverse dependencies
    for filepath, data in file_data.items():
        for dep in data.get("imports_resolved", []):
            if dep in file_data:
                file_data[dep]["used_by"].append(filepath)
    
    # Deduplicate used_by
    for filepath, data in file_data.items():
        data["used_by"] = sorted(list(set(data["used_by"])))
    
    return file_data

# --- GENERATORS ---

def generate_skeleton(root_path):
    """
    Scans the whole project and returns a comprehensive map with:
    - File roles
    - Descriptions
    - Exports
    - Imports (resolved to actual files)
    - Reverse dependencies (UsedBy)
    - Signatures
    """
    output = []
    type_index = defaultdict(list)  # type_name -> [file_paths]
    file_data = {}  # filepath -> parsed data
    ignore_dirs = get_ignore_dirs()

    # First pass: collect all file data
    for dirpath, dirnames, filenames in os.walk(root_path):
        dirnames[:] = [d for d in dirnames if d not in ignore_dirs]
        for f in filenames:
            if f in IGNORE_FILES: continue
            _, ext = os.path.splitext(f)
            if ext not in VALID_EXTENSIONS: continue

            full_path = os.path.join(dirpath, f)
            rel_path = os.path.relpath(full_path, root_path)
            norm_rel = rel_path.replace("\\", "/")
            
            lines = read_file_content(full_path)
            
            # Parse all data
            role = classify_file_role(norm_rel, ext)
            doc = extract_docstring(lines, ext)
            imports = extract_imports(lines, ext)
            exports = extract_exports(lines, ext)
            types = extract_type_definitions(lines, ext)
            sigs = parse_code_structure(lines, ext)
            
            file_data[norm_rel] = {
                "extension": ext,
                "role": role,
                "doc": doc,
                "imports": imports,
                "exports": exports,
                "types": types,
                "signatures": sigs,
            }
            
            # Build type index
            for t in types:
                type_index[t].append(norm_rel)
    
    # Build dependency graph (adds imports_resolved and used_by)
    file_data = build_dependency_graph(root_path, file_data)
    
    # Second pass: format output
    for norm_rel in sorted(file_data.keys()):
        data = file_data[norm_rel]
        
        # Start with path and role
        entry_parts = [f"{norm_rel} [{data['role']}]"]
        
        # Description
        if data['doc']:
            short_doc = (data['doc'][:50] + '..') if len(data['doc']) > 50 else data['doc']
            entry_parts.append(f"-> {short_doc}")
        
        details = []
        
        # Exports (what this file provides)
        if data['exports']:
            shown = data['exports'][:8]
            exp_str = ", ".join(shown)
            if len(data['exports']) > 8:
                exp_str += f" +{len(data['exports'])-8}"
            details.append(f"Exports: [{exp_str}]")
        
        # Imports (resolved to actual project files)
        if data['imports_resolved']:
            shown = data['imports_resolved'][:5]
            # Shorten paths for readability
            short_imports = [os.path.basename(p).split('.')[0] for p in shown]
            imp_str = ", ".join(short_imports)
            if len(data['imports_resolved']) > 5:
                imp_str += f" +{len(data['imports_resolved'])-5}"
            details.append(f"Imports: [{imp_str}]")
        
        # UsedBy (reverse dependencies - critical for impact analysis)
        if data['used_by']:
            shown = data['used_by'][:5]
            short_used = [os.path.basename(p).split('.')[0] for p in shown]
            used_str = ", ".join(short_used)
            if len(data['used_by']) > 5:
                used_str += f" +{len(data['used_by'])-5}"
            details.append(f"UsedBy: [{used_str}]")
        
        if details:
            entry_parts.append(" | ".join(details))
        
        # Signatures
        if data['signatures']:
            shown_sigs = data['signatures'][:10]
            sig_str = "; ".join([s.replace("export ", "").replace("async ", "").strip() for s in shown_sigs])
            if len(data['signatures']) > 10:
                sig_str += f"; +{len(data['signatures'])-10} more"
            entry_parts.append(f"{{ {sig_str} }}")
        
        output.append(" ".join(entry_parts))
    
    # Format type index
    type_index_lines = []
    for type_name in sorted(type_index.keys()):
        files = type_index[type_name]
        files_str = ", ".join(files[:3])
        if len(files) > 3:
            files_str += f" +{len(files)-3}"
        type_index_lines.append(f"  {type_name} --> {files_str}")
    
    type_index_str = "\n".join(type_index_lines) if type_index_lines else "(No type definitions found)"
    
    return "\n".join(output), type_index_str

def generate_territory_data(root_path, file_list):
    output = []
    files = [f.strip() for f in file_list if f.strip()]
    normalized_files = set()
    
    for rel_path in files:
        rel_path = rel_path.replace('"', '').replace("'", "")
        safe_path = os.path.normpath(os.path.join(root_path, rel_path))
        norm_rel = os.path.relpath(safe_path, root_path).replace("\\", "/")
        normalized_files.add(norm_rel)

        if os.path.exists(safe_path):
            content = read_file_content(safe_path)
            output.append(f"START OF FILE: {norm_rel}")
            output.append("-" * 40)
            output.append("".join(content))
            output.append("-" * 40)
            output.append(f"END OF FILE: {norm_rel}\n\n")
        else:
            output.append(f"\n[ERROR] File not found: {rel_path}\n")
    
    return "\n".join(output), normalized_files

def generate_project_structure(root_path):
    """Generates a simple list of file paths."""
    valid_files = []
    ignore_dirs = get_ignore_dirs()

    for dirpath, dirnames, filenames in os.walk(root_path):
        dirnames[:] = [d for d in dirnames if d not in ignore_dirs]
        for f in filenames:
            if f in IGNORE_FILES: continue
            _, ext = os.path.splitext(f)
            is_valid_ext = ext in VALID_EXTENSIONS
            is_critical = f in CRITICAL_CONFIGS

            if is_valid_ext or is_critical:
                full_path = os.path.join(dirpath, f)
                rel_path = os.path.relpath(full_path, root_path)
                norm_rel = rel_path.replace("\\", "/") 
                valid_files.append(norm_rel)

    valid_files.sort()
    return "\n".join(valid_files)

# --- MAIN ---

def main():
    parser = argparse.ArgumentParser(description="Context Manager")
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    parser_scan = subparsers.add_parser("scan", help="Generates Project Skeleton")
    parser_scan.add_argument("--out", help="Output to file")

    parser_build = subparsers.add_parser("build", help="Generates File Context")
    parser_build.add_argument("--files", required=True, help="Comma-separated list of files")
    parser_build.add_argument("--out", help="Output to file")

    args = parser.parse_args()
    root = get_project_root()
    final_result = ""

    if args.command == "scan":
        print("Scanning project structure...")
        skeleton, type_index = generate_skeleton(root)
        
        final_result = render_template(
            "template_scan.txt", 
            DEFAULT_SCAN_TEMPLATE, 
            content=skeleton,
            type_index=type_index
        )

    elif args.command == "build":
        print(f"Building context for: {args.files} ...")
        
        requested_files = [f.strip() for f in re.split(r'[,\n]', args.files) if f.strip()]
        
        for config in CRITICAL_CONFIGS:
            config_path = os.path.join(root, config)
            if os.path.exists(config_path) and config not in requested_files:
                requested_files.append(config)
                print(f"-> Auto-including critical config: {config}")

        content_data, included_files = generate_territory_data(root, requested_files)
        structure_data = generate_project_structure(root)

        final_result = render_template(
            "template_build.txt", 
            DEFAULT_BUILD_TEMPLATE, 
            content=content_data,
            files=structure_data
        )

    else:
        parser.print_help()
        return

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(final_result)
        print(f"--> [OK] Saved to {args.out}")
    else:
        copy_to_clipboard(final_result)

if __name__ == "__main__":
    main()