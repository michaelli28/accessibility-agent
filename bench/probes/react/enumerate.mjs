// SPIKE: tests two candidate ENUMERATION fixes for crawlDOM (which never visits a plain <div> with a handler):
//  A) one CDP call: DOMDebugger.getEventListeners(document, depth:-1) -> every node carrying a click-ish listener
//  B) page-side walk: elements whose __reactProps$* carry any on[A-Z]* function prop
// Reports which data-probe ids (and which non-probe nodes) each method returns.
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import serve from './serve.cjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILDS = ['react18-prod', 'react18-dev', 'react19-prod', 'react19-dev', 'control'];
const CLICKISH = ['click', 'mousedown', 'mouseup', 'keydown', 'keyup', 'touchstart', 'touchend'];

const labelOf = (node) => {
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'data-probe') return attrs[i + 1];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'id') return `${node.localName}#${attrs[i + 1]}`;
  return node.localName || node.nodeName;
};

const { server, base } = await serve.startServer(join(HERE, 'dist'));
const browser = await chromium.launch();
try {
  for (const build of BUILDS) {
    const page = await browser.newPage();
    await page.goto(`${base}/${build}/index.html`, { waitUntil: 'load' });
    await page.waitForSelector('[data-probe]');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: root.backendNodeId });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: object.objectId, depth: -1, pierce: true });
    const byNode = new Map();
    for (const l of listeners) {
      if (!CLICKISH.includes(l.type) || l.backendNodeId === undefined) continue;
      byNode.set(l.backendNodeId, [...(byNode.get(l.backendNodeId) ?? []), l.type]);
    }
    const found = [];
    for (const [backendNodeId, types] of byNode) {
      const { node } = await cdp.send('DOM.describeNode', { backendNodeId });
      found.push(`${labelOf(node)}(${[...new Set(types)].join('+')})`);
    }
    const reactWalk = await page.evaluate(() =>
      [...document.querySelectorAll('*')].flatMap((el) => {
        const k = Object.keys(el).find((x) => x.startsWith('__reactProps$'));
        if (!k) return [];
        const handlers = Object.keys(el[k]).filter((p) => /^on[A-Z]/.test(p) && typeof el[k][p] === 'function');
        return handlers.length ? [`${el.getAttribute('data-probe') ?? el.tagName.toLowerCase()}(${handlers.join('+')})`] : [];
      }),
    );
    console.log(`${build}\n  A cdp-subtree listeners(total=${listeners.length}) clickish nodes: ${found.join(', ') || 'none'}\n  B reactProps walk: ${reactWalk.join(', ') || 'none'}`);
    await cdp.detach();
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
