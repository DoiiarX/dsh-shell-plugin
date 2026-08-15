/** Failure-isolating Loader entry for optional Windows shell tools. */
export const name = 'tool-windows-shells-supervisor'
export const inject = ['tools', 'subprocess', 'sandboxPolicy', 'settings', 'systemPrompt']

const SETTINGS_NS = 'local-shell-tools'

function diagnostic(scope, error) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return `[windows-shells] ${scope} unavailable: ${detail}`
}

function report(ctx, scope, error) {
  const message = diagnostic(scope, error)
  const logger = ctx.root?.logger?.('windows-shells')
  if (logger?.error) logger.error('%s', message)
  console.error(message)
}

function baseSettings(config) {
  const cmd = config.shells?.cmd ?? {}
  const bash = config.shells?.bash ?? {}
  const pwsh = config.shells?.pwsh ?? {}
  return {
    cmdEnabled: cmd.enabled === true,
    bashEnabled: bash.enabled === true,
    bashExecutable: bash.executable ?? '',
    bashLang: bash.lang ?? 'C.UTF-8',
    pwshEnabled: pwsh.enabled === true,
    pwshExecutable: pwsh.executable ?? '',
    maxOutputBytes: bash.maxOutputBytes ?? 64000,
    maxSpillBytes: bash.maxSpillBytes ?? 67108864,
    graceMs: bash.graceMs ?? 3000,
  }
}

function mergeSettings(config, settings) {
  const shells = config.shells ?? {}
  return {
    ...config,
    shells: {
      ...shells,
      cmd: { ...(shells.cmd ?? {}), enabled: settings.cmdEnabled },
      bash: {
        ...(shells.bash ?? {}),
        enabled: settings.bashEnabled,
        executable: settings.bashExecutable || undefined,
        lang: settings.bashLang,
        maxOutputBytes: settings.maxOutputBytes,
        maxSpillBytes: settings.maxSpillBytes,
        graceMs: settings.graceMs,
      },
      pwsh: {
        ...(shells.pwsh ?? {}),
        enabled: settings.pwshEnabled,
        executable: settings.pwshExecutable || undefined,
      },
    },
  }
}

export async function applyIsolated(ctx, config = {}, importer = () => import('./implementation.js'), readSettings = undefined) {
  try {
    const implementation = await importer()
    implementation.applyShells(ctx, config, (scope, error) => { report(ctx, scope, error) }, readSettings)
  } catch (error) {
    report(ctx, 'implementation', error)
  }
}

export async function apply(ctx, config = {}) {
  try {
    // `schemastery` is a CommonJS-style module whose named export surface is
    // absent under ESM interop: the usable entry is the `default` export
    // (`Schema.object` etc.). Destructuring `{ Schema }` yields undefined and
    // every schema build fails — which previously fell into the catch below,
    // silently leaving the `local-shell-tools` settings namespace unregistered
    // and the settings page's Shell section stuck on "reading configuration".
    const { default: SchemaModule } = await import('schemastery')
    const Schema = SchemaModule?.Schema ?? SchemaModule
    if (typeof Schema?.object !== 'function') {
      throw new Error(`schemastery export shape unexpected: ${typeof Schema}`)
    }
    const base = baseSettings(config)
    const schema = Schema.object({
      cmdEnabled: Schema.boolean().default(base.cmdEnabled),
      bashEnabled: Schema.boolean().default(base.bashEnabled),
      bashExecutable: Schema.string().default(base.bashExecutable),
      bashLang: Schema.string().default(base.bashLang),
      pwshEnabled: Schema.boolean().default(base.pwshEnabled),
      pwshExecutable: Schema.string().default(base.pwshExecutable),
      maxOutputBytes: Schema.number().min(1024).max(16777216).default(base.maxOutputBytes),
      maxSpillBytes: Schema.number().min(1048576).max(1073741824).default(base.maxSpillBytes),
      graceMs: Schema.number().min(100).max(60000).default(base.graceMs),
    })
    const scope = ctx.settings.register(SETTINGS_NS, schema, { base })
    return applyIsolated(ctx, mergeSettings(config, scope.get()), undefined, () => scope.get())
  } catch (error) {
    report(ctx, 'settings', error)
    return applyIsolated(ctx, config)
  }
}
