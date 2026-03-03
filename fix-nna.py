"""Auto-fix @typescript-eslint/no-non-null-assertion warnings."""
import os, re
from collections import defaultdict

BASE = r'D:\echoagent\projects\AgentForge'

with open(os.path.join(BASE, 'nna-locations.txt'), encoding='utf-8-sig') as f:
    locations = [line.strip() for line in f if line.strip()]

file_locs = defaultdict(set)
for loc in locations:
    m = re.match(r'^(.+):(\d+):(\d+)$', loc)
    if not m:
        continue
    path = m.group(1)
    line_num = int(m.group(2))
    file_locs[path].add(line_num)

stats = {'removed': 0, 'skipped': 0, 'files': 0}

def fix_nna_on_line(line, is_test):
    """Find and fix all non-null assertions on a single line."""
    result = []
    i = 0
    changes = 0
    while i < len(line):
        if line[i] == '!' and i > 0:
            # Check it's not !== or !=
            if i + 1 < len(line) and line[i + 1] == '=':
                result.append(line[i])
                i += 1
                continue
            # Check it's not logical not: preceded by space/operator/open bracket
            prev = line[i - 1]
            if prev in ' \t(=!&|,;:{[<>?+\n':
                result.append(line[i])
                i += 1
                continue
            # It's a NNA. What follows?
            after = line[i + 1] if i + 1 < len(line) else '\n'
            if after == '.':
                # expr!.prop -> expr?.prop
                result.append('?')
                changes += 1
            elif after == '[':
                # expr![idx] -> expr?.[idx]
                result.append('?.')
                changes += 1
            else:
                # expr! followed by terminator -> remove !
                # (just don't append the !)
                changes += 1
        else:
            result.append(line[i])
        i += 1
    return ''.join(result), changes

for filepath, line_nums in file_locs.items():
    with open(filepath, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    is_test = '__tests__' in filepath or '.test.' in filepath
    changed = False

    for line_num in sorted(line_nums):
        idx = line_num - 1
        if idx >= len(lines):
            stats['skipped'] += 1
            continue
        new_line, count = fix_nna_on_line(lines[idx], is_test)
        if count > 0:
            lines[idx] = new_line
            changed = True
            stats['removed'] += count
        else:
            stats['skipped'] += 1

    if changed:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.writelines(lines)
        stats['files'] += 1

print(f"Removed: {stats['removed']} NNAs in {stats['files']} files")
print(f"Skipped: {stats['skipped']}")
