/*
 * Agency Agents service worker (web build).
 *
 * Minimal, deliberate — this mirrors DevForge's approach:
 *  • Network-first for everything (app code + navigations), so updates are
 *    picked up on the next load.
 *  • Successful responses are cached as an offline shell: when the phone is
 *    offline, the app still opens (stale data + a quiet failure on /api).
 *  • /api and /api/chat are NEVER cached (live backend only).
 */
const CACHE = "agency-agents-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => undefined)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  // Live backend + non-same-origin: never intercepted.
  if (url.pathname.startsWith("/api/") || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => undefined);
        }
        return res;
      })
      .catch(() =>
        caches.match(event.request).then((hit) => hit ?? caches.match("/")),
      ),
  );
});
