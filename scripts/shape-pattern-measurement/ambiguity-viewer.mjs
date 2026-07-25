#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCandidatePartitions } from './build-candidates.mjs'
import { attachCleanupFailure } from './measurement-errors.mjs'
import {
  assertRedacted,
  replayRawBundle,
  safeErrorRecord,
} from './tdx-source.mjs'
import { stableStringify } from './util.mjs'

const DEFAULT_LIMITS = Object.freeze({
  maxPartitions: 120,
  maxPatternsPerPartition: 16,
  maxShapesPerPartition: 16,
  maxStopsPerPattern: 250,
  maxCoordinatesPerShape: 400,
})

const RISK_LABELS = Object.freeze({
  'duplicate-pattern-identity': '同一 SubRouteUID 有多組站序',
  'duplicate-shape-identity': '同一 SubRouteUID 有多條 Shape',
  'many-to-many-after-exact-identity': '移除唯一 identity 後仍為多對多',
  'one-to-many-after-exact-identity': '一組站序仍有多條候選 Shape',
  'many-to-one-after-exact-identity': '多組站序競爭同一條 Shape',
  'missing-pattern-identity': '站序缺少 SubRouteUID',
  'missing-shape-identity': 'Shape 缺少 SubRouteUID',
})

export function buildAmbiguityViewerData(rawBundle, provenance = {}, requestedLimits = {}) {
  const limits = resolveLimits(requestedLimits)
  const candidateBundle = buildCandidatePartitions(rawBundle)
  const metadata = buildMetadataIndex(rawBundle)
  const analyzed = candidateBundle.partitions
    .map((partition) => analyzePartition(partition, metadata.get(partition.key), limits))
    .filter(Boolean)
    .sort(compareRiskPartition)
  const included = analyzed.slice(0, limits.maxPartitions)

  return {
    schemaVersion: 1,
    title: 'Shape／站序歧義檢視',
    provenance: {
      fetchedAt: textOrNull(provenance.fetchedAt ?? rawBundle?.fetchedAt),
      cities: Array.isArray(provenance.cities) ? provenance.cities.filter(nonEmptyText) : [],
      includeIntercity: provenance.includeIntercity === true,
      bundleContentHash: hashOrNull(provenance.bundleContentHash, 64),
      sourceCommit: hashOrNull(provenance.sourceCommit, 40),
    },
    limits,
    summary: {
      candidatePartitionCount: candidateBundle.partitions.length,
      rejectedSourceRecordCount: candidateBundle.rejected.length,
      riskyPartitionCount: analyzed.length,
      includedPartitionCount: included.length,
      omittedPartitionCount: Math.max(0, analyzed.length - included.length),
      riskReasonCounts: countBy(analyzed.flatMap((partition) => partition.riskReasons)),
    },
    riskLabels: RISK_LABELS,
    partitions: included,
  }
}

function analyzePartition(partition, metadata, limits) {
  const patternCounts = identityCounts(partition.patterns)
  const shapeCounts = identityCounts(partition.shapes)
  const uniqueExactIdentities = [...patternCounts.entries()]
    .filter(([identity, count]) => identity !== null && count === 1 && shapeCounts.get(identity) === 1)
    .map(([identity]) => identity)
    .sort()
  const exactSet = new Set(uniqueExactIdentities)
  const remainingPatterns = partition.patterns
    .filter((pattern) => !exactSet.has(normalizeIdentity(pattern.subRouteUid)))
    .sort((a, b) => a.patternId.localeCompare(b.patternId))
  const remainingShapes = partition.shapes
    .filter((shape) => !exactSet.has(normalizeIdentity(shape.subRouteUid)))
    .sort((a, b) => a.shapeId.localeCompare(b.shapeId))

  const patternCandidateCounts = new Map(remainingPatterns.map((pattern) => [
    pattern.patternId,
    remainingShapes.filter((shape) => identitiesCompatible(pattern.subRouteUid, shape.subRouteUid)).length,
  ]))
  const shapeCandidateCounts = new Map(remainingShapes.map((shape) => [
    shape.shapeId,
    remainingPatterns.filter((pattern) => identitiesCompatible(pattern.subRouteUid, shape.subRouteUid)).length,
  ]))
  const compatiblePairCount = [...patternCandidateCounts.values()].reduce((sum, count) => sum + count, 0)
  const atRiskPatternCount = [...patternCandidateCounts.values()].filter((count) => count > 1).length
  const competingShapeCount = [...shapeCandidateCounts.values()].filter((count) => count > 1).length
  const duplicatePatternIdentityCount = duplicateCompleteIdentityCount(patternCounts)
  const duplicateShapeIdentityCount = duplicateCompleteIdentityCount(shapeCounts)

  const riskReasons = []
  if (duplicatePatternIdentityCount > 0 && competingShapeCount > 0) {
    riskReasons.push('duplicate-pattern-identity')
  }
  if (duplicateShapeIdentityCount > 0 && atRiskPatternCount > 0) {
    riskReasons.push('duplicate-shape-identity')
  }
  if (remainingPatterns.length > 1 && remainingShapes.length > 1
    && (atRiskPatternCount > 0 || competingShapeCount > 0)) {
    riskReasons.push('many-to-many-after-exact-identity')
  } else if (remainingPatterns.length === 1 && atRiskPatternCount > 0) {
    riskReasons.push('one-to-many-after-exact-identity')
  } else if (remainingShapes.length === 1 && competingShapeCount > 0) {
    riskReasons.push('many-to-one-after-exact-identity')
  }
  if (remainingPatterns.some((pattern) => !normalizeIdentity(pattern.subRouteUid)) && atRiskPatternCount > 0) {
    riskReasons.push('missing-pattern-identity')
  }
  if (remainingShapes.some((shape) => !normalizeIdentity(shape.subRouteUid)) && competingShapeCount > 0) {
    riskReasons.push('missing-shape-identity')
  }
  if (!riskReasons.length) return null

  const patterns = remainingPatterns.slice(0, limits.maxPatternsPerPartition).map((pattern) => {
    const displayStops = sampleSequence(
      pattern.stops.map((stop) => stop.coordinate),
      limits.maxStopsPerPattern,
    )
    return {
      patternId: pattern.patternId,
      subRouteUid: normalizeIdentity(pattern.subRouteUid),
      subRouteName: metadataName(metadata, pattern.subRouteUid),
      stopCount: pattern.stops.length,
      compatibleShapeCount: patternCandidateCounts.get(pattern.patternId) ?? 0,
      firstCoordinate: copyCoordinate(pattern.stops[0]?.coordinate),
      lastCoordinate: copyCoordinate(pattern.stops.at(-1)?.coordinate),
      displayStops,
      displayTruncated: displayStops.length < pattern.stops.length,
    }
  })
  const shapes = remainingShapes.slice(0, limits.maxShapesPerPartition).map((shape) => {
    const displayCoordinates = sampleSequence(shape.coordinates, limits.maxCoordinatesPerShape)
    return {
      shapeId: shape.shapeId,
      subRouteUid: normalizeIdentity(shape.subRouteUid),
      subRouteName: metadataName(metadata, shape.subRouteUid),
      coordinateCount: shape.coordinates.length,
      compatiblePatternCount: shapeCandidateCounts.get(shape.shapeId) ?? 0,
      firstCoordinate: copyCoordinate(shape.coordinates[0]),
      lastCoordinate: copyCoordinate(shape.coordinates.at(-1)),
      displayCoordinates,
      displayTruncated: displayCoordinates.length < shape.coordinates.length,
    }
  })

  return {
    partitionId: partition.partitionId,
    sourceScope: partition.sourceScope,
    city: partition.city,
    routeUid: partition.routeUid,
    routeName: firstSorted(metadata?.routeNames) ?? partition.routeUid,
    direction: partition.direction,
    riskReasons,
    originalPatternCount: partition.patterns.length,
    originalShapeCount: partition.shapes.length,
    uniqueExactPairCount: uniqueExactIdentities.length,
    remainingPatternCount: remainingPatterns.length,
    remainingShapeCount: remainingShapes.length,
    compatiblePairCount,
    atRiskPatternCount,
    competingShapeCount,
    duplicatePatternIdentityCount,
    duplicateShapeIdentityCount,
    patternDisplayOmittedCount: Math.max(0, remainingPatterns.length - patterns.length),
    shapeDisplayOmittedCount: Math.max(0, remainingShapes.length - shapes.length),
    identities: identitySummary(patternCounts, shapeCounts, metadata),
    patterns,
    shapes,
  }
}

function buildMetadataIndex(rawBundle) {
  const result = new Map()
  for (const source of safeArray(rawBundle?.sources)) {
    for (const item of [...safeArray(source?.stopOfRoute), ...safeArray(source?.shapes)]) {
      const routeUid = normalizeIdentity(item?.RouteUID)
      const direction = item?.Direction
      if (!routeUid || !Number.isInteger(direction)) continue
      const key = partitionKey(source?.scope, source?.city, routeUid, direction)
      let entry = result.get(key)
      if (!entry) {
        entry = { routeNames: new Set(), subRouteNames: new Map() }
        result.set(key, entry)
      }
      const routeName = localizedName(item?.RouteName)
      if (routeName) entry.routeNames.add(routeName)
      const subRouteUid = normalizeIdentity(item?.SubRouteUID)
      const subRouteName = localizedName(item?.SubRouteName)
      if (!subRouteName) continue
      const identityKey = subRouteUid ?? ''
      let names = entry.subRouteNames.get(identityKey)
      if (!names) {
        names = new Set()
        entry.subRouteNames.set(identityKey, names)
      }
      names.add(subRouteName)
    }
  }
  return result
}

function identitySummary(patternCounts, shapeCounts, metadata) {
  return [...new Set([...patternCounts.keys(), ...shapeCounts.keys()])]
    .sort(compareNullableText)
    .map((identity) => ({
      subRouteUid: identity,
      subRouteName: metadataName(metadata, identity),
      patternCount: patternCounts.get(identity) ?? 0,
      shapeCount: shapeCounts.get(identity) ?? 0,
      uniqueExact: identity !== null
        && patternCounts.get(identity) === 1
        && shapeCounts.get(identity) === 1,
    }))
}

function identityCounts(candidates) {
  const counts = new Map()
  for (const candidate of candidates) {
    const identity = normalizeIdentity(candidate.subRouteUid)
    counts.set(identity, (counts.get(identity) ?? 0) + 1)
  }
  return counts
}

function duplicateCompleteIdentityCount(counts) {
  return [...counts.entries()].reduce((sum, [identity, count]) =>
    sum + (identity === null ? 0 : Math.max(0, count - 1)), 0)
}

function identitiesCompatible(patternIdentity, shapeIdentity) {
  const pattern = normalizeIdentity(patternIdentity)
  const shape = normalizeIdentity(shapeIdentity)
  return !(pattern && shape && pattern !== shape)
}

function metadataName(metadata, identity) {
  return firstSorted(metadata?.subRouteNames?.get(normalizeIdentity(identity) ?? ''))
}

function localizedName(value) {
  if (nonEmptyText(value)) return value.trim()
  if (!value || typeof value !== 'object') return null
  for (const key of ['Zh_tw', 'ZhTw', 'zh_tw', 'En', 'en']) {
    if (nonEmptyText(value[key])) return value[key].trim()
  }
  return firstSorted(new Set(Object.values(value).filter(nonEmptyText).map((entry) => entry.trim())))
}

function resolveLimits(requested) {
  const result = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (requested[key] === undefined) continue
    if (!Number.isSafeInteger(requested[key]) || requested[key] < 2 || requested[key] > 10_000) {
      throw new RangeError(`${key} must be a safe integer between 2 and 10000`)
    }
    result[key] = requested[key]
  }
  return result
}

function sampleSequence(values, maximum) {
  const source = safeArray(values)
  if (source.length <= maximum) return source.map(copyCoordinate)
  const sampled = []
  const seen = new Set()
  for (let index = 0; index < maximum; index += 1) {
    const sourceIndex = Math.round(index * (source.length - 1) / (maximum - 1))
    if (seen.has(sourceIndex)) continue
    seen.add(sourceIndex)
    sampled.push(copyCoordinate(source[sourceIndex]))
  }
  return sampled
}

function copyCoordinate(value) {
  return Array.isArray(value) && value.length >= 2 ? [value[0], value[1]] : null
}

function compareRiskPartition(a, b) {
  return b.atRiskPatternCount - a.atRiskPatternCount
    || b.competingShapeCount - a.competingShapeCount
    || b.compatiblePairCount - a.compatiblePairCount
    || b.remainingPatternCount * b.remainingShapeCount - a.remainingPatternCount * a.remainingShapeCount
    || a.routeName.localeCompare(b.routeName, 'zh-Hant')
    || a.partitionId.localeCompare(b.partitionId)
}

function compareNullableText(a, b) {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a.localeCompare(b)
}

function countBy(values) {
  const result = {}
  for (const value of values) result[value] = (result[value] ?? 0) + 1
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)))
}

function partitionKey(scope, city, routeUid, direction) {
  return `${scope === 'intercity' ? 'intercity' : 'city'}\0${scope === 'intercity' ? '' : city ?? ''}\0${routeUid}\0${direction}`
}

function normalizeIdentity(value) { return nonEmptyText(value) ? value.trim() : null }
function nonEmptyText(value) { return typeof value === 'string' && value.trim().length > 0 }
function textOrNull(value) { return nonEmptyText(value) ? value.trim() : null }
function safeArray(value) { return Array.isArray(value) ? value : [] }
function firstSorted(values) {
  if (!values) return null
  return [...values].filter(nonEmptyText).sort((a, b) => a.localeCompare(b, 'zh-Hant'))[0] ?? null
}
function hashOrNull(value, length) {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value) ? value : null
}

export function renderAmbiguityViewerHtml(report) {
  const serialized = JSON.stringify(report).replaceAll('<', '\\u003c')
  return `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shape／站序歧義檢視</title>
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--bg:#f4f1e9;--panel:#fffdf7;--ink:#211f1a;--muted:#706b60;--line:#d6d0c2;--accent:#a33b2b;--chip:#ece5d7}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}button,input,select{font:inherit}header{padding:24px 28px 18px;border-bottom:1px solid var(--line);background:var(--panel)}h1{margin:0 0 6px;font-size:24px}.sub{color:var(--muted);font-size:14px}.summary{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}.metric{padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:var(--chip)}main{display:grid;grid-template-columns:minmax(300px,36%) 1fr;min-height:calc(100vh - 130px)}aside{border-right:1px solid var(--line);padding:16px;overflow:auto}.controls{display:grid;grid-template-columns:1fr auto;gap:8px;position:sticky;top:0;background:var(--bg);padding-bottom:12px;z-index:2}input,select{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink)}#list{display:grid;gap:8px}.route{display:block;width:100%;text-align:left;border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:11px;cursor:pointer}.route.active{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}.route strong{display:block}.route small{display:block;color:var(--muted);margin-top:4px}.chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}.chip{font-size:11px;padding:3px 6px;border-radius:999px;background:var(--chip)}section{padding:20px;min-width:0}#empty{color:var(--muted)}.heading{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.heading h2{margin:0}.facts{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.map{width:100%;height:min(64vh,720px);border:1px solid var(--line);border-radius:12px;background:var(--panel)}.legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px;margin-top:12px}.legend-item{display:flex;align-items:flex-start;gap:8px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}.swatch{width:18px;height:4px;margin-top:8px;border-radius:2px;flex:none}.legend-item small{display:block;color:var(--muted)}table{width:100%;border-collapse:collapse;margin-top:18px;font-size:13px}th,td{text-align:left;border-bottom:1px solid var(--line);padding:7px}code{font-size:12px}@media(max-width:850px){main{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid var(--line);max-height:42vh}.map{height:55vh}}@media(prefers-color-scheme:dark){:root{--bg:#181713;--panel:#22201b;--ink:#f2eee4;--muted:#aaa396;--line:#3b382f;--accent:#df7864;--chip:#302d26}}
</style>
</head>
<body>
<header><h1>Shape／站序歧義檢視</h1><div class="sub">只顯示移除唯一完整 identity 後，仍可能在多個 geometry 候選間選線的 partition。圖形為顯示用途的等距索引抽樣，不參與 matcher。</div><div id="summary" class="summary"></div></header>
<main><aside><div class="controls"><input id="search" type="search" placeholder="搜尋路線名稱或 UID"><select id="reason"><option value="">全部風險</option></select></div><div id="list"></div></aside><section><div id="empty">請從左側選擇一條路線。</div><div id="detail" hidden></div></section></main>
<script id="viewer-data" type="application/json">${serialized}</script>
<script>
'use strict'
const data=JSON.parse(document.getElementById('viewer-data').textContent)
const palette=['#b43b2b','#2474a6','#8d5aa8','#2f8c69','#c07824','#5b68c4','#a84f75','#477b2f','#8a6540','#2b8f94','#6756a5','#a5522f','#3971a8','#80851f','#b3415d','#53606f']
const summary=document.getElementById('summary'),list=document.getElementById('list'),search=document.getElementById('search'),reason=document.getElementById('reason'),detail=document.getElementById('detail'),empty=document.getElementById('empty')
const metric=(label,value)=>{const n=document.createElement('span');n.className='metric';n.textContent=label+' '+value;return n}
summary.append(metric('候選 partition',data.summary.candidatePartitionCount),metric('有選錯風險',data.summary.riskyPartitionCount),metric('本檔顯示',data.summary.includedPartitionCount),metric('省略',data.summary.omittedPartitionCount))
for(const key of Object.keys(data.riskLabels)){const option=document.createElement('option');option.value=key;option.textContent=data.riskLabels[key];reason.append(option)}
let activeId=null
function filtered(){const q=search.value.trim().toLowerCase(),r=reason.value;return data.partitions.filter(p=>(!q||(p.routeName+' '+p.routeUid+' '+(p.city||'')).toLowerCase().includes(q))&&(!r||p.riskReasons.includes(r)))}
function renderList(){list.replaceChildren();for(const p of filtered()){const button=document.createElement('button');button.className='route'+(p.partitionId===activeId?' active':'');const title=document.createElement('strong');title.textContent=p.routeName+' · 方向 '+p.direction;const meta=document.createElement('small');meta.textContent=(p.city||'InterCity')+' · '+p.routeUid+' · '+p.remainingPatternCount+' 站序 × '+p.remainingShapeCount+' Shape';const chips=document.createElement('div');chips.className='chips';for(const r of p.riskReasons){const chip=document.createElement('span');chip.className='chip';chip.textContent=data.riskLabels[r]||r;chips.append(chip)}button.append(title,meta,chips);button.addEventListener('click',()=>{activeId=p.partitionId;renderList();renderDetail(p)});list.append(button)}}
function svgNode(tag,attrs={}){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,String(v));return n}
function bounds(p){const points=[];for(const x of p.patterns)points.push(...x.displayStops);for(const x of p.shapes)points.push(...x.displayCoordinates);const xs=points.map(x=>x[0]),ys=points.map(x=>x[1]);let minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);if(!Number.isFinite(minX)){minX=0;maxX=1;minY=0;maxY=1}if(maxX===minX)maxX=minX+1e-6;if(maxY===minY)maxY=minY+1e-6;return{minX,maxX,minY,maxY}}
function project(point,b){const pad=38,w=1000-pad*2,h=700-pad*2,scale=Math.min(w/(b.maxX-b.minX),h/(b.maxY-b.minY)),usedW=(b.maxX-b.minX)*scale,usedH=(b.maxY-b.minY)*scale;return[pad+(w-usedW)/2+(point[0]-b.minX)*scale,pad+(h-usedH)/2+(b.maxY-point[1])*scale]}
function renderDetail(p){empty.hidden=true;detail.hidden=false;detail.replaceChildren();const head=document.createElement('div');head.className='heading';const h=document.createElement('h2');h.textContent=p.routeName+' · 方向 '+p.direction;const id=document.createElement('code');id.textContent=p.routeUid;head.append(h,id);const facts=document.createElement('div');facts.className='facts';facts.append(metric('唯一 identity 已排除',p.uniqueExactPairCount),metric('剩餘候選',p.remainingPatternCount+' × '+p.remainingShapeCount),metric('相容 pair',p.compatiblePairCount),metric('高風險站序',p.atRiskPatternCount));const svg=svgNode('svg',{class:'map',viewBox:'0 0 1000 700',role:'img','aria-label':'候選 Shape 與站序疊圖'}),b=bounds(p),legend=document.createElement('div');legend.className='legend';let colorIndex=0
const addLegend=(label,meta,color,target)=>{const item=document.createElement('label');item.className='legend-item';const check=document.createElement('input');check.type='checkbox';check.checked=true;check.style.width='auto';const sw=document.createElement('span');sw.className='swatch';sw.style.background=color;const text=document.createElement('span');const strong=document.createElement('strong');strong.textContent=label;const small=document.createElement('small');small.textContent=meta;text.append(strong,small);item.append(check,sw,text);check.addEventListener('change',()=>target.style.display=check.checked?'':'none');legend.append(item)}
for(const s of p.shapes){const color=palette[colorIndex++%palette.length],g=svgNode('g'),points=s.displayCoordinates.map(x=>project(x,b).join(',')).join(' ');g.append(svgNode('polyline',{points,fill:'none',stroke:color,'stroke-width':3,'stroke-linecap':'round','stroke-linejoin':'round',opacity:.78}));svg.append(g);addLegend('Shape '+(s.subRouteName||s.subRouteUid||'缺少 SubRouteUID'),s.coordinateCount+' 點 · 相容 '+s.compatiblePatternCount+' 組站序'+(s.displayTruncated?' · 圖形已抽樣':''),color,g)}
for(const ptn of p.patterns){const color=palette[colorIndex++%palette.length],g=svgNode('g'),coords=ptn.displayStops.map(x=>project(x,b));g.append(svgNode('polyline',{points:coords.map(x=>x.join(',')).join(' '),fill:'none',stroke:color,'stroke-width':2,'stroke-dasharray':'7 6',opacity:.9}));coords.forEach((x,i)=>g.append(svgNode('circle',{cx:x[0],cy:x[1],r:i===0||i===coords.length-1?5:3,fill:color,stroke:'white','stroke-width':1})));svg.append(g);addLegend('站序 '+(ptn.subRouteName||ptn.subRouteUid||'缺少 SubRouteUID'),ptn.stopCount+' 站 · 相容 '+ptn.compatibleShapeCount+' 條 Shape'+(ptn.displayTruncated?' · 站點已抽樣':''),color,g)}
const table=document.createElement('table'),thead=document.createElement('thead'),tr=document.createElement('tr');for(const text of ['SubRouteUID','名稱','站序數','Shape 數','唯一 exact']){const th=document.createElement('th');th.textContent=text;tr.append(th)}thead.append(tr);const tbody=document.createElement('tbody');for(const row of p.identities){const r=document.createElement('tr');for(const value of [row.subRouteUid||'（缺少）',row.subRouteName||'—',row.patternCount,row.shapeCount,row.uniqueExact?'是':'否']){const td=document.createElement('td');td.textContent=String(value);r.append(td)}tbody.append(r)}table.append(thead,tbody);detail.append(head,facts,svg,legend,table)}
search.addEventListener('input',renderList);reason.addEventListener('change',renderList);renderList();if(data.partitions[0]){activeId=data.partitions[0].partitionId;renderList();renderDetail(data.partitions[0])}
</script>
</body>
</html>
`
}

export async function publishAmbiguityViewer(report, outputDir) {
  const target = resolve(outputDir)
  const existing = await lstat(target).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (existing) throw new Error('Ambiguity viewer output directory already exists')
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${randomUUID()}`
  await mkdir(temporary, { recursive: false })
  try {
    const index = {
      schemaVersion: report.schemaVersion,
      provenance: report.provenance,
      limits: report.limits,
      summary: report.summary,
      partitions: report.partitions.map((partition) => ({
        partitionId: partition.partitionId,
        sourceScope: partition.sourceScope,
        city: partition.city,
        routeUid: partition.routeUid,
        routeName: partition.routeName,
        direction: partition.direction,
        riskReasons: partition.riskReasons,
        uniqueExactPairCount: partition.uniqueExactPairCount,
        remainingPatternCount: partition.remainingPatternCount,
        remainingShapeCount: partition.remainingShapeCount,
        compatiblePairCount: partition.compatiblePairCount,
        atRiskPatternCount: partition.atRiskPatternCount,
        competingShapeCount: partition.competingShapeCount,
      })),
    }
    await writeFile(`${temporary}/index.json`, `${stableStringify(index, 2)}\n`, { mode: 0o600 })
    await writeFile(`${temporary}/ambiguity-viewer.html`, renderAmbiguityViewerHtml(report), { mode: 0o600 })
    await rename(temporary, target)
    return target
  } catch (error) {
    try {
      await rm(temporary, { recursive: true, force: true })
    } catch {
      throw attachCleanupFailure(error, {
        stage: 'ambiguity-viewer-temporary-cleanup',
        temporaryPath: temporary,
      })
    }
    throw error
  }
}

function parseCli(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    const value = args[index + 1]
    if (!name.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid ambiguity viewer argument: ${name}`)
    }
    values[name] = value
    index += 1
  }
  const rawDir = values['--raw-dir']
  const outputDir = values['--output-dir']
  if (!nonEmptyText(rawDir) || !nonEmptyText(outputDir)) {
    throw new Error('Ambiguity viewer requires --raw-dir and --output-dir')
  }
  return {
    rawDir,
    outputDir,
    limits: {
      maxPartitions: optionalInteger(values['--max-partitions']),
      maxPatternsPerPartition: optionalInteger(values['--max-patterns']),
      maxShapesPerPartition: optionalInteger(values['--max-shapes']),
      maxStopsPerPattern: optionalInteger(values['--max-stops']),
      maxCoordinatesPerShape: optionalInteger(values['--max-coordinates']),
    },
  }
}

function optionalInteger(value) {
  if (value === undefined) return undefined
  if (!/^[1-9]\d*$/.test(value)) throw new Error('Ambiguity viewer limits must be positive integers')
  return Number(value)
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2))
    let source = await replayRawBundle({ rawDir: options.rawDir })
    const report = buildAmbiguityViewerData(source.bundle, {
      ...source.manifest,
      sourceCommit: process.env.GITHUB_SHA,
    }, Object.fromEntries(Object.entries(options.limits).filter(([, value]) => value !== undefined)))
    Reflect.set(source, 'bundle', null)
    source = null
    const outputDir = await publishAmbiguityViewer(report, options.outputDir)
    process.stdout.write(`${stableStringify({
      phase: 'complete',
      outputDir,
      riskyPartitionCount: report.summary.riskyPartitionCount,
      includedPartitionCount: report.summary.includedPartitionCount,
      omittedPartitionCount: report.summary.omittedPartitionCount,
    })}\n`)
  } catch (error) {
    const record = safeErrorRecord(error)
    assertRedacted(record, [process.env.TDX_CLIENT_ID, process.env.TDX_CLIENT_SECRET])
    process.stderr.write(`${stableStringify(record)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main()
