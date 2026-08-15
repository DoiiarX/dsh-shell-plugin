import { existsSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_MAX_OUTPUT_BYTES = 64_000
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024
const DEFAULT_GRACE_MS = 3_000
const DEFAULT_CODE_PAGE = 65001
const DEFAULT_COLS = 160
const DEFAULT_ROWS = 40

/**
 * Model-facing shell-availability paragraph for one prompt assembly. Mirrors
 * the `user:language` injection pattern: the section text is re-evaluated at
 * every assembly from the live settings, so enabling/disabling a shell in the
 * settings page changes the constraint on the next turn without a restart.
 *
 * Lists the enabled shell tools and names the disabled ones, then forbids
 * calling any shell outside the enabled set even when its tool is present in
 * the catalog (a preset or host row can still mount a system tool this plugin
 * does not own, e.g. `@deepseek-ai/dsh-tool-pwsh`).
 *
 * @param flags - flattened enable flags (the `local-shell-tools` settings
 *   shape, plus `persistentEnabled` for the shell_session tool).
 * @returns the constraint paragraph, or '' when every shell is enabled
 *   (nothing to constrain; empty sections are skipped by renderPrompt).
 */
export function shellAvailabilityText(flags) {
  const enabled = []
  const disabled = []
  const push = (name, on) => { (on ? enabled : disabled).push(name) }
  push('cmd', flags.cmdEnabled === true)
  push('bash', flags.bashEnabled === true)
  push('pwsh', flags.pwshEnabled === true)
  if (flags.persistentEnabled === true) enabled.push('shell_session')
  if (disabled.length === 0) return ''
  const enabledLine = enabled.length > 0
    ? `本部署启用的 shell 工具：${enabled.join('、')}。`
    : '本部署当前没有启用的 shell 工具。'
  const disabledLine = `未启用的 shell 工具：${disabled.join('、')}。`
  const rule = '只使用上面列出的已启用 shell 工具执行命令；未启用的工具即使出现在你的工具列表中（例如 pwsh）也视为禁用，不得调用。'
  return [enabledLine, disabledLine, rule].join('\n')
}

/**
 * Persistent-shell session registry, keyed by owning agent. One terminal per
 * agent keeps cwd, exported variables, and session state across calls; the
 * session dies with its agent (agent/disposed cleanup below) or on stop().
 */
const persistentSessions = new Map()

function sessionKey(exec) {
  if (exec?.agent === undefined) return 'anonymous'
  return exec.agent.id
}

/** Resolve the argv for one persistent terminal backend. */
function persistentArgv(backend, config, codePage) {
  if (backend === 'bash') {
    const executable = resolveBashExecutable(config.shells?.bash?.executable)
    return [executable, '--noprofile', '--norc', '-i']
  }
  if (backend === 'pwsh') {
    const executable = resolvePwshExecutable(config.shells?.pwsh?.executable)
    return [executable, '-NoLogo', '-NoProfile', '-NonInteractive']
  }
  const executable = assertExecutable(
    'cmd',
    config.shells?.cmd?.executable ?? process.env.ComSpec ?? `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\cmd.exe`,
  )
  return [executable, '/d', '/q', '/s', '/k', `chcp ${codePage}>nul`]
}

/** Spawn one owned persistent terminal; returns the session record. */
async function startPersistent(ctx, exec, backend, config) {
  const key = sessionKey(exec)
  const existing = persistentSessions.get(key)
  if (existing !== undefined) {
    return { sessionId: key, alreadyRunning: true, backend: existing.backend }
  }
  const codePage = positiveInteger('shells.cmd.codePage', config.shells?.cmd?.codePage, DEFAULT_CODE_PAGE)
  const cols = positiveInteger('shells.cmd.cols', config.shells?.cmd?.cols, DEFAULT_COLS)
  const rows = positiveInteger('shells.cmd.rows', config.shells?.cmd?.rows, DEFAULT_ROWS)
  const graceMs = positiveInteger('shells.cmd.graceMs', config.shells?.cmd?.graceMs, DEFAULT_GRACE_MS)
  const terminal = await ctx.subprocess.spawnTerminal({
    argv: persistentArgv(backend, config, codePage),
    cwd: commandWorkdir(undefined, exec),
    rows,
    cols,
    graceMs,
  })
  const session = {
    id: key,
    backend,
    terminal,
    chunks: [],
    bytes: 0,
    maxOutputBytes: positiveInteger('shells.bash.maxOutputBytes', config.shells?.bash?.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
    truncated: false,
  }
  terminal.output.on('data', (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    session.chunks.push(buffer)
    session.bytes += buffer.length
    while (session.bytes > session.maxOutputBytes && session.chunks.length > 0) {
      const excess = session.bytes - session.maxOutputBytes
      const head = session.chunks[0]
      if (head.length <= excess) {
        session.chunks.shift()
        session.bytes -= head.length
      } else {
        session.chunks[0] = head.subarray(excess)
        session.bytes -= excess
      }
      session.truncated = true
    }
  })
  void terminal.done.then(() => { persistentSessions.delete(key) })
  persistentSessions.set(key, session)
  return { sessionId: key, alreadyRunning: false, backend }
}

/** Drain output accumulated since `sinceBytes`, normalizing terminal control sequences. */
function drainSince(session, sinceBytes) {
  const all = Buffer.concat(session.chunks).toString('utf8')
  const text = normalizeTerminalText(all.slice(Math.max(0, sinceBytes)))
  return { text, truncated: session.truncated }
}

/** Write one command to a persistent terminal and wait for output to settle. */
async function runPersistent(ctx, exec, command, session, quietMs = 350, maxWaitMs = 120_000) {
  const sinceBytes = session.bytes
  const settled = Promise.withResolvers()
  const timer = setTimeout(() => settled.resolve(false), maxWaitMs)
  let seen = 0
  const onOutput = () => {
    if (session.bytes > sinceBytes) {
      seen = Date.now()
      // Output stopped growing for `quietMs` ⇒ the command's echo is done.
      if (Date.now() - seen >= quietMs) settled.resolve(true)
    }
  }
  const interval = setInterval(onOutput, 60)
  try {
    await session.terminal.write(`${command}\n`)
    await settled.promise
  } finally {
    clearTimeout(timer)
    clearInterval(interval)
  }
  return drainSince(session, sinceBytes)
}

/** Register agent-disposal cleanup so a session never outlives its owner. */
function bindPersistentCleanup(ctx) {
  ctx.on('agent/disposed', ({ agent }) => {
    const session = persistentSessions.get(agent.id)
    if (session !== undefined) {
      persistentSessions.delete(agent.id)
      try { session.terminal.terminate() } catch { /* teardown race: already gone */ }
    }
  })
}

/** Stop one owned persistent terminal. */
function stopPersistent(ctx, exec, sessionId) {
  const key = sessionId ?? sessionKey(exec)
  const session = persistentSessions.get(key)
  if (session === undefined) return { stopped: false }
  persistentSessions.delete(key)
  try { session.terminal.terminate() } catch { /* already gone */ }
  return { stopped: true, backend: session.backend }
}

/** List the calling agent's persistent terminals. */
function listPersistent(exec) {
  const key = sessionKey(exec)
  const session = persistentSessions.get(key)
  if (session === undefined) return { sessions: [] }
  return {
    sessions: [{
      sessionId: session.id,
      backend: session.backend,
      // The session is removed from the map when its terminal exits, so a
      // present entry is by definition still running.
      running: true,
    }],
  }
}

function positiveNumber(name, value, fallback, maximum = Number.POSITIVE_INFINITY) {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`invalid ${name}: expected a positive number, got ${JSON.stringify(resolved)}`)
  }
  return Math.min(resolved, maximum)
}

function positiveInteger(name, value, fallback) {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`invalid ${name}: expected a positive integer, got ${JSON.stringify(resolved)}`)
  }
  return resolved
}

function commandWorkdir(modelWorkdir, exec) {
  const workspace = exec.agent?.session.header.cwd
  if (modelWorkdir === undefined) return workspace ?? process.cwd()
  if (workspace !== undefined && !isAbsolute(modelWorkdir)) return resolve(workspace, modelWorkdir)
  return modelWorkdir
}

function assertExecutable(label, executable) {
  if (!isAbsolute(executable)) throw new Error(`${label} executable must be an absolute path: ${executable}`)
  if (!existsSync(executable) || !statSync(executable).isFile()) {
    throw new Error(`${label} executable is not a file: ${executable}`)
  }
  return executable
}

/** Resolve Git for Windows' GUI launcher to its non-GUI Bash executable. */
export function resolveBashExecutable(configured) {
  if (configured === undefined || configured.length === 0) {
    throw new Error('bash is enabled but shells.bash.executable is empty')
  }
  const leaf = basename(configured).toLowerCase()
  if (leaf === 'git-bash.exe') {
    return assertExecutable('bash', join(dirname(configured), 'bin', 'bash.exe'))
  }
  return assertExecutable('bash', configured)
}

function assertArgs(args) {
  if (args.command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
  if (args.description.trim().length === 0) throw new Error('invalid description: expected a non-empty string')
}

function assertFullAccess(ctx, exec, toolName) {
  const policy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
  if (policy.mode !== 'danger-full-access') {
    throw new Error(`${toolName} is disabled under ${policy.mode} mode; switch this session to danger-full-access to use it`)
  }
}

/**
 * Model-facing exit-status semantics shared by every registered shell tool.
 * First-principles contract: an exit code is the command's own status
 * vocabulary, not a tool verdict — many commands return non-zero for expected
 * outcomes (grep with no match, diff with differences, `test` evaluating
 * false). The tool reports the fact; the model judges success from the output
 * and the command's purpose. Re-running a command or adding verification
 * solely because the exit code is non-zero is the loop this sentence exists
 * to prevent.
 */
const EXIT_CODE_SEMANTICS =
  'Exit codes report the command\'s own status, not a tool error: many commands return non-zero for expected outcomes '
  + '(grep with no match, diff with differences, `test` evaluating false). Judge success from the output and the '
  + 'command\'s purpose. Do not re-run a command or add extra verification solely because the exit code is non-zero.'

function renderResult(stdout, stderr, outcome, timedOut, timeoutMs) {
  let text = stdout
  if (stderr.length > 0) {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n'
    text += `[stderr]\n${stderr}`
  }
  if (timedOut) {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n'
    text += `[timed out after ${timeoutMs}ms]\n`
  }
  if (outcome.exitCode !== 0) {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n'
    text += `[exit code: ${outcome.exitCode ?? 1}]`
  }
  return text.length === 0 ? '(no output)' : text.replace(/\n+$/, '')
}

export function normalizeTerminalText(raw) {
  return stripVTControlCharacters(raw.replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, ''))
    .replace(/\u0007/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

function toolParameters(dialect) {
  return {
    command: { type: 'string', required: true, description: `The ${dialect} command to execute.` },
    description: {
      type: 'string',
      required: true,
      description: 'Clear, concise description of what this command does, shown in the UI.',
    },
    timeoutMs: { type: 'number', description: 'Timeout in milliseconds; defaults to 120000 and is capped at 600000.' },
    workdir: { type: 'string', description: 'Working directory; relative paths resolve against the session workspace.' },
    run_in_background: {
      type: 'boolean',
      description: 'Run the command in the background (fire-and-forget): the call returns a job id immediately; '
        + 'poll it with `job_output` (or `job_output` with `wait: true`) and stop it with `job_kill`. '
        + 'When the process settles, a completion notice is delivered to this session automatically.',
    },
  }
}

/**
 * Register one background shell execution with `ctx.jobs` (fire-and-forget).
 * The call returns immediately with a job id; `job_output`/`job_kill` (and the
 * session completion notice) arrive through the jobs service, so the model can
 * hand off a long-running command and check on it later.
 * @param ctx - the tool context (host plane).
 * @param exec - the tool execution (owner/agent for job fencing).
 * @param label - one-line job label (the command text).
 * @param spawnProcess - starts the process and returns { done, cancel, readOutput }.
 * @param kind - jobs producer kind (defaults to the tool name).
 * @returns the started job id.
 */
export function startBackground(ctx, exec, label, spawnProcess, kind) {
  const jobs = ctx.get('jobs')
  if (jobs === undefined) {
    throw new Error('run_in_background is unavailable: no background job registry (ctx.jobs) in this composition')
  }
  return jobs.start({
    kind: kind ?? 'shell',
    label,
    ...exec.agent ? { owner: exec.agent } : {},
    run: () => spawnProcess(),
  })
}

/** Map a settled subprocess outcome onto the generic task-outcome vocabulary. */
function shellOutcome(outcome) {
  if (outcome.signal !== undefined && outcome.signal !== null) {
    return { status: 'killed', detail: `signal: ${outcome.signal}` }
  }
  return { status: 'completed', detail: `exit code: ${outcome.exitCode ?? 0}` }
}

/** Read the settled background process's collected stdout as model-facing text. */
function backgroundText(running) {
  return renderResult(
    finalText(running.collected.stdout),
    finalText(running.collected.stderr),
    running.outcome ?? {},
    false,
    0,
  )
}

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/**
 * Present a shell call as a terminal card (input preview): the command is the
 * title, the description sits under it, and a foreground workdir becomes the
 * terminal cwd. Background starts use a generic card carrying the description.
 */
export function presentShellCall(args) {
  const command = typeof args?.command === 'string' ? args.command : ''
  if (args?.run_in_background === true) {
    return {
      card: 'generic',
      title: command,
      kind: 'execute',
      rawInput: command,
      content: [{ type: 'text', text: args?.description ?? '' }],
    }
  }
  return {
    card: 'terminal',
    title: command,
    description: args?.description ?? '',
    ...typeof args?.workdir === 'string' && args.workdir.length > 0 ? { cwd: args.workdir } : {},
  }
}

/**
 * Present a completed shell result as a terminal card: the trailing exit
 * marker becomes the card's exit pill, leaving the output body. Background
 * acknowledgements and errors use a generic fenced block instead.
 */
export function presentShellResult(args, result) {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  const raw = block.text
  const isBackground = typeof args === 'object' && args !== null && args.run_in_background === true
  if (isBackground || result.isError) {
    return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] }
  }
  const marker = /\[(?:exit code: (\d+)|killed by signal: ([^\]]+)|timed out after (\d+)ms)\]$/.exec(raw.trimEnd())
  if (marker === null) return { card: 'terminal', output: raw }
  const [, exitCode, signal, timedOut] = marker
  const body = raw.slice(0, raw.trimEnd().length - marker[0].length).replace(/\n+$/, '')
  return {
    card: 'terminal',
    output: body,
    ...exitCode !== undefined ? { exitCode: Number(exitCode) } : {},
    ...signal !== undefined ? { signal } : undefined,
    ...timedOut !== undefined ? { timedOut: true } : undefined,
  }
}

function registerCmd(ctx, config) {
  const executable = assertExecutable(
    'cmd',
    config.executable ?? process.env.ComSpec ?? `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\cmd.exe`,
  )
  const codePage = positiveInteger('shells.cmd.codePage', config.codePage, DEFAULT_CODE_PAGE)
  const cols = positiveInteger('shells.cmd.cols', config.cols, DEFAULT_COLS)
  const rows = positiveInteger('shells.cmd.rows', config.rows, DEFAULT_ROWS)
  const maxOutputBytes = positiveInteger('shells.cmd.maxOutputBytes', config.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES)
  const graceMs = positiveInteger('shells.cmd.graceMs', config.graceMs, DEFAULT_GRACE_MS)

  ctx.tools.register(defineTool({
    name: config.toolName ?? 'cmd',
    description: 'Execute native Windows Command Prompt syntax through a hidden ConPTY terminal in danger-full-access mode. '
      + 'Use `cd`, `dir`, `set NAME=value`, `%NAME%`, `&&`, and `|`; do not use PowerShell cmdlets. '
      + `The terminal sets Windows code page ${codePage} before execution and returns normalized Unicode text. `
      + EXIT_CODE_SEMANTICS,
    parameters: toolParameters('CMD'),
    output: textOutput,
    presentCall: presentShellCall,
    presentResult: presentShellResult,
    async execute(args, exec) {
      assertArgs(args)
      assertFullAccess(ctx, exec, config.toolName ?? 'cmd')
      const timeoutMs = positiveNumber('timeoutMs', args.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = AbortSignal.any([exec.signal, timeout])
      // Fire-and-forget via the jobs registry; the terminal is started and its
      // output collected until `done`, so job_output can read the full result.
      if (args.run_in_background === true) {
        return runShellChain(ctx, exec, args, async () => {
          const terminal = await ctx.subprocess.spawnTerminal({
            argv: [executable, '/d', '/q', '/s', '/c', `chcp ${codePage}>nul & ${args.command}`],
            cwd: commandWorkdir(args.workdir, exec),
            rows,
            cols,
            graceMs,
            signal,
          })
          const chunks = []
          let bytes = 0
          terminal.output.on('data', (chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            chunks.push(buffer)
            bytes += buffer.length
            while (bytes > maxOutputBytes && chunks.length > 0) {
              const excess = bytes - maxOutputBytes
              const head = chunks[0]
              if (head.length <= excess) {
                chunks.shift()
                bytes -= head.length
              } else {
                chunks[0] = head.subarray(excess)
                bytes -= excess
              }
            }
          })
          const jobId = startBackground(ctx, exec, args.command, () => ({
            cancel: () => void terminal.terminate(),
            done: terminal.done.then((outcome) => ({
              status: 'completed',
              detail: `exit code: ${outcome.exitCode ?? 0}`,
            })),
            readOutput: () => normalizeTerminalText(Buffer.concat(chunks).toString('utf8')),
          }), 'cmd')
          return { text: `started background job ${jobId}`, outcome: { exitCode: 0 } }
        }).then((result) => result.text)
      }
      // Middleware chain wraps the real terminal execution (see registerBash).
      return runShellChain(ctx, exec, args, async () => {
        const terminal = await ctx.subprocess.spawnTerminal({
          argv: [executable, '/d', '/q', '/s', '/c', `chcp ${codePage}>nul & ${args.command}`],
          cwd: commandWorkdir(args.workdir, exec),
          rows,
          cols,
          graceMs,
          signal,
        })
        const chunks = []
        let bytes = 0
        let truncated = false
        terminal.output.on('data', (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          chunks.push(buffer)
          bytes += buffer.length
          while (bytes > maxOutputBytes && chunks.length > 0) {
            const excess = bytes - maxOutputBytes
            const head = chunks[0]
            if (head.length <= excess) {
              chunks.shift()
              bytes -= head.length
            } else {
              chunks[0] = head.subarray(excess)
              bytes -= excess
            }
            truncated = true
          }
        })
        const aborted = Promise.withResolvers()
        const onAbort = () => { aborted.resolve(false) }
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
        try {
          const settled = await Promise.race([terminal.done.then(() => true), aborted.promise])
          if (!settled) await terminal.terminate()
          const outcome = await terminal.done
          const output = normalizeTerminalText(Buffer.concat(chunks).toString('utf8'))
          const prefix = truncated ? '[output truncated to tail]\n' : ''
          return {
            text: prefix + renderResult(output, '', outcome, timeout.aborted && !exec.signal.aborted, timeoutMs),
            outcome,
          }
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      }).then((result) => result.text)
    },
  }))
}

function finalText(reader) {
  return reader?.readFrom(0).text ?? ''
}

/**
 * Run one shell execution through the middleware chain registered in the
 * `shellMiddlewareSlot` service, then the core. The slot is provided by
 * applyShells; reading it here (instead of closing over it) keeps the
 * register* functions decoupled and lets any plugin register at any time.
 * Each middleware: async (ctx, exec, args, next) => result, where
 * result = { text, outcome }; next() runs the remaining chain then core.
 */
function runShellChain(ctx, exec, args, core) {
  const slot = ctx.get('shellMiddlewareSlot')
  const middlewares = slot?.list?.() ?? []
  const dispatch = async (index) => {
    const fn = middlewares[index]
    if (fn === undefined) return core()
    return fn(ctx, exec, args, () => dispatch(index + 1))
  }
  return dispatch(0)
}

function registerBash(ctx, config) {
  const executable = resolveBashExecutable(config.executable)
  const maxOutputBytes = positiveInteger('shells.bash.maxOutputBytes', config.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES)
  const maxSpillBytes = positiveInteger('shells.bash.maxSpillBytes', config.maxSpillBytes, DEFAULT_MAX_SPILL_BYTES)
  const graceMs = positiveInteger('shells.bash.graceMs', config.graceMs, DEFAULT_GRACE_MS)

  ctx.tools.register(defineTool({
    name: config.toolName ?? 'bash',
    description: 'Execute Linux-like Bash syntax through Git for Windows bash.exe in danger-full-access mode. '
      + 'Use POSIX paths, quoting, variables, pipes, redirection, and common Unix utilities. '
      + 'This controls the Windows host through Git Bash; it is not WSL or a Linux VM. Output is UTF-8. '
      + EXIT_CODE_SEMANTICS,
    parameters: toolParameters('Bash'),
    output: textOutput,
    presentCall: presentShellCall,
    presentResult: presentShellResult,
    async execute(args, exec) {
      assertArgs(args)
      assertFullAccess(ctx, exec, config.toolName ?? 'bash')
      const timeoutMs = positiveNumber('timeoutMs', args.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = AbortSignal.any([exec.signal, timeout])
      const collect = { maxBytes: maxOutputBytes, spill: { maxBytes: maxSpillBytes } }
      // Fire-and-forget: register with the jobs service and return the id now.
      if (args.run_in_background === true) {
        return runShellChain(ctx, exec, args, async () => {
          const running = ctx.subprocess.spawn({
            argv: [executable, '--noprofile', '--norc', '-lc', args.command],
            cwd: commandWorkdir(args.workdir, exec),
            stdio: { stdin: 'ignore', stdout: collect, stderr: collect },
            graceMs,
            signal,
            env: { LANG: config.lang ?? 'C.UTF-8', LC_ALL: config.lang ?? 'C.UTF-8' },
          })
          const jobId = startBackground(ctx, exec, args.command, () => ({
            cancel: () => void running.terminate(),
            done: running.done.then((outcome) => {
              running.outcome = outcome
              return shellOutcome(outcome)
            }),
            readOutput: () => backgroundText(running),
          }), 'bash')
          return { text: `started background job ${jobId}`, outcome: { exitCode: 0 } }
        }).then((result) => result.text)
      }
      // The middleware chain wraps the real execution; the core resolves to
      // { text, outcome } so middleware can read outcome.resources and adjust
      // the presented text. This plugin only calls the chain (the slot).
      return runShellChain(ctx, exec, args, async () => {
        const running = ctx.subprocess.spawn({
          argv: [executable, '--noprofile', '--norc', '-lc', args.command],
          cwd: commandWorkdir(args.workdir, exec),
          stdio: { stdin: 'ignore', stdout: collect, stderr: collect },
          graceMs,
          signal,
          env: { LANG: config.lang ?? 'C.UTF-8', LC_ALL: config.lang ?? 'C.UTF-8' },
        })
        const outcome = await running.done
        return {
          text: renderResult(
            finalText(running.collected.stdout),
            finalText(running.collected.stderr),
            outcome,
            timeout.aborted && !exec.signal.aborted,
            timeoutMs,
          ),
          outcome,
        }
      }).then((result) => result.text)
    },
  }))
}

/** Resolve the configured PowerShell executable (pwsh.exe preferred, then Windows PowerShell 5.1). */
export function resolvePwshExecutable(configured, env = process.env) {
  if (configured !== undefined && configured.length > 0) {
    return assertExecutable('pwsh', configured)
  }
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  const candidates = [
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  // PATH fallback mirrors pwsh-local's resolution order; trust the first hit.
  for (const entry of (env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length === 0) continue
    for (const leaf of ['pwsh.exe', 'powershell.exe']) {
      const candidate = join(trimmed, leaf)
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
  }
  return 'pwsh'
}

function registerPwsh(ctx, config) {
  const executable = resolvePwshExecutable(config.executable)
  const maxOutputBytes = positiveInteger('shells.pwsh.maxOutputBytes', config.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES)
  const maxSpillBytes = positiveInteger('shells.pwsh.maxSpillBytes', config.maxSpillBytes, DEFAULT_MAX_SPILL_BYTES)
  const graceMs = positiveInteger('shells.pwsh.graceMs', config.graceMs, DEFAULT_GRACE_MS)

  ctx.tools.register(defineTool({
    name: config.toolName ?? 'pwsh',
    description: 'Execute a PowerShell command (`pwsh -NoLogo -NoProfile -NonInteractive -Command`) in danger-full-access mode. '
      + 'Use PowerShell syntax: cmdlets, `$variables`, pipelines, and `;`. '
      + 'This spawns a real PowerShell process through the Harness subprocess seam (independent of the system `ctx.shell` executor). '
      + 'Output is normalized UTF-8. '
      + EXIT_CODE_SEMANTICS,
    parameters: toolParameters('PowerShell'),
    output: textOutput,
    presentCall: presentShellCall,
    presentResult: presentShellResult,
    async execute(args, exec) {
      assertArgs(args)
      assertFullAccess(ctx, exec, config.toolName ?? 'pwsh')
      const timeoutMs = positiveNumber('timeoutMs', args.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = AbortSignal.any([exec.signal, timeout])
      const collect = { maxBytes: maxOutputBytes, spill: { maxBytes: maxSpillBytes } }
      if (args.run_in_background === true) {
        return runShellChain(ctx, exec, args, async () => {
          const running = ctx.subprocess.spawn({
            argv: [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', args.command],
            cwd: commandWorkdir(args.workdir, exec),
            stdio: { stdin: 'ignore', stdout: collect, stderr: collect },
            graceMs,
            signal,
          })
          const jobId = startBackground(ctx, exec, args.command, () => ({
            cancel: () => void running.terminate(),
            done: running.done.then((outcome) => {
              running.outcome = outcome
              return shellOutcome(outcome)
            }),
            readOutput: () => backgroundText(running),
          }), 'pwsh')
          return { text: `started background job ${jobId}`, outcome: { exitCode: 0 } }
        }).then((result) => result.text)
      }
      return runShellChain(ctx, exec, args, async () => {
        const running = ctx.subprocess.spawn({
          argv: [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', args.command],
          cwd: commandWorkdir(args.workdir, exec),
          stdio: { stdin: 'ignore', stdout: collect, stderr: collect },
          graceMs,
          signal,
        })
        const outcome = await running.done
        return {
          text: renderResult(
            finalText(running.collected.stdout),
            finalText(running.collected.stderr),
            outcome,
            timeout.aborted && !exec.signal.aborted,
            timeoutMs,
          ),
          outcome,
        }
      }).then((result) => result.text)
    },
  }))
}

export function applyShells(ctx, config = {}, report = () => {}, readSettings = undefined) {
  // ── Middleware slot ─────────────────────────────────────────────────────
  // This plugin provides a REGISTRATION POINT (slot), not measurement logic.
  // Any middleware (e.g. perf-hook) registers a function here; it is then
  // invoked around every shell execution, receiving (ctx, exec, args, next)
  // where next() runs the real command and resolves to { text, outcome }.
  // The middleware may read outcome.resources (executor-kept Job-Object
  // accounting) and may replace the returned text. This plugin never knows
  // who registers — it only provides the slot and calls the chain.
  // Set-mode registry: each middleware is keyed by its registering plugin's
  // owner label, so the same owner re-registering replaces its old entry and a
  // plugin update can dispose its own middleware without disturbing others.
  // `use(owner, fn)` returns a disposer; `use(fn)` (legacy) auto-keys by a
  // unique label. `list()` keeps returning plain functions for runShellChain;
  // `entries()` exposes `{ owner, fn }` for inspection and self-cleaning.
  const middlewares = new Map()
  let anonymousCounter = 0

  /**
   * Run one shell execution through the registered middleware chain, then the
   * core. Each middleware: async (ctx, exec, args, next) => result, where
   * result = { text, outcome }. Core returns the same shape. The slot is
   * exposed as a service so any plugin can read it; `use` registers.
   */
  const slot = {
    use(owner, fn) {
      let key = owner
      if (typeof owner === 'function') {
        fn = owner
        key = `anonymous-${++anonymousCounter}`
      }
      if (typeof key !== 'string' || key.length === 0) {
        throw new TypeError('shellMiddlewareSlot.use: owner must be a non-empty string (or pass a bare function for legacy auto-keying)')
      }
      if (typeof fn !== 'function') {
        throw new TypeError('shellMiddlewareSlot.use: middleware must be a function')
      }
      middlewares.set(key, fn)
      return () => { if (middlewares.get(key) === fn) middlewares.delete(key) }
    },
    remove(owner) { middlewares.delete(owner) },
    has(owner) { return middlewares.has(owner) },
    entries() { return [...middlewares.entries()].map(([owner, fn]) => ({ owner, fn })) },
    list() { return [...middlewares.values()] },
  }
  ctx.provide('shellMiddlewareSlot', slot)

  const shells = config.shells ?? {}
  const cmd = shells.cmd ?? { enabled: true }
  const bash = shells.bash ?? { enabled: false }
  const pwsh = shells.pwsh ?? { enabled: false }
  if (cmd.enabled !== true && bash.enabled !== true && pwsh.enabled !== true) {
    report('configuration', new Error('enable at least one of shells.cmd, shells.bash or shells.pwsh'))
    return { registered: [], failed: ['configuration'] }
  }

  // ── Model-facing shell-availability constraint ──────────────────────────
  // Mirrors the `user:language` injection pattern: a dynamic system-prompt
  // section re-evaluated at every assembly, so enabling/disabling a shell in
  // the settings page is reflected on the next turn without a restart. When
  // `readSettings` is provided (the settings scope), live values win over the
  // startup config. Any evaluation failure degrades to an empty paragraph.
  const persistentConfig = config.persistent ?? { enabled: false }
  const availability = () => {
    try {
      let flags
      if (readSettings !== undefined) {
        const live = readSettings()
        if (live !== null && typeof live === 'object') {
          flags = { ...live, persistentEnabled: persistentConfig.enabled === true }
        }
      }
      // A missing or malformed settings read falls back to the startup config
      // rather than emitting a misleading all-disabled paragraph.
      if (flags === undefined) {
        flags = {
          cmdEnabled: cmd.enabled === true,
          bashEnabled: bash.enabled === true,
          pwshEnabled: pwsh.enabled === true,
          persistentEnabled: persistentConfig.enabled === true,
        }
      }
      return shellAvailabilityText(flags)
    } catch (error) {
      report('system-prompt', error)
      return ''
    }
  }
  ctx.systemPrompt?.section?.({
    name: 'shell:availability',
    order: 110,
    text: availability,
  })

  const registered = []
  const failed = []

  // ── Persistent sessions ──────────────────────────────────────────────────
  // One owned terminal per agent (bash/cmd/pwsh backend) keeps cwd and session
  // state across calls. Enabled by `persistent.enabled: true`; the backend
  // defaults to the first enabled shell.
  const persistentEnabled = persistentConfig.enabled === true
  if (persistentEnabled) {
    bindPersistentCleanup(ctx)
    const defaultBackend = persistentConfig.backend
      ?? (bash.enabled === true ? 'bash' : pwsh.enabled === true ? 'pwsh' : cmd.enabled === true ? 'cmd' : 'bash')
    ctx.tools.register(defineTool({
      name: 'shell_session',
      description: 'Manage a persistent shell session for this agent. '
        + '`start` spawns a long-lived terminal (backend: ' + defaultBackend + ') that keeps cwd, exported variables, '
        + 'and shell state across calls; `run` executes one command in it and returns the accumulated output; '
        + '`stop` terminates it; `list` shows the current session. '
        + 'The session is owned by this agent and is torn down automatically when the agent ends.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: 'One of start | run | stop | list.',
        },
        command: {
          type: 'string',
          description: 'The shell command to run (required for action=run).',
        },
        backend: {
          type: 'string',
          description: 'Session backend: bash | cmd | pwsh (start only; defaults to ' + defaultBackend + ').',
        },
        sessionId: {
          type: 'string',
          description: 'Target session id (stop/list; defaults to this agent\'s session).',
        },
      },
      output: textOutput,
      async execute(args, exec) {
        assertFullAccess(ctx, exec, 'shell_session')
        const action = args.action
        if (action === 'start') {
          const result = await startPersistent(ctx, exec, args.backend ?? defaultBackend, config)
          return result.alreadyRunning
            ? `persistent session ${result.sessionId} already running (backend: ${result.backend})`
            : `started persistent session ${result.sessionId} (backend: ${result.backend})`
        }
        if (action === 'stop') {
          const result = stopPersistent(ctx, exec, args.sessionId)
          return result.stopped ? `stopped persistent session ${args.sessionId ?? sessionKey(exec)}` : 'no persistent session to stop'
        }
        if (action === 'list') {
          const result = listPersistent(exec)
          return result.sessions.length === 0
            ? 'no persistent session'
            : result.sessions.map((s) => `session ${s.sessionId} (backend: ${s.backend})`).join('\n')
        }
        if (action === 'run') {
          if (typeof args.command !== 'string' || args.command.trim().length === 0) {
            throw new Error('invalid command: action=run requires a non-empty command string')
          }
          let target = persistentSessions.get(sessionKey(exec))
          if (target === undefined) {
            await startPersistent(ctx, exec, defaultBackend, config)
            target = persistentSessions.get(sessionKey(exec))
          }
          const { text, truncated } = await runPersistent(ctx, exec, args.command, target)
          const prefix = truncated ? '[output truncated to tail]\n' : ''
          const trimmed = (prefix + text).trim()
          return trimmed === '' ? '(no output)' : trimmed
        }
        throw new Error(`invalid action: expected start | run | stop | list, got ${JSON.stringify(action)}`)
      },
    }))
    registered.push('shell_session')
  }

  if (cmd.enabled === true) {
    try {
      registerCmd(ctx, cmd)
      registered.push(cmd.toolName ?? 'cmd')
    } catch (error) {
      failed.push(cmd.toolName ?? 'cmd')
      report(cmd.toolName ?? 'cmd', error)
    }
  }
  if (bash.enabled === true) {
    try {
      registerBash(ctx, bash)
      registered.push(bash.toolName ?? 'bash')
    } catch (error) {
      failed.push(bash.toolName ?? 'bash')
      report(bash.toolName ?? 'bash', error)
    }
  }
  if (pwsh.enabled === true) {
    try {
      registerPwsh(ctx, pwsh)
      registered.push(pwsh.toolName ?? 'pwsh')
    } catch (error) {
      failed.push(pwsh.toolName ?? 'pwsh')
      report(pwsh.toolName ?? 'pwsh', error)
    }
  }
  return { registered, failed }
}
