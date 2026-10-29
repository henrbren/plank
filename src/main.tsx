import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router/dom";
import { router } from "./App";
import { ToastProvider } from "./components/ui";
import { ApiError } from "./lib/api";
import { BrandProvider } from "./lib/brand";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

// Ved utløpt sesjon: send brukeren til innlogging
window.addEventListener("plank:unauthorized", () => {
  if (!location.pathname.startsWith("/login") && !location.pathname.startsWith("/auth") && !location.pathname.startsWith("/venter") && !location.pathname.startsWith("/onboarding")) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrandProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </BrandProvider>
    </QueryClientProvider>
  </StrictMode>,
);
