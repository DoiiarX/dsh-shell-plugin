import assert from 'node:assert/strict'
import test from 'node:test'
import { applyIsolated, apply, Config, materializeConfig } from './index.js'
import { Readable } from 'node:stream'
import { applyShells, normalizeTerminalText, presentShellCall, presentShellResult, resolveBashExecutable, resolvePwshExecutable, shellAvailabilityText, startBackground } from './implementation.js'

test('git-bash.exe resolves to the non-GUI bash.exe', () => {
  assert.equal(
    resolveBashExecutable('D:\\Scoop\\apps\\git\\current\\git-bash.exe'),
    'D:\\Scoop\\apps\\git\\current\\bin\\bash.exe',
  )
})

test('terminal normalization removes control sequences without altering Unicode', () => {
  const raw = '\u001b]0;C:\\Windows\\System32\\cmd.exe\u0007\u001b[?25l当前目录: D:\\项目\r\n\u001b[?25hmain\r\n'
  assert.equal(normalizeTerminalText(raw), '当前目录: D:\\项目\nmain')
})

test('one broken shell does not prevent the other from registering', () => {
  const registered = []
  const failures = []
  const result = applyShells({
    tools: { register(tool) { registered.push(tool.name) } },
    provide() {},
  }, {
    shells: {
      cmd: { enabled: true },
      bash: { enabled: true, executable: 'D:\\missing\\git-bash.exe' },
    },
  }, (scope) => { failures.push(scope) })
  assert.deepEqual(registered, ['cmd'])
  assert.deepEqual(result, { registered: ['cmd'], failed: ['bash'] })
  assert.deepEqual(failures, ['bash'])
})

test('a broken implementation does not reject the supervisor plugin', async () => {
  const errors = []
  const original = console.error
  console.error = (message) => { errors.push(String(message)) }
  try {
    await assert.doesNotReject(applyIsolated(
      {},
      {},
      () => Promise.reject(new Error('simulated implementation import failure')),
    ))
  } finally {
    console.error = original
  }
  assert.match(errors.join('\n'), /implementation unavailable.*simulated implementation import failure/)
})

test('pwsh is registered when shells.pwsh.enabled is true', () => {
  const registered = []
  const failures = []
  const result = applyShells({
    tools: { register(tool) { registered.push(tool.name) } },
    provide() {},
  }, {
    shells: {
      cmd: { enabled: false },
      bash: { enabled: false },
      pwsh: { enabled: true },
    },
  }, (scope) => { failures.push(scope) })
  assert.equal(registered.includes('pwsh'), true)
  assert.deepEqual(result.registered, ['pwsh'])
  assert.deepEqual(failures, [])
})

test('at least one of cmd/bash/pwsh must be enabled', () => {
  const failures = []
  const result = applyShells({ provide() {} }, { shells: { cmd: { enabled: false }, bash: { enabled: false }, pwsh: { enabled: false } } }, (scope) => { failures.push(scope) })
  assert.deepEqual(result, { registered: [], failed: ['configuration'] })
  assert.deepEqual(failures, ['configuration'])
})

test('pwsh executable resolution falls back through well-known locations', () => {
  const env = {
    ProgramFiles: 'P:\Program Files',
    SystemRoot: 'S:\Windows',
    PATH: 'C:\tools',
  }
  assert.equal(resolvePwshExecutable(undefined, env), 'pwsh')
})

test('registered shell tools expose run_in_background', () => {
  const tools = []
  applyShells({
    tools: { register(tool) { tools.push(tool) } },
    provide() {},
    get() { return undefined }, // no middleware slot
  }, {
    shells: {
      cmd: { enabled: false },
      bash: { enabled: true, executable: 'D:\\Scoop\\apps\\git\\current\\git-bash.exe' },
      pwsh: { enabled: true },
    },
  }, () => {})
  const bash = tools.find(t => t.name === 'bash')
  const pwsh = tools.find(t => t.name === 'pwsh')
  assert.equal(typeof bash.parameters.properties.run_in_background, 'object')
  assert.equal(bash.parameters.properties.run_in_background.type, 'boolean')
  assert.equal(typeof pwsh.parameters.properties.run_in_background, 'object')
  assert.equal(pwsh.parameters.properties.run_in_background.type, 'boolean')
})

test('startBackground registers with ctx.jobs when present', () => {
  const started = []
  const running = { terminate() {}, done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: { readFrom: () => ({ text: 'bg output', lossy: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false }) } } }
  const ctx = {
    get(name) {
      if (name === 'jobs') return { start(spec) { started.push(spec); return 'job-1' } }
      if (name === 'shellMiddlewareSlot') return { list: () => [] }
      return undefined
    },
  }
  const exec = {}
  const jobId = startBackground(ctx, exec, 'sleep 5', () => ({
    cancel: () => void running.terminate(),
    done: running.done.then((outcome) => ({ status: 'completed', detail: `exit code: ${outcome.exitCode}` })),
    readOutput: () => ({ text: 'bg output', truncated: false }),
  }), 'bash')
  assert.equal(jobId, 'job-1')
  assert.equal(started[0].kind, 'bash')
  assert.equal(started[0].label, 'sleep 5')
})

test('startBackground fails loud without ctx.jobs', () => {
  const ctx = { get: () => undefined }
  assert.throws(() => startBackground(ctx, {}, 'echo hi', () => ({})), /no background job registry/)
})

test('background readOutput returns a string (jobs contract)', () => {
  const hooks = []
  const running = {
    terminate() {},
    done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: {
      stdout: { readFrom: () => ({ text: 'hello-background', lossy: false }) },
      stderr: { readFrom: () => ({ text: '', lossy: false }) },
    },
  }
  const ctx = {
    get(name) {
      if (name === 'jobs') return { start(spec) { hooks.push(spec.run()); return 'job-x' } }
      if (name === 'shellMiddlewareSlot') return { list: () => [] }
      return undefined
    },
  }
  startBackground(ctx, {}, 'echo hi', () => ({
    cancel: () => void running.terminate(),
    done: running.done.then((o) => ({ status: 'completed', detail: `exit code: ${o.exitCode}` })),
    readOutput: () => 'hello-background',
  }), 'bash')
  const text = hooks[0].readOutput()
  assert.equal(typeof text, 'string')
  assert.equal(text, 'hello-background')
})

test('persistent session tool registers when enabled', () => {
  const tools = []
  const result = applyShells({
    tools: { register(tool) { tools.push(tool) } },
    provide() {},
    get(name) { return name === 'shellMiddlewareSlot' ? { list: () => [] } : undefined },
    on() { return () => {} },
  }, {
    shells: { cmd: { enabled: false }, bash: { enabled: true, executable: 'D:\Scoop\apps\git\current\git-bash.exe' }, pwsh: { enabled: false } },
    persistent: { enabled: true },
  }, () => {})
  assert.equal(result.registered.includes('shell_session'), true)
  const tool = tools.find(t => t.name === 'shell_session')
  assert.equal(typeof tool, 'object')
  assert.equal(tool.parameters.properties.action.type, 'string')
  assert.equal(tool.parameters.required.includes('action'), true)
})

test('persistent session tool absent when disabled', () => {
  const tools = []
  const result = applyShells({
    tools: { register(tool) { tools.push(tool) } },
    provide() {},
    get(name) { return name === 'shellMiddlewareSlot' ? { list: () => [] } : undefined },
    on() { return () => {} },
  }, {
    shells: { cmd: { enabled: true } },
    persistent: { enabled: false },
  }, () => {})
  assert.equal(result.registered.includes('shell_session'), false)
})

test('presentShellCall renders a terminal card for foreground commands', () => {
  const view = presentShellCall({ command: 'echo hi', description: 'say hi', workdir: '/tmp' })
  assert.equal(view.card, 'terminal')
  assert.equal(view.title, 'echo hi')
  assert.equal(view.cwd, '/tmp')
})

test('presentShellCall renders a generic card for background starts', () => {
  const view = presentShellCall({ command: 'sleep 5', description: 'bg', run_in_background: true })
  assert.equal(view.card, 'generic')
  assert.equal(view.rawInput, 'sleep 5')
})

test('presentShellResult extracts the exit pill from the terminal body', () => {
  const view = presentShellResult({}, { content: [{ type: 'text', text: 'hello\n[exit code: 1]' }], isError: false })
  assert.equal(view.card, 'terminal')
  assert.equal(view.output, 'hello')
  assert.equal(view.exitCode, 1)
})

test('presentShellResult renders errors as generic fenced blocks', () => {
  const view = presentShellResult({}, { content: [{ type: 'text', text: 'boom' }], isError: true })
  assert.equal(view.card, 'generic')
  assert.match(view.content[0].text, /```console/)
})

test('every shell tool description teaches exit-code semantics (first-principles contract)', () => {
  const tools = []
  applyShells({
    tools: { register(tool) { tools.push(tool) } },
    provide() {},
    get() { return undefined },
  }, {
    shells: {
      cmd: { enabled: true },
      bash: { enabled: true, executable: 'D:\\Scoop\\apps\\git\\current\\git-bash.exe' },
      pwsh: { enabled: true },
    },
  }, () => {})
  for (const name of ['cmd', 'bash', 'pwsh']) {
    const tool = tools.find(t => t.name === name)
    assert.equal(typeof tool, 'object', `${name} should register`)
    assert.match(tool.description, /Exit codes report the command's own status, not a tool error/)
    assert.match(tool.description, /Do not re-run a command or add extra verification solely because the exit code is non-zero/)
  }
})

test('non-zero exits render as facts, never as isError results', () => {
  // renderResult is internal; the model-visible contract is the rendered
  // marker plus a presentResult that extracts it as a terminal exit pill
  // while the tool result itself stays isError: false.
  const view = presentShellResult({}, { content: [{ type: 'text', text: 'grep found nothing\n[exit code: 1]' }], isError: false })
  assert.equal(view.card, 'terminal')
  assert.equal(view.output, 'grep found nothing')
  assert.equal(view.exitCode, 1)
})

test('shellAvailabilityText lists enabled and disabled shells', () => {
  const text = shellAvailabilityText({ cmdEnabled: false, bashEnabled: true, pwshEnabled: false, persistentEnabled: true })
  assert.match(text, /启用的 shell 工具：bash、shell_session/)
  assert.match(text, /未启用的 shell 工具：cmd、pwsh/)
  assert.match(text, /只使用上面列出的已启用 shell 工具/)
})

test('shellAvailabilityText is empty when every shell is enabled', () => {
  assert.equal(shellAvailabilityText({ cmdEnabled: true, bashEnabled: true, pwshEnabled: true, wslEnabled: true, persistentEnabled: false }), '')
})

test('shellAvailabilityText handles the no-enabled edge without a misleading list', () => {
  const text = shellAvailabilityText({ cmdEnabled: false, bashEnabled: false, pwshEnabled: false, wslEnabled: false, persistentEnabled: false })
  assert.match(text, /当前没有启用的 shell 工具/)
  assert.match(text, /不得调用/)
})

test('applyShells renders availability from the current entry config', () => {
  const sections = []
  applyShells({
    tools: { register() {} },
    provide() {},
    get(name) { return name === 'shellMiddlewareSlot' ? { list: () => [] } : undefined },
    systemPrompt: { section(section) { sections.push(section) } },
  }, {
    shells: {
      cmd: { enabled: false },
      bash: { enabled: true, executable: 'D:\\Scoop\\apps\\git\\current\\git-bash.exe' },
      pwsh: { enabled: false },
      wsl: { enabled: false },
    },
  }, () => {})
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'shell:availability')
  assert.equal(sections[0].order, 110)
  assert.match(sections[0].text(), /启用的 shell 工具：bash/)
  assert.match(sections[0].text(), /未启用的 shell 工具：cmd、pwsh、wsl/)
})

test('shells.env entries are injected into every bash spawn, layered over the UTF-8 locale', async () => {
  const spawns = []
  let bashTool
  const makeCollected = (isProbe) => ({
    stdout: { readFrom: () => ({ text: isProbe ? 'dsh-probe-ok' : '', lossy: false }) },
    stderr: { readFrom: () => ({ text: '', lossy: false }) },
  })
  const ctx = {
    tools: { register(tool) { if (tool.name === 'bash') bashTool = tool } },
    provide() {},
    get(name) { return name === 'shellMiddlewareSlot' ? { list: () => [] } : undefined },
    subprocess: {
      spawn: (spec) => {
        spawns.push(spec)
        return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: makeCollected(spec.argv.some((a) => a.includes('dsh-probe-ok'))) }
      },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
  }
  applyShells(ctx, {
    shells: {
      cmd: { enabled: false },
      bash: { enabled: true, executable: 'D:\\Scoop\\apps\\git\\current\\git-bash.exe', lang: 'C.UTF-8' },
      pwsh: { enabled: false },
      env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    },
  }, () => {})
  await bashTool.execute({ command: "echo hi", description: "probe" }, { signal: new AbortController().signal })
  assert.equal(spawns.length, 2)
  assert.deepEqual(spawns[1].env, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' })
})

test('an explicit shells.env LANG overrides the bash default locale', async () => {
  const spawns = []
  let bashTool
  const makeCollected = (isProbe) => ({
    stdout: { readFrom: () => ({ text: isProbe ? 'dsh-probe-ok' : '', lossy: false }) },
    stderr: { readFrom: () => ({ text: '', lossy: false }) },
  })
  const ctx = {
    tools: { register(tool) { if (tool.name === 'bash') bashTool = tool } },
    provide() {},
    get(name) { return name === 'shellMiddlewareSlot' ? { list: () => [] } : undefined },
    subprocess: {
      spawn: (spec) => {
        spawns.push(spec)
        return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: makeCollected(spec.argv.some((a) => a.includes('dsh-probe-ok'))) }
      },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
  }
  applyShells(ctx, {
    shells: {
      cmd: { enabled: false },
      bash: { enabled: true, executable: 'D:\\Scoop\\apps\\git\\current\\git-bash.exe', lang: 'C.UTF-8' },
      pwsh: { enabled: false },
      env: { LANG: 'en_US.UTF-8' },
    },
  }, () => {})
  await bashTool.execute({ command: 'true', description: 'probe' }, { signal: new AbortController().signal })
  assert.equal(spawns[0].env.LANG, 'en_US.UTF-8')
  assert.equal(spawns[0].env.LC_ALL, 'C.UTF-8')
})

test('shells.env rejects a non-map value or an empty key', () => {
  const registered = []
  assert.throws(() => applyShells(
    { tools: { register(tool) { registered.push(tool.name) } }, provide() {} },
    { shells: { cmd: { enabled: true }, env: ['PYTHONIOENCODING', 'utf-8'] } },
    () => {},
  ), /shells\.env must be a map/)
  assert.throws(() => applyShells(
    { tools: { register(tool) { registered.push(tool.name) } }, provide() {} },
    { shells: { cmd: { enabled: true }, env: { '': 'x' } } },
    () => {},
  ), /keys must be non-empty/)
  assert.throws(() => applyShells(
    { tools: { register(tool) { registered.push(tool.name) } }, provide() {} },
    { shells: { cmd: { enabled: true }, env: { PYTHONIOENCODING: 42 } } },
    () => {},
  ), /must be a string/)
})

test('Config covers the profile patch fields and materializes nested values', () => {
  const patch = {
    shells: {
      cmd: { enabled: false, codePage: 65001, cols: 160, rows: 40, maxOutputBytes: 64000, graceMs: 3000 },
      bash: {
        enabled: true,
        executable: 'D:\\Scoop\\apps\\git\\current\\git-bash.exe',
        lang: 'C.UTF-8',
        maxOutputBytes: 64000,
        maxSpillBytes: 67108864,
        graceMs: 3000,
        probe: true,
      },
      wsl: {
        enabled: true,
        maxOutputBytes: 64000,
        maxSpillBytes: 67108864,
        graceMs: 3000,
        probeTimeoutMs: 15000,
        probe: true,
      },
      env: { PYTHONIOENCODING: 'utf-8' },
    },
    persistent: { enabled: true, backend: 'bash' },
  }
  const parsed = materializeConfig(Config(patch))
  const expected = {
    'shells.cmd.enabled': false,
    'shells.cmd.codePage': 65001,
    'shells.cmd.cols': 160,
    'shells.cmd.rows': 40,
    'shells.cmd.maxOutputBytes': 64000,
    'shells.cmd.graceMs': 3000,
    'shells.bash.enabled': true,
    'shells.bash.executable': 'D:\\Scoop\\apps\\git\\current\\git-bash.exe',
    'shells.bash.lang': 'C.UTF-8',
    'shells.bash.maxOutputBytes': 64000,
    'shells.bash.maxSpillBytes': 67108864,
    'shells.bash.graceMs': 3000,
    'shells.bash.probe': true,
    'shells.wsl.enabled': true,
    'shells.wsl.maxOutputBytes': 64000,
    'shells.wsl.maxSpillBytes': 67108864,
    'shells.wsl.graceMs': 3000,
    'shells.wsl.probeTimeoutMs': 15000,
    'shells.wsl.probe': true,
    'shells.env.PYTHONIOENCODING': 'utf-8',
    'persistent.enabled': true,
    'persistent.backend': 'bash',
  }
  for (const [path, expectedValue] of Object.entries(expected)) {
    let value = parsed
    for (const key of path.split('.')) value = value?.[key]
    assert.equal(value, expectedValue, path)
  }
})

test('apply configures the settings policy and uses nested entry config env for bash', async () => {
  const exe = 'D:/Scoop/apps/git/current/git-bash.exe'
  const spawns = []
  let bashTool
  let settingsPolicy
  let settingsOwner
  const makeCollected = (isProbe) => ({
    stdout: { readFrom: () => ({ text: isProbe ? 'dsh-probe-ok' : '', lossy: false }) },
    stderr: { readFrom: () => ({ text: '', lossy: false }) },
  })
  const ctx = {
    fiber: { id: 'shell-plugin-local' },
    root: { logger: () => ({ error: () => {} }) },
    tools: { register(tool) { if (tool.name === 'bash') bashTool = tool } },
    inject(services, callback) {
      if (services.length !== 1 || services[0] !== 'settings') throw new Error('unexpected inject request')
      callback({
        settings: { configure(policy, owner) { settingsPolicy = policy; settingsOwner = owner; return () => {} } },
        effect(effect) { effect(); return () => {} },
      })
    },
    provide() {},
    get(name) { return name === 'shellMiddlewareSlot' ? { list: () => [] } : undefined },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    subprocess: {
      spawn: (spec) => {
        spawns.push(spec)
        return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: makeCollected(spec.argv.some((a) => a.includes('dsh-probe-ok'))) }
      },
    },
  }
  await apply(ctx, {
    shells: {
      cmd: { enabled: false },
      bash: { enabled: true, executable: exe, lang: 'C.UTF-8' },
      pwsh: { enabled: false },
      wsl: { enabled: false },
      env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', LANG: 'en_US.UTF-8' },
    },
    persistent: { enabled: false },
  })
  assert.deepEqual(settingsPolicy, { auto: false })
  assert.equal(settingsOwner, ctx.fiber)
  assert.equal(typeof bashTool, 'object')
  await bashTool.execute({ command: 'true', description: 'probe' }, { signal: new AbortController().signal })
  assert.equal(spawns.length, 2)
  assert.deepEqual(spawns[1].env, {
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C.UTF-8',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  })
})

test('wsl tools register when shells.wsl.enabled is true (and not otherwise)', () => {
  const registered = []
  const ctx = {
    tools: { register(tool) { registered.push(tool.name) } },
    provide() {},
    get() { return undefined },
    systemPrompt: { section() {} },
  }
  const result = applyShells(ctx, {
    shells: {
      cmd: { enabled: false },
      bash: { enabled: true, executable: 'D:/Scoop/apps/git/current/git-bash.exe' },
      pwsh: { enabled: false },
      wsl: { enabled: true },
    },
  }, () => {})
  assert.ok(registered.includes('wsl_probe'), 'wsl_probe registered')
  assert.ok(registered.includes('wsl_info'), 'wsl_info registered')
  assert.ok(registered.includes('wsl_exec'), 'wsl_exec registered')
  assert.ok(registered.includes('wsl_path'), 'wsl_path registered')
  assert.ok(registered.includes('bash'), 'bash still registered')
  assert.deepEqual(result.registered.filter((r) => r.startsWith('wsl')), ['wsl_exec'])

  const without = []
  applyShells({
    tools: { register(tool) { without.push(tool.name) } },
    provide() {},
    get() { return undefined },
    systemPrompt: { section() {} },
  }, {
    shells: {
      cmd: { enabled: false },
      bash: { enabled: true, executable: 'D:/Scoop/apps/git/current/git-bash.exe' },
    },
  }, () => {})
  assert.ok(!without.includes('wsl_exec'), 'wsl tools absent when wsl disabled')
})

test('wsl-enabled config satisfies the at-least-one-shell check', () => {
  const registered = []
  const ctx = {
    tools: { register(tool) { registered.push(tool.name) } },
    provide() {},
    get() { return undefined },
    systemPrompt: { section() {} },
  }
  const result = applyShells(ctx, {
    shells: { cmd: { enabled: false }, bash: { enabled: false }, pwsh: { enabled: false }, wsl: { enabled: true } },
  }, () => {})
  assert.notDeepEqual(result, { registered: [], failed: ['configuration'] })
  assert.ok(registered.includes('wsl_exec'))
})

test('shell availability text names wsl as enabled or disabled', () => {
  const enabled = shellAvailabilityText({ cmdEnabled: false, bashEnabled: true, pwshEnabled: false, wslEnabled: true })
  assert.ok(enabled.includes('bash') && enabled.includes('wsl'), 'enabled line lists bash and wsl')
  const disabled = shellAvailabilityText({ cmdEnabled: true, bashEnabled: true, pwshEnabled: true, wslEnabled: false })
  assert.ok(disabled.includes('未启用的 shell 工具：wsl'), 'disabled line names wsl')
})

test('wsl_exec fails fast on probe failure without running the command', async () => {
  const spawnArgs = []
  let wslTool
  const ctx = {
    tools: { register(tool) { if (tool.name === 'wsl_exec') wslTool = tool } },
    provide() {},
    get(name) { return name === 'shellMiddlewareSlot' ? { list: () => [] } : undefined },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    subprocess: {
      spawn(spec) {
        spawnArgs.push(spec.argv)
        return {
          stdout: Readable.from(['不存在具有所提供名称的分发。\r\n']),
          stderr: Readable.from([]),
          done: Promise.resolve({ exitCode: 4294967295, signal: null }),
        }
      },
    },
  }
  applyShells(ctx, { shells: { cmd: { enabled: false }, bash: { enabled: false }, wsl: { enabled: true } } }, () => {})
  assert.equal(typeof wslTool, 'object')
  const result = await wslTool.execute({ argv: ['echo', 'should-not-run'], distro: 'nope' }, { signal: new AbortController().signal })
  assert.equal(result.status, 'probe-failed')
  assert.equal(result.probe.ok, false)
  assert.equal(spawnArgs.length, 1, 'only the probe spawns')
  assert.ok(spawnArgs[0].includes('printf'), 'probe runs printf')
})

test('wsl_exec runs the command after a successful probe and reports the probe phase', async () => {
  const spawnArgs = []
  let wslTool
  const ctx = {
    tools: { register(tool) { if (tool.name === 'wsl_exec') wslTool = tool } },
    provide() {},
    get(name) { return name === 'shellMiddlewareSlot' ? { list: () => [] } : undefined },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    subprocess: {
      spawn(spec) {
        spawnArgs.push(spec.argv)
        const probe = spec.argv.includes('printf')
        return {
          stdout: Readable.from(probe ? ['wslctl-probe-ok'] : ['hello wsl\n']),
          stderr: Readable.from([]),
          done: Promise.resolve({ exitCode: 0, signal: null }),
        }
      },
    },
  }
  applyShells(ctx, { shells: { cmd: { enabled: false }, bash: { enabled: false }, wsl: { enabled: true } } }, () => {})
  const result = await wslTool.execute({ argv: ['echo', 'hello'] }, { signal: new AbortController().signal })
  assert.equal(result.status, 'exited')
  assert.equal(result.stdout.trim(), 'hello wsl')
  assert.equal(result.probe.ok, true)
  assert.equal(spawnArgs.length, 2, 'probe then command')
  assert.ok(spawnArgs[1].includes('bash'), 'command runs through bash -s')
})

test('wsl_exec with probe:false skips the probe entirely', async () => {
  const spawnArgs = []
  let wslTool
  const ctx = {
    tools: { register(tool) { if (tool.name === 'wsl_exec') wslTool = tool } },
    provide() {},
    get(name) { return name === 'shellMiddlewareSlot' ? { list: () => [] } : undefined },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    subprocess: {
      spawn(spec) {
        spawnArgs.push(spec.argv)
        return { stdout: Readable.from(['direct\n']), stderr: Readable.from([]), done: Promise.resolve({ exitCode: 0, signal: null }) }
      },
    },
  }
  applyShells(ctx, { shells: { cmd: { enabled: false }, bash: { enabled: false }, wsl: { enabled: true } } }, () => {})
  const result = await wslTool.execute({ argv: ['echo', 'direct'], probe: false }, { signal: new AbortController().signal })
  assert.equal(result.status, 'exited')
  assert.equal(result.stdout.trim(), 'direct')
  assert.equal(result.probe, null)
  assert.equal(spawnArgs.length, 1)
})

test('bash channel probe fails fast without running the command', async () => {
  const spawnArgs = []
  let bashTool
  const ctx = {
    tools: { register(tool) { if (tool.name === 'bash') bashTool = tool } },
    provide() {},
    get(name) { return name === 'shellMiddlewareSlot' ? { list: () => [] } : undefined },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    subprocess: {
      spawn(spec) {
        spawnArgs.push(spec.argv)
        return {
          done: Promise.resolve({ exitCode: 1, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: '', lossy: false }) },
            stderr: { readFrom: () => ({ text: 'no such file', lossy: false }) },
          },
        }
      },
    },
  }
  applyShells(ctx, { shells: { bash: { enabled: true, executable: process.execPath } } }, () => {})
  assert.equal(typeof bashTool, 'object')
  const out = await bashTool.execute({ command: 'echo hi', description: 'x' }, { signal: new AbortController().signal })
  assert.match(out, /\[probe failed\] bash/)
  assert.equal(spawnArgs.length, 1, 'only the probe spawns')
})

test('bash channel probe succeeds then the command runs', async () => {
  const spawnArgs = []
  let bashTool
  const ctx = {
    tools: { register(tool) { if (tool.name === 'bash') bashTool = tool } },
    provide() {},
    get(name) { return name === 'shellMiddlewareSlot' ? { list: () => [] } : undefined },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    subprocess: {
      spawn(spec) {
        spawnArgs.push(spec.argv)
        const isProbe = spec.argv.some((a) => a.includes('dsh-probe-ok'))
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: isProbe ? 'dsh-probe-ok' : 'hi\n', lossy: false }) },
            stderr: { readFrom: () => ({ text: '', lossy: false }) },
          },
        }
      },
    },
  }
  applyShells(ctx, { shells: { bash: { enabled: true, executable: process.execPath } } }, () => {})
  const out = await bashTool.execute({ command: 'echo hi', description: 'x' }, { signal: new AbortController().signal })
  assert.match(out, /hi/)
  assert.equal(spawnArgs.length, 2, 'probe then command')
  assert.ok(spawnArgs[0].some((a) => a.includes('dsh-probe-ok')), 'probe runs printf dsh-probe-ok')
})

test('bash probe:false skips the probe entirely', async () => {
  const spawnArgs = []
  let bashTool
  const ctx = {
    tools: { register(tool) { if (tool.name === 'bash') bashTool = tool } },
    provide() {},
    get(name) { return name === 'shellMiddlewareSlot' ? { list: () => [] } : undefined },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    subprocess: {
      spawn(spec) {
        spawnArgs.push(spec.argv)
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: 'hi\n', lossy: false }) },
            stderr: { readFrom: () => ({ text: '', lossy: false }) },
          },
        }
      },
    },
  }
  applyShells(ctx, { shells: { bash: { enabled: true, executable: process.execPath } } }, () => {})
  const out = await bashTool.execute({ command: 'echo hi', description: 'x', probe: false }, { signal: new AbortController().signal })
  assert.match(out, /hi/)
  assert.equal(spawnArgs.length, 1)
})

test('pwsh does not probe by default (default off)', async () => {
  const spawnArgs = []
  let pwshTool
  const ctx = {
    tools: { register(tool) { if (tool.name === 'pwsh') pwshTool = tool } },
    provide() {},
    get(name) { return name === 'shellMiddlewareSlot' ? { list: () => [] } : undefined },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    subprocess: {
      spawn(spec) {
        spawnArgs.push(spec.argv)
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: '', lossy: false }) },
            stderr: { readFrom: () => ({ text: '', lossy: false }) },
          },
        }
      },
    },
  }
  applyShells(ctx, { shells: { pwsh: { enabled: true, executable: process.execPath } } }, () => {})
  const out = await pwshTool.execute({ command: 'Write-Output hi', description: 'x' }, { signal: new AbortController().signal })
  assert.equal(out, '(no output)')
  assert.equal(spawnArgs.length, 1, 'no probe spawn for pwsh by default')
})

test('wsl_path preserves Windows backslashes through bash stdin', async () => {
  const spawns = []
  let pathTool
  const ctx = {
    tools: { register(tool) { if (tool.name === 'wsl_path') pathTool = tool } },
    provide() {},
    get(name) { return name === 'shellMiddlewareSlot' ? { list: () => [] } : undefined },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    subprocess: {
      spawn(spec) {
        spawns.push(spec)
        return {
          stdout: Readable.from(['/mnt/d/Programs/deepseek-harness\n']),
          stderr: Readable.from([]),
          done: Promise.resolve({ exitCode: 0, signal: null }),
        }
      },
    },
  }
  applyShells(ctx, { shells: { cmd: { enabled: false }, bash: { enabled: false }, pwsh: { enabled: false }, wsl: { enabled: true } } }, () => {})
  const result = await pathTool.execute({ path: 'D:\\Programs\\deepseek-harness', direction: 'windows-to-wsl' }, { signal: new AbortController().signal })
  assert.deepEqual(result, { path: '/mnt/d/Programs/deepseek-harness', kind: 'drvfs' })
  assert.equal(spawns.length, 1)
  assert.ok(spawns[0].argv.includes('bash'))
  assert.match(spawns[0].stdio.stdin.data, /'D:\\Programs\\deepseek-harness'/)
})

test('wsl_probe tool guard outlives the configured probe deadline', () => {
  let probeTool
  const ctx = {
    tools: { register(tool) { if (tool.name === 'wsl_probe') probeTool = tool } },
    provide() {},
    get() { return undefined },
    systemPrompt: { section() {} },
  }
  applyShells(ctx, {
    shells: {
      cmd: { enabled: false },
      bash: { enabled: false },
      pwsh: { enabled: false },
      wsl: { enabled: true, probeTimeoutMs: 15000 },
    },
  }, () => {})
  assert.equal(probeTool.timeoutMs, 20000)
})
