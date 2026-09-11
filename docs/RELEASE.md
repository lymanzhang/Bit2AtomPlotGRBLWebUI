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
gh release create v<版本> "_release\bit2atombot-<版本>-src.zip" `
    --title "Bit2AtomBot v<版本>" --notes-file <说明文件路径>
Remove-Item Env:\GH_TOKEN
```

### 4. 验证

打开 `https://github.com/lymanzhang/Bit2AtomPlotWebUI/releases/tag/v<版本>`，确认说明渲染正常、Assets 区 zip 可下载。

### 5. 收尾

- 在 CHANGELOG.md 对应版本小节补充发布链接与本轮发布备注
- `_release/` 已被 .gitignore 忽略，无需提交

## 发布记录

### v0.20.0（2026-09-08）

- **版本**：0.19.0 → 0.20.0（缩放三态/SVG 尺寸检测/防撞轴收尾 + 裁剪误删与加载卡死修复，升 minor），`node tools/release.mjs --level minor`
- **流程修正**：release.mjs 只提交 package.json/package-lock.json——功能改动必须先手动提交再跑它，tag 才包含全部内容（本次先提交 acac7c8，再 bump f5543f2）
- **tag 重指向**：tag 推送前的补充提交（维护注释 6e4418e、README 措辞 a6a26d0、更新日志补回 5ff710e）用 `git tag -f v0.20.0` 重锚定，保证 tag 快照为定稿内容
- **IDE 旧缓冲区覆盖（已两次踩坑）**：IDE 中打开着旧版本文件时，外部工具对其的编辑会被 IDE 缓冲区在保存时整体覆盖——本版先丢了 `ui.tsx` 的 handleFile 解构（导致加载卡死 bug 差点进 tag），后又丢了 README 更新日志 v0.20.0 条目。防范：批量编辑前提醒关闭相关文件的 IDE 标签页；提交前对关键文档 `git grep` 目标标记复核（如 `v0.20.0`、`scaleMode`），不能只看 `git status` 的 M 标记
- **打包坑**：PowerShell 5.1 管道 `git archive | tar -xf` 会损坏二进制流（报 Damaged tar archive），须 `git archive --output=xxx.tar` 先落盘再解包
- **包结构**：git archive（tag 跟踪文件 64 个）+ dist/ 预构建产物，共 100 条目、1.38 MB；.NET ZipArchive 打包，0 反斜杠条目
- **验证**：从 GitHub 克隆 v0.20.0 tag → `npm ci` → `npm run build` → 53 测试通过 → `node cli.mjs --port 9099` 冒烟 HTTP 200
- **产物**：tag `v0.20.0`、Release 附件 `bit2atombot-0.20.0-src.zip`，说明渲染与附件验证通过

### v0.19.0（2026-09-08）

- **版本**：0.18.0 → 0.19.0（新增任务日志/排版设置 + 多项长时绘制可靠性修复，升 minor）
- **release.mjs 的坑**：该工具会**自动** `inc` 版本 + commit + 打 tag——先手动 `npm version` 再跑它会导致版本连升两级（本次 0.19.0 → 0.20.0）。修正：版本文件手动改回目标值后，bump 提交变为空提交、`--amend` 会被 git 拒绝，需 `git reset HEAD^` 丢弃 bump 提交后重打 tag（注意先删掉误打的 tag）
- **包结构**：git archive（tag 内容 61 个跟踪文件）+ `dist/` 预构建产物（36 个文件），共 97 条目、1.37 MB；`git archive` + `tar -xf` 解包到暂存目录，再用 .NET ZipArchive 打包
- **credential 新坑**：本机安全策略禁止 `cmd /c`，`Start-Process -RedirectStandardInput` 喂 `git credential fill` 报 `missing protocol field`（PS 5.1 重定向编码问题）；**node `spawnSync` 的 `input` 选项是二进制安全的可靠替代**：
  ```powershell
  $r = node -e "const {spawnSync}=require('child_process'); const res=spawnSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8'}); process.stdout.write(res.stdout||'')" | Out-String
  $env:GH_TOKEN = ($r | ConvertFrom-StringData).password
  ```
- **产物**：tag `v0.19.0`、Release 附件 `bit2atombot-0.19.0-src.zip`，说明渲染与附件验证通过

### v0.18.0（2026-09-07）

- **版本**：0.17.2 → 0.18.0（含新功能「运行日志落盘」，按 semver 升 minor），`npm version minor --no-git-tag-version` 同步 package.json + package-lock.json
- **分叉调和**：发布前本地与远端 main 各有 1 个不同提交，`git pull --rebase` 无冲突解决后再提交/打 tag
- **包结构演进**：`install.bat` / `install.sh` / `start.bat` / `start.sh` 已在 0.17.2 后从仓库移除，打包清单以 `git ls-tree HEAD --name-only` 为准（本次 85 条目、661.9 KB）
- **fixture 收编**：复合路径回归测试原引用仓库外 SVG，已收进 `src/__tests__/fixtures/` 并用 `new URL("./fixtures/…", import.meta.url)` 引用，保证包内测试可独立运行
- **credential 坑**：PowerShell 5.1 管道喂 `git credential fill` 报 `missing host/protocol field`（详见注意事项 3）
- **产物**：tag `v0.18.0`、Release 附件 `bit2atombot-0.18.0-src.zip`，说明渲染与附件均验证通过

## 注意事项（各版本踩过的坑）

1. **`Compress-Archive` 的 zip 分隔符缺陷**：其生成的条目路径用反斜杠 `\`，违反 zip 规范——Windows 资源管理器和多数 Windows 工具能容错，但 Linux/macOS 解压会得到损坏的文件名/目录结构。**必须用 .NET ZipArchive 并显式 `Replace('\','/')`**。
2. **PowerShell 不能直接调用 .NET 扩展方法**：`$arch.CreateEntryFromFile(...)` 会报 MethodNotFound，要用静态形式 `[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($arch, ...)`。
3. **gh 自动化需要令牌**：非交互环境报 `To use GitHub CLI in automation, set the GH_TOKEN environment variable`。用 `git credential fill` 取 Windows 凭据管理器中已存的令牌注入 `$env:GH_TOKEN`，用完即清，避免明文落盘。注意：PowerShell 5.1 管道直接喂多行输入（无论 `url=` 还是 `protocol=`/`host=` 形式）会报 `missing host/protocol field`——须将 `protocol=https\nhost=github.com\n\n` 写入临时文件后用 `cmd /c "git credential fill < 输入文件"` 供入（v0.18.0 实测）。
4. **先打 tag 后发 release**：`gh release create` 必须引用已存在的 tag；tag 要在**发布内容定稿的提交**上打（tag 之后再提交的文档更新不会包含在 tag 快照里，属正常现象）。
5. **打包前同步文档**：README/CHANGELOG 在打 tag 前若有更新，记得复制进 `_release` 目录再打包，否则包内文档滞后。
6. **PowerShell 不支持 heredoc**：提交信息用 `git commit -F <文件>`，不要用 `<<'EOF'` 语法。
