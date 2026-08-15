# DSH 可配置 Windows Shell

> [English](README.md) | 中文

> 本插件属于 [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) 合集，完整的自研插件索引见该仓库。

拥有 Windows shell 界面的本地 DeepSeek Harness 插件包：它能独立注册
`cmd`、`bash`、`pwsh` 三个工具，其 bundle patch 在 host 级禁用 harness 的
系统 PowerShell 工具（`tool-pwsh`），因此模型可见的 shell 默认只有 bash。

`cmd` 在 Harness 的 ConPTY 终端原语内运行。终端在命令执行前切换到可配置的
代码页 65001，因此 CMD 内置命令和普通的终端感知型原生程序直接在源头产出
一条 Unicode 流，而不是从猜测的重定向管道编码解码而来。

`bash` 用 Git for Windows 的非 GUI `bin/bash.exe`，带干净的 UTF-8 locale。
配置既可指向 `bin/bash.exe`，也可指向熟悉的 `git-bash.exe`；后者会被有意地
解析为相邻的 `bin/bash.exe`，从而绝不启动 GUI 启动器。

`pwsh` 通过同一个 subprocess 接缝启动真实的 PowerShell 进程，独立于系统的
`ctx.shell` 执行器；它是可选的（`shells.pwsh.enabled`），默认关闭。

`shells.cmd.enabled`、`shells.bash.enabled`、`shells.pwsh.enabled` 这三个开关
决定注册哪些工具。每个 shell 还各自支持自己的可执行文件、输出上限、清理
宽限期，以及 shell 特有的编码/会话设置。三者都接受 `run_in_background: true`
（通过 `ctx.jobs` 即发即弃），可选的 `persistent.enabled` 配置则暴露一个
per-agent 持久化的 `shell_session` 工具。

## 失败隔离

bundle 根 Loader 入口只 import 一个无依赖的 supervisor。该 supervisor 动态
import shell 实现，并把任何 import 或初始化失败都限制为诊断。实现随后分别
隔离 CMD 与 Bash 的配置：一个无效的可执行文件或配置只移除那一个工具，另一个
仍然保留注册。因此可选的 shell 失败绝不会拒绝 Cordis 根 Loader，也不会阻止
DSH Web profile 启动。

该工具有意与 `ctx.shell` 分离：插件自己的工具通过 `ctx.subprocess` 直接启动
进程，绝不经过 harness 执行器接缝。系统的 `pwsh-sandbox` 执行器保持挂载，
因为 `permission-presets` 和 hooks 桥会硬注入 `ctx.shell`，但系统的
`tool-pwsh` 消费者被本 bundle 的 patch 禁用（见
[PowerShell 支持](#powershell-支持)）。

由于当前 Windows 沙箱 provider 包装的是单一的 `ctx.shell` 后端而非任意的
工具自有子进程，这个 CMD 工具在会话权限模式不是 `danger-full-access` 时
会 fail-closed（拒绝运行）。

## PowerShell 支持

### 系统 PowerShell 工具被本插件禁用

插件自己的 `cordis.patch.yml` 声明了 `- id: tool-pwsh / disabled: true`，因此
**挂载本 bundle 会在 host 级禁用 harness 的系统 PowerShell 工具**
（`@deepseek-ai/dsh-tool-pwsh`，win32 上由 `dsh-base` 挂载）——覆盖所有
profile（web、headless、CLI）。模型可见的 shell 界面默认只有 bash；
PowerShell 不适合模型的 RL/tool 环境。`pwsh-sandbox` EXECUTOR 行被有意地
**不**禁用：`permission-presets` 和 hooks 桥硬注入 `ctx.shell` 并读取其
`sandboxMode`，因此执行器为进程内消费者保留，即使没有模型工具消费它。

插件**同时**提供自己的可选 `pwsh` 工具（`shells.pwsh.enabled: true`），通过
与 `bash` 相同的 subprocess 接缝启动真实 PowerShell 进程（`pwsh -NoLogo
-NoProfile -NonInteractive -Command <command>`），完全独立于系统的
`ctx.shell`/`tool-pwsh` 栈。配置字段与 `bash` 对齐：`executable`（默认取
Program Files 下第一个存在的 `pwsh.exe`，其次 System32 下的 Windows PowerShell
5.1，再回退 PATH）、`maxOutputBytes`、`maxSpillBytes`、`graceMs`。

设置页（Shell 小节）暴露两个控件：`cmdEnabled`、`bashEnabled`、`pwshEnabled`
和 `pwshExecutable` 持久化到 `local-shell-tools` settings 命名空间，并在下次
DSH 重启时合并进工具配置。想找回系统 PowerShell 工具的部署，可从本 bundle 的
`cordis.patch.yml` 移除 `tool-pwsh` 行；只想用本插件 PowerShell 的部署，改启用
`shells.pwsh` 即可。

## 后台执行（即发即弃）

每个注册的 shell 工具（`cmd`、`bash`、`pwsh`）都接受 `run_in_background: true`。
调用会把进程注册到 harness 的 `ctx.jobs` 服务并立即返回 job id
（`started background job <id>`）；模型随后可用 `job_output`（或带 `wait: true`
的 `job_output`）轮询，用 `job_kill` 停止。进程结束时，jobs 服务自动向所属
会话投递完成通知——这就是长任务的即发即弃模式。

后台进程由所属 agent 栅栏隔离（agent 销毁时取消并等待它们），并在插件 fiber
拆除时被 kill/join。

## 持久化 shell 会话

设置 `persistent.enabled: true`（可选 `persistent.backend: bash|cmd|pwsh`，默认
取第一个启用的 shell）即可暴露 `shell_session` 工具：

- `start` — 为每个 agent 启动一个长生命周期终端（cwd、exported 变量、shell
  状态跨调用保持）；
- `run <command>` — 在所属会话中执行一条命令并返回累积输出；
- `stop` — 终止会话；
- `list` — 显示当前会话。

会话由调用 agent 拥有，agent 结束时自动拆除（agent/disposed 监听器）；会话
也会在其终端进程退出时结束。状态保持是重点：会话内的 `cd`、`export`、后台
任务在多次 `run` 调用间存活。

## Shell 可用性提示

因为本 bundle 之外的 preset 或 host 行仍可能挂载一个系统 shell 工具（例如
`@deepseek-ai/dsh-tool-pwsh`），插件自己的 `shells.*.enabled` 开关并非模型可见
shell 工具的唯一来源。为了让「启用集合」保持权威，插件注册了一个
`shell:availability` 系统提示词段落，把模型约束到本部署实际启用的 shell。

该段落列出启用的 shell（`cmd`/`bash`/`pwsh`，以及启用 `persistent.enabled` 时的
`shell_session`），点名被禁用的，并禁止调用启用集合之外的任何 shell——即使其
工具仍出现在 catalog 中。只有当至少一个 shell 被禁用时才渲染这段文字；当所有
shell 都启用时无需约束，该段落不贡献任何文本。

仿照 `user:language` 注入模式，段落文字在每次提示词组装时从实时
`local-shell-tools` settings 重新求值，因此在设置页切换 `cmdEnabled`/
`bashEnabled`/`pwshEnabled` 会在下一轮改变约束而无需重启。任何 settings 读取
失败降级为启动配置，任何求值失败降级为空段落——注入绝不破坏提示词。

## 输入 / 输出预览

每个 shell 工具都声明了 `presentCall` 和 `presentResult`，因此 GUI 把命令显示
为终端卡片（标题 = 命令，下方是描述，前台 `workdir` 作为终端 cwd），把输出
显示为终端正文，退出状态作为 pill（`[exit code: N]`、`[killed by signal: …]`、
`[timed out after …ms]`）。后台启动和错误回退为通用 fenced 块，与 harness 的
`bash`/`pwsh` 工具一致。

## 退出码语义（第一性原理契约）

本插件防范的是这种评估驱动循环：agent 运行一条验证命令，其退出码本应合法地
非零（grep 无匹配），却把非零退出误读为任务失败，然后不断创建并修复额外的
验证步骤。根因不是退出码本身，而是「非零 = 失败」的呈现绑定。

第一性原理立场，与实现一致：

- **退出码是命令自身的状态词汇，不是工具判决。** 工具只报告事实（
  `[exit code: N]` 标记、`completed` job 状态、无 `isError`）；它绝不把非零退出
  归类为工具错误，因为工具无法知道命令的语义（grep 1 = 无匹配、diff 1 =
  有差异、`test` 1 = false）。
- **工具绝不猜测语义。** 没有「非零且输出为空 = 预期」之类的启发式——那对
  grep 成立，但对失败的 `rm` 却会破坏，其 stderr 才携带错误。
- **面向模型的描述传授判断规则。** 每个注册的 shell 工具都附加共享的
  `EXIT_CODE_SEMANTICS` 句子：从输出和命令目的判断成败，不要仅因退出码非零
  就重跑命令或添加验证。

该契约由「每个 shell 工具描述都传授退出码语义」测试断言。
