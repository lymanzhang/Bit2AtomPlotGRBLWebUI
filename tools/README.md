# Tools - 项目辅助工具

## safe-edit.ps1 — PowerShell UTF-8 安全编辑函数

**用途**：替代 `Set-Content` / `Out-File`，避免 ANSI 编码损坏 UTF-8 文件。

**用法**：
```powershell
# 1. 加载到当前会话
. .\tools\safe-edit.ps1

# 2. 读取文件
$lines = Safe-Read src/ui.tsx           # 返回行数组
$text  = Safe-ReadRaw src/ui.tsx        # 返回单个字符串

# 3. 写入文件（自动 UTF-8 无 BOM）
$lines | Safe-Write src/ui.tsx

# 4. 替换匹配行中的文本
Safe-Patch src/ui.tsx -Old '</div>' -New '</form>' -LineMatch '^\s+</div>$'

# 5. 在匹配行后插入内容
Safe-InsertAfter src/ui.tsx -Match 'cropToMargins' -Insert "`n          <label>新内容</label>"
```

---

## file-edit.py — Python UTF-8 安全编辑工具

**用途**：同上，但跨平台兼容，更稳定。

**用法**：
```bash
# 读取
python tools/file-edit.py read src/ui.tsx

# 文本替换
python tools/file-edit.py patch src/ui.tsx --old "旧文本" --new "新文本"

# 在匹配行后插入
python tools/file-edit.py insert-after src/ui.tsx --match "cropToMargins" --text "新行内容"

# 重写文件（也可从 stdin 管道输入）
python tools/file-edit.py write src/ui.tsx --text "文件内容"
```

---

## 为什么需要这两个工具？

PowerShell 5.1 的 `Set-Content` 和 `Out-File` **默认使用 ANSI 编码**
（中文 Windows 下是 GBK）写入文件。项目源码是 UTF-8 无 BOM 格式，
一旦用 `Set-Content` 写回，**所有中文字符都会损坏**。

这两个工具通过 .NET 的 `WriteAllText`（PowerShell 版）
或 Python 的 `open(..., encoding='utf-8')`（Python 版）
确保写入时使用纯 UTF-8 无 BOM 编码。

**黄金法则**：不要用 `>`, `Set-Content`, `Out-File` 写含有中文的源码文件。
用 `Safe-Write` 或 `file-edit.py` 替代。
