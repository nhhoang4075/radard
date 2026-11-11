import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./design/fonts.css";
import "./design/tokens.css";
import "./design/base.css";
import { strings } from "./lib/strings.vi.ts";
import { routeTree } from "./routeTree.gen.ts";
import { ToastProvider, TooltipProvider } from "./ui/index.ts";

const queryClient = new QueryClient();
const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <ToastProvider closeLabel={strings.shell.toastClose}>
          <RouterProvider router={router} />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
