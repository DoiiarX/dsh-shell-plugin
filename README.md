# DSH configurable Windows shells

> 本插件属于 [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) 合集，完整的自研插件索引见该仓库。

Local DeepSeek Harness bundle that owns the Windows shell surface: it can
independently register `cmd`, `bash`, and `pwsh` tools, and its bundle patch
disables the harness's system PowerShell tool (`tool-pwsh`) host-wide so the
model-facing shell is bash-only by default.

`cmd` runs inside the Harness ConPTY terminal primitive. The terminal switches
to configurable code page 65001 before the command, so CMD built-ins and
ordinary terminal-aware native programs produce one Unicode stream at the
source instead of being decoded from a guessed redirected-pipe encoding.

`bash` runs Git for Windows' non-GUI `bin/bash.exe` with a clean UTF-8 locale.
Configuration may point at either `bin/bash.exe` directly or the familiar
   D:\Scoop\apps\git\current\git-bash.exe，改成你机器上 Git for Windows
`bin/bash.exe` so the GUI launcher is never spawned.

`pwsh` spawns a real PowerShell process through the same subprocess seam,
independent of the system `ctx.shell` executor; it is optional
(`shells.pwsh.enabled`) and defaults to off.

The `shells.cmd.enabled`, `shells.bash.enabled`, and `shells.pwsh.enabled`
flags select which tools are registered. Each shell also supports its own
executable, output bounds, cleanup grace, and shell-specific
encoding/session settings. All three accept `run_in_background: true`
(fire-and-forget via `ctx.jobs`), and the optional `persistent.enabled`
config exposes a per-agent persistent `shell_session` tool.

## Failure isolation

The bundle's root Loader entry imports only a dependency-free supervisor.
That supervisor dynamically imports the shell implementation and contains any
import or initialization failure as a diagnostic. The implementation then
contains CMD and Bash setup independently: one invalid executable or config
removes only that tool, while the other remains registered. Optional shell
failure therefore cannot reject the Cordis root Loader or prevent the DSH Web
profile from starting.

The tool is intentionally separate from `ctx.shell`: the plugin's own tools
spawn processes directly through `ctx.subprocess`, never through the harness
executor seam. The system `pwsh-sandbox` executor stays mounted because
`permission-presets` and the hooks bridges hard-inject `ctx.shell`, but the
system `tool-pwsh` consumer is disabled by this bundle's patch (see
[PowerShell support](#powershell-support)).

Because the current Windows sandbox provider wraps the single `ctx.shell`
backend rather than arbitrary tool-owned subprocesses, this CMD tool fails
closed unless the session permission mode is `danger-full-access`.

## PowerShell support

### The system PowerShell tool is disabled by this plugin

The plugin's own `cordis.patch.yml` declares `- id: tool-pwsh / disabled:
true`, so **mounting this bundle disables the harness's system PowerShell
tool** (`@deepseek-ai/dsh-tool-pwsh`, mounted by `dsh-base` on win32)
host-wide — every profile (web, headless, CLI). The model-facing shell surface
is bash-only by default; PowerShell does not fit the model's RL/tool
environment. The `pwsh-sandbox` EXECUTOR row is intentionally NOT disabled:
`permission-presets` and the hooks bridges hard-inject `ctx.shell` and read
its `sandboxMode`, so the executor stays for in-process consumers even though
no model tool consumes it.

The plugin ALSO provides its own optional `pwsh` tool (`shells.pwsh.enabled:
true`), which spawns a real PowerShell process (`pwsh -NoLogo -NoProfile
-NonInteractive -Command <command>`) through the same subprocess seam as
`bash`, fully independent of the system `ctx.shell`/`tool-pwsh` stack.
Configuration fields mirror `bash`: `executable` (defaults to the first
existing of `pwsh.exe` under Program Files, Windows PowerShell 5.1 under
System32, then PATH), `maxOutputBytes`, `maxSpillBytes`, `graceMs`.

The settings page (Shell section) exposes both controls: `cmdEnabled`,
`bashEnabled`, `pwshEnabled` and `pwshExecutable` are persisted to the
`local-shell-tools` settings namespace and merged into the tool configuration
on the next DSH restart. A deployment that wants the SYSTEM PowerShell tool
back removes the `tool-pwsh` row from this bundle's `cordis.patch.yml`; a
deployment that wants only this plugin's PowerShell enables `shells.pwsh`
instead.

## Background execution (fire-and-forget)

Every registered shell tool (`cmd`, `bash`, `pwsh`) accepts `run_in_background:
true`. The call registers the process with the harness `ctx.jobs` service and
returns immediately with a job id (`started background job <id>`); the model
can then poll with `job_output` (or `job_output` with `wait: true`) and stop
with `job_kill`. When the process settles, the jobs service delivers a
completion notice to the owning session automatically — the fire-and-forget
pattern for long-running commands.

Background processes are fenced by the owning agent (agent disposal cancels
and awaits them) and are killed/joined when the plugin fiber tears down.

## Persistent shell sessions

Set `persistent.enabled: true` (optionally `persistent.backend: bash|cmd|pwsh`,
defaulting to the first enabled shell) to expose the `shell_session` tool:

- `start` — spawn one long-lived terminal per agent (cwd, exported variables,
  and shell state persist across calls);
- `run <command>` — execute a command in the owned session and return the
  accumulated output;
- `stop` — terminate the session;
- `list` — show the current session.

Sessions are owned by the calling agent and torn down automatically when the
agent ends (agent/disposed listener); a session also ends when its terminal
process exits. State retention is the point: `cd`, `export`, and background
jobs inside the session survive between `run` calls.

## Shell availability prompt

Because a preset or host row outside this bundle can still mount a system
shell tool (e.g. `@deepseek-ai/dsh-tool-pwsh`), the plugin's own
`shells.*.enabled` flags are not the only source of model-facing shell tools.
To keep the "enabled set" authoritative, the plugin registers a
`shell:availability` system-prompt section that constrains the model to the
shells this deployment actually enabled.

The section lists the enabled shells (`cmd`/`bash`/`pwsh`, plus `shell_session`
when `persistent.enabled`), names the disabled ones, and forbids calling any
shell outside the enabled set even when its tool is present in the catalog.
The paragraph only renders when at least one shell is disabled; when every
shell is enabled nothing needs constraining and the section contributes no
text.

Mirroring the `user:language` injection pattern, the section text is
re-evaluated at every prompt assembly from the live `local-shell-tools`
settings, so toggling `cmdEnabled`/`bashEnabled`/`pwshEnabled` in the settings
page changes the constraint on the next turn without a restart. Any settings
read failure degrades to the startup config, and any evaluation failure
degrades to an empty paragraph — the injection never breaks the prompt.

## Input / output previews

Every shell tool declares `presentCall` and `presentResult`, so the GUI shows
the command as a terminal card (title = command, description below, foreground
`workdir` as the terminal cwd) and the output as a terminal body with the exit
status as a pill (`[exit code: N]`, `[killed by signal: …]`,
`[timed out after …ms]`). Background starts and errors fall back to generic
fenced blocks, matching the harness `bash`/`pwsh` tools.

## Exit-status semantics (first-principles contract)

The eval-driven loop this plugin guards against: an agent runs a verification
command whose exit code is legitimately non-zero (grep found no match), reads
the non-zero exit as a failed task, and keeps creating and fixing extra
verification steps. The root cause is not the exit code itself but the
presentation binding "non-zero = failure".

First-principles stance, mirrored by the implementation:

- **An exit code is the command's own status vocabulary, not a tool verdict.**
  The tool reports the fact (`[exit code: N]` marker, `completed` job status,
  no `isError`); it never classifies a non-zero exit as a tool error, because
  the tool cannot know the command's semantics (grep 1 = no match, diff 1 =
  differences, `test` 1 = false).
- **The tool never guesses semantics.** No heuristic like "non-zero with empty
  output = expected" — that holds for grep but breaks for a failed `rm`, whose
  stderr carries the error.
- **The model-facing description teaches the judgment rule.** Every registered
  shell tool appends the shared `EXIT_CODE_SEMANTICS` sentence: judge success
  from the output and the command's purpose, and do not re-run a command or add
  verification solely because the exit code is non-zero.

The contract is asserted by the `every shell tool description teaches
exit-code semantics` test.

## Installation

复制下面的指令块给你的 DSH agent，它会自动完成安装：

```text
请安装 Windows Shell 插件（@local/dsh-shell-plugin）：

1. 前置：本机已有 deepseek-harness 源码（本插件 link 依赖其中的 dsh-tools 包，
   位于 <deepseek-harness>/packages/core/tools）；且运行环境为 Windows。
2. 克隆仓库：
   git clone https://github.com/DoiiarX/dsh-shell-plugin
   cd dsh-shell-plugin
3. 安装依赖：pnpm install
   （如果 package.json 里 dsh-tools 的 link 路径与你机器不符，改成你的
   deepseek-harness 实际路径后再装。）
4. 检查 cordis.patch.yml 里的 bash 路径：默认硬编码为
   D:\Scoop\apps\git\current\git-bash.exe，改成你机器上 Git for Windows
   的实际 bash 路径（bin/bash.exe 或 git-bash.exe 均可，但建议指向 bin/bash.exe
   避免拉起 GUI 启动器）。
5. 挂进 web profile：编辑 $HOME/.dsh/profiles/web/package.json，
   在 dependencies 加 "@local/dsh-shell-plugin": "link:<本插件目录绝对路径>"，
   在 dsh.profile.bundles 加 "@local/dsh-shell-plugin"。
6. 在 profile 目录执行 pnpm install。
7. 暴露设置页：在 <deepseek-harness>/packages/host/apiproxy/src/api-proxy.ts
   的 WEB_SETTINGS_NAMESPACES 数组加 "local-shell-tools"。
8. 重 build host（pnpm run build:lib:host）并重启 web 进程。
9. 验证：工具列表出现 bash（可选 cmd/pwsh），设置页出现 Shell 小节。
```

注意：本插件挂载后会禁用 harness 的系统 PowerShell 工具（tool-pwsh），使
模型面向的 shell 默认只留 bash；如需 PowerShell 请改 cordis.patch.yml 或
在设置页开启 `shells.pwsh`。本插件仅 Windows 可用。
