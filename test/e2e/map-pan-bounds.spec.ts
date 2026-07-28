import { expect, mockMapBootstrapCities, test, type Page } from './fixtures'

type MapCamera = {
  latitude: number
  longitude: number
  zoom: number
}

const city = {
  code: 'Taipei',
  name: '臺北',
  region: 'north',
  center: [25, 121] as [number, number],
}

async function mockTiles(page: Page) {
  await page.route('https://tile.openstreetmap.org/**', async (route) => {
    await route.fulfill({ status: 204 })
  })
}

async function readMapCamera(page: Page): Promise<MapCamera | null> {
  return page.evaluate(() => {
    const map = document.getElementById('map')
    if (!map) return null

    const tilePattern = /\/(\d+)\/(\d+)\/(\d+)\.png(?:$|\?)/
    const tile = Array.from(document.querySelectorAll<HTMLImageElement>('.leaflet-tile')).find((candidate) => {
      const rect = candidate.getBoundingClientRect()
      const tileOpacity = Number(getComputedStyle(candidate).opacity)
      const levelOpacity = Number(getComputedStyle(candidate.parentElement!).opacity)
      return rect.width > 0
        && rect.height > 0
        && tileOpacity > .5
        && levelOpacity > .5
        && tilePattern.test(candidate.currentSrc || candidate.src)
    })
    if (!tile) return null

    const match = (tile.currentSrc || tile.src).match(tilePattern)
    if (!match) return null

    const tileZoom = Number(match[1])
    const tileX = Number(match[2])
    const tileY = Number(match[3])
    const tileRect = tile.getBoundingClientRect()
    const mapRect = map.getBoundingClientRect()
    const scale = tileRect.width / 256
    if (!Number.isFinite(scale) || scale <= 0) return null

    const centerX = mapRect.left + mapRect.width / 2
    const centerY = mapRect.top + mapRect.height / 2
    const worldX = tileX * 256 + (centerX - tileRect.left) / scale
    const worldY = tileY * 256 + (centerY - tileRect.top) / scale
    const worldSize = 256 * 2 ** tileZoom
    const mercatorY = Math.PI * (1 - 2 * worldY / worldSize)

    return {
      latitude: Math.atan(Math.sinh(mercatorY)) * 180 / Math.PI,
      longitude: worldX / worldSize * 360 - 180,
      zoom: tileZoom + Math.log2(scale),
    }
  })
}

async function waitForStableCamera(page: Page): Promise<MapCamera> {
  let previousCamera: MapCamera | null = null
  await expect.poll(async () => {
    const camera = await readMapCamera(page)
    if (!camera) return false
    const stable = previousCamera !== null
      && Math.abs(camera.latitude - previousCamera.latitude) < .0001
      && Math.abs(camera.longitude - previousCamera.longitude) < .0001
      && Math.abs(camera.zoom - previousCamera.zoom) < .0001
    previousCamera = camera
    const animating = await page.locator('.leaflet-pan-anim, .leaflet-zoom-anim').count()
    return stable && animating === 0
  }, { timeout: 5_000 }).toBe(true)

  return (await readMapCamera(page))!
}

async function openMap(page: Page) {
  await page.setViewportSize({ width: 1200, height: 800 })
  await mockTiles(page)
  await mockMapBootstrapCities(page, [city])
  await page.goto('/map')
  await expect(page.getByRole('heading', { name: '地圖初始化失敗' })).toHaveCount(0)
  await expect.poll(() => readMapCamera(page)).not.toBeNull()
}

test.describe('Taiwan map pan bounds', () => {
  test('settles inside Taiwan when wheel zoom takes over drag inertia', async ({ page }) => {
    await openMap(page)
    const initialCamera = (await readMapCamera(page))!

    const mapBox = await page.locator('#map').boundingBox()
    expect(mapBox).not.toBeNull()

    const startX = mapBox!.x + mapBox!.width * .08
    const endX = mapBox!.x + mapBox!.width * .58
    const y = mapBox!.y + mapBox!.height * .45

    await page.mouse.move(startX, y)
    await page.mouse.down()
    for (const progress of [.2, .4, .6, .8, 1]) {
      await page.mouse.move(startX + (endX - startX) * progress, y)
      await page.waitForTimeout(10)
    }
    await page.mouse.up()
    await page.mouse.wheel(0, -180)

    const finalCamera = await waitForStableCamera(page)
    expect(finalCamera.zoom).toBeGreaterThan(initialCamera.zoom + .1)
    expect(finalCamera.latitude).toBeGreaterThanOrEqual(21.17)
    expect(finalCamera.latitude).toBeLessThanOrEqual(26.83)
    expect(finalCamera.longitude).toBeGreaterThanOrEqual(117.67)
    expect(finalCamera.longitude).toBeLessThanOrEqual(122.43)
  })

  test('keeps repeated keyboard panning inside Taiwan', async ({ page }) => {
    await openMap(page)
    await page.locator('#map').focus()

    for (let index = 0; index < 4; index += 1) {
      await page.keyboard.press('Shift+ArrowLeft')
      await waitForStableCamera(page)
    }

    const finalCamera = (await readMapCamera(page))!
    expect(finalCamera.latitude).toBeGreaterThanOrEqual(21.17)
    expect(finalCamera.latitude).toBeLessThanOrEqual(26.83)
    expect(finalCamera.longitude).toBeGreaterThanOrEqual(117.67)
    expect(finalCamera.longitude).toBeLessThanOrEqual(117.75)
  })
})
