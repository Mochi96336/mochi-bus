import { Hono } from 'hono'
import { mapCities } from '../config/map-cities'
import { renderMapPage } from '../map-page'
import { siteName } from '../seo'
import type { MapEnv } from './map-http-context'
import {
  findNearbyPlaces,
  readPlace,
  readPlaceRoutes,
  readStopPlace,
  searchPlaces,
} from './map-place-lookups'
import { readDirectRoutes, readTransferPlans } from './map-journey-plans'
import { journeyEtaBodyLimit, readJourneyEta } from './map-journey-eta'
import { readRouteMap, readRouteTimetable } from './map-route-reads'
import { readCityNetwork } from './map-network-read'
import { readRouteCatalog } from './map-route-catalog'
import { readVehicles } from './map-vehicles-read'
import { readPlaceArrivals } from './map-place-arrivals'

const map = new Hono<MapEnv>()

map.get('/map', (c) => {
  // 深連結的標題直接從 query 組(路線名就在網址裡,不用查庫);
  // place 深連結要查 DB 才有名字,不值得為標題多一次往返,維持通用標題。
  const routeName = c.req.query('route')?.trim()
  const cityName = mapCities.find((city) => city.code === c.req.query('city')?.trim())?.name
  const meta = routeName && routeName.length <= 40
    ? { title: `${routeName} 公車路線圖｜${siteName}`, description: `${routeName} 的路線走向、站牌與即時到站`, heading: `${routeName} 公車路線圖` }
    : cityName
      ? { title: `${cityName}公車地圖｜${siteName}`, description: `${cityName}的公車路網、附近站牌與路線規劃`, heading: `${cityName}公車地圖` }
      : {}
  return c.html(renderMapPage({ ...meta, requestUrl: c.req.url }), 200, {
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  })
})

map.get('/api/v1/map/cities', (c) => c.json({ schemaVersion: 1, cities: mapCities }, 200, {
  'Cache-Control': 'public, max-age=86400',
}))

map.get('/api/v1/map/locate', (c) => {
  // Cloudflare 依連線 IP 推估的粗略位置(縣市級),不經過瀏覽器定位、不會跳授權框;
  // 誤差可達數公里,只夠拿來挑縣市,不能拿來找站牌。
  const cf = (c.req.raw as Request & { cf?: { latitude?: string; longitude?: string } }).cf
  const latitude = Number(cf?.latitude)
  const longitude = Number(cf?.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return c.json({ error: '這次的連線判斷不出位置' }, 404)
  }
  return c.json({ latitude, longitude }, 200, { 'Cache-Control': 'no-store' })
})

map.get('/api/v1/map/routes', readRouteCatalog)

map.get('/api/v1/map/route', readRouteMap)

map.get('/api/v1/map/timetable', readRouteTimetable)

map.get('/api/v1/map/network', readCityNetwork)

map.get('/api/v1/map/vehicles', readVehicles)

map.get('/api/v1/map/search', searchPlaces)

map.get('/api/v1/map/nearby', findNearbyPlaces)

map.get('/api/v1/map/place/:placeId/routes', readPlaceRoutes)

map.get('/api/v1/map/place/:placeId/arrivals', readPlaceArrivals)

map.get('/api/v1/map/place/:placeId', readPlace)

map.get('/api/v1/map/stop-place', readStopPlace)

map.get('/api/v1/map/direct', readDirectRoutes)

map.get('/api/v1/map/transfer', readTransferPlans)

map.post('/api/v1/map/journey-eta', journeyEtaBodyLimit, readJourneyEta)

export default map
