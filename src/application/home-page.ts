import type { BusQuery, ResolvedBusQuery } from '../domain/bus-query'
import { renderETAPage } from '../ui'

export type HomePageView = {
  demoQuery: BusQuery | null
  defaultCity: string
  notice?: string
  requestUrl: string
}

const homeSnapshotFirstPaintHead = `<style id="mochi-home-snapshot-first-paint">html[data-mochi-home-snapshot-pending="true"] .skeleton-row,html[data-mochi-home-snapshot-pending="true"] .skeleton-title{visibility:hidden}</style><script>(()=>{try{const raw=sessionStorage.getItem('mochi.bus.home-view.v2');if(!raw)return;const snapshot=JSON.parse(raw);const now=Date.now();if(snapshot.version!==2||typeof snapshot.savedAt!=='number'||!Number.isFinite(snapshot.savedAt)||now-snapshot.savedAt>180000||snapshot.savedAt-now>60000||!Array.isArray(snapshot.rows)||!snapshot.rows.length)return;const match=typeof snapshot.updatedText==='string'&&snapshot.updatedText.match(/(?:^|\\s)(\\d{1,2}):(\\d{2}):(\\d{2})(?:\\s|$)/);if(!match)return;const clockParts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(snapshot.savedAt));const clock=Object.fromEntries(clockParts.map((part)=>[part.type,part.value]));const captured=Number(clock.hour)*3600+Number(clock.minute)*60+Number(clock.second);let sourceHour=Number(match[1]);if(sourceHour===24)sourceHour=0;const sourceClock=sourceHour*3600+Number(match[2])*60+Number(match[3]);let age=captured-sourceClock;if(age< -60)age+=86400;if(age<0)age=0;const sourceTime=snapshot.savedAt-age*1000;if(now-sourceTime>180000||sourceTime-now>60000)return;const read=(key)=>{try{return JSON.parse(localStorage.getItem(key)||'null')}catch{return null}};const normalize=(value)=>Array.isArray(value)?value.filter((board)=>board&&typeof board==='object'&&Array.isArray(board.buses)):[];const boards=normalize(read('mochi.bus.boards.v2'));const draftValue=read('mochi.bus.homeBoard.v1');const draft=draftValue&&typeof draftValue==='object'&&Array.isArray(draftValue.buses)?draftValue:null;const samePattern=(a,b)=>{const sameRoute=a.routeUid&&b.routeUid?a.routeUid===b.routeUid:a.routeName===b.routeName;return sameRoute&&a.direction===b.direction&&(!a.subRouteUid||!b.subRouteUid||a.subRouteUid===b.subRouteUid)&&(!a.patternId||!b.patternId||a.patternId===b.patternId)};const sameBoard=(a,b)=>Boolean(a.placeId&&b.placeId&&a.city===b.city&&a.placeId===b.placeId&&a.buses.length===b.buses.length&&a.buses.every((bus)=>b.buses.some((candidate)=>samePattern(bus,candidate)&&bus.stopUid===candidate.stopUid)));let board;if(draft)board=boards.find((candidate)=>sameBoard(candidate,draft))||draft;else{const active=localStorage.getItem('mochi.bus.activeBoard.v2');board=(active&&boards.find((candidate)=>candidate.id===active))||boards[0]}if(!board)return;const busKey=(bus)=>{const route=bus.routeUid?'uid:'+bus.routeUid:'name:'+(bus.routeName||'');return route+'|sub:'+(bus.subRouteUid||'')+'|pattern:'+(bus.patternId||'')+'|dir:'+bus.direction+'|stop:'+(bus.stopUid||'')};const fingerprint=JSON.stringify({id:board.id,title:board.title,city:board.city,placeId:board.placeId,updatedAt:board.updatedAt,buses:board.buses.map(busKey)});if(snapshot.boardFingerprint!==fingerprint)return;window.__mochiHomeSnapshotCandidate=snapshot;document.documentElement.dataset.mochiHomeSnapshotPending='true';window.__mochiHomeSnapshotPaintTimer=window.setTimeout(()=>{document.documentElement.removeAttribute('data-mochi-home-snapshot-pending');delete window.__mochiHomeSnapshotCandidate},4000)}catch{}})()</script>`

const homeSnapshotInlineRestore = `<script id="mochi-home-snapshot-inline-restore">(()=>{const root=document.documentElement;const finish=(restored)=>{window.clearTimeout(window.__mochiHomeSnapshotPaintTimer);root.removeAttribute('data-mochi-home-snapshot-pending');if(restored)root.dataset.mochiHomeSnapshot='restored';delete window.__mochiHomeSnapshotCandidate};try{const snapshot=window.__mochiHomeSnapshotCandidate;if(!snapshot)return finish(false);const title=document.querySelector('#board-title');const list=document.querySelector('#bus-list');const updated=document.querySelector('#updated');const notice=document.querySelector('#notice');if(!title||!list||!updated||!notice)return finish(false);const allowedClasses=new Set(['estimated','urgent','non-numeric']);const text=(value,max)=>typeof value==='string'&&value.length<=max;const makePart=(parent,className,value)=>{if(!value)return;const node=document.createElement(className==='eta-freshness'?'small':'span');node.className=className;node.textContent=value;parent.appendChild(node)};const nodes=[];for(const row of snapshot.rows){if(!row||typeof row!=='object'||!text(row.key,2048)||!row.key||!text(row.href,2048)||!(row.href==='#'||row.href==='/route'||row.href.startsWith('/route?'))||!text(row.routeName,240)||!text(row.directionLabel,500)||!row.eta||typeof row.eta!=='object'||!Array.isArray(row.eta.classes)||row.eta.classes.some((name)=>!allowedClasses.has(name))||!text(row.eta.ariaLabel,500)||!text(row.eta.signature,1000)||!text(row.eta.prefix,120)||!text(row.eta.value,240)||!text(row.eta.suffix,120)||!text(row.eta.freshness,120))return finish(false);const anchor=document.createElement('a');anchor.className='bus-row';anchor.dataset.busKey=row.key;anchor.href=row.href;const routeCopy=document.createElement('span');routeCopy.className='bus-route-copy';const route=document.createElement('strong');route.className='bus-name';route.textContent=row.routeName;routeCopy.appendChild(route);const eta=document.createElement('span');eta.className=['bus-eta',...row.eta.classes].join(' ');eta.dataset.signature=row.eta.signature;eta.setAttribute('aria-label',row.eta.ariaLabel);const etaCopy=document.createElement('span');etaCopy.className='eta-copy';makePart(etaCopy,'eta-prefix',row.eta.prefix);makePart(etaCopy,'eta-value',row.eta.value);makePart(etaCopy,'eta-suffix',row.eta.suffix);makePart(etaCopy,'eta-freshness',row.eta.freshness);eta.appendChild(etaCopy);const direction=document.createElement('small');direction.className='bus-direction';direction.textContent=row.directionLabel;direction.hidden=!row.directionLabel;anchor.replaceChildren(routeCopy,eta,direction);nodes.push(anchor)}title.textContent=typeof snapshot.title==='string'?snapshot.title:'';list.replaceChildren(...nodes);list.removeAttribute('aria-busy');updated.textContent=typeof snapshot.updatedText==='string'?snapshot.updatedText:'';const noticeNodes=[];for(const part of Array.isArray(snapshot.notice)?snapshot.notice:[]){if(!part||typeof part!=='object'||!text(part.value,2000))continue;if(part.kind==='setup-link'){const link=document.createElement('a');link.href='/setup';link.textContent=part.value;noticeNodes.push(link)}else if(part.kind==='text')noticeNodes.push(document.createTextNode(part.value))}notice.replaceChildren(...noticeNodes);finish(true)}catch{finish(false)}})()</script>`

/**
 * Keep `/` as the local-board surface even when an instance has no sample route.
 * A null bootstrap lets the browser choose a saved board or the explicit empty state.
 */
export function renderHomePage(view: HomePageView): string {
  const query = view.demoQuery ? resolvedDemoQuery(view.demoQuery) : undefined
  const html = renderETAPage({
    query,
    initialBoard: query ? undefined : null,
    mapCity: view.defaultCity,
    notice: view.notice,
    useLocalBoard: true,
    requestUrl: view.requestUrl,
  })
  return addHomeSnapshotFirstPaintBootstrap(html)
}

export function addHomeSnapshotFirstPaintBootstrap(html: string): string {
  const withHead = html.replace('</head>', `${homeSnapshotFirstPaintHead}</head>`)
  if (withHead === html) throw new Error('Home page is missing </head> for snapshot bootstrap')
  const withRestore = withHead.replace(
    '<script id="eta-bootstrap"',
    `${homeSnapshotInlineRestore}<script id="eta-bootstrap"`,
  )
  if (withRestore === withHead) throw new Error('Home page is missing eta-bootstrap for snapshot restore')
  return withRestore
}

function resolvedDemoQuery(query: BusQuery): ResolvedBusQuery {
  if (!query.stopName || !query.stopUid) {
    throw new Error('Instance demoQuery must include stopName and stopUid')
  }
  return query as ResolvedBusQuery
}
