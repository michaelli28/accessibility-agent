// SPIKE: live-site reachability probe (landing URL only — no a11y checks, no clicks, no navigation past the URL).
// Runs every URL in two modes: Playwright's default headless shell and new headless (channel:'chromium').
// Usage (outside the sandbox): node bench/probes/reach/probe.mjs
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })

const BAD = 'https://www.w3.org/WAI/demos/bad'
const PAGES = ['home', 'news', 'tickets', 'survey']

const SITES = [
  ['example', 'https://example.com'],
  ['amazon', 'https://www.amazon.com'],
  ['mealkeyway', 'https://order.mealkeyway.com/customer/release/index?mid=75452b6a42425a6b4f31646a6e4633415168496f75673d3d#/main'],
  ['troyroyalpalace', 'https://www.troyroyalpalace.com'],
  ['fake-university', 'https://fake-university.com'],
  ['cmu', 'https://cmu.edu'],
  ['troy-k12', 'https://www.troy.k12.mi.us/'],
  ['bad-index', `${BAD}/`],
  ...PAGES.map((p) => [`bad-before-${p}`, `${BAD}/before/${p}.html`]),
  ...PAGES.map((p) => [`bad-after-${p}`, `${BAD}/after/${p}.html`]),
  ...PAGES.map((p) => [`bad-report-before-${p}`, `${BAD}/before/reports/${p}.html`]),
]

const MODES = [
  ['shell', {}],
  ['newheadless', { channel: 'chromium' }],
]

const FOCUSABLE = 'a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])'
const BOT_WALL = /captcha|robot|access denied|just a moment|verify you are human|sorry, we just need to make sure|unusual traffic|cf-chl/i
const GOTO_TIMEOUT_MS = 60_000
const IDLE_TIMEOUT_MS = 30_000
const CONCURRENCY = 4

function botWallHit(text) {
  const m = BOT_WALL.exec(text)
  if (!m) return null
  const start = Math.max(0, m.index - 60)
  const context = text.slice(start, m.index + m[0].length + 60).replace(/\s+/g, ' ').trim()
  return { term: m[0], context }
}

async function probeOne(browser, mode, [site, url]) {
  const row = { site, mode, url }
  const context = await browser.newContext()
  const page = await context.newPage()
  const t0 = Date.now()
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS })
    row.status = resp ? resp.status() : null
    row.dclMs = Date.now() - t0
    const chain = []
    for (let r = resp?.request(); r; r = r.redirectedFrom()) chain.unshift(r.url())
    row.redirectChain = chain
  } catch (err) {
    row.gotoError = String(err.message || err).split('\n')[0]
  }
  if (!row.gotoError) {
    const t1 = Date.now()
    try {
      await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS })
      row.networkIdle = 'reached'
      row.idleMs = Date.now() - t1
    } catch (err) {
      row.networkIdle = /Timeout/i.test(String(err)) ? 'timeout' : `error: ${String(err.message || err).split('\n')[0]}`
    }
    try {
      row.finalUrl = page.url()
      row.title = await page.title()
      row.focusable = await page.evaluate((sel) => document.querySelectorAll(sel).length, FOCUSABLE)
      const bodyText = await page.evaluate(() => (document.body ? document.body.innerText : ''))
      row.bodyChars = bodyText.length
      row.ua = await page.evaluate(() => navigator.userAgent)
      row.webdriver = await page.evaluate(() => navigator.webdriver)
      const hit = botWallHit(`${row.title}\n${bodyText}`)
      row.botWall = Boolean(hit)
      row.botWallHit = hit
      const shot = join(SHOTS, `${site}-${mode}.png`)
      await page.screenshot({ path: shot, timeout: 30_000 })
      row.screenshot = `shots/${site}-${mode}.png`
    } catch (err) {
      row.inspectError = String(err.message || err).split('\n')[0]
    }
  }
  row.totalMs = Date.now() - t0
  await context.close()
  return row
}

async function runMode([mode, launchOpts]) {
  const browser = await chromium.launch(launchOpts)
  const version = browser.version()
  console.log(`MODE ${mode} launched chromium ${version} opts=${JSON.stringify(launchOpts)}`)
  const results = new Array(SITES.length)
  let next = 0
  async function worker() {
    while (next < SITES.length) {
      const i = next++
      results[i] = await probeOne(browser, mode, SITES[i])
      const r = results[i]
      console.log(
        `ROW ${mode} ${r.site} status=${r.status ?? '-'} final=${r.finalUrl ?? '-'} title=${JSON.stringify(r.title ?? null)} ` +
          `focusable=${r.focusable ?? '-'} idle=${r.networkIdle ?? '-'} botWall=${r.botWall ?? '-'}` +
          (r.botWallHit ? ` hit=${JSON.stringify(r.botWallHit)}` : '') +
          (r.gotoError ? ` gotoError=${JSON.stringify(r.gotoError)}` : '') +
          (r.inspectError ? ` inspectError=${JSON.stringify(r.inspectError)}` : ''),
      )
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  await browser.close()
  return { mode, version, launchOpts, results }
}

const runs = await Promise.all(MODES.map(runMode))
const out = { ranAt: new Date().toISOString(), runs }
writeFileSync(join(HERE, 'results.json'), JSON.stringify(out, null, 2))
console.log(`WROTE ${join(HERE, 'results.json')}`)
