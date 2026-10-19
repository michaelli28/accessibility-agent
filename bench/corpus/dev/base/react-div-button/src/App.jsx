import { useState } from "react";
import { createPortal } from "react-dom";

// data-bench-id props render into the DOM, so labels can address React-rendered elements.
export function App() {
  const [status, setStatus] = useState("");
  return (
    <main>
      {/* A portal into the static header: React marks the host _reactListening and delegates from it. */}
      {createPortal(
        <button
          type="button"
          data-bench-id="share-button"
          onClick={() => setStatus("Link copied")}
        >
          Share
        </button>,
        document.getElementById("header-actions"),
      )}
      <h1>Canvas tote bag</h1>
      <p>$24.00</p>
      {/* Keyboard-inaccessible on purpose: onClick on a div, no role, no tabIndex. */}
      <div
        data-bench-id="add-to-cart-div"
        className="add-to-cart"
        style={{ cursor: "pointer" }}
        onClick={() => setStatus("Added to cart")}
      >
        Add to cart
      </div>
      <button
        type="button"
        data-bench-id="wishlist-button"
        onClick={() => setStatus("Saved to wishlist")}
      >
        Save to wishlist
      </button>
      <div data-bench-id="plain-div" className="note">
        Free shipping on orders over $50
      </div>
      <p id="status" role="status">
        {status}
      </p>
    </main>
  );
}
