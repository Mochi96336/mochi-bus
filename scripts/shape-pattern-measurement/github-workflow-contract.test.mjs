import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const WORKFLOW_PATH = '.github/workflows/measure-shape-pattern.yml'
const source = await readFile(WORKFLOW_PATH, 'utf8')

function stepBlock(name) {
  const marker = `      - name: ${name}\n`
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`Missing workflow step: ${name}`)
  const next = source.indexOf('\n      - ', start + marker.length)
  return source.slice(start, next < 0 ? source.length : next)
}

describe('credentialed Shape matcher measurement workflow', () => {
  it('is manual-only, non-cancelling, and read-only', () => {
    expect(source).toMatch(/^on:\n  workflow_dispatch:\n/m)
    expect(source).not.toMatch(/^  (?:push|pull_request|schedule):/m)
    expect(source).toMatch(/^permissions:\n  contents: read$/m)
    expect(source).toMatch(/^  group: shape-pattern-measurement$/m)
    expect(source).toMatch(/^  cancel-in-progress: false$/m)
    expect(source).toMatch(/^    timeout-minutes: 180$/m)
  })

  it('requires deliberate confirmation and limits TDX secrets to a separate acquisition process', () => {
    const measurement = stepBlock('Run credentialed measurement gate')
    expect(source).toContain('description: Type MEASURE to run the credentialed gate')
    expect(measurement).toContain('INPUT_CONFIRMATION: ${{ inputs.confirmation }}')
    expect(measurement).toContain('TDX_CLIENT_ID: ${{ secrets.TDX_CLIENT_ID }}')
    expect(measurement).toContain('TDX_CLIENT_SECRET: ${{ secrets.TDX_CLIENT_SECRET }}')
    expect(measurement).toContain('set +x')
    expect(measurement).toContain('[[ "${INPUT_CONFIRMATION}" == "MEASURE" ]]')
    expect(source.match(/secrets\.TDX_CLIENT_ID/g)).toHaveLength(1)
    expect(source.match(/secrets\.TDX_CLIENT_SECRET/g)).toHaveLength(1)

    const acquisition = measurement.indexOf('node scripts/shape-pattern-measurement/acquire-raw.mjs')
    const unset = measurement.indexOf('unset TDX_CLIENT_ID TDX_CLIENT_SECRET')
    const live = measurement.indexOf('live_dir="$(run_measurement live-acquisition-uninstrumented')
    const replay = measurement.indexOf('plain_dir="$(run_measurement replay-uninstrumented')
    expect(acquisition).toBeGreaterThanOrEqual(0)
    expect(unset).toBeGreaterThan(acquisition)
    expect(live).toBeGreaterThan(unset)
    expect(replay).toBeGreaterThan(live)
    expect(measurement.slice(unset)).not.toContain('TDX_CLIENT_ID')
    expect(measurement.slice(unset)).not.toContain('TDX_CLIENT_SECRET')
  })

  it('uses the reviewed nine-city plus InterCity protocol and three fresh replay processes', () => {
    const measurement = stepBlock('Run credentialed measurement gate')
    expect(measurement).toContain('--cities Taipei,NewTaipei,Taoyuan,Keelung,Taichung,Tainan,Kaohsiung,Chiayi,MiaoliCounty')
    expect(measurement).toContain('--include-intercity')
    expect(measurement.match(/run_measurement /g)).toHaveLength(4) // function definition plus three invocations
    expect(measurement.match(/--replay/g)).toHaveLength(3)
    expect(measurement).toContain('--instrumented')
    expect(measurement).toContain('--matcher-sha "${matcher_sha}"')
    expect(measurement.match(/verify-report\.mjs/g)).toHaveLength(1)
    expect(measurement).toContain('bundleContentHash')
    expect(measurement).toContain('deterministicContentHash')
  })

  it('verifies the exact report copies that cross the artifact boundary', () => {
    const measurement = stepBlock('Run credentialed measurement gate')
    const copy = measurement.indexOf('cp -R -- "${run_dir}" "${target}"')
    const verify = measurement.indexOf('verify-report.mjs "${target}"')
    expect(copy).toBeGreaterThanOrEqual(0)
    expect(verify).toBeGreaterThan(copy)
    expect(measurement).not.toContain('verify-report.mjs "${run_dir}"')
  })

  it('binds every verified report to the exact workflow checkout commit', () => {
    const measurement = stepBlock('Run credentialed measurement gate')
    expect(measurement).toContain('metadata.repositoryMainSha')
    expect(measurement).toContain('process.env.GITHUB_SHA')
    expect(measurement).toContain('Report source commit differs from workflow checkout')
  })

  it('keeps raw data in runner temp and uploads only the verified artifact directory', () => {
    const measurement = stepBlock('Run credentialed measurement gate')
    const upload = stepBlock('Upload verified measurement reports')
    expect(measurement).toContain('MEASUREMENT_ROOT: ${{ runner.temp }}/shape-pattern-measurement-${{ github.run_id }}-${{ github.run_attempt }}')
    expect(measurement).toContain('raw_dir="${MEASUREMENT_ROOT}/raw"')
    expect(measurement).toContain('artifact_dir="${MEASUREMENT_ROOT}/artifact"')
    expect(measurement).toContain('rm -rf "${raw_dir}" "${generated_dir}" "${logs_dir}" "${reports_dir}"')
    expect(upload).toContain('path: ${{ runner.temp }}/shape-pattern-measurement-${{ github.run_id }}-${{ github.run_attempt }}/artifact')
    expect(upload).not.toContain('/raw')
    expect(upload).not.toContain('/generated')
    expect(upload).not.toContain('/logs')
    expect(upload).toContain('if-no-files-found: error')
    expect(upload).toContain('retention-days: 14')
  })

  it('pins checkout, setup-node, and artifact upload actions and does not persist credentials', () => {
    expect(source).toContain('actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0')
    expect(source).toContain('actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e')
    expect(source).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02')
    expect(source).toContain('persist-credentials: false')
    expect(source).not.toContain('continue-on-error: true')
  })
})
