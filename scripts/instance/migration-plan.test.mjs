import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildInstanceManifest,
  parseInstanceInitArguments,
  writeInstanceManifest,
} from './init.mjs'
import {
  buildInstanceMigrationPlan,
  main,
  parseInstanceMigrationPlanArguments,
  renderInstanceMigrationPlanMarkdown,
  renderInstanceMigrationPlanText,
} from './migration-plan.mjs'

const DATABASE_ID = '123e4567-e89b-42d3-a456-426614174000'
const REPLACEMENT_DATABASE_ID = '223e4567-e89b-42d3-a456-426614174111'

async function createInstance({
  profile = 'managed',
  ids = true,
  origin = profile === 'operator' ? 'https://bus.example.com' : 'request',
  cities = 'Chiayi,Tainan',
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mochi-migration-plan-'))
  const args = [
    'island-bus',
    '--profile', profile,
    '--cities', cities,
    '--origin', origin,
    '--output', 'instances/island.json',
  ]
  if (ids) {
    args.push(
      '--database-id', DATABASE_ID,
      '--standard-rate-limit-id', '41001',
      '--expensive-rate-limit-id', '41002',
    )
  }
  const result = buildInstanceManifest(parseInstanceInitArguments(args), { cwd: root })
  await writeInstanceManifest(result)
  return { root, configPath: 'instances/island.json', result }
}

function parse(configPath, changes) {
  return parseInstanceMigrationPlanArguments([
    '--config', configPath,
    ...changes,
  ])
}

function findStep(plan, id) {
  return plan.steps.find((step) => step.id === id)
}

describe('instance migration plan', () => {
  test('parses updater options, JSON output and GitHub summary while rejecting writes', () => {
    const options = parseInstanceMigrationPlanArguments([
      '--config', 'instances/island.json',
      '--add-city', 'Kaohsiung',
      '--json',
      '--github-summary',
    ])

    expect(options.json).toBe(true)
    expect(options.githubSummary).toBe(true)
    expect(options.updateOptions.addCities).toEqual(['Kaohsiung'])
    expect(() => parseInstanceMigrationPlanArguments([
      '--config', 'instances/island.json',
      '--site-name', 'Island Transit',
      '--write',
    ])).toThrow(/non-destructive/)
  })

  test('keeps a site-name-only proposal repository scoped', async () => {
    const fixture = await createInstance()
    const plan = await buildInstanceMigrationPlan(parse(fixture.configPath, [
      '--site-name', 'Island Transit',
    ]), { cwd: fixture.root, env: {} })

    expect(plan.changed).toBe(true)
    expect(plan.cutoverReady).toBe(true)
    expect(plan.proposal.changes.map((change) => change.path)).toEqual(['site.name'])
    expect(findStep(plan, 'worker-routing').status).toBe('not_applicable')
    expect(findStep(plan, 'd1-database').status).toBe('not_applicable')
    expect(findStep(plan, 'r2-bucket').status).toBe('not_applicable')
    expect(findStep(plan, 'post-cutover-verification').commands).not.toContainEqual(expect.stringContaining('--remote'))
  })

  test('plans Worker and origin cutover with an explicit high-risk rollback', async () => {
    const fixture = await createInstance()
    const plan = await buildInstanceMigrationPlan(parse(fixture.configPath, [
      '--worker-name', 'island-v2',
      '--origin', 'https://new-bus.example.com',
      '--workers-dev', 'false',
    ]), { cwd: fixture.root, env: {} })

    const worker = findStep(plan, 'worker-routing')
    expect(plan.risk).toBe('high')
    expect(worker.status).toBe('action_required')
    expect(worker.detail).toContain('island-bus → island-v2')
    expect(worker.rollbackActions.join('\n')).toContain('island-bus')
    expect(worker.rollbackActions.join('\n')).toContain('request')
    expect(findStep(plan, 'post-cutover-verification').commands).toContainEqual(expect.stringContaining('instance:doctor'))
  })

  test('treats a D1 ID replacement as a data migration', async () => {
    const fixture = await createInstance({ profile: 'operator' })
    const plan = await buildInstanceMigrationPlan(parse(fixture.configPath, [
      '--d1-name', 'island-transit-v2',
      '--database-id', REPLACEMENT_DATABASE_ID,
    ]), { cwd: fixture.root, env: {} })

    const d1 = findStep(plan, 'd1-database')
    expect(d1.status).toBe('action_required')
    expect(d1.risk).toBe('high')
    expect(d1.manualActions.join('\n')).toMatch(/schema migrations/)
    expect(d1.manualActions.join('\n')).toMatch(/row counts/)
    expect(d1.rollbackActions.join('\n')).toContain(DATABASE_ID)
  })

  test('requires only read verification when the D1 ID is preserved across a name change', async () => {
    const fixture = await createInstance({ profile: 'operator' })
    const plan = await buildInstanceMigrationPlan(parse(fixture.configPath, [
      '--d1-name', 'island-data-label',
    ]), { cwd: fixture.root, env: {} })

    const d1 = findStep(plan, 'd1-database')
    expect(d1.status).toBe('verify')
    expect(d1.risk).toBe('medium')
    expect(d1.commands).toContainEqual(expect.stringContaining('instance:doctor'))
    expect(d1.detail).toContain(DATABASE_ID)
  })

  test('never treats an R2 rename as an object migration', async () => {
    const fixture = await createInstance()
    const plan = await buildInstanceMigrationPlan(parse(fixture.configPath, [
      '--r2-name', 'island-shapes-v2',
    ]), { cwd: fixture.root, env: {} })

    const r2 = findStep(plan, 'r2-bucket')
    expect(r2.status).toBe('action_required')
    expect(r2.risk).toBe('high')
    expect(r2.detail).toMatch(/does not rename a bucket or copy any object/)
    expect(r2.manualActions.join('\n')).toMatch(/object counts/)
    expect(r2.rollbackActions.join('\n')).toContain('island-transit-shapes')
  })

  test('plans snapshot seeding, removed-city retention and schedule coordination', async () => {
    const fixture = await createInstance({ cities: 'Chiayi,Tainan' })
    const plan = await buildInstanceMigrationPlan(parse(fixture.configPath, [
      '--add-city', 'Kaohsiung',
      '--remove-city', 'Tainan',
      '--snapshot-schedule', 'manual',
      '--public-probe', 'false',
      '--window-watchdog', 'false',
    ]), { cwd: fixture.root, env: {} })

    const transit = findStep(plan, 'transit-scope')
    expect(transit.status).toBe('action_required')
    expect(transit.detail).toContain('add Kaohsiung')
    expect(transit.detail).toContain('remove Tainan')
    expect(transit.manualActions.join('\n')).toMatch(/Seed and validate snapshots/)
    expect(transit.manualActions.join('\n')).toMatch(/retention policy/)
    expect(findStep(plan, 'scheduled-operations').status).toBe('action_required')
  })

  test('blocks operator deployment when a profile transition still lacks provisioned identities', async () => {
    const fixture = await createInstance({ profile: 'managed', ids: false })
    const plan = await buildInstanceMigrationPlan(parse(fixture.configPath, [
      '--profile', 'operator',
      '--origin', 'https://operator.example.com',
    ]), { cwd: fixture.root, env: {} })

    expect(plan.provisioningDraft).toBe(true)
    expect(plan.cutoverReady).toBe(false)
    expect(findStep(plan, 'operator-readiness').status).toBe('blocked')
    expect(findStep(plan, 'operator-readiness').commands).toContainEqual(expect.stringContaining('instance:provision-plan'))
    expect(findStep(plan, 'manifest-cutover').status).toBe('blocked')
    expect(plan.proposal.applyCommand).toContain('--write')
  })

  test('allows a complete managed to operator plan while preserving provisioned identities', async () => {
    const fixture = await createInstance({ profile: 'managed', ids: true })
    const plan = await buildInstanceMigrationPlan(parse(fixture.configPath, [
      '--profile', 'operator',
      '--origin', 'https://operator.example.com',
    ]), { cwd: fixture.root, env: {} })

    expect(plan.provisioningDraft).toBe(false)
    expect(plan.cutoverReady).toBe(true)
    expect(plan.risk).toBe('high')
    expect(findStep(plan, 'operator-readiness').status).toBe('verify')
    expect(findStep(plan, 'profile-transition').status).toBe('action_required')
    expect(plan.proposal.changes).toContainEqual(expect.objectContaining({ path: 'operations.profile' }))
  })

  test('reports a no-op without manufacturing migration work', async () => {
    const fixture = await createInstance()
    const plan = await buildInstanceMigrationPlan(parse(fixture.configPath, [
      '--site-name', 'Island Bus',
    ]), { cwd: fixture.root, env: {} })

    expect(plan.changed).toBe(false)
    expect(plan.risk).toBe('none')
    expect(plan.summary.actionRequired).toBe(0)
    expect(plan.summary.blocked).toBe(0)
    expect(findStep(plan, 'manifest-cutover').status).toBe('complete')
    expect(findStep(plan, 'rollback-plan').status).toBe('not_applicable')
  })

  test('reconstructs repeatable preview and apply commands without output-only flags', async () => {
    const fixture = await createInstance()
    const options = parseInstanceMigrationPlanArguments([
      '--config', fixture.configPath,
      '--add-city', 'Kaohsiung,PingtungCounty',
      '--database-id', 'null',
      '--public-probe', 'false',
      '--json',
      '--github-summary',
    ])
    const plan = await buildInstanceMigrationPlan(options, { cwd: fixture.root, env: {} })

    expect(plan.proposal.previewCommand).toContain("--add-city 'Kaohsiung,PingtungCounty'")
    expect(plan.proposal.previewCommand).toContain("--database-id 'null'")
    expect(plan.proposal.previewCommand).not.toContain('--json')
    expect(plan.proposal.previewCommand).not.toContain('--github-summary')
    expect(plan.proposal.previewCommand).not.toContain('--write')
    expect(plan.proposal.applyCommand).toMatch(/--write$/)
  })

  test('keeps human, JSON and Markdown reports free of credential values', async () => {
    const fixture = await createInstance()
    const plan = await buildInstanceMigrationPlan(parse(fixture.configPath, [
      '--worker-name', 'island-v2',
    ]), {
      cwd: fixture.root,
      env: {
        CLOUDFLARE_API_TOKEN: 'super-secret-cloudflare-token',
        TDX_CLIENT_SECRET: 'super-secret-tdx-token',
      },
    })

    const combined = [
      renderInstanceMigrationPlanText(plan),
      JSON.stringify(plan),
      renderInstanceMigrationPlanMarkdown(plan),
    ].join('\n')
    expect(combined).not.toContain('super-secret-cloudflare-token')
    expect(combined).not.toContain('super-secret-tdx-token')
    expect(combined).toContain('NO CHANGES WERE APPLIED')
  })

  test('appends a GitHub summary without writing the manifest', async () => {
    const fixture = await createInstance()
    const summaryPath = join(fixture.root, 'summary.md')
    const output = []
    const plan = await main({
      argv: [
        '--config', fixture.configPath,
        '--site-name', 'Island Transit',
        '--github-summary',
      ],
      cwd: fixture.root,
      env: { GITHUB_STEP_SUMMARY: summaryPath },
      stdout: { write: (value) => output.push(value) },
    })

    const summary = await readFile(summaryPath, 'utf8')
    const manifest = JSON.parse(await readFile(join(fixture.root, fixture.configPath), 'utf8'))
    expect(plan.nonDestructive).toBe(true)
    expect(output.join('')).toContain('NO CHANGES WERE APPLIED')
    expect(summary).toContain('Mochi Bus instance migration plan')
    expect(summary).toContain('non-destructive')
    expect(manifest.site.name).toBe('Island Bus')
  })


  test('keeps repository-only operator changes local and no-op risk-free', async () => {
    const fixture = await createInstance({ profile: 'operator' })
    const noOp = await buildInstanceMigrationPlan(parse(fixture.configPath, [
      '--site-name', 'Island Bus',
    ]), { cwd: fixture.root, env: {} })

    expect(noOp.risk).toBe('none')
    expect(findStep(noOp, 'operator-readiness').status).toBe('complete')

    const siteOnly = await buildInstanceMigrationPlan(parse(fixture.configPath, [
      '--site-name', 'Island Transit',
    ]), { cwd: fixture.root, env: {} })

    expect(siteOnly.risk).toBe('medium')
    expect(findStep(siteOnly, 'operator-readiness').status).toBe('not_applicable')
    expect(findStep(siteOnly, 'source-control-baseline').manualActions).toEqual([])
    expect(findStep(siteOnly, 'post-cutover-verification').commands).not.toContainEqual(expect.stringContaining('--remote'))
  })

  test('treats the first D1 ID as provisioning rather than data migration', async () => {
    const fixture = await createInstance({ profile: 'managed', ids: false })
    const plan = await buildInstanceMigrationPlan(parse(fixture.configPath, [
      '--database-id', DATABASE_ID,
    ]), { cwd: fixture.root, env: {} })

    const d1 = findStep(plan, 'd1-database')
    expect(d1.status).toBe('action_required')
    expect(d1.risk).toBe('medium')
    expect(d1.title).toMatch(/Provision and verify/)
    expect(d1.manualActions.join('\n')).toMatch(/schema migrations/)
    expect(d1.manualActions.join('\n')).not.toMatch(/Copy or rebuild|required production data|row counts|previous database/)
  })

  test('quotes updater values that begin with option syntax', async () => {
    const fixture = await createInstance()
    const plan = await buildInstanceMigrationPlan(parseInstanceMigrationPlanArguments([
      '--config', fixture.configPath,
      '--site-name=--preview',
    ]), { cwd: fixture.root, env: {} })

    expect(plan.proposal.previewCommand).toContain("--site-name '--preview'")
    expect(plan.proposal.previewCommand).not.toContain('--site-name --preview')
  })

})
