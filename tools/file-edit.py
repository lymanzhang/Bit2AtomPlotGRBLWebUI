"""
UTF-8 安全的文件编辑工具。

用法:
  python tools/file-edit.py read <path>
  python tools/file-edit.py patch <path> --old <old> --new <new> [--line-match <regex>]
  python tools/file-edit.py insert-after <path> --match <regex> --text <lines...>
  python tools/file-edit.py write <path> --text <content>

所有读写操作均使用 UTF-8 无 BOM 编码。
"""

import sys
import os
import re
import argparse


def read_file(path):
    """以 UTF-8 读取文件，返回行列表"""
    with open(path, 'r', encoding='utf-8', newline='') as f:
        lines = f.readlines()
    return lines


def write_file(path, lines):
    """以 UTF-8 无 BOM 写回文件，保留原换行风格"""
    # 检测原文件换行风格
    newline = '\n'
    if os.path.exists(path):
        with open(path, 'rb') as f:
            raw = f.read(8192)
            if b'\r\n' in raw:
                newline = '\r\n'

    with open(path, 'w', encoding='utf-8', newline=newline) as f:
        f.writelines(lines)


def cmd_read(args):
    lines = read_file(args.path)
    sys.stdout.write(''.join(lines))


def cmd_patch(args):
    lines = read_file(args.path)
    pattern = re.compile(args.line_match) if args.line_match else None
    changed = 0
    for i, line in enumerate(lines):
        if pattern and not pattern.search(line):
            continue
        if args.old in line:
            new_line = line.replace(args.old, args.new)
            if new_line != line:
                print(f"  L{i+1}: {line.rstrip()}  →  {new_line.rstrip()}")
                lines[i] = new_line
                changed += 1
    if changed:
        write_file(args.path, lines)
        print(f"[OK] Patched {changed} occurrence(s) in {args.path}")
    else:
        print(f"⚠ No matches for '{args.old}' in {args.path}")


def cmd_insert_after(args):
    lines = read_file(args.path)
    pattern = re.compile(args.match)
    result = []
    found = False
    for line in lines:
        result.append(line)
        if pattern.search(line):
            for text in args.text:
                result.append(text + '\n')
            found = True
    if found:
        write_file(args.path, result)
        print(f"[OK] Inserted after line matching '{args.match}' in {args.path}")
    else:
        print(f"⚠ No match for '{args.match}' in {args.path}")


def cmd_write(args):
    text = args.text
    if not text and not sys.stdin.isatty():
        text = sys.stdin.read()
    if text:
        lines = [text] if isinstance(text, str) else text
        write_file(args.path, [l + '\n' if not l.endswith('\n') else l for l in lines])
        print(f"[OK] Written to {args.path}")


def main():
    # Force UTF-8 for stdout/stderr
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description="UTF-8 Safe File Editor")
    subparsers = parser.add_subparsers(dest='command')

    # read
    p_read = subparsers.add_parser('read', help='Read file to stdout')
    p_read.add_argument('path')

    # patch
    p_patch = subparsers.add_parser('patch', help='Replace text in file')
    p_patch.add_argument('path')
    p_patch.add_argument('--old', required=True)
    p_patch.add_argument('--new', required=True)
    p_patch.add_argument('--line-match', help='Only patch lines matching this regex')

    # insert-after
    p_ins = subparsers.add_parser('insert-after', help='Insert text after matching line')
    p_ins.add_argument('path')
    p_ins.add_argument('--match', required=True)
    p_ins.add_argument('--text', nargs='+', required=True)

    # write
    p_write = subparsers.add_parser('write', help='Write content to file')
    p_write.add_argument('path')
    p_write.add_argument('--text', nargs='*', help='Content to write (or pipe via stdin)')

    args = parser.parse_args()
    if args.command == 'read':
        cmd_read(args)
    elif args.command == 'patch':
        cmd_patch(args)
    elif args.command == 'insert-after':
        cmd_insert_after(args)
    elif args.command == 'write':
        cmd_write(args)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
