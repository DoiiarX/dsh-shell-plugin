window.__ModuleLoader__.load({
  id: "@doiiarx/dsh-shell-plugin",
  factory: (require) => {
    const module = { exports: {} };
    const React = require("react");
    const inject = ["slots", "settingsScope", "connection", "remote"];
    const NS = "local-shell-tools";
    const h = React.createElement;
    const page = { display: "grid", gap: "18px", color: "var(--dsw-alias-label-primary)" };
    const card = { display: "grid", gap: "12px", padding: "18px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px", background: "var(--dsw-alias-bg-layer-1)" };
    const row = { display: "grid", gridTemplateColumns: "minmax(180px,1fr) minmax(220px,320px)", gap: "18px", alignItems: "center" };
    const inputStyle = { boxSizing: "border-box", width: "100%", height: "36px", padding: "0 10px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-specific-input-major)", font: "inherit" };
    function Field({ itemId, title, description, children }) {
      return h("label", { ...(itemId ? { "data-settings-item": itemId } : {}), style: row }, h("span", null, h("strong", { style: { display: "block", marginBottom: "3px" } }, title), h("small", { style: { color: "var(--dsw-alias-label-tertiary)" } }, description)), children);
    }
    function ShellSettings({ scope }) {
      const snapshot = React.useSyncExternalStore((listener) => scope.subscribe(listener), () => scope.getSnapshot());
      const value = snapshot.value;
      if (snapshot.status !== "ready" || value === undefined) return h("div", { style: page }, h("h2", null, "Shell"), h("p", null, "正在读取配置…"));
      const set = (field, next) => { void scope.set(field, next); };
      return h("div", { style: page },
        h("div", null, h("h2", { style: { margin: "0 0 6px" } }, "Shell"), h("p", { style: { margin: 0, color: "var(--dsw-alias-label-secondary)" } }, "配置本地 CMD、Git Bash 与 PowerShell 工具。修改会持久化，重启 DSH 后生效。")),
        h("section", { style: card },
          h(Field, { itemId: "cmdEnabled", title: "启用 CMD", description: "注册 cmd 工具；当前部署默认关闭。" }, h("input", { type: "checkbox", checked: value.cmdEnabled, disabled: !snapshot.writable, onChange: (event) => set("cmdEnabled", event.target.checked) })),
          h(Field, { itemId: "bashEnabled", title: "启用 Bash", description: "注册 Git Bash 工具。" }, h("input", { type: "checkbox", checked: value.bashEnabled, disabled: !snapshot.writable, onChange: (event) => set("bashEnabled", event.target.checked) })),
          h(Field, { itemId: "pwshEnabled", title: "启用 PowerShell", description: "注册 pwsh 工具（独立于系统 ctx.shell）。" }, h("input", { type: "checkbox", checked: value.pwshEnabled, disabled: !snapshot.writable, onChange: (event) => set("pwshEnabled", event.target.checked) })),
          h(Field, { itemId: "bashExecutable", title: "Bash 可执行文件", description: "Git Bash 的绝对路径。" }, h("input", { style: inputStyle, value: value.bashExecutable, disabled: !snapshot.writable, onChange: (event) => set("bashExecutable", event.target.value) })),
          h(Field, { itemId: "pwshExecutable", title: "PowerShell 可执行文件", description: "pwsh.exe 或 powershell.exe 的绝对路径；留空自动探测。" }, h("input", { style: inputStyle, value: value.pwshExecutable, disabled: !snapshot.writable, onChange: (event) => set("pwshExecutable", event.target.value) })),
          h(Field, { itemId: "bashLang", title: "语言环境", description: "写入 LANG 与 LC_ALL。" }, h("input", { style: inputStyle, value: value.bashLang, disabled: !snapshot.writable, onChange: (event) => set("bashLang", event.target.value) })),
          h(Field, { itemId: "maxOutputBytes", title: "最大输出字节", description: "返回给模型的最大输出。" }, h("input", { type: "number", min: 1024, max: 16777216, style: inputStyle, value: value.maxOutputBytes, disabled: !snapshot.writable, onChange: (event) => set("maxOutputBytes", Number(event.target.value)) })),
          h(Field, { itemId: "maxSpillBytes", title: "最大溢出文件字节", description: "完整输出落盘时的上限。" }, h("input", { type: "number", min: 1048576, max: 1073741824, style: inputStyle, value: value.maxSpillBytes, disabled: !snapshot.writable, onChange: (event) => set("maxSpillBytes", Number(event.target.value)) })),
          h(Field, { itemId: "graceMs", title: "终止宽限期（毫秒）", description: "结束进程前等待清理的时间。" }, h("input", { type: "number", min: 100, max: 60000, style: inputStyle, value: value.graceMs, disabled: !snapshot.writable, onChange: (event) => set("graceMs", Number(event.target.value)) }))
        ),
        h("p", { style: { margin: 0, color: "var(--dsw-alias-state-warn-label)" } }, "这些选项控制工具注册和进程参数，需要重启 DSH 才会重新装载。")
      );
    }
    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NS });
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "local-shell-tools",
        order: 110,
        label: "Shell",
        inject: () => ({ scope })
      }, ShellSettings));
      const search = (globalThis.__DSH_SETTINGS_SEARCH__ ??= {
        sections: new Map(),
        register(sectionId, spec) {
          this.sections.set(sectionId, spec)
          return () => { this.sections.delete(sectionId) }
        },
      });
      search.register(NS, {
        label: "Shell",
        keywords: "shell 终端 命令 cmd bash powershell pwsh 语言环境",
        items: [
          { id: "cmdEnabled", label: "启用 CMD", desc: "注册 cmd 工具；当前部署默认关闭", keywords: "cmd 命令 启用" },
          { id: "bashEnabled", label: "启用 Bash", desc: "注册 Git Bash 工具", keywords: "bash git 启用" },
          { id: "pwshEnabled", label: "启用 PowerShell", desc: "注册 pwsh 工具（独立于系统 ctx.shell）", keywords: "pwsh powershell 启用" },
          { id: "bashExecutable", label: "Bash 可执行文件", desc: "Git Bash 的绝对路径", keywords: "bash 路径 executable git-bash" },
          { id: "pwshExecutable", label: "PowerShell 可执行文件", desc: "pwsh.exe 或 powershell.exe 的绝对路径；留空自动探测", keywords: "pwsh powershell 路径 executable" },
          { id: "bashLang", label: "语言环境", desc: "写入 LANG 与 LC_ALL", keywords: "语言 locale lang 环境" },
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
