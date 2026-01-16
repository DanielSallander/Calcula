import os
import re
import sys
import shutil

# Configuration
UPDATE_FILE = "ai_changes.txt"
STYLE_MAP = {
    'python': ['.py'],
    'c_style': ['.js', '.jsx', '.ts', '.tsx', '.rs', '.c', '.cpp', '.cs', '.java', '.php', '.go']
}

def detect_language_style(filename):
    ext = os.path.splitext(filename)[1].lower()
    for style, extensions in STYLE_MAP.items():
        if ext in extensions:
            return style
    return 'unknown'

def find_block_end_python(lines, start_index):
    start_line = lines[start_index]
    base_indent = len(start_line) - len(start_line.lstrip())
    end_index = start_index
    for i in range(start_index + 1, len(lines)):
        line = lines[i]
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            end_index = i
            continue
        current_indent = len(line) - len(line.lstrip())
        if current_indent <= base_indent:
            return end_index
        end_index = i
    return end_index

def find_block_end_c_style(lines, start_index):
    brace_count = 0
    started = False
    for i in range(start_index, len(lines)):
        line = lines[i]
        open_braces = line.count('{')
        close_braces = line.count('}')
        brace_count += (open_braces - close_braces)
        if open_braces > 0:
            started = True
        if started and brace_count <= 0:
            return i
    return len(lines) - 1

def process_updates():
    if not os.path.exists(UPDATE_FILE):
        print(f"Error: Input file '{UPDATE_FILE}' not found.")
        return

    with open(UPDATE_FILE, 'r', encoding='utf-8') as f:
        content = f.read()

    pattern = re.compile(
        r'<<<< FILE: (.*?) >>>>\s*'
        r'<<<< SEARCH: (.*?) >>>>\s*'
        r'<<<< CODE >>>>\n(.*?)\n<<<< END >>>>',
        re.DOTALL
    )

    matches = pattern.findall(content)
    if not matches:
        print("No valid update blocks found.")
        return

    print(f"Found {len(matches)} actions.")

    for file_path, search_line, new_code in matches:
        file_path = file_path.strip()
        search_line = search_line.strip()
        file_path = os.path.normpath(file_path)
        
        clean_code_command = new_code.strip()

        # 1. CREATE NEW FILE
        if search_line.lower() == "create new file":
            print(f"[NEW] Creating file: {file_path}")
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(new_code.strip() + '\n')
            continue

        if not os.path.exists(file_path):
            print(f"[SKIP] File not found for update: {file_path}")
            continue

        with open(file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()

        backup_path = file_path + ".bak"
        shutil.copy2(file_path, backup_path)

        try:
            # 2. APPEND TO END
            if search_line.lower() == "append to end":
                print(f"[APPEND] Appending to: {file_path}")
                if lines and not lines[-1].endswith('\n'):
                    lines[-1] += '\n'
                lines.append('\n' + new_code.strip() + '\n')
            
            # 3. SEARCH & REPLACE / DELETE
            else:
                action_type = "DELETE" if clean_code_command == "DELETE_BLOCK" else "UPDATE"
                print(f"[{action_type}] Searching in {file_path} for: '{search_line}'")
                
                start_index = -1
                for idx, line in enumerate(lines):
                    if search_line in line:
                        start_index = idx
                        break
                
                if start_index == -1:
                    print(f"  [ERROR] Search line not found. Skipping.")
                    os.remove(backup_path)
                    continue

                # --- SMART SNAP FEATURE ---
                # Checks if the AI included a decorator/attribute in CODE that exists above SEARCH
                if action_type == "UPDATE":
                    new_code_lines = new_code.splitlines()
                    # Find first non-empty line of new code
                    first_code_line = next((l for l in new_code_lines if l.strip()), None)
                    
                    if first_code_line and start_index > 0:
                        prev_line = lines[start_index - 1]
                        # If the line above matches the first line of the new code, 
                        # we assume the AI meant to replace that too.
                        if prev_line.strip() == first_code_line.strip():
                            print("  [AUTO-FIX] Detected attribute inclusion (e.g. #[macro]). Extending scope up.")
                            start_index -= 1
                # ---------------------------

                style = detect_language_style(file_path)
                end_index = -1

                if style == 'python':
                    end_index = find_block_end_python(lines, start_index)
                elif style == 'c_style':
                    end_index = find_block_end_c_style(lines, start_index)
                else:
                    print(f"  [ERROR] Unknown language style for {file_path}")
                    os.remove(backup_path)
                    continue

                if clean_code_command == "DELETE_BLOCK":
                    print(f"  [OK] Deleting lines {start_index+1} to {end_index+1}")
                    del lines[start_index : end_index + 1]
                else:
                    print(f"  [OK] Replacing lines {start_index+1} to {end_index+1}")
                    new_code_formatted = new_code.splitlines(keepends=True)
                    if new_code_formatted and not new_code_formatted[-1].endswith('\n'):
                        new_code_formatted[-1] += '\n'
                    lines[start_index : end_index + 1] = new_code_formatted

            with open(file_path, 'w', encoding='utf-8') as f:
                f.writelines(lines)
            
            os.remove(backup_path)

        except Exception as e:
            print(f"  [CRITICAL ERROR] {e}")
            print(f"  Restoring backup from {backup_path}")
            shutil.copy2(backup_path, file_path)

    print("Processing complete.")

if __name__ == "__main__":
    process_updates()