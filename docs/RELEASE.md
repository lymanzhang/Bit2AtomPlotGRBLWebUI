# 发布流程与注意事项

以 v0.17.2（2026-09-01）、v0.18.0（2026-09-07）的实际发布过程为基准整理。发布地址：<https://github.com/lymanzhang/Bit2AtomPlotWebUI/releases>

## 前置条件

- 本地仓库工作区干净、已推送最新提交
- `gh` CLI 已安装（2.95+）
- `tools/release.mjs` 可辅助生成本地发布目录（`_release/bit2atombot-<版本>/`）

## 流程

### 1. 准备发布目录与打包（关键：zip 分隔符）

将最新 README.md / CHANGELOG.md 同步进 `_release/bit2atombot-<版本>/`，然后用 **.NET ZipArchive** 打包（不要用 `Compress-Archive`，见下方注意事项）：

```powershell
$ver = "0.17.2"
$src = "$PWD\_release\bit2atombot-$ver"
$zip = "$PWD\_release\bit2atombot-$ver-src.zip"
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$fs = [System.IO.File]::Open($zip, 'Create')
$arch = New-Object System.IO.Compression.ZipArchive($fs, 'Create')
Get-ChildItem $src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length + 1).Replace('\', '/')
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $arch, $_.FullName, "bit2atombot-$ver/$rel", 'Optimal')
}
$arch.Dispose(); $fs.Dispose()
```

**打包后必须验证**：条目为正斜杠、关键文件齐全：

```powershell
$z = [System.IO.Compression.ZipFile]::OpenRead($zip)
($z.Entries | Where-Object { $_.FullName -match '\\' }).Count   # 应为 0
$z.Entries.FullName | Select-String 'CHANGELOG|README|package.json|install'  # 应齐全
$z.Dispose()
```

### 2. 打 tag 并推送

tag 锚定发布时的 HEAD 提交，先于 release 创建：

```bash
git tag -a v<版本> -m "<一句话版本摘要>"
git push origin v<版本>
```

### 3. 创建 GitHub Release（含附件）

写好版本说明文件（可直接取 CHANGELOG 对应版本小节），复用 git 凭据为 gh 供水（gh 无需单独登录）：

```powershell
# 版本说明写入临时文件后：
$cred = "url=https://github.com`n`n" | git credential fill | Out-String | ConvertFrom-StringData
$env:GH_TOKEN = $cred.password
gh release create v<版本> "_release\bit2atomplotgrbl-<版本>-src.zip" `
    --title "Bit2AtomPlotGRBL v<版本>" --notes-file <说明文件路径>
Remove-Item Env:\GH_TOKEN
```

### 4. 验证

打开 `https://github.com/lymanzhang/Bit2AtomPlotWebUI/releases/tag/v<版本>`，确认说明渲染正常、Assets 区 zip 可下载。

### 5. 收尾

- 在 CHANGELOG.md 对应版本小节补充发布链接与本轮发布备注
- `_release/` 已被 .gitignore 忽略，无需提交

## 发布记录

### v0.1.0（已发布 2026-09-12）

- 发布地址：<https://github.com/lymanzhang/Bit2AtomPlotGRBLWebUI/releases/tag/v0.1.0>，附件 `bit2atomplotgrbl-0.1.0-src.zip`（105 条目，正斜杠校验通过）
- 首个 GRBL 移植版发布（EBB 版 v0.20.0 基线），版本历程见姊妹项目 Bit2AtomPlotWebUI 的发布记录
- 已完成：package.json / CHANGELOG.md 版本号核对一致（0.1.0）；174 测试全绿、lint 零告警、typecheck 通过；本地 tag `v0.1.0` 锚定发布提交；远端仓库（Public）创建、master + tag 推送、GitHub Release 创建（说明取自 RELEASE_NOTES.md）
- 发布前核对清单：package.json 版本号、CHANGELOG.md 小节、tag、发布包三者一致；包内测试可独立运行（`npm ci` → `npm test`）

## 注意事项（各版本踩过的坑）

1. **`Compress-Archive` 的 zip 分隔符缺陷**：其生成的条目路径用反斜杠 `\`，违反 zip 规范——Windows 资源管理器和多数 Windows 工具能容错，但 Linux/macOS 解压会得到损坏的文件名/目录结构。**必须用 .NET ZipArchive 并显式 `Replace('\','/')`**。
2. **PowerShell 不能直接调用 .NET 扩展方法**：`$arch.CreateEntryFromFile(...)` 会报 MethodNotFound，要用静态形式 `[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($arch, ...)`。
3. **gh 自动化需要令牌**：非交互环境报 `To use GitHub CLI in automation, set the GH_TOKEN environment variable`。用 `git credential fill` 取 Windows 凭据管理器中已存的令牌注入 `$env:GH_TOKEN`，用完即清，避免明文落盘。注意：PowerShell 5.1 管道直接喂多行输入（无论 `url=` 还是 `protocol=`/`host=` 形式）会报 `missing host/protocol field`——须将 `protocol=https\nhost=github.com\n\n` 写入临时文件后用 `cmd /c "git credential fill < 输入文件"` 供入（v0.18.0 实测）。
4. **先打 tag 后发 release**：`gh release create` 必须引用已存在的 tag；tag 要在**发布内容定稿的提交**上打（tag 之后再提交的文档更新不会包含在 tag 快照里，属正常现象）。
5. **打包前同步文档**：README/CHANGELOG 在打 tag 前若有更新，记得复制进 `_release` 目录再打包，否则包内文档滞后。
6. **PowerShell 不支持 heredoc**：提交信息用 `git commit -F <文件>`，不要用 `<<'EOF'` 语法。
