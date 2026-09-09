import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

const readme = read('README.md')
const publicProbe = read('docs/operations/public-network-probe.md')
const rollbackAuthority = read('docs/operations/transit-snapshot-rollback-authority.md')

describe('snapshot routing authority documentation', () => {
  it('describes new snapshot D1 storage as low-cardinality only', () => {
    expect(readme).toContain('新版本不再把高基數 `stops` / `pattern_stops` 寫入 D1')
    expect(readme).toContain('root-bound 版本的高基數 routing authority 在 R2')
    expect(readme).not.toContain('routes / patterns / stops / stop_places / pattern_stops')
  })

  it('keeps public probe D1 reference reads low-cardinality', () => {
    expect(publicProbe).toContain('routes/patterns/stop_places counts')
    expect(publicProbe).toContain('root-bound 新版本的 D1 reference')
    expect(publicProbe).not.toContain('active version 的 routes/patterns/stops/places/pattern_stops 非空')
  })

  it('documents fail-closed rollback routing authority modes', () => {
    expect(rollbackAuthority).toContain('**0/4 manifests：`legacy-d1`**')
    expect(rollbackAuthority).toContain('**1–3/4 manifests：incomplete**')
    expect(rollbackAuthority).toContain('`legacy-backfill`')
    expect(rollbackAuthority).toContain('`root-bound`')
    expect(rollbackAuthority).toContain('partial/mismatched binding fail closed')
    expect(rollbackAuthority).toContain('`rootBoundRollbackWindow=true`')
    expect(rollbackAuthority).not.toContain('D1 routes、patterns、stops、places、pattern stops 均非零')
  })
})
