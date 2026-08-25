import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import SettingsApp from "./SettingsApp";
// Explicit import pins the shared theme/controls stylesheet to THIS entry instead of
// relying on Rollup assigning main.css to whatever chunk all entries happen to share.
import "../main.css";
import "./settings.css";

const rootElement = document.getElementById("root");

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <SettingsApp />
    </StrictMode>,
  );
}
