import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  compileInstanceConfig,
  loadInstanceConfig,
  parseCliArguments,
  resolveInstanceConfigPath,
  validateInstanceConfig,
  writeCompiledInstance,
} from './config.mjs'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const productionPath = join(repositoryRoot, 'instances/mochi-production.json')
const starterPath = join(repositoryRoot, 'instances/starter-chiayi.example.json')

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

test('production and starter examples validate', async () => {
  const production = await loadInstanceConfig(productionPath)
  const starter = await loadInstanceConfig(starterPath)

  assert.equal(production.operations.profile, 'operator')
  assert.equal(production.transit.enabledCities.length, 22)
  assert.equal(starter.operations.profile, 'starter')
  assert.deepEqual(starter.transit.enabledCities, ['Chiayi'])
})

test('validation fails closed on unknown properties and city mistakes', async () => {
  const starter = await loadJson(starterPath)
  starter.unexpected = true
  starter.transit.enabledCities = ['Chiayi', 'Chiayi']
  starter.transit.defaultCity = 'Taipei'

  assert.throws(
    () => validateInstanceConfig(starter, { source: 'starter' }),
    (error) => {
      assert.match(error.message, /unknown property unexpected/)
      assert.match(error.message, /duplicate city Chiayi/)
      assert.match(error.message, /defaultCity must be included/)
      return true
    },
  )
})

test('demo query city must be enabled', async () => {
  const starter = await loadJson(starterPath)
  starter.transit.demoQuery = {
    city: 'Taipei',
    routeName: '307',
    stopName: '捷運西門站',
    stopUid: 'TPE213044',
    routeUid: 'TPE19108',
    direction: 0,
  }

  assert.throws(
    () => validateInstanceConfig(starter),
    /demoQuery\.city must be included in enabledCities/,
  )
})

test('operator profile requires fixed identity, resources and checks', async () => {
  const production = await loadJson(productionPath)
  production.site.canonicalOrigin = 'request'
  production.cloudflare.workersDev = true
  production.cloudflare.d1.databaseId = null
  production.cloudflare.rateLimits.standardNamespaceId = null
  production.operations.publicProbe = false

  assert.throws(
    () => validateInstanceConfig(production),
    (error) => {
      assert.match(error.message, /canonicalOrigin must be fixed/)
      assert.match(error.message, /workersDev must be false/)
      assert.match(error.message, /databaseId is required/)
      assert.match(error.message, /namespace IDs are required/)
      assert.match(error.message, /requires all verification checks/)
      return true
    },
  )
})

test('compilation is deterministic and omits unprovisioned IDs', async () => {
  const starter = await loadInstanceConfig(starterPath)
  const first = compileInstanceConfig(starter)
  const second = compileInstanceConfig(starter)

  assert.deepEqual(first, second)
  assert.equal(first.operations.provisioned, false)
  assert.equal('database_id' in first.wrangler.d1_databases[0], false)
  assert.equal('ratelimits' in first.wrangler, false)
  assert.deepEqual(first.operations.enabledCities, ['Chiayi'])
})

test('compiled files are replaced atomically and contain no secret fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-instance-'))
  const output = join(root, 'compiled')
  const starter = await loadInstanceConfig(starterPath)
  await writeCompiledInstance(compileInstanceConfig(starter), output)

  const runtime = await readFile(join(output, 'instance-runtime.json'), 'utf8')
  const wrangler = await readFile(join(output, 'wrangler.instance.jsonc'), 'utf8')
  const operations = await readFile(join(output, 'operations-plan.json'), 'utf8')
  const combined = `${runtime}\n${wrangler}\n${operations}`

  assert.match(runtime, /"instanceId": "chiayi-bus"/)
  assert.match(wrangler, /"database_name": "chiayi-transit"/)
  assert.match(operations, /"snapshotSchedule": "manual"/)
  assert.doesNotMatch(combined, /TDX_CLIENT_SECRET|CLOUDFLARE_API_TOKEN|R2_SECRET_ACCESS_KEY/)
})

test('configuration resolution follows CLI, environment, local and production precedence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mochi-resolution-'))
  await mkdir(join(root, 'instances'), { recursive: true })
  await writeFile(join(root, 'instance.json'), '{}')
  await writeFile(join(root, 'from-env.json'), '{}')
  await writeFile(join(root, 'from-cli.json'), '{}')
  await writeFile(join(root, 'instances/mochi-production.json'), '{}')

  assert.equal(
    await resolveInstanceConfigPath({ cwd: root, argv: ['--config', 'from-cli.json'], env: {} }),
    join(root, 'from-cli.json'),
  )
  assert.equal(
    await resolveInstanceConfigPath({
      cwd: root,
      argv: [],
      env: { MOCHI_BUS_INSTANCE_CONFIG: 'from-env.json' },
    }),
    join(root, 'from-env.json'),
  )
  assert.equal(await resolveInstanceConfigPath({ cwd: root, argv: [], env: {} }), join(root, 'instance.json'))

  const emptyRoot = await mkdtemp(join(tmpdir(), 'mochi-resolution-fallback-'))
  await mkdir(join(emptyRoot, 'instances'), { recursive: true })
  assert.equal(
    await resolveInstanceConfigPath({ cwd: emptyRoot, argv: [], env: {} }),
    join(emptyRoot, 'instances/mochi-production.json'),
  )
})

test('CLI parser accepts explicit config and output directory', () => {
  assert.deepEqual(
    parseCliArguments(['--config=instances/starter-chiayi.example.json', '--out-dir', '.tmp/compiled']),
    {
      configPath: 'instances/starter-chiayi.example.json',
      outputDirectory: '.tmp/compiled',
    },
  )
  assert.throws(() => parseCliArguments(['--unknown']), /Unknown option/)
})
