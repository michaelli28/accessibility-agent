// SPIKE: isolates why getInteractivitySignals reports hasCursorPointer=false on a cursor:pointer div.
// Replays dom-crawler.ts:250-316 in a fresh CDP session (DOM.enable + CSS.enable, NO DOM.getDocument),
// then repeats the push after DOM.getDocument.
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<div id="t" style="cursor:pointer">x</div>');

  const a = await page.context().newCDPSession(page);
  await a.send('DOM.enable');
  const { root } = await a.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await a.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#t' });
  const { node } = await a.send('DOM.describeNode', { nodeId });
  await a.detach();
  console.log(`backendNodeId=${node.backendNodeId}`);

  const b = await page.context().newCDPSession(page);
  await b.send('DOM.enable');
  await b.send('CSS.enable');
  try {
    const before = await b.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [node.backendNodeId] });
    console.log(`fresh session, no getDocument: nodeIds=${JSON.stringify(before.nodeIds)}`);
  } catch (err) {
    // dom-crawler.ts:318 swallows exactly this error, leaving hasCursorPointer=false.
    console.log(`fresh session, no getDocument: THREW ${err instanceof Error ? err.message : String(err)}`);
  }
  await b.send('DOM.getDocument', { depth: 0 });
  const after = await b.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [node.backendNodeId] });
  const { computedStyle } = await b.send('CSS.getComputedStyleForNode', { nodeId: after.nodeIds[0] });
  console.log(
    `after getDocument: nodeIds=${JSON.stringify(after.nodeIds)} cursor=${computedStyle.find((p) => p.name === 'cursor')?.value}`,
  );
  await b.detach();
} finally {
  await browser.close();
}
