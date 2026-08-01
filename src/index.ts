import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { applyAppearanceShell } from './appearance-shell'
import { apiRateLimit } from './rate-limit'
import { applyRouteShell } from './route-shell'
import bus from './routes/bus'
import health from './routes/health'
import map from './routes/map'
import playwrightTestState from './routes/playwright-test-state'
import routeEta from './routes/route-eta'
import { cspViolationSummaries, httpsRedirectTarget, securityHeaders } from './security'

type Env = { Bindings: CloudflareBindings }
const app = new Hono<Env>()

app.use('*', async (c, next) => {
  const requestUrl = new URL(c.req.url)
  const redirectTarget = httpsRedirectTarget(requestUrl.toString())
  const headers = securityHeaders(requestUrl.protocol === 'https:', requestUrl.toString())

  for (const [name, value] of Object.entries(headers)) c.header(name, value)
  if (redirectTarget) return c.redirect(redirectTarget, 308)

  await next()
  c.res = applyAppearanceShell(c.res)
  if (requestUrl.pathname === '/route') c.res = applyRouteShell(c.res)

  // Keep route-specific policies when they are stricter than the global defaults.
  for (const [name, value] of Object.entries(headers)) {
    if (!c.res.headers.has(name)) c.header(name, value)
  }
})

app.use('/api/*', apiRateLimit())

app.post('/api/v1/csp-report', bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) => c.body(null, 413, { 'Cache-Control': 'no-store' }),
}), async (c) => {
  const payload = await c.req.json<unknown>().catch(() => undefined)
  for (const report of cspViolationSummaries(payload)) {
    console.warn(JSON.stringify({ message: 'csp_violation', ...report }))
  }
  return c.body(null, 204, { 'Cache-Control': 'no-store' })
})

app.route('/', playwrightTestState)
app.route('/', health)
app.route('/', map)
app.route('/', routeEta)
app.route('/', bus)

export default app
