// SPIKE: probe fixture. Each element is tagged data-probe="<id>"; handlers log to window.__clicks
// so the probe can prove the React handlers are live, not just present.
const log = (id) => () => {
  window.__clicks.push(id);
};

export function App() {
  return (
    <div id="app">
      <div
        data-probe="a"
        className="btn"
        style={{ cursor: "pointer" }}
        onClick={log("a")}
      >
        Add to cart
      </div>
      <div data-probe="b" onClick={log("b")}>
        Add to cart
      </div>
      <div data-probe="c" onClick={log("c")}>
        <span data-probe="c-child">Nested text</span>
      </div>
      <div data-probe="d" role="button" tabIndex={0} onClick={log("d")}>
        Accessible div
      </div>
      <button data-probe="e" onClick={log("e")}>
        Real button
      </button>
      <div data-probe="f" className="plain">
        No handler
      </div>
      {/* Beyond-spec: React only plants the onclick=noop trap for onClick, so these may be CDP-invisible. */}
      <div data-probe="g" onMouseDown={log("g")}>
        Mouse-down only
      </div>
      <div data-probe="h" onKeyDown={log("h")}>
        Key-down only
      </div>
      <div data-probe="i" onPointerDown={log("i")}>
        Pointer-down only
      </div>
    </div>
  );
}
