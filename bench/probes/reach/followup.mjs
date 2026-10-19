// SPIKE: follow-up reachability checks after probe.mjs (landing URLs only, no a11y checks).
// 1) which binary each mode actually launches, 2) Amazon verdict stability across repeats,
// 3) whether the w3.org Cloudflare wall depends on the browser UA / JS vs plain HTTP.
// Usage (outside the sandbox): node bench/probes/reach/followup.mjs
import { chromium, request } from 'playwright'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MODES = [
  ['shell', {}],
  ['newheadless', { channel: 'chromium' }],
]
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
const W3C_URLS = ['https://www.w3.org/WAI/demos/bad/', 'https://www.w3.org/WAI/demos/bad/before/home.html']
const AMAZON = 'https://www.amazon.com'
const AMAZON_REPEATS = 3
const out = { ranAt: new Date().toISOString(), binaries: [], amazon: [], w3c: [] }

async function landing(browser, url, ctxOpts = {}) {
  const context = await browser.newContext(ctxOpts)
  const page = await context.newPage()
  const row = { url, ua: ctxOpts.userAgent ? 'desktop-override' : 'default' }
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    row.status = resp ? resp.status() : null
    try {
      await page.waitForLoadState('networkidle', { timeout: 30_000 })
      row.networkIdle = 'reached'
    } catch {
      row.networkIdle = 'timeout'
    }
    row.title = await page.title()
    row.focusable = await page.evaluate(
      () => document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])').length,
    )
    const text = await page.evaluate(() => document.body?.innerText ?? '')
    row.continueShoppingWall = /click the button below to continue shopping/i.test(text)
    row.cloudflareWall = /performing security verification|just a moment/i.test(`${row.title}\n${text}`)
  } catch (err) {
    row.error = String(err.message || err).split('\n')[0]
  }
  await context.close()
  return row
}

// 1) binaries
for (const [mode, opts] of MODES) {
  const server = await chromium.launchServer(opts)
  const proc = server.process()
  const browser = await chromium.connect(server.wsEndpoint())
  const page = await browser.newPage()
  const ua = await page.evaluate(() => navigator.userAgent)
  const row = { mode, opts, spawnfile: proc.spawnfile, headlessArg: proc.spawnargs.find((a) => a.startsWith('--headless')), version: browser.version(), ua }
  out.binaries.push(row)
  console.log(`BIN ${JSON.stringify(row)}`)
  await browser.close()
  await server.close()
}

// 2) Amazon repeats (sequential, fresh context each time, 5s apart)
for (const [mode, opts] of MODES) {
  const browser = await chromium.launch(opts)
  for (let i = 1; i <= AMAZON_REPEATS; i++) {
    const row = { mode, attempt: i, ...(await landing(browser, AMAZON)) }
    out.amazon.push(row)
    console.log(`AMAZON ${JSON.stringify(row)}`)
    await new Promise((r) => setTimeout(r, 5_000))
  }
  await browser.close()
}

// 3) w3.org: plain HTTP via Playwright APIRequestContext (no JS), then each browser mode with default and desktop UA
const api = await request.newContext()
for (const url of W3C_URLS) {
  const resp = await api.get(url, { timeout: 60_000 })
  const body = await resp.text()
  const title = (/<title>([^<]*)<\/title>/i.exec(body) || [])[1] ?? null
  const row = { via: 'apirequest', url, status: resp.status(), bytes: body.length, title, serverHeader: resp.headers()['server'] ?? null }
  out.w3c.push(row)
  console.log(`W3C ${JSON.stringify(row)}`)
}
await api.dispose()
for (const [mode, opts] of MODES) {
  const browser = await chromium.launch(opts)
  for (const url of W3C_URLS) {
    for (const ctxOpts of [{}, { userAgent: DESKTOP_UA }]) {
      const row = { via: mode, ...(await landing(browser, url, ctxOpts)) }
      out.w3c.push(row)
      console.log(`W3C ${JSON.stringify(row)}`)
      await new Promise((r) => setTimeout(r, 3_000))
    }
  }
  await browser.close()
}

writeFileSync(join(HERE, 'followup.json'), JSON.stringify(out, null, 2))
console.log(`WROTE ${join(HERE, 'followup.json')}`)
