import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import ManagerApp from "./ManagerApp";
// Explicit import pins the shared theme/controls stylesheet to THIS entry instead of
// relying on Rollup assigning main.css to whatever chunk both entries happen to share.
// The quota/settings page styles load here too: both tab contents stay mounted in
// one page (CSS toggle), so their classes must exist in the manager bundle.
import "../main.css";
import "../config/config.css";
import "../quota/quota.css";
import "../settings/settings.css";
import "./manager.css";

const rootElement = document.getElementById("root");

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <ManagerApp />
    </StrictMode>,
  );
}
