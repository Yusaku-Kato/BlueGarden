import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { errorName, logger } from "./infra/logger";
import "./styles.css";

// SDK errors can carry request fragments; log only the error name (docs/DESIGN.md section 21).
window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  logger.error("unexpected", { where: "unhandledrejection", error: errorName(event.reason) });
});
window.addEventListener("error", (event) => {
  event.preventDefault();
  logger.error("unexpected", { where: "window.error", error: errorName(event.error) });
});

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Root element #root is missing from index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
