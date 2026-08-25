import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import QuotaApp from "./QuotaApp";
// Explicit import pins the shared theme/controls stylesheet to THIS entry instead of
// relying on Rollup assigning main.css to whatever chunk both entries happen to share.
import "../main.css";
import "./quota.css";

const rootElement = document.getElementById("root");

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <QuotaApp />
    </StrictMode>,
  );
}
