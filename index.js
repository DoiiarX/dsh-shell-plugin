/** Failure-isolating Loader entry for optional Windows shell tools. */
import z from '@deepseek-ai/schemastery'

export const name = 'tool-windows-shells-supervisor'
export const inject = ['tools', 'subprocess', 'sandboxPolicy', 'settings', 'systemPrompt']

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * Plugin configuration, and therefore the settings section, is the entry's
 * Config schema. Fields under the two object-level `.volatile()` nodes are
 * live, path-editable profile configuration; apply materializes their snapshots
 * before passing plain values to the implementation.
 */
export const Config = z.object({
  shells: z.object({
    cmd: z.object({
      enabled: z.boolean().default(true),
      executable: z.string(),
      codePage: z.number().min(1).default(65001),
      cols: z.number().min(1).default(160),
      rows: z.number().min(1).default(40),
      maxOutputBytes: z.number().min(1024).max(16777216).default(64000),
      graceMs: z.number().min(100).max(60000).default(3000),
      probe: z.boolean().default(false),
      toolName: z.string(),
    }).default({}),
    bash: z.object({
      enabled: z.boolean().default(false),
      executable: z.string(),
      lang: z.string().default('C.UTF-8'),
      maxOutputBytes: z.number().min(1024).max(16777216).default(64000),
      maxSpillBytes: z.number().min(1048576).max(1073741824).default(67108864),
      graceMs: z.number().min(100).max(60000).default(3000),
      probe: z.boolean().default(true),
      toolName: z.string(),
    }).default({}),
    pwsh: z.object({
      enabled: z.boolean().default(false),
      executable: z.string(),
      maxOutputBytes: z.number().min(1024).max(16777216).default(64000),
      maxSpillBytes: z.number().min(1048576).max(1073741824).default(67108864),
      graceMs: z.number().min(100).max(60000).default(3000),
      probe: z.boolean().default(false),
      toolName: z.string(),
    }).default({}),
    wsl: z.object({
      enabled: z.boolean().default(false),
      maxOutputBytes: z.number().min(1024).max(16777216).default(64000),
      maxSpillBytes: z.number().min(1048576).max(1073741824).default(67108864),
      graceMs: z.number().min(100).max(60000).default(3000),
      probeTimeoutMs: z.number().min(100).max(60000).default(15000),
      probe: z.boolean().default(true),
      toolName: z.string(),
    }).default({}),
    env: z.dict(z.string()).default({}),
  }).default({}).volatile(),
  persistent: z.object({
    enabled: z.boolean().default(false),
    backend: z.union(['bash', 'cmd', 'pwsh']),
  }).default({}).volatile(),
})

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

function isVolatileRef(value) {
  return value !== null && typeof value === 'object'
    && VOLATILE_WRITE in value && typeof value.get === 'function'
}

/** Convert schemastery live references into the plain Config shape used by implementation.js. */
export function materializeConfig(value) {
  if (isVolatileRef(value)) return materializeConfig(value.get())
  if (Array.isArray(value)) return value.map(materializeConfig)
  if (value !== null && typeof value === 'object') {
    const result = {}
    for (const [key, child] of Object.entries(value)) result[key] = materializeConfig(child)
    return result
  }
  return value
}

export async function applyIsolated(ctx, config = {}, importer = () => import('./implementation.js')) {
  try {
    const implementation = await importer()
    implementation.applyShells(ctx, materializeConfig(config), (scope, error) => { report(ctx, scope, error) })
  } catch (error) {
    report(ctx, 'implementation', error)
  }
}

export async function apply(ctx, config = {}) {
  try {
    // This package ships its own settings page, so suppress the generated one.
    ctx.inject(['settings'], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
  } catch (error) {
    report(ctx, 'settings-policy', error)
  }
  return applyIsolated(ctx, config)
}
