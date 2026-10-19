// SPIKE: Tab wrap-around probe. Usage: node probe.mjs <shell|new|headed> [outTag] [fixtures e.g. b,a] [presses]
// Writes out/<mode>.json with every per-press snapshot (immediate + settled).
import { chromium } from 'playwright'
import http from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const FIXTURES = path.join(HERE, 'fixtures')
const OUT = path.join(HERE, 'out')
const SETTLE_MS = 150

// F = number of sequentially focusable elements in each fixture.
const FIXTURES_F = { a: 3, b: 1, c: 4, d: 3, e: 3 }

const MODES = {
  shell: () => chromium.launch(),
  new: () => chromium.launch({ channel: 'chromium' }),
  headed: () => chromium.launch({ headless: false }),
}

async function loadToolsExpression() {
  const file = path.join(ROOT, 'packages/agent/src/tools.ts')
  const src = await readFile(file, 'utf8')
  const matches = [...src.matchAll(/evaluate<string>\(`([\s\S]*?)`\)/g)]
  if (matches.length !== 1) throw new Error(`expected 1 evaluate<string> block in tools.ts, found ${matches.length}`)
  const startLine = src.slice(0, matches[0].index).split('\n').length
  const endLine = startLine + matches[0][0].split('\n').length - 1
  return { expr: matches[0][1].trim(), startLine, endLine }
}

function infoExpression(toolsExpr) {
  return `(() => {
    const el = document.activeElement;
    return {
      tag: el ? el.tagName.toLowerCase() : null,
      id: el && el.id ? el.id : null,
      text: el ? (el.textContent || '').trim().slice(0, 30) : null,
      p: el && el.getAttribute ? el.getAttribute('data-p') : null,
      isBody: el === document.body,
      isNull: el === null,
      hasFocus: document.hasFocus(),
      url: location.href,
      toolsId: ${toolsExpr},
    };
  })()`
}

async function snap(cdp, infoExpr) {
  const r = await cdp.send('Runtime.evaluate', { expression: infoExpr, returnByValue: true })
  if (r.exceptionDetails) throw new Error('info eval failed: ' + JSON.stringify(r.exceptionDetails))
  const o = await cdp.send('Runtime.evaluate', { expression: 'document.activeElement', objectGroup: 'probe' })
  let backendNodeId = null
  let nodeName = null
  if (o.result.objectId) {
    const d = await cdp.send('DOM.describeNode', { objectId: o.result.objectId })
    backendNodeId = d.node.backendNodeId
    nodeName = d.node.nodeName
  }
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'probe' })
  const v = r.result.value
  const label = v.isNull ? 'null' : v.isBody ? 'body' : v.p || v.id || v.tag
  return { ...v, label, backendNodeId, nodeName }
}

async function settle() {
  await new Promise((res) => setTimeout(res, SETTLE_MS))
}

async function walk({ page, cdp, infoExpr, key, presses, events }) {
  const steps = []
  for (let i = 1; i <= presses; i++) {
    try {
      await page.keyboard.press(key)
      const immediate = await snap(cdp, infoExpr)
      await settle()
      const settled = await snap(cdp, infoExpr)
      steps.push({ press: i, key, immediate, settled })
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n')[0] : String(err)
      console.error(`  walk ${key} failed at press ${i}: ${message}; page events: ${JSON.stringify(events)}`)
      return { steps, error: { press: i, message, events: [...events] } }
    }
  }
  return { steps, error: null }
}

function trackPage(page) {
  const events = []
  page.on('close', () => events.push('page-close'))
  page.on('crash', () => events.push('page-crash'))
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) events.push(`nav:${f.url()}`) })
  page.on('popup', (p) => events.push(`popup:${p.url()}`))
  return events
}

async function openFixture({ context, baseUrl, fixture, via }) {
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  if (via === 'goto') {
    await page.goto(`${baseUrl}/${fixture}.html`, { waitUntil: 'load' })
  } else {
    const html = await readFile(path.join(FIXTURES, `${fixture}.html`), 'utf8')
    await page.setContent(html, { waitUntil: 'load' })
  }
  return { page, cdp }
}

async function runFixture({ browser, baseUrl, fixture, via, infoExpr }) {
  const F = FIXTURES_F[fixture]
  const presses = process.argv[5] ? Number(process.argv[5]) : 5 * (F + 1) + 5
  const result = { fixture, via, F, presses }

  // Forward walk from a fresh load.
  {
    const context = await browser.newContext()
    const { page, cdp } = await openFixture({ context, baseUrl, fixture, via })
    const events = trackPage(page)
    result.initial = await snap(cdp, infoExpr)
    const w = await walk({ page, cdp, infoExpr, key: 'Tab', presses, events })
    result.forward = w.steps
    result.forwardError = w.error
    await context.close().catch(() => {})
  }

  // Reverse walk: fresh load, one Tab to reach the first element, then Shift+Tab.
  {
    const context = await browser.newContext()
    const { page, cdp } = await openFixture({ context, baseUrl, fixture, via })
    const events = trackPage(page)
    await page.keyboard.press('Tab')
    await settle()
    result.reverseStart = await snap(cdp, infoExpr)
    const w = await walk({ page, cdp, infoExpr, key: 'Shift+Tab', presses, events })
    result.reverse = w.steps
    result.reverseError = w.error
    await context.close().catch(() => {})
  }
  return result
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    const name = path.basename(new URL(req.url, 'http://x').pathname)
    try {
      const body = await readFile(path.join(FIXTURES, name))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

async function main() {
  const mode = process.argv[2]
  if (!MODES[mode]) throw new Error(`usage: node probe.mjs <${Object.keys(MODES).join('|')}>`)
  const tools = await loadToolsExpression()
  console.log(`tools.ts identity expression extracted from lines ${tools.startLine}-${tools.endLine}`)
  const infoExpr = infoExpression(tools.expr)

  const server = await startServer()
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const browser = await MODES[mode]()
  const version = browser.version()
  console.log(`mode=${mode} browser=${version} base=${baseUrl}`)

  browser.on('disconnected', () => console.error('  browser disconnected'))
  const runs = []
  const order = process.argv[4] ? process.argv[4].split(',') : Object.keys(FIXTURES_F)
  const plan = order.flatMap((f) => (f === 'a' ? [[f, 'goto'], [f, 'setContent']] : [[f, 'goto']]))
  try {
    for (const [fixture, via] of plan) {
      try {
        const run = await runFixture({ browser, baseUrl, fixture, via, infoExpr })
        runs.push(run)
        const fmt = (steps) => steps.map((s) => s.settled.label).join(' ')
        console.log(`${mode} ${fixture}/${via} fwd: ${fmt(run.forward)}${run.forwardError ? ` [ERROR at press ${run.forwardError.press}]` : ''}`)
        console.log(`${mode} ${fixture}/${via} rev(from ${run.reverseStart.label}): ${fmt(run.reverse)}${run.reverseError ? ` [ERROR at press ${run.reverseError.press}]` : ''}`)
      } catch (err) {
        const message = err instanceof Error ? err.message.split('\n')[0] : String(err)
        console.error(`${mode} ${fixture}/${via} run failed: ${message}`)
        runs.push({ fixture, via, runError: message })
      }
    }
  } finally {
    await browser.close().catch((err) => console.error('browser.close failed:', err.message))
    server.close()
  }

  await mkdir(OUT, { recursive: true })
  const outFile = path.join(OUT, `${mode}${process.argv[3] ?? ''}.json`)
  await writeFile(outFile, JSON.stringify({ mode, version, toolsLines: [tools.startLine, tools.endLine], runs }, null, 2))
  console.log(`wrote ${outFile}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
