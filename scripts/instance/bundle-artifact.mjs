import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildInstanceChangeBundle, parseInstanceChangeBundleArguments } from './change-bundle.mjs'
import { buildInstanceUpdate } from './update.mjs'
import { createInstanceBundleArtifact } from './bundle-integrity.mjs'

const FORBIDDEN_DIRECTORIES = new Set(['.git', 'node_modules'])
const RESERVED_FILENAMES = new Set(['instance-runtime.json', 'operations-plan.json'])

export function parseInstanceBundleArtifactArguments(argv = process.argv.slice(2)) {
  const forwarded = []
  let outputPath = null
  let dryRun = false
  let json = false
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run' || argument === '--json' || argument === '--help') {
      if (argument === '--dry-run') dryRun = true
      else if (argument === '--json') json = true
      else help = true
      continue
    }
    if (argument === '--github-summary') {
      throw new Error('instance:bundle-artifact does not accept --github-summary; verify the saved artifact separately')
    }
    if (argument === '--output') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('Missing value after --output')
      outputPath = value
      index += 1
      continue
    }
    if (argument.startsWith('--output=')) {
      outputPath = argument.slice('--output='.length)
      if (!outputPath) throw new Error('Missing value after --output=')
      continue
    }
    forwarded.push(argument)
  }

  const bundleOptions = parseInstanceChangeBundleArguments(forwarded)
  if (!dryRun && !help && !outputPath) {
    throw new Error('instance:bundle-artifact requires an explicit --output <path>; use --dry-run to preview without writing')
  }
  return Object.freeze({ bundleOptions, outputPath, dryRun, json, help })
}

export async function buildInstanceBundleArtifact(options, {
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  if (!options?.bundleOptions) throw new Error('Bundle artifact options are required')
  const bundle = await buildInstanceChangeBundle(options.bundleOptions, { cwd, env })
  const proposal = await buildInstanceUpdate(
    { ...options.bundleOptions.updateOptions, write: false },
    { cwd, env },
  )
  return createInstanceBundleArtifact(bundle, {
    sourceManifest: proposal.source,
    baselineManifest: proposal.before,
  })
}

export function resolveBundleArtifactOutputPath(cwd, value, configPath) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('--output must be a non-empty path')
  const root = resolve(cwd)
  const outputPath = resolve(root, value)
  const display = displayPath(root, outputPath)
  if (outputPath === root || display === '..' || display.startsWith('../')) {
    throw new Error('--output must stay inside the repository working directory')
  }
  if (extname(outputPath).toLowerCase() !== '.json') {
    throw new Error('--output must use a .json extension')
  }
  const segments = display.split('/')
  const normalizedSegments = segments.map((segment) => segment.toLowerCase())
  if (normalizedSegments.some((segment) => FORBIDDEN_DIRECTORIES.has(segment))) {
    throw new Error('--output cannot write inside .git or node_modules')
  }
  if (RESERVED_FILENAMES.has(normalizedSegments.at(-1))) {
    throw new Error(`--output cannot replace generated runtime file ${segments.at(-1)}`)
  }
  const resolvedConfig = resolve(root, configPath)
  if (outputPath.toLowerCase() === resolvedConfig.toLowerCase()) {
    throw new Error('--output cannot be the source instance manifest')
  }
  return Object.freeze({ outputPath, displayPath: display, rootPath: root })
}

export async function writeInstanceBundleArtifact(artifact, target) {
  const content = `${JSON.stringify(artifact, null, 2)}\n`
  await assertSafeArtifactParent(target)
  await mkdir(dirname(target.outputPath), { recursive: true })
  await assertResolvedArtifactParent(target)
  const temporary = `${target.outputPath}.tmp-${process.pid}-${randomUUID()}`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await link(temporary, target.outputPath)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`${target.displayPath} already exists; bundle artifacts are never overwritten`)
    }
    throw error
  } finally {
    await handle?.close()
    await rm(temporary, { force: true })
  }
  return target.outputPath
}

export function renderInstanceBundleArtifactText(artifact, target, { dryRun = false } = {}) {
  const action = dryRun ? 'Previewed' : 'Created'
  return `${[
    `${action} Mochi Bus change-bundle artifact${target ? `: ${target.displayPath}` : ''}`,
    `Instance: ${artifact.bundle.instance.id}`,
    `Bundle SHA-256: ${artifact.bundle.hashes.bundleHash}`,
    `Artifact SHA-256: ${artifact.integrity.artifactHash}`,
    dryRun
      ? 'No artifact was written.'
      : `Verify: npm run instance:verify-bundle -- --input ${shellQuote(target.displayPath)} --expect-hash ${artifact.bundle.hashes.bundleHash} --expect-artifact-hash ${artifact.integrity.artifactHash}`,
    'The source manifest, generated artifacts and remote resources were not changed.',
  ].join('\n')}\n`
}

export function instanceBundleArtifactUsage() {
  return `Persist a deterministic Mochi Bus instance change bundle as a self-contained review artifact.\n\nUsage:\n  npm run instance:bundle-artifact -- --output <artifact.json> [--config <path>] <instance:update changes>\n  npm run instance:bundle-artifact -- --dry-run [--config <path>] <instance:update changes>\n\nOptions:\n  --output <path>        Explicit artifact path inside the working directory\n  --dry-run              Print the complete artifact JSON without writing\n  --json                 Print a machine-readable creation result\n  --expect-hash <sha256> Require the rebuilt #218 bundle hash before saving\n  --out-dir <path>       Generated-artifact directory used only in projected commands\n  --help                 Show this help\n\nThe writer uses atomic exclusive creation and never overwrites an existing artifact. All instance:update change options are accepted except --write.\n`
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
} = {}) {
  const options = parseInstanceBundleArtifactArguments(argv)
  if (options.help) {
    stdout.write(instanceBundleArtifactUsage())
    return null
  }

  const artifact = await buildInstanceBundleArtifact(options, { cwd, env })
  if (options.dryRun) {
    stdout.write(options.json
      ? `${JSON.stringify({ message: 'instance_change_bundle_artifact_preview', artifact }, null, 2)}\n`
      : `${JSON.stringify(artifact, null, 2)}\n`)
    return artifact
  }

  const target = resolveBundleArtifactOutputPath(
    cwd,
    options.outputPath,
    artifact.bundle.instance.configPath,
  )
  await writeInstanceBundleArtifact(artifact, target)
  stdout.write(options.json
    ? `${JSON.stringify({
        message: 'instance_change_bundle_artifact_created',
        path: target.displayPath,
        instanceId: artifact.bundle.instance.id,
        bundleHash: artifact.bundle.hashes.bundleHash,
        artifactHash: artifact.integrity.artifactHash,
      })}\n`
    : renderInstanceBundleArtifactText(artifact, target))
  return artifact
}

async function assertSafeArtifactParent(target) {
  const parent = dirname(target.outputPath)
  const shown = relative(target.rootPath, parent).split(sep).filter(Boolean)
  let current = target.rootPath
  for (const segment of shown) {
    current = resolve(current, segment)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) throw new Error(`--output parent contains a symbolic link: ${displayPath(target.rootPath, current)}`)
      if (!stat.isDirectory()) throw new Error(`--output parent is not a directory: ${displayPath(target.rootPath, current)}`)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
  }
}

async function assertResolvedArtifactParent(target) {
  const [rootReal, parentReal] = await Promise.all([
    realpath(target.rootPath),
    realpath(dirname(target.outputPath)),
  ])
  const shown = relative(rootReal, parentReal)
  if (shown === '..' || shown.startsWith(`..${sep}`)) {
    throw new Error('--output parent resolves outside the repository working directory')
  }
}

function displayPath(cwd, path) {
  return relative(resolve(cwd), path).split(sep).join('/') || '.'
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`)
    process.exitCode = 1
  })
}
