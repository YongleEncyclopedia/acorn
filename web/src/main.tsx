import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";
import "./styles/reader.css";
import { queryClient } from "./lib/queries.ts";
import { bootTheme } from "./lib/theme.ts";
import { App } from "./App.tsx";

bootTheme();
// Not awaited: the interface paints with system fonts and the reading fonts swap in when they arrive.
void import("./fonts.ts");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
