<#
.SYNOPSIS
    UTF-8 安全的文件读写辅助工具
.DESCRIPTION
    提供 Safe-Read, Safe-Write, Safe-Patch 三个命令，
    彻底规避 Set-Content / Out-File 默认 ANSI 编码导致 UTF-8 文件损坏的问题。
    用法：将此脚本 dot-source 到当前会话：
        . .\tools\safe-edit.ps1
    或直接调用 Python 封装的编辑命令。
#>

# ─────────────────────────────────────────────────────
# 方法一：PowerShell 函数（本进程内使用）
# ─────────────────────────────────────────────────────

function Safe-Read {
    <#
    .SYNOPSIS
        以 UTF-8 编码读取文件，返回字符串数组（每行一个元素）
    #>
    param([Parameter(Mandatory)][string]$Path)
    $absolutePath = Resolve-Path $Path -ErrorAction Stop
    return [System.IO.File]::ReadAllLines($absolutePath, [System.Text.UTF8Encoding]::new($false))
}

function Safe-ReadRaw {
    <#
    .SYNOPSIS
        以 UTF-8 编码读取整个文件为单一字符串
    #>
    param([Parameter(Mandatory)][string]$Path)
    $absolutePath = Resolve-Path $Path -ErrorAction Stop
    return [System.IO.File]::ReadAllText($absolutePath, [System.Text.UTF8Encoding]::new($false))
}

function Safe-Write {
    <#
    .SYNOPSIS
        以 UTF-8 无 BOM 编码写入文件
    .PARAMETER Path
        目标文件路径
    .PARAMETER Value
        要写入的内容（字符串或字符串数组）
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory, ValueFromPipeline)][AllowEmptyString()][string[]]$Value
    )
    begin   { $lines = @() }
    process { $lines += $_ }
    end {
        $absolutePath = if (Test-Path $Path) { Resolve-Path $Path } else { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path) }
        if ($lines.Count -gt 1 -or ($lines.Count -eq 1 -and $lines[0].Contains("`n"))) {
            # 多行内容，按原样写入
            $text = $lines -join "`n"
            [System.IO.File]::WriteAllText($absolutePath, $text, [System.Text.UTF8Encoding]::new($false))
        } else {
            # 单行或管道进来的行数组
            [System.IO.File]::WriteAllLines($absolutePath, $lines, [System.Text.UTF8Encoding]::new($false))
        }
    }
}

function Safe-Patch {
    <#
    .SYNOPSIS
        对文件中的某行进行文本替换（UTF-8 安全）
    .PARAMETER Path
        目标文件路径
    .PARAMETER Old
        被替换的旧文本
    .PARAMETER New
        替换的新文本
    .PARAMETER LineMatch
        可选：仅替换匹配此正则表达式的行
    .EXAMPLE
        Safe-Patch -Path src/ui.tsx -Old '</div>' -New '</form>' -LineMatch '^\s+</div>$'
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Old,
        [Parameter(Mandatory)][string]$New,
        [string]$LineMatch = ".*"
    )
    $absolutePath = Resolve-Path $Path -ErrorAction Stop
    $content = [System.IO.File]::ReadAllLines($absolutePath, [System.Text.UTF8Encoding]::new($false))
    $changed = $false
    for ($i = 0; $i -lt $content.Length; $i++) {
        if ($content[$i] -match $LineMatch -and $content[$i].Contains($Old)) {
            $oldLine = $content[$i]
            $content[$i] = $content[$i] -replace [regex]::Escape($Old), $New
            if ($oldLine -ne $content[$i]) { $changed = $true }
        }
    }
    if ($changed) {
        [System.IO.File]::WriteAllLines($absolutePath, $content, [System.Text.UTF8Encoding]::new($false))
        Write-Host "✓ Patched: $Path" -ForegroundColor Green
    } else {
        Write-Host "⚠ No change: $Path (pattern not found)" -ForegroundColor Yellow
    }
}

function Safe-InsertAfter {
    <#
    .SYNOPSIS
        在匹配行之后插入新行（UTF-8 安全）
    .PARAMETER Path
        目标文件路径
    .PARAMETER Match
        匹配行（正则表达式）
    .PARAMETER InsertText
        要插入的一行或多行文本（字符串数组）
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Match,
        [Parameter(Mandatory)][string[]]$InsertText
    )
    $absolutePath = Resolve-Path $Path -ErrorAction Stop
    $content = [System.IO.File]::ReadAllLines($absolutePath, [System.Text.UTF8Encoding]::new($false))
    $result = @()
    $found = $false
    foreach ($line in $content) {
        $result += $line
        if ($line -match $Match) {
            $result += $InsertText
            $found = $true
        }
    }
    if ($found) {
        [System.IO.File]::WriteAllLines($absolutePath, $result, [System.Text.UTF8Encoding]::new($false))
        Write-Host "✓ Inserted after line matching '$Match' in: $Path" -ForegroundColor Green
    } else {
        Write-Host "⚠ No match found: $Path" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "╔═══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   UTF-8 Safe Edit Tools Loaded               ║" -ForegroundColor Cyan
Write-Host "║                                               ║" -ForegroundColor Cyan
Write-Host "║   Safe-Read <path>                            ║" -ForegroundColor Cyan
Write-Host "║   Safe-ReadRaw <path>                         ║" -ForegroundColor Cyan
Write-Host "║   Safe-Write <path>                           ║" -ForegroundColor Cyan
Write-Host "║   Safe-Patch <path> -Old '' -New ''           ║" -ForegroundColor Cyan
Write-Host "║   Safe-InsertAfter <path> -Match '' -Insert   ║" -ForegroundColor Cyan
Write-Host "║                                               ║" -ForegroundColor Cyan
Write-Host "║   以下命令自动使用 UTF-8 无 BOM 编码          ║" -ForegroundColor Cyan
Write-Host "║   彻底避免 Set-Content 的 ANSI 编码陷阱       ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# 也导出成模块级别的函数（供 Import-Module 使用）
Export-ModuleMember -Function Safe-Read, Safe-ReadRaw, Safe-Write, Safe-Patch, Safe-InsertAfter
