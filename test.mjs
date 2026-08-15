import assert from 'node:assert/strict'
import test from 'node:test'
import { applyIsolated } from './index.js'
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
  assert.equal(shellAvailabilityText({ cmdEnabled: true, bashEnabled: true, pwshEnabled: true, persistentEnabled: false }), '')
})

test('shellAvailabilityText handles the no-enabled edge without a misleading list', () => {
  const text = shellAvailabilityText({ cmdEnabled: false, bashEnabled: false, pwshEnabled: false, persistentEnabled: false })
  assert.match(text, /当前没有启用的 shell 工具/)
  assert.match(text, /不得调用/)
})

test('applyShells registers the shell:availability section and re-reads live settings', () => {
  const sections = []
  let live = { cmdEnabled: false, bashEnabled: true, pwshEnabled: false, persistentEnabled: false }
  applyShells({
    tools: { register() {} },
    provide() {},
    get(name) { return name === 'shellMiddlewareSlot' ? { list: () => [] } : undefined },
    systemPrompt: { section(section) { sections.push(section) } },
  }, {
    shells: { cmd: { enabled: false }, bash: { enabled: true, executable: 'D:\\Scoop\\apps\\git\\current\\git-bash.exe' }, pwsh: { enabled: false } },
  }, () => {}, () => live)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'shell:availability')
  assert.equal(sections[0].order, 110)
  assert.match(sections[0].text(), /启用的 shell 工具：bash/)
  assert.match(sections[0].text(), /未启用的 shell 工具：cmd、pwsh/)
  // Live settings win over the startup config: pwsh and cmd both flip to
  // enabled, leaving nothing to constrain.
  live = { cmdEnabled: true, bashEnabled: true, pwshEnabled: true, persistentEnabled: false }
  assert.equal(sections[0].text(), '')
  // A failed read falls back to the startup config instead of throwing.
  live = null
  assert.match(sections[0].text(), /启用的 shell 工具：bash/)
  assert.match(sections[0].text(), /未启用的 shell 工具：cmd、pwsh/)
})
