// SPIKE: measures, per probe element and build, (i) CDP listeners via the exact dom-crawler.ts sequence,
// (ii) React's __reactProps$* expando and typeof onClick, (iii) computed cursor via the same CSS route
// the detector uses. Also clicks each element to prove the handlers are live. Writes out/probe-results.json.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import serve from './serve.cjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, 'dist');
const BUILDS = ['react18-prod', 'react18-dev', 'react19-prod', 'react19-dev', 'control'];
// g/h/i are beyond-spec: handlers other than onClick (onMouseDown / onKeyDown / onPointerDown).
const REACT_IDS = ['a', 'b', 'c', 'c-child', 'd', 'e', 'f', 'g', 'h', 'i'];
const CONTROL_IDS = ['ctl-listener', 'ctl-inline'];
// Same list as taskgen/src/dom-crawler.ts:334
const CLICKISH = ['click', 'mousedown', 'mouseup', 'keydown', 'keyup', 'touchstart', 'touchend'];

const INSPECT_FN = `function () {
  const own = Object.keys(this);
  const reactKeys = own.filter((k) => k.startsWith('__react')).map((k) => k.slice(0, k.indexOf('$') + 1) + '*');
  const propsKey = own.find((k) => k.startsWith('__reactProps$'));
  const props = propsKey ? this[propsKey] : undefined;
  let nearest = null;
  for (let el = this, depth = 0; el && el.nodeType === 1; el = el.parentElement, depth++) {
    const k = Object.keys(el).find((x) => x.startsWith('__reactProps$'));
    if (k && el[k] && typeof el[k].onClick === 'function') {
      nearest = { depth, tag: el.tagName.toLowerCase(), probe: el.getAttribute('data-probe') };
      break;
    }
  }
  return {
    reactKeys,
    hasPropsKey: Boolean(propsKey),
    onClickType: props ? typeof props.onClick : 'no-props',
    handlerProps: props ? Object.keys(props).filter((k) => /^on[A-Z]/.test(k) && typeof props[k] === 'function') : [],
    nearestOnClick: nearest,
    onclickProp: this.onclick === null ? 'null' : typeof this.onclick,
    onclickSrc: typeof this.onclick === 'function' ? String(this.onclick).replace(/\\s+/g, ' ').slice(0, 60) : null,
    onclickAttr: this.getAttribute('onclick'),
  };
}`;

const summarize = (listeners) => ({
  total: listeners.length,
  distinctTypes: new Set(listeners.map((l) => l.type)).size,
  clickish: listeners.filter((l) => CLICKISH.includes(l.type)).map((l) => `${l.type}${l.useCapture ? '(cap)' : ''}`),
});

async function listenersOf(cdp, objectId, objectGroup) {
  const params = objectGroup ? { objectId, objectGroup } : { objectId };
  const { listeners } = await cdp.send('DOMDebugger.getEventListeners', params);
  return listeners;
}

async function probeElement(cdp, rootNodeId, id) {
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: rootNodeId, selector: `[data-probe="${id}"]` });
  if (!nodeId) return { id, error: 'not found' };
  const { node } = await cdp.send('DOM.describeNode', { nodeId });
  // Exact dom-crawler.ts:324-331 sequence: resolveNode(backendNodeId) -> getEventListeners(objectId), default params.
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId });
  const listeners = await listenersOf(cdp, object.objectId);
  const detail = listeners.length
    ? (await listenersOf(cdp, object.objectId, 'probe')).map((l) => ({
        type: l.type,
        capture: l.useCapture,
        handler: l.handler?.description?.replace(/\s+/g, ' ').slice(0, 60) ?? null,
        backendNodeId: l.backendNodeId ?? null,
      }))
    : [];
  const call = await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: INSPECT_FN,
    returnByValue: true,
  });
  if (call.exceptionDetails) return { id, error: `callFunctionOn threw: ${call.exceptionDetails.text}` };
  // Cursor via the detector's route (dom-crawler.ts:304-316).
  const { nodeIds } = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [node.backendNodeId] });
  const { computedStyle } = await cdp.send('CSS.getComputedStyleForNode', { nodeId: nodeIds[0] });
  const cursor = computedStyle.find((p) => p.name === 'cursor')?.value ?? null;
  return {
    id,
    tag: node.localName,
    backendNodeId: node.backendNodeId,
    listenerTypes: listeners.map((l) => l.type),
    clickish: summarize(listeners).clickish,
    listenerDetail: detail,
    ...call.result.value,
    cursor,
  };
}

async function probeBuild(browser, base, build) {
  const ids = build === 'control' ? CONTROL_IDS : REACT_IDS;
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 200)}`);
  });
  try {
    await page.goto(`${base}/${build}/index.html`, { waitUntil: 'load' });
    await page.waitForSelector(`[data-probe="${ids[ids.length - 1]}"]`, { timeout: 10000 });
    const runtime = await page.evaluate(() => window.__PROBE__);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });

    const rootQ = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#root' });
    const rootDesc = await cdp.send('DOM.describeNode', { nodeId: rootQ.nodeId });
    const rootObj = await cdp.send('DOM.resolveNode', { backendNodeId: rootDesc.node.backendNodeId });
    const docObj = await cdp.send('DOM.resolveNode', { backendNodeId: root.backendNodeId });
    const winObj = await cdp.send('Runtime.evaluate', { expression: 'window' });
    const containers = {
      '#root': summarize(await listenersOf(cdp, rootObj.object.objectId)),
      document: summarize(await listenersOf(cdp, docObj.object.objectId)),
      window: summarize(await listenersOf(cdp, winObj.result.objectId)),
    };

    const elements = [];
    for (const id of ids) elements.push(await probeElement(cdp, root.nodeId, id));
    await cdp.detach();

    // Liveness: real clicks; c-child should bubble to c's handler, f should log nothing.
    const clicked = {};
    for (const id of ids) {
      const before = await page.evaluate(() => window.__clicks.length);
      await page.click(`[data-probe="${id}"]`);
      clicked[id] = await page.evaluate((n) => window.__clicks.slice(n), before);
    }
    return { build, runtime, containers, elements, clicked, errors };
  } finally {
    await page.close();
  }
}

const fmt = (v) => (Array.isArray(v) ? (v.length ? v.join(',') : '-') : v === null || v === undefined ? '-' : String(v));

const { server, base } = await serve.startServer(DIST);
const browser = await chromium.launch();
const results = [];
try {
  console.log(`chromium ${browser.version()} serving ${base}`);
  for (const build of BUILDS) {
    const r = await probeBuild(browser, base, build);
    results.push(r);
    console.log(`\n=== ${build} runtime=${JSON.stringify(r.runtime)} errors=${r.errors.length}`);
    for (const e of r.errors) console.log(`  ${e}`);
    for (const [name, s] of Object.entries(r.containers)) {
      console.log(`  container ${name}: listeners=${s.total} distinctTypes=${s.distinctTypes} clickish=${fmt(s.clickish)}`);
    }
    for (const el of r.elements) {
      if (el.error) {
        console.log(`  ${el.id}: ERROR ${el.error}`);
        continue;
      }
      console.log(
        `  ${el.id.padEnd(12)} <${el.tag}> listeners=[${fmt(el.listenerTypes)}] clickish=[${fmt(el.clickish)}] ` +
          `onclickProp=${el.onclickSrc ?? el.onclickProp} onclickAttr=${fmt(el.onclickAttr)} ` +
          `reactKeys=[${fmt(el.reactKeys)}] props.onClick=${el.onClickType} handlerProps=[${fmt(el.handlerProps)}] ` +
          `nearestOnClick=${el.nearestOnClick ? `${el.nearestOnClick.probe}@${el.nearestOnClick.depth}` : '-'} ` +
          `cursor=${el.cursor} clicked->[${fmt(r.clicked[el.id])}]`,
      );
    }
  }
} finally {
  await browser.close();
  server.close();
}

mkdirSync(join(HERE, 'out'), { recursive: true });
writeFileSync(join(HERE, 'out', 'probe-results.json'), JSON.stringify(results, null, 2));
console.log(`\nwrote ${join(HERE, 'out', 'probe-results.json')}`);
