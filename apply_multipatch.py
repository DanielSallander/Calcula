import sys
import os
import re
import shutil

def apply_hunks(target_file, hunks):
    """
    Applies a list of hunks to a specific target file.
    Uses whitespace-insensitive matching to find context.
    """
    if not os.path.exists(target_file):
        print(f"  [ERROR] Target file not found: {target_file}")
        return False

    try:
        with open(target_file, 'r', encoding='utf-8') as f:
            original_lines = f.readlines()
    except Exception as e:
        print(f"  [ERROR] Could not read {target_file}: {e}")
        return False

    # Create a backup of the target source file
    backup_file = target_file + ".bak"
    shutil.copy(target_file, backup_file)
    print(f"  [INFO] Backup created: {backup_file}")

    lines = original_lines[:]
    changes_made = False
    offset = 0

    for header, content in hunks:
        # Parse header
        m = re.search(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', header)
        if not m:
            print(f"  [WARN] Invalid hunk header: {header.strip()}")
            continue

        old_start = int(m.group(1))
        
        patch_lines = content.strip().split('\n')
        
        # Build expected blocks
        expected_original_block = []
        new_block = []
        
        for pl in patch_lines:
            if not pl: continue
            code_line = pl[1:] # Remove the +, -, or space
            
            if pl.startswith(' '):
                expected_original_block.append(code_line)
                new_block.append(code_line)
            elif pl.startswith('-'):
                expected_original_block.append(code_line)
            elif pl.startswith('+'):
                new_block.append(code_line)
            else:
                # Fallback: assume it's context if undefined
                expected_original_block.append(pl)
                new_block.append(pl)

        # We strip indentation for the SEARCH, but keep it for the REPLACEMENT
        search_block_stripped = [x.strip() for x in expected_original_block]
        
        # Fuzzy search for the context
        match_index = -1
        start_search_idx = (old_start - 1) + offset
        search_range = 2000 # Increased search range
        
        min_search = max(0, start_search_idx - search_range)
        max_search = min(len(lines), start_search_idx + search_range)

        for i in range(min_search, max_search):
            match = True
            for j, search_line_stripped in enumerate(search_block_stripped):
                if i + j >= len(lines):
                    match = False
                    break
                
                # KEY FIX: Compare stripped lines to ignore indentation differences
                if lines[i+j].strip() != search_line_stripped:
                    match = False
                    break
            if match:
                match_index = i
                break
        
        if match_index == -1:
            print(f"  [FAIL] Could not find context for hunk starting at approximate line {old_start}")
            print(f"         Make sure the context lines (starting with space) in the patch match your file content.")
            continue

        # Apply replacement
        del lines[match_index : match_index + len(expected_original_block)]
        lines_to_insert = [x + '\n' for x in new_block]
        
        for k, line_to_add in enumerate(lines_to_insert):
            lines.insert(match_index + k, line_to_add)

        offset += (len(new_block) - len(expected_original_block))
        changes_made = True

    if changes_made:
        with open(target_file, 'w', encoding='utf-8') as f:
            f.writelines(lines)
        print(f"  [OK] Successfully updated {target_file}")
        
        # Cleanup target backup on success
        if os.path.exists(backup_file):
            os.remove(backup_file)
        return True
    else:
        print(f"  [INFO] No changes applied to {target_file}")
        # Cleanup target backup if nothing happened
        if os.path.exists(backup_file):
            os.remove(backup_file)
        return False

def main():
    patch_file = "changes.patch"
    if len(sys.argv) > 1:
        patch_file = sys.argv[1]

    if not os.path.exists(patch_file):
        print(f"Patch file '{patch_file}' not found.")
        sys.exit(1)

    # Backup the patch file itself
    patch_backup = patch_file + ".bak"
    shutil.copy(patch_file, patch_backup)
    print(f"--> Patch file backed up to {patch_backup}")

    with open(patch_file, 'r', encoding='utf-8') as f:
        content = f.read()

    # Split files
    raw_blocks = re.split(r'(^--- .*$)', content, flags=re.MULTILINE)
    
    if len(raw_blocks) < 2:
        print("No file headers (--- filename) found in patch.")
        sys.exit(0)

    files_processed = 0

    for i in range(1, len(raw_blocks), 2):
        header_line = raw_blocks[i].strip()
        body = raw_blocks[i+1]
        
        target_file = header_line.replace('--- ', '').strip()
        # Clean git prefixes
        if target_file.startswith('a/') or target_file.startswith('b/'):
             target_file = target_file[2:]
             
        if not body.strip().startswith('+++'):
            continue
            
        print(f"\n--> Processing changes for: {target_file}")
        
        hunks = re.split(r'(^@@ -[\d,]+ \+[\d,]+ @@.*$)', body, flags=re.MULTILINE)
        
        parsed_hunks = []
        for h in range(1, len(hunks), 2):
            h_header = hunks[h]
            h_content = hunks[h+1]
            parsed_hunks.append((h_header, h_content))
            
        if parsed_hunks:
            if apply_hunks(target_file, parsed_hunks):
                files_processed += 1

    if files_processed > 0:
        with open(patch_file, 'w', encoding='utf-8') as f:
            f.write("")
        print(f"\n--> {patch_file} has been cleared.")
        if os.path.exists(patch_backup):
            os.remove(patch_backup)
    else:
        print("\n--> No changes were made. Check the console output for [FAIL] messages.")

if __name__ == "__main__":
    main()