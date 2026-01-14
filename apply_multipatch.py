import sys
import os
import re
import shutil

def normalize_line_endings(lines):
    return [line.rstrip('\r\n') for line in lines]

def apply_hunks(target_file, hunks):
    """
    Applies a list of hunks to a specific target file.
    Returns True if successful, False otherwise.
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
        # Parse header: @@ -old_start,old_len +new_start,new_len @@
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
            code_line = pl[1:]
            
            if pl.startswith(' '):
                expected_original_block.append(code_line)
                new_block.append(code_line)
            elif pl.startswith('-'):
                expected_original_block.append(code_line)
            elif pl.startswith('+'):
                new_block.append(code_line)
            else:
                expected_original_block.append(pl)
                new_block.append(pl)

        search_block = normalize_line_endings(expected_original_block)
        
        # Fuzzy search for the context
        match_index = -1
        start_search_idx = (old_start - 1) + offset
        search_range = 1000 
        
        min_search = max(0, start_search_idx - search_range)
        max_search = min(len(lines), start_search_idx + search_range)

        for i in range(min_search, max_search):
            match = True
            for j, line_content in enumerate(search_block):
                if i + j >= len(lines):
                    match = False
                    break
                if lines[i+j].rstrip('\r\n') != line_content:
                    match = False
                    break
            if match:
                match_index = i
                break
        
        if match_index == -1:
            print(f"  [FAIL] Could not find context for hunk at line {old_start}")
            continue

        # Apply replacement
        del lines[match_index : match_index + len(search_block)]
        lines_to_insert = [x + '\n' for x in new_block]
        
        for k, line_to_add in enumerate(lines_to_insert):
            lines.insert(match_index + k, line_to_add)

        offset += (len(new_block) - len(search_block))
        changes_made = True

    if changes_made:
        with open(target_file, 'w', encoding='utf-8') as f:
            f.writelines(lines)
        print(f"  [OK] Successfully updated {target_file}")
        
        # CLEANUP: Remove backup on success
        try:
            os.remove(backup_file)
            print(f"  [CLEAN] Backup removed: {backup_file}")
        except OSError as e:
            print(f"  [WARN] Could not remove backup: {e}")
            
        return True
    else:
        print(f"  [INFO] No changes applied to {target_file}")
        # If no changes, we should probably remove the backup we just made 
        # since it is identical to the file.
        if os.path.exists(backup_file):
            os.remove(backup_file)
        return False

def main():
    # Set default patch filename if not provided
    patch_file = "changes.patch"
    if len(sys.argv) > 1:
        patch_file = sys.argv[1]

    if not os.path.exists(patch_file):
        print(f"Patch file '{patch_file}' not found.")
        print("Please create this file with your AI generated diff content.")
        # Pause effect if run from double-click (optional, handled by .bat usually)
        sys.exit(1)

    # 1. Backup the patch file
    patch_backup = patch_file + ".bak"
    shutil.copy(patch_file, patch_backup)
    print(f"--> Patch file backed up to {patch_backup}")

    with open(patch_file, 'r', encoding='utf-8') as f:
        content = f.read()

    # Split by the "--- " marker 
    raw_blocks = re.split(r'(^--- .*$)', content, flags=re.MULTILINE)
    
    if len(raw_blocks) < 2:
        print("No file headers (--- filename) found in patch.")
        sys.exit(0)

    files_processed = 0

    for i in range(1, len(raw_blocks), 2):
        header_line = raw_blocks[i].strip()
        body = raw_blocks[i+1]
        
        target_file = header_line.replace('--- ', '').strip()
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

    # 3. Clear the patch file and remove its backup if work was done
    if files_processed > 0:
        with open(patch_file, 'w', encoding='utf-8') as f:
            f.write("")
        print(f"\n--> {patch_file} has been cleared.")
        
        # Cleanup patch backup
        if os.path.exists(patch_backup):
            os.remove(patch_backup)
            print(f"--> Patch backup {patch_backup} removed.")
            
        print("\n[SUCCESS] All operations completed.")
    else:
        print("\n--> No files were updated. Backups preserved.")

if __name__ == "__main__":
    main()