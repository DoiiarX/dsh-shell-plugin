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
 * @param flags - flattened enable flags derived from the current entry Config,
 *   plus `persistentEnabled` for the shell_session tool.
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
  push('wsl', flags.wslEnabled === true)
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
  const persistentEnv = assertEnvMap(config.shells?.env)
  const terminal = await ctx.subprocess.spawnTerminal({
    argv: persistentArgv(backend, config, codePage),
    cwd: commandWorkdir(undefined, exec),
    rows,
    cols,
    graceMs,
    ...Object.keys(persistentEnv).length > 0 ? { env: persistentEnv } : {},
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

/**
 * Validate and return a `shells.env` map of extra environment entries injected
 * into every command. A plain object with non-empty string keys is required;
 * config mistakes fail here at load rather than silently under-executing.
 * @param env - the configured `shells.env` value (undefined allowed).
 * @returns the validated record, or an empty object when absent.
 */
function assertEnvMap(env) {
  if (env === undefined || env === null) return {}
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw new Error(`shells.env must be a map of KEY: VALUE, got ${JSON.stringify(env)}`)
  }
  const validated = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.length === 0) {
      throw new Error('shells.env: environment variable keys must be non-empty')
    }
    if (typeof value !== 'string') {
      throw new Error(`shells.env: value for ${JSON.stringify(key)} must be a string, got ${JSON.stringify(value)}`)
    }
    validated[key] = value
  }
  return validated
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
    probe: {
      type: 'boolean',
      description: 'Run a fast channel probe before the command (default: shells.<dialect>.probe). '
        + 'On probe failure the tool returns immediately without running the command.',
    },
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

function registerCmd(ctx, config, extraEnv = {}) {
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
      // Fast channel probe (default per shells.cmd.probe): a lightweight plain
      // spawn (no ConPTY needed for `echo`); failure skips the real command.
      const probeEnabled = args.probe ?? config.probe ?? false
      if (probeEnabled) {
        const probe = await runProbeCheck(ctx, exec, (probeSignal) => ctx.subprocess.spawn({
          argv: [executable, '/d', '/q', '/c', `echo ${PROBE_MARKER}`],
          cwd: commandWorkdir(args.workdir, exec),
          stdio: { stdin: 'ignore', stdout: { maxBytes: maxOutputBytes }, stderr: { maxBytes: maxOutputBytes } },
          graceMs,
          signal: probeSignal,
        }))
        if (!probe.ok) return probeFailureText('cmd', probe)
      }
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
            ...Object.keys(extraEnv).length > 0 ? { env: extraEnv } : {},
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
          ...Object.keys(extraEnv).length > 0 ? { env: extraEnv } : {},
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

const PROBE_MARKER = 'dsh-probe-ok'

/** Model-facing text for a failed channel probe: names the shell and the fact. */
function probeFailureText(dialect, probe) {
  const detail = probe.error ?? (probe.stderr.trim() || probe.stdout.trim() || `exit code ${probe.exitCode}`)
  return `[probe failed] ${dialect} channel unavailable: ${detail}`
}

/**
 * Fast channel probe shared by every shell: spawn one lightweight command that
 * prints `PROBE_MARKER`, fail fast (short deadline) when the executable or the
 * environment is unusable so the real command never starts. Returns the probe
 * facts; the caller decides how to present a failure.
 */
async function runProbeCheck(ctx, exec, makeSpawn, timeoutMs = 8000) {
  const started = Date.now()
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = AbortSignal.any([exec.signal, timeout])
  let running
  try {
    running = makeSpawn(signal)
  } catch (err) {
    return { ok: false, error: err.message, durationMs: Date.now() - started }
  }
  let outcome
  try { outcome = await running.done } catch (err) {
    return { ok: false, error: err.message, durationMs: Date.now() - started }
  }
  const stdout = finalText(running.collected.stdout)
  const stderr = finalText(running.collected.stderr)
  return {
    ok: outcome.exitCode === 0 && stdout.includes(PROBE_MARKER),
    timedOut: timeout.aborted && !exec.signal.aborted,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout,
    stderr,
    durationMs: Date.now() - started,
  }
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

function registerBash(ctx, config, extraEnv = {}) {
  const executable = resolveBashExecutable(config.executable)
  const maxOutputBytes = positiveInteger('shells.bash.maxOutputBytes', config.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES)
  const maxSpillBytes = positiveInteger('shells.bash.maxSpillBytes', config.maxSpillBytes, DEFAULT_MAX_SPILL_BYTES)
  const graceMs = positiveInteger('shells.bash.graceMs', config.graceMs, DEFAULT_GRACE_MS)
  // clean-UTF-8 locale default, with an explicit shells.env entry winning.
  const spawnEnv = { LANG: config.lang ?? 'C.UTF-8', LC_ALL: config.lang ?? 'C.UTF-8', ...extraEnv }

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
      // Fast channel probe (default per shells.bash.probe): fail immediately
      // when the executable or environment is unusable, before starting the
      // real command or the background job.
      const probeEnabled = args.probe ?? config.probe ?? true
      if (probeEnabled) {
        const probe = await runProbeCheck(ctx, exec, (probeSignal) => ctx.subprocess.spawn({
          argv: [executable, '--noprofile', '--norc', '-lc', `printf ${PROBE_MARKER}`],
          cwd: commandWorkdir(args.workdir, exec),
          stdio: { stdin: 'ignore', stdout: collect, stderr: collect },
          graceMs,
          signal: probeSignal,
          env: spawnEnv,
        }))
        if (!probe.ok) return probeFailureText('bash', probe)
      }
      // Fire-and-forget: register with the jobs service and return the id now.
      if (args.run_in_background === true) {
        return runShellChain(ctx, exec, args, async () => {
          const running = ctx.subprocess.spawn({
            argv: [executable, '--noprofile', '--norc', '-lc', args.command],
            cwd: commandWorkdir(args.workdir, exec),
            stdio: { stdin: 'ignore', stdout: collect, stderr: collect },
            graceMs,
            signal,
            env: spawnEnv,
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
          env: spawnEnv,
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

function registerPwsh(ctx, config, extraEnv = {}) {
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
      // Fast channel probe (default per shells.pwsh.probe): fail immediately
      // when the executable or environment is unusable.
      const probeEnabled = args.probe ?? config.probe ?? false
      if (probeEnabled) {
        const probe = await runProbeCheck(ctx, exec, (probeSignal) => ctx.subprocess.spawn({
          argv: [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Write-Output ${PROBE_MARKER}`],
          cwd: commandWorkdir(args.workdir, exec),
          stdio: { stdin: 'ignore', stdout: collect, stderr: collect },
          graceMs,
          signal: probeSignal,
          ...Object.keys(extraEnv).length > 0 ? { env: extraEnv } : {},
        }))
        if (!probe.ok) return probeFailureText('pwsh', probe)
      }
      if (args.run_in_background === true) {
        return runShellChain(ctx, exec, args, async () => {
          const running = ctx.subprocess.spawn({
            argv: [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', args.command],
            cwd: commandWorkdir(args.workdir, exec),
            stdio: { stdin: 'ignore', stdout: collect, stderr: collect },
            graceMs,
            signal,
            ...Object.keys(extraEnv).length > 0 ? { env: extraEnv } : {},
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
          ...Object.keys(extraEnv).length > 0 ? { env: extraEnv } : {},
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

// ══════════════════════════════════════════════════════════════════════
// WSL shell (`shells.wsl.enabled`): structured WSL control tools
// ══════════════════════════════════════════════════════════════════════

/** Single-quote a value for safe embedding in a generated bash line (no shell interpretation). */
function shq(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/** Best-effort Windows → WSL path conversion (`D:\a\b` → `/mnt/d/a/b`); WSL paths pass through. */
function toWslPath(p) {
  if (p.startsWith('/')) return p
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(p)
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
  return p
}

function wslExePath() {
  return process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\wsl.exe` : 'C:\\Windows\\System32\\wsl.exe'
}

function wslArgsFor(distro, rest) {
  const args = []
  if (distro) args.push('-d', distro)
  args.push('--')
  args.push(...rest)
  return args
}

function mergeChunks(chunks) {
  let total = 0
  for (const c of chunks) total += c.length
  const out = Buffer.allocUnsafe(total)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.length }
  return out
}

/** Collect one pipe stream to bytes; resolves at stream end. */
function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    stream.on('end', () => resolve(mergeChunks(chunks)))
    stream.on('error', reject)
  })
}

/**
 * Decode wsl.exe output bytes: its own console output is UTF-16LE while Linux
 * command output is byte-transparent (normally UTF-8). Detect UTF-16LE by
 * sampling odd-indexed null bytes; otherwise decode as UTF-8.
 */
function decodeWsl(bytes) {
  if (!bytes || bytes.length === 0) return ''
  const limit = Math.min(bytes.length, 256)
  let nulls = 0
  let total = 0
  for (let i = 1; i < limit; i += 2) { total++; if (bytes[i] === 0) nulls++ }
  if (total >= 4 && nulls / total >= 0.5) {
    try { return bytes.toString('utf16le') } catch { /* fallthrough */ }
  }
  return bytes.toString('utf8')
}

/** Build the bash script piped to `wsl.exe -d <distro> -- bash -s` over stdin. */
function buildWslScript({ cwd, env, argv, script }) {
  const lines = []
  if (cwd) {
    lines.push(`cd ${shq(cwd)} || { printf "[wslctl] cd failed: ${cwd}\n" >&2; exit 126; }`)
  }
  if (env) {
    for (const key of Object.keys(env)) lines.push(`export ${shq(key)}=${shq(env[key])}`)
  }
  if (argv) {
    lines.push(`exec ${argv.map(shq).join(' ')}`)
  } else if (script !== undefined) {
    lines.push(script)
  }
  return lines.join('\n')
}

/**
 * Register the four WSL tools. `wsl_exec` shares the plugin's run_in_background
 * (fire-and-forget via `ctx.jobs`) and exit-status conventions with bash/cmd/pwsh,
 * adds a channel probe (`probe: false` to disable) that fails fast before the
 * command, and returns structured JSON (probe phase + command phase).
 */
function registerWsl(ctx, config, extraEnv = {}) {
  const maxOutputBytes = positiveInteger('shells.wsl.maxOutputBytes', config.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES)
  const maxSpillBytes = positiveInteger('shells.wsl.maxSpillBytes', config.maxSpillBytes, DEFAULT_MAX_SPILL_BYTES)
  const graceMs = positiveInteger('shells.wsl.graceMs', config.graceMs, DEFAULT_GRACE_MS)
  const probeTimeoutMs = positiveInteger('shells.wsl.probeTimeoutMs', config.probeTimeoutMs, 15000)
  const mainName = config.toolName ?? 'wsl_exec'

  const renderJson = {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  }

  const wslSpawnCwd = (exec) => exec?.agent?.session?.header?.cwd ?? process.cwd()

  /** Fast channel probe: `wsl.exe -d <distro> -- printf wslctl-probe-ok`. */
  async function runProbe(exec, distro, timeoutMs) {
    const started = Date.now()
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([exec.signal, timeout])
    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv: [wslExePath(), ...wslArgsFor(distro, ['printf', 'wslctl-probe-ok'])],
        cwd: wslSpawnCwd(exec),
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs,
        signal,
      })
    } catch (err) {
      return { ok: false, error: err.message, durationMs: Date.now() - started }
    }
    const [outBuf, errBuf] = await Promise.all([readAll(handle.stdout), readAll(handle.stderr)])
    let outcome
    try { outcome = await handle.done } catch (err) {
      return { ok: false, error: err.message, stdout: decodeWsl(outBuf), stderr: decodeWsl(errBuf), durationMs: Date.now() - started }
    }
    return {
      ok: outcome.exitCode === 0 && decodeWsl(outBuf).includes('wslctl-probe-ok'),
      timedOut: timeout.aborted && !exec.signal.aborted,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: decodeWsl(outBuf),
      stderr: decodeWsl(errBuf),
      durationMs: Date.now() - started,
    }
  }

  /** Foreground execution: `wsl.exe -d <distro> -- bash -s` with the script on stdin. */
  async function runWsl(exec, args, script, distro, timeoutMsArg) {
    const started = Date.now()
    const timeoutMs = positiveNumber('timeoutMs', timeoutMsArg, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([exec.signal, timeout])
    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv: [wslExePath(), ...wslArgsFor(distro, args)],
        cwd: wslSpawnCwd(exec),
        stdio: { stdin: { data: script }, stdout: 'pipe', stderr: 'pipe' },
        graceMs,
        signal,
      })
    } catch (err) {
      return { status: 'spawn-error', message: err.message }
    }
    const [outBuf, errBuf] = await Promise.all([readAll(handle.stdout), readAll(handle.stderr)])
    let outcome
    try { outcome = await handle.done } catch (err) {
      return { status: 'spawn-error', message: err.message, stdout: decodeWsl(outBuf), stderr: decodeWsl(errBuf), durationMs: Date.now() - started }
    }
    return {
      status: outcome.signal ? 'signal' : 'exited',
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: decodeWsl(outBuf),
      stderr: decodeWsl(errBuf),
      durationMs: Date.now() - started,
      timedOut: timeout.aborted && !exec.signal.aborted,
    }
  }

  ctx.tools.register(defineTool({
    name: 'wsl_probe',
    description: '快速探测 WSL 通道是否可用（指定发行版存在且 wsl.exe 可启动），通常 1-3 秒返回，失败立即返回诊断。'
      + '长任务/批量命令前可先探测。返回 { ok, distro, timedOut, exitCode, signal, stdout, stderr, durationMs }。',
    parameters: {
      distro: { type: 'string', description: 'WSL 发行版名，缺省用默认发行版' },
    },
    output: renderJson,
    // The tool guard must outlive the subprocess deadline so runProbe can
    // collect the process result and return structured timeout diagnostics.
    timeoutMs: probeTimeoutMs + 5000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertFullAccess(ctx, exec, 'wsl_probe')
      const probe = await runProbe(exec, args.distro, probeTimeoutMs)
      return { ...probe, distro: args.distro ?? null }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wsl_info',
    description: '枚举本机 WSL 发行版、状态、默认发行版与 WSL 版本。返回结构化 JSON：'
      + '{ available, defaultDistro, version, distros: [{name,state,version,default}], raw }。',
    parameters: {},
    output: renderJson,
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      assertFullAccess(ctx, exec, 'wsl_info')
      const started = Date.now()
      let handle
      try {
        handle = ctx.subprocess.spawn({
          argv: [wslExePath(), '-l', '-v'],
          cwd: wslSpawnCwd(exec),
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
          graceMs,
          signal: exec.signal,
        })
      } catch (err) {
        return { available: false, error: err.message }
      }
      const [outBuf, errBuf] = await Promise.all([readAll(handle.stdout), readAll(handle.stderr)])
      let outcome
      try { outcome = await handle.done } catch (err) {
        return { available: false, error: err.message }
      }
      const raw = decodeWsl(outBuf)
      const lines = raw.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
      const distros = []
      let defaultDistro = null
      for (const line of lines) {
        if (/^NAME\s+STATE/.test(line) || /^名称/.test(line)) continue
        const m = /^(\*?)\s*(.+?)\s+(\S+)\s+(\d+)\s*$/.exec(line)
        if (!m) continue
        const isDefault = m[1] === '*'
        if (isDefault) defaultDistro = m[2]
        distros.push({ name: m[2], state: m[3].toLowerCase(), version: Number(m[4]), default: isDefault })
      }
      return {
        available: outcome.exitCode === 0,
        defaultDistro,
        version: distros.length > 0 ? Math.max(...distros.map((d) => d.version)) : null,
        distros,
        warnings: decodeWsl(errBuf).trim() ? [decodeWsl(errBuf).trim()] : [],
        raw,
        durationMs: Date.now() - started,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: mainName,
    description: '在 WSL 发行版中执行命令。默认先快速探测通道（probe），失败立即返回 probe-failed 不执行命令；'
      + '成功则结果附带 probe 字段（阶段化返回）。两种模式：argv（参数数组，无 shell 解释，推荐）或 script（shell 脚本，经 stdin 传递无命令行转义）。'
      + 'cwd 支持 windows 路径（自动转 /mnt/<drive>）与 wsl 路径；env 在脚本内 export。'
      + 'run_in_background=true 时注册为宿主后台作业返回 job id，用 job_output 增量读、job_kill 终止（与 bash/cmd/pwsh 同模式）。'
      + '返回 { status, exitCode, signal, stdout, stderr, durationMs, distro, resolvedCwd, probe }。',
    parameters: {
      distro: { type: 'string', description: 'WSL 发行版名，缺省用默认发行版' },
      argv: { type: 'array', items: { type: 'string' }, description: '命令参数数组，argv[0] 为 Linux 可执行文件（与 script 互斥，推荐）' },
      script: { type: 'string', description: 'shell 脚本文本（与 argv 互斥）' },
      cwd: { type: 'string', description: '工作目录：windows 路径（D:\\x）或 wsl 路径（/home/x），缺省继承当前目录' },
      cwdFormat: { type: 'string', enum: ['auto', 'windows', 'wsl'], description: 'cwd 解释方式，缺省 auto（/ 开头视为 wsl 路径，否则按 windows 转换）' },
      env: { type: 'object', additionalProperties: true, description: '注入的环境变量（脚本内 export）' },
      probe: { type: 'boolean', description: '执行前先探测 WSL 通道（默认 per shells.wsl.probe），探测失败立即返回 probe-failed' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds; defaults to 120000 and is capped at 600000.' },
      run_in_background: {
        type: 'boolean',
        description: 'Run in the background (fire-and-forget): returns a job id; poll with `job_output`, stop with `job_kill`.',
      },
    },
    output: renderJson,
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertFullAccess(ctx, exec, mainName)
      const hasArgv = Array.isArray(args.argv) && args.argv.length > 0
      const hasScript = typeof args.script === 'string'
      if (hasArgv === hasScript) {
        return { status: 'arg-error', message: 'argv（非空数组）与 script（字符串）必须且只能提供一个' }
      }
      let cwd
      if (args.cwd) {
        const fmt = args.cwdFormat ?? 'auto'
        if (fmt === 'wsl') cwd = args.cwd
        else if (fmt === 'windows') cwd = toWslPath(args.cwd)
        else cwd = args.cwd.startsWith('/') ? args.cwd : toWslPath(args.cwd)
      }
      const script = buildWslScript({ cwd, env: args.env, argv: hasArgv ? args.argv : undefined, script: hasScript ? args.script : undefined })
      let probe = null
      if (args.probe ?? config.probe ?? true) {
        probe = await runProbe(exec, args.distro, probeTimeoutMs)
        if (!probe.ok) {
          return {
            status: 'probe-failed',
            probe,
            message: 'WSL 通道探测失败，未执行命令。',
            distro: args.distro ?? null,
            resolvedCwd: cwd ?? null,
          }
        }
      }
      const label = hasArgv ? `wsl ${args.argv.join(' ')}`.slice(0, 120) : `wsl script: ${(args.script.split('\n')[0] ?? '').trim()}`.slice(0, 120)
      if (args.run_in_background === true) {
        const collect = { maxBytes: maxOutputBytes, spill: { maxBytes: maxSpillBytes } }
        const running = ctx.subprocess.spawn({
          argv: [wslExePath(), ...wslArgsFor(args.distro, ['bash', '-s'])],
          cwd: wslSpawnCwd(exec),
          stdio: { stdin: { data: script }, stdout: collect, stderr: collect },
          graceMs,
          signal: exec.signal,
        })
        const jobId = startBackground(ctx, exec, label, () => ({
          cancel: () => void running.terminate(),
          done: running.done.then((outcome) => {
            running.outcome = outcome
            return shellOutcome(outcome)
          }),
          readOutput: () => backgroundText(running),
        }), 'wsl')
        return `started background job ${jobId}`
      }
      const result = await runWsl(exec, ['bash', '-s'], script, args.distro, args.timeoutMs)
      return { ...result, distro: args.distro ?? null, resolvedCwd: cwd ?? null, probe }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wsl_path',
    description: '在 Windows 路径与 WSL 路径之间转换（基于 WSL 内 wslpath，处理 UNC/符号链接等边界）。'
      + 'windows-to-wsl：D:\\foo → /mnt/d/foo；wsl-to-windows：/home/x → \\\\wsl.localhost\\<distro>\\... 返回 { path, kind }。',
    parameters: {
      path: { type: 'string', required: true, description: '要转换的路径' },
      direction: { type: 'string', required: true, enum: ['windows-to-wsl', 'wsl-to-windows'], description: '转换方向' },
      distro: { type: 'string', description: 'WSL 发行版名，缺省用默认' },
    },
    output: renderJson,
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertFullAccess(ctx, exec, 'wsl_path')
      const flag = args.direction === 'windows-to-wsl' ? '-a' : '-w'
      // wsl.exe's direct command line is interpreted by the distro shell, so a
      // Windows path such as D:\\Programs\\x would lose its backslashes. Pass
      // wslpath through bash stdin with the same single-quote escaping used by
      // wsl_exec argv mode.
      const script = buildWslScript({ argv: ['wslpath', flag, args.path] })
      const result = await runWsl(exec, ['bash', '-s'], script, args.distro, 15000)
      if (result.status !== 'exited' || result.exitCode !== 0) {
        return { error: result.stderr || result.stdout || result.message || `wslpath 退出码 ${result.exitCode}`, detail: result }
      }
      const value = result.stdout.trim()
      return {
        path: value,
        kind: args.direction === 'windows-to-wsl' ? (value.startsWith('/mnt/') ? 'drvfs' : 'wsl-filesystem') : 'windows',
      }
    },
  }))
}

export function applyShells(ctx, config = {}, report = () => {}) {
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
  const wsl = shells.wsl ?? { enabled: false }
  // Shared extra environment injected into every command across all shells
  // (PyCharm-style common presets, e.g. PYTHONIOENCODING=utf-8 on Windows).
  const extraEnv = assertEnvMap(shells.env)
  if (cmd.enabled !== true && bash.enabled !== true && pwsh.enabled !== true && wsl.enabled !== true) {
    report('configuration', new Error('enable at least one of shells.cmd, shells.bash, shells.pwsh or shells.wsl'))
    return { registered: [], failed: ['configuration'] }
  }

  // ── Model-facing shell-availability constraint ──────────────────────────
  // The entry Config is current configuration. 0.2 settings writes persist into
  // the profile layer; a reload invokes apply again with the updated Config.
  const persistentConfig = config.persistent ?? { enabled: false }
  const availability = () => {
    try {
      return shellAvailabilityText({
        cmdEnabled: cmd.enabled === true,
        bashEnabled: bash.enabled === true,
        pwshEnabled: pwsh.enabled === true,
        wslEnabled: wsl.enabled === true,
        persistentEnabled: persistentConfig.enabled === true,
      })
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
      registerCmd(ctx, cmd, extraEnv)
      registered.push(cmd.toolName ?? 'cmd')
    } catch (error) {
      failed.push(cmd.toolName ?? 'cmd')
      report(cmd.toolName ?? 'cmd', error)
    }
  }
  if (bash.enabled === true) {
    try {
      registerBash(ctx, bash, extraEnv)
      registered.push(bash.toolName ?? 'bash')
    } catch (error) {
      failed.push(bash.toolName ?? 'bash')
      report(bash.toolName ?? 'bash', error)
    }
  }
  if (pwsh.enabled === true) {
    try {
      registerPwsh(ctx, pwsh, extraEnv)
      registered.push(pwsh.toolName ?? 'pwsh')
    } catch (error) {
      failed.push(pwsh.toolName ?? 'pwsh')
      report(pwsh.toolName ?? 'pwsh', error)
    }
  }
  if (wsl.enabled === true) {
    try {
      registerWsl(ctx, wsl, extraEnv)
      registered.push(wsl.toolName ?? 'wsl_exec')
    } catch (error) {
      failed.push(wsl.toolName ?? 'wsl_exec')
      report(wsl.toolName ?? 'wsl_exec', error)
    }
  }
  return { registered, failed }
}
