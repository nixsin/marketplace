"use client";

import { useEffect } from "react";

// Dev-only skip: a service worker caching hot-reloading JS/CSS during
// active development causes more confusion (stale bundles, phantom bugs)
// than it's worth — see public/sw.js for what this registers in prod.
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.error("Service worker registration failed:", error);
    });
  }, []);

  return null;
}
