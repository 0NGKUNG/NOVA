import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const bootSurface = (() => {
  const s = new URLSearchParams(window.location.search).get("surface");
  if (s === "island" || s === "orb" || s === "mobile" || s === "hub") return s;
  return window.innerWidth <= 620 ? "mobile" : "hub";
})();
document.documentElement.dataset.surface = bootSurface;
document.body.dataset.surface = bootSurface;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
