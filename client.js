window.__ModuleLoader__.load({
  id: "@doiiarx/dsh-shell-plugin",
  factory: (require) => {
    const module = { exports: {} };
    const React = require("react");
    const inject = ["slots", "configForms", "remote"];
    const ENTRY_ID = "shell-plugin-local";
    const h = React.createElement;
    const page = { display: "grid", gap: "18px", color: "var(--dsw-alias-label-primary)" };
    const card = { display: "grid", gap: "12px", padding: "18px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px", background: "var(--dsw-alias-bg-layer-1)" };
    const row = { display: "grid", gridTemplateColumns: "minmax(180px,1fr) minmax(220px,320px)", gap: "18px", alignItems: "center" };
    const inputStyle = { boxSizing: "border-box", width: "100%", height: "36px", padding: "0 10px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-specific-input-major)", font: "inherit" };
    const FIELD_PATHS = {
      cmdEnabled: ["shells", "cmd", "enabled"],
      bashEnabled: ["shells", "bash", "enabled"],
      pwshEnabled: ["shells", "pwsh", "enabled"],
      wslEnabled: ["shells", "wsl", "enabled"],
      cmdProbe: ["shells", "cmd", "probe"],
      bashProbe: ["shells", "bash", "probe"],
      pwshProbe: ["shells", "pwsh", "probe"],
      wslProbe: ["shells", "wsl", "probe"],
      bashExecutable: ["shells", "bash", "executable"],
      pwshExecutable: ["shells", "pwsh", "executable"],
      bashLang: ["shells", "bash", "lang"],
      bashEnv: ["shells", "env"],
      maxOutputBytes: ["shells", "bash", "maxOutputBytes"],
      maxSpillBytes: ["shells", "bash", "maxSpillBytes"],
      graceMs: ["shells", "bash", "graceMs"],
    };
    function Field({ itemId, title, description, children }) {
      return h("label", { ...(itemId ? { "data-settings-item": itemId } : {}), style: row }, h("span", null, h("strong", { style: { display: "block", marginBottom: "3px" } }, title), h("small", { style: { color: "var(--dsw-alias-label-tertiary)" } }, description)), children);
    }
    const envRow = { display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "8px", alignItems: "center" };
    const envAddButton = { height: "32px", padding: "0 12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-specific-input-major)", font: "inherit", cursor: "pointer" };
    const envDeleteButton = { height: "32px", padding: "0 10px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px", color: "var(--dsw-alias-state-danger-label, var(--dsw-alias-label-secondary))", background: "transparent", font: "inherit", cursor: "pointer" };
    /** PyCharm-style key=value editor persisted as the `shells.env` map. */
    function EnvEditor({ env, writable, onChange }) {
      const entries = Object.entries(env ?? {});
      const [rows, setRows] = React.useState(entries.length > 0 ? entries.map(([key, val]) => ({ key, value: val })) : [{ key: "", value: "" }]);
      const commit = (nextRows) => {
        setRows(nextRows);
        const map = {};
        for (const r of nextRows) {
          if (r.key.trim().length > 0) map[r.key.trim()] = r.value;
        }
        onChange(map);
      };
      return h("div", { style: { display: "grid", gap: "8px", width: "100%" } },
        rows.map((r, index) => h("div", { key: index, style: envRow },
          h("input", { style: inputStyle, placeholder: "KEY", value: r.key, disabled: !writable, onChange: (e) => { const next = rows.map((x, i) => (i === index ? { ...x, key: e.target.value } : x)); commit(next); } }),
          h("input", { style: inputStyle, placeholder: "VALUE", value: r.value, disabled: !writable, onChange: (e) => { const next = rows.map((x, i) => (i === index ? { ...x, value: e.target.value } : x)); commit(next); } }),
          h("button", { style: envDeleteButton, disabled: !writable, onClick: () => { const next = rows.filter((_, i) => i !== index); commit(next.length > 0 ? next : [{ key: "", value: "" }]); } }, "删除")
        )),
        h("button", { style: envAddButton, disabled: !writable, onClick: () => commit([...rows, { key: "", value: "" }]) }, "+ 添加变量")
      );
    }
    function readView(section) {
      const shells = section?.shells ?? {};
      const cmd = shells.cmd ?? {};
      const bash = shells.bash ?? {};
      const pwsh = shells.pwsh ?? {};
      const wsl = shells.wsl ?? {};
      return {
        cmdEnabled: cmd.enabled === true,
        bashEnabled: bash.enabled === true,
        pwshEnabled: pwsh.enabled === true,
        wslEnabled: wsl.enabled === true,
        cmdProbe: cmd.probe === true,
        bashProbe: bash.probe !== false,
        pwshProbe: pwsh.probe === true,
        wslProbe: wsl.probe !== false,
        bashExecutable: bash.executable ?? "",
        pwshExecutable: pwsh.executable ?? "",
        bashLang: bash.lang ?? "C.UTF-8",
        bashEnv: shells.env ?? {},
        maxOutputBytes: bash.maxOutputBytes ?? 64000,
        maxSpillBytes: bash.maxSpillBytes ?? 67108864,
        graceMs: bash.graceMs ?? 3000,
      };
    }
    function ShellSettings({ form }) {
      const snapshot = React.useSyncExternalStore((listener) => form.subscribe(listener), () => form.getSnapshot());
      if (snapshot.status !== "ready" || snapshot.value === undefined) return h("div", { style: page }, h("h2", null, "Shell"), h("p", null, "正在读取配置…"));
      const value = readView(snapshot.value);
      const set = (field, next) => {
        const path = FIELD_PATHS[field];
        if (path === undefined) return;
        void form.mutate([{ op: "set", path, value: next }]).catch((error) => {
          console.error("[windows-shells] settings write failed:", error);
        });
      };
      return h("div", { style: page },
        h("div", null, h("h2", { style: { margin: "0 0 6px" } }, "Shell"), h("p", { style: { margin: 0, color: "var(--dsw-alias-label-secondary)" } }, "配置本地 CMD、Git Bash、PowerShell 与 WSL 工具。修改会持久化，重启 DSH 后生效。")),
        h("section", { style: card },
          h(Field, { itemId: "cmdEnabled", title: "启用 CMD", description: "注册 cmd 工具；当前部署默认关闭。" }, h("input", { type: "checkbox", checked: value.cmdEnabled, disabled: !snapshot.writable, onChange: (event) => set("cmdEnabled", event.target.checked) })),
          h(Field, { itemId: "bashEnabled", title: "启用 Bash", description: "注册 Git Bash 工具。" }, h("input", { type: "checkbox", checked: value.bashEnabled, disabled: !snapshot.writable, onChange: (event) => set("bashEnabled", event.target.checked) })),
          h(Field, { itemId: "pwshEnabled", title: "启用 PowerShell", description: "注册 pwsh 工具（独立于系统 ctx.shell）。" }, h("input", { type: "checkbox", checked: value.pwshEnabled, disabled: !snapshot.writable, onChange: (event) => set("pwshEnabled", event.target.checked) })),
          h(Field, { itemId: "wslEnabled", title: "启用 WSL", description: "注册 wsl_info / wsl_exec / wsl_path / wsl_probe 工具。" }, h("input", { type: "checkbox", checked: value.wslEnabled, disabled: !snapshot.writable, onChange: (event) => set("wslEnabled", event.target.checked) })),
          h(Field, { itemId: "cmdProbe", title: "CMD 通道探测", description: "执行命令前先快速探测 cmd 通道；失败立即返回不执行。" }, h("input", { type: "checkbox", checked: value.cmdProbe, disabled: !snapshot.writable, onChange: (event) => set("cmdProbe", event.target.checked) })),
          h(Field, { itemId: "bashProbe", title: "Bash 通道探测", description: "执行命令前先快速探测 bash 通道；失败立即返回不执行（默认开）。" }, h("input", { type: "checkbox", checked: value.bashProbe, disabled: !snapshot.writable, onChange: (event) => set("bashProbe", event.target.checked) })),
          h(Field, { itemId: "pwshProbe", title: "PowerShell 通道探测", description: "执行命令前先快速探测 pwsh 通道；失败立即返回不执行。" }, h("input", { type: "checkbox", checked: value.pwshProbe, disabled: !snapshot.writable, onChange: (event) => set("pwshProbe", event.target.checked) })),
          h(Field, { itemId: "wslProbe", title: "WSL 通道探测", description: "执行命令前先探测 WSL 通道并预热发行版；失败立即返回 probe-failed（默认开）。" }, h("input", { type: "checkbox", checked: value.wslProbe, disabled: !snapshot.writable, onChange: (event) => set("wslProbe", event.target.checked) })),
          h(Field, { itemId: "bashExecutable", title: "Bash 可执行文件", description: "Git Bash 的绝对路径。" }, h("input", { style: inputStyle, value: value.bashExecutable, disabled: !snapshot.writable, onChange: (event) => set("bashExecutable", event.target.value) })),
          h(Field, { itemId: "pwshExecutable", title: "PowerShell 可执行文件", description: "pwsh.exe 或 powershell.exe 的绝对路径；留空自动探测。" }, h("input", { style: inputStyle, value: value.pwshExecutable, disabled: !snapshot.writable, onChange: (event) => set("pwshExecutable", event.target.value) })),
          h(Field, { itemId: "bashLang", title: "语言环境", description: "写入 LANG 与 LC_ALL。" }, h("input", { style: inputStyle, value: value.bashLang, disabled: !snapshot.writable, onChange: (event) => set("bashLang", event.target.value) })),
          h(Field, { itemId: "bashEnv", title: "环境变量", description: "注入到所有 shell 命令（如 PYTHONIOENCODING=utf-8）。" }, h(EnvEditor, { env: value.bashEnv, writable: snapshot.writable, onChange: (map) => set("bashEnv", map) })),
          h(Field, { itemId: "maxOutputBytes", title: "最大输出字节", description: "返回给模型的最大输出。" }, h("input", { type: "number", min: 1024, max: 16777216, style: inputStyle, value: value.maxOutputBytes, disabled: !snapshot.writable, onChange: (event) => set("maxOutputBytes", Number(event.target.value)) })),
          h(Field, { itemId: "maxSpillBytes", title: "最大溢出文件字节", description: "完整输出落盘时的上限。" }, h("input", { type: "number", min: 1048576, max: 1073741824, style: inputStyle, value: value.maxSpillBytes, disabled: !snapshot.writable, onChange: (event) => set("maxSpillBytes", Number(event.target.value)) })),
          h(Field, { itemId: "graceMs", title: "终止宽限期（毫秒）", description: "结束进程前等待清理的时间。" }, h("input", { type: "number", min: 100, max: 60000, style: inputStyle, value: value.graceMs, disabled: !snapshot.writable, onChange: (event) => set("graceMs", Number(event.target.value)) }))
        ),
        h("p", { style: { margin: 0, color: "var(--dsw-alias-state-warn-label)" } }, "这些选项控制工具注册和进程参数，需要重启 DSH 才会重新装载。")
      );
    }
    function apply(ctx) {
      const form = ctx.configForms.get(ENTRY_ID);
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: ENTRY_ID,
        order: 110,
        label: "Shell",
        inject: () => ({ form })
      }, ShellSettings));
      const search = (globalThis.__DSH_SETTINGS_SEARCH__ ??= {
        sections: new Map(),
        register(sectionId, spec) {
          this.sections.set(sectionId, spec)
          return () => { this.sections.delete(sectionId) }
        },
      });
      search.register(ENTRY_ID, {
        label: "Shell",
        keywords: "shell 终端 命令 cmd bash powershell pwsh wsl 语言环境",
        items: [
          { id: "cmdEnabled", label: "启用 CMD", desc: "注册 cmd 工具；当前部署默认关闭", keywords: "cmd 命令 启用" },
          { id: "bashEnabled", label: "启用 Bash", desc: "注册 Git Bash 工具", keywords: "bash git 启用" },
          { id: "pwshEnabled", label: "启用 PowerShell", desc: "注册 pwsh 工具（独立于系统 ctx.shell）", keywords: "pwsh powershell 启用" },
          { id: "wslEnabled", label: "启用 WSL", desc: "注册 wsl_info / wsl_exec / wsl_path / wsl_probe 工具", keywords: "wsl linux 子系统 启用" },
          { id: "cmdProbe", label: "CMD 通道探测", desc: "执行命令前先快速探测 cmd 通道", keywords: "cmd probe 探测 通道" },
          { id: "bashProbe", label: "Bash 通道探测", desc: "执行命令前先快速探测 bash 通道（默认开）", keywords: "bash probe 探测 通道" },
          { id: "pwshProbe", label: "PowerShell 通道探测", desc: "执行命令前先快速探测 pwsh 通道", keywords: "pwsh probe 探测 通道" },
          { id: "wslProbe", label: "WSL 通道探测", desc: "执行命令前先探测 WSL 通道并预热发行版（默认开）", keywords: "wsl probe 探测 通道" },
          { id: "bashExecutable", label: "Bash 可执行文件", desc: "Git Bash 的绝对路径", keywords: "bash 路径 executable git-bash" },
          { id: "pwshExecutable", label: "PowerShell 可执行文件", desc: "pwsh.exe 或 powershell.exe 的绝对路径；留空自动探测", keywords: "pwsh powershell 路径 executable" },
          { id: "bashLang", label: "语言环境", desc: "写入 LANG 与 LC_ALL", keywords: "语言 locale lang 环境" },
          { id: "bashEnv", label: "环境变量", desc: "注入到所有 shell 命令（如 PYTHONIOENCODING=utf-8）", keywords: "环境变量 env PYTHONIOENCODING 注入" },
          { id: "maxOutputBytes", label: "最大输出字节", desc: "返回给模型的最大输出", keywords: "输出 字节 上限 output" },
          { id: "maxSpillBytes", label: "最大溢出文件字节", desc: "完整输出落盘时的上限", keywords: "溢出 文件 字节 spill" },
          { id: "graceMs", label: "终止宽限期（毫秒）", desc: "结束进程前等待清理的时间", keywords: "宽限 终止 grace 毫秒" },
        ],
      });
    }
    module.exports.inject = inject;
    module.exports.apply = apply;
    return module.exports;
  }
});
