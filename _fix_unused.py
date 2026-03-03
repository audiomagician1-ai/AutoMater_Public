"""
Auto-fix @typescript-eslint/no-unused-vars — v4 (safe-only).

ONLY does:
  1. Remove unused imports (named, default, type)
  2. Rename catch(err) -> catch(_err)
  3. Rename function ARGS (not used at all) -> prefix _

Does NOT prefix local variables (too risky — may break references).
"""
import json, sys, re
from collections import defaultdict

data = json.loads(sys.stdin.read())
BASE = r'D:\echoagent\projects\AgentForge'

file_fixes = defaultdict(list)
for f in data:
    msgs = [m for m in f['messages'] if m['ruleId'] == '@typescript-eslint/no-unused-vars']
    if msgs:
        file_fixes[f['filePath']].extend(msgs)

stats = {'import_removed': 0, 'catch_renamed': 0, 'arg_prefixed': 0, 'skipped': 0}

def is_import_context(lines, line_idx):
    line = lines[line_idx].strip()
    if line.startswith('import '):
        return True
    for i in range(line_idx, max(-1, line_idx - 10), -1):
        l = lines[i].strip()
        if l.startswith('import '):
            return True
        if '}' in l and 'from' in l:
            return True
    return False

def remove_from_import(lines, line_idx, varname):
    line = lines[line_idx]
    stripped = line.strip()
    
    # Default import: import X from 'y'
    if re.match(r"^import\s+" + re.escape(varname) + r"\s+from\s+['\"]", stripped):
        lines[line_idx] = ''
        return True
    
    # Single named: import { X } from 'y' or import type { X } from 'y'
    if re.match(r"^import\s+(?:type\s+)?\{\s*" + re.escape(varname) + r"(?:\s+as\s+\w+)?\s*\}\s+from\s+", stripped):
        lines[line_idx] = ''
        return True
    
    # Multi named on same line
    new_line = line
    # Handle "type X as Y," or "X as Y," or "X," patterns
    # Be more precise: match the exact specifier including any 'type' prefix and 'as' alias
    
    # Pattern: "type varname as alias, " or "type varname, "
    new_line = re.sub(r'\btype\s+' + re.escape(varname) + r'(?:\s+as\s+\w+)?\s*,\s*', '', new_line, count=1)
    if new_line == line:
        # Pattern: "varname as alias, " or "varname, "
        new_line = re.sub(r'(?<![.\w])' + re.escape(varname) + r'(?:\s+as\s+\w+)?\s*,\s*', '', new_line, count=1)
    if new_line == line:
        # End of list: ", type varname" or ", varname"
        new_line = re.sub(r',\s*type\s+' + re.escape(varname) + r'(?:\s+as\s+\w+)?(?=\s*[}\n])', '', new_line, count=1)
    if new_line == line:
        new_line = re.sub(r',\s*(?<![.\w])' + re.escape(varname) + r'(?:\s+as\s+\w+)?(?=\s*[}\n])', '', new_line, count=1)
    
    if new_line != line:
        if re.search(r'import\s+(?:type\s+)?\{\s*\}\s+from', new_line):
            new_line = ''
        lines[line_idx] = new_line
        return True
    
    # Own line in multi-line import
    if re.match(r'^\s+(?:type\s+)?' + re.escape(varname) + r'(?:\s+as\s+\w+)?\s*,?\s*$', stripped):
        lines[line_idx] = ''
        return True
    
    return False

for filepath, msgs in file_fixes.items():
    with open(filepath, 'r', encoding='utf-8') as fh:
        lines = fh.readlines()
    
    modified = False
    msgs.sort(key=lambda m: -m['line'])
    
    for m in msgs:
        line_idx = m['line'] - 1
        if line_idx >= len(lines):
            stats['skipped'] += 1
            continue
        msg = m['message']
        col = m['column'] - 1
        line = lines[line_idx]
        
        name_match = re.match(r"'(\w+)' is (?:defined|assigned)", msg)
        if not name_match:
            stats['skipped'] += 1
            continue
        varname = name_match.group(1)
        
        if varname.startswith('_'):
            stats['skipped'] += 1
            continue
        
        # 1. catch(err) -> catch(_err)
        catch_pat = re.search(r'catch\s*\(\s*' + re.escape(varname) + r'\s*\)', line)
        if catch_pat:
            lines[line_idx] = line[:catch_pat.start()] + f'catch (_{varname})' + line[catch_pat.end():]
            modified = True
            stats['catch_renamed'] += 1
            continue
        
        # 2. Import context -> remove
        if is_import_context(lines, line_idx):
            if remove_from_import(lines, line_idx, varname):
                modified = True
                stats['import_removed'] += 1
            else:
                stats['skipped'] += 1
            continue
        
        # 3. Function arg that is "defined but never used" -> prefix _
        # Only for args: check if msg says "args must match"
        if 'Allowed unused args' in msg:
            pat = r'\b' + re.escape(varname) + r'\b'
            search_start = max(0, col - 3)
            search_end = min(len(line), col + len(varname) + 5)
            m_found = re.search(pat, line[search_start:search_end])
            if m_found:
                abs_start = search_start + m_found.start()
                abs_end = abs_start + len(varname)
                lines[line_idx] = line[:abs_start] + '_' + varname + line[abs_end:]
                modified = True
                stats['arg_prefixed'] += 1
            else:
                stats['skipped'] += 1
            continue
        
        # Everything else: skip (too risky for automated fix)
        stats['skipped'] += 1
    
    if modified:
        rel = filepath.replace(BASE + '\\', '')
        with open(filepath, 'w', encoding='utf-8') as fh:
            fh.writelines(lines)
        print(f'  Fixed: {rel}')

print(f"\nDone: imports={stats['import_removed']}, catch={stats['catch_renamed']}, args={stats['arg_prefixed']}, skipped={stats['skipped']}")



