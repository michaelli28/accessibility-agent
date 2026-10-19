// SPIKE: probe entry. Records the React/ReactDOM versions actually loaded at runtime.
import React from "react";
import { version as reactDomVersion } from "react-dom";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";

window.__clicks = [];
window.__PROBE__ = {
  react: React.version,
  reactDom: reactDomVersion,
  nodeEnv: process.env.NODE_ENV,
};

createRoot(document.getElementById("root")).render(<App />);
