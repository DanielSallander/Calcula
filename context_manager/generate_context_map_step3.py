import os
import sys
import argparse
import subprocess
import re
from pathlib import Path

# ==============================================================================
# CONFIGURATION
# ==============================================================================
# Use raw string (r"...") for Windows paths
DEFAULT_PROJECT_ROOT = r"C:\Dropbox\Projekt\Calcula"
TEMPLATE_FILE = r"context_manager\template_dependency_step3.txt"

# Directories to always exclude
EXCLUDE_DIRECTORIES = {
    "node_modules", ".git", "__pycache__", "venv", ".venv", "env", "target",
    ".idea", ".vscode", "dist", "build", "__tests__", ".next", "coverage",
    "general_stuff", "context_manager"
}

# File patterns to exclude (Regex)
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

# ==============================================================================
# LOGIC
# ==============================================================================

def copy_to_clipboard(text):
    """Copies text to the Windows clipboard using the 'clip' command."""
    try:
        # Use utf-16 for reliable unicode handling on Windows clip
        subprocess.run(['clip'], input=text.encode('utf-16'), check=True)
        print("[OK] Content copied to clipboard successfully.")
    except Exception as e:
        print(f"[ERROR] Failed to copy to clipboard: {e}")

def load_template(template_path):
    """Loads the template file content."""
    try:
        with open(template_path, 'r', encoding='utf-8') as f:
            return f.read()
    except FileNotFoundError:
        print(f"[ERROR] Template file not found: {template_path}")
        print("Please ensure the template file exists at the specified location.")
        sys.exit(1)
    except Exception as e:
        print(f"[ERROR] Failed to read template file: {e}")
        sys.exit(1)

def should_process_file(file_path):
    """Checks if a file should be included based on configuration."""
    path_obj = Path(file_path)
    filename = path_obj.name
    
    # 1. Check strict ignore list
    if filename in IGNORE_FILES:
        return False

    # 2. Check extension
    if not filename.lower().endswith(SOURCE_EXTENSIONS):
        return False

    # 3. Check regex patterns
    for pattern in EXCLUDE_PATTERNS:
        if re.match(pattern, filename, re.IGNORECASE):
            return False

    return True

def should_process_dir(dir_name):
    """Checks if a directory should be traversed."""
    return dir_name not in EXCLUDE_DIRECTORIES

def collect_files_from_path(path_str):
    """
    Recursively collects files from a directory or returns the file itself
    if it matches criteria.
    """
    target_path = Path(path_str)
    collected = []

    if not target_path.exists():
        print(f"[WARNING] Path not found: {path_str}")
        return collected

    if target_path.is_file():
        # If user specifically requested a file, we might skip the extension check
        # or enforce it. Here we enforce consistency with the rules.
        if should_process_file(target_path):
            collected.append(target_path)
    
    elif target_path.is_dir():
        for root, dirs, files in os.walk(target_path):
            # Modify dirs in-place to skip excluded directories
            dirs[:] = [d for d in dirs if should_process_dir(d)]
            
            for file in files:
                full_path = Path(root) / file
                if should_process_file(full_path):
                    collected.append(full_path)
    
    return collected

def generate_content(paths):
    """Generates the formatted string from the list of paths."""
    output_lines = []
    
    # Header
    output_lines.append("=" * 80)
    output_lines.append(f"{'PROJECT FILES'.center(80)}")
    output_lines.append("=" * 80)
    output_lines.append("")

    # Deduplicate paths and sort them for stable output
    unique_paths = sorted(set(paths))
    
    files_processed_count = 0

    for file_path in unique_paths:
        try:
            # Read file content
            # Try UTF-8 first, fallback to standard windows encoding if needed
            with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
            
            # Format relative path for readability (relative to project root)
            # If script is running in project root, file_path is already relative or absolute
            # We try to make it relative to the current working directory (Project Root)
            try:
                rel_path = file_path.relative_to(os.getcwd())
            except ValueError:
                rel_path = file_path

            # Append formatted block
            output_lines.append(f"### {rel_path}")
            output_lines.append(content)
            output_lines.append("") # Empty line between files
            
            files_processed_count += 1
            print(f"Processing --> {rel_path}")

        except Exception as e:
            print(f"[ERROR] Could not read {file_path}: {e}")

    print("-" * 40)
    print(f"Total files processed: {files_processed_count}")
    return "\n".join(output_lines)

def inject_content_into_template(template_text, content):
    """Replaces the {<content>} placeholder in the template with actual content."""
    # Replace the placeholder with the generated content
    return template_text.replace("{<content>}", content)

def main():
    parser = argparse.ArgumentParser(description="Concatenate project files to clipboard.")
    parser.add_argument(
        "--include", 
        nargs='+', 
        required=True, 
        help="List of files or folders to include."
    )
    
    args = parser.parse_args()

    # 1. Change working directory to Project Root
    try:
        os.chdir(DEFAULT_PROJECT_ROOT)
        print(f"Working Directory set to: {DEFAULT_PROJECT_ROOT}")
    except FileNotFoundError:
        print(f"[ERROR] Could not find project root: {DEFAULT_PROJECT_ROOT}")
        print("Please check the DEFAULT_PROJECT_ROOT configuration in the script.")
        sys.exit(1)

    # 2. Load template file
    template_path = Path(DEFAULT_PROJECT_ROOT) / TEMPLATE_FILE
    template_text = load_template(template_path)
    print(f"Template loaded: {TEMPLATE_FILE}")

    # 3. Collect all valid files
    all_files = []
    for path_arg in args.include:
        files = collect_files_from_path(path_arg)
        all_files.extend(files)

    if not all_files:
        print("[WARNING] No matching files found in the provided paths.")
        return

    # 4. Generate concatenated text
    generated_content = generate_content(all_files)

    # 5. Inject content into template
    final_text = inject_content_into_template(template_text, generated_content)

    # 6. Copy to clipboard
    copy_to_clipboard(final_text)

if __name__ == "__main__":
    main()