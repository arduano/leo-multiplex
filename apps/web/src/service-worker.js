/* This file is filled with a build inventory by personalPwa. */
const BUILD = __LEO_BUILD_CONFIG__;
const CACHE = "leo-shell-" + BUILD.version;
const ALLOWED = new Set(BUILD.assets);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

self.addEventListener("install", event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  try {
    for (const path of ALLOWED) {
      const response = await fetch(path, { credentials: "same-origin", redirect: "error", cache: "no-store" });
      if (!response.ok || response.redirected || response.type === "opaque") throw Error("Shell unavailable");
      const type = response.headers.get("content-type") ?? "";
      if (path.endsWith(".js") && !type.includes("javascript") || path.endsWith(".css") && !type.includes("text/css") || path.endsWith(".png") && !type.includes("image/png")) throw Error("Unexpected shell response");
      if (path === "/offline-shell.html") {
        const html = await response.text();
        if (!html.includes('name="leo-offline"') || html.includes('name="agent-multiplex-style-nonce"')) throw Error("Invalid offline entry");
        // Cache only the build's anonymous template, not authenticated CSP/headers.
        await cache.put(path, new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
      } else await cache.put(path, response);
    }
  } catch (error) { await caches.delete(CACHE); throw error; }
  // An update waits for an explicit action in the app. No automatic skipWaiting.
})()));

self.addEventListener("activate", event => event.waitUntil((async () => {
  // Old build caches support lazy chunks in still-open old clients. Two prior
  // builds are enough for the update window, independent of transcript length.
  const keys = (await caches.keys()).filter(key => key.startsWith("leo-shell-") && key !== CACHE);
  for (const key of keys.slice(0, -2)) await caches.delete(key);
  await self.clients.claim();
})()));

function assetPath(request) {
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== "GET" || url.search) return null;
  if (ALLOWED.has(url.pathname) || /^\/assets\/[A-Za-z0-9_.-]+$/.test(url.pathname)) return url.pathname;
  return null;
}
async function offlineEntry() {
  const cached = await (await caches.open(CACHE)).match("/offline-shell.html");
  if (!cached) return new Response("Reconnect to open Leo / agents", { status: 503, headers: { "Content-Type": "text/plain" } });
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replaceAll("+", "-").replaceAll("/", "_");
  const html = (await cached.text()).replace("</head>", `<meta name="agent-multiplex-style-nonce" content="${nonce}"></head>`);
  return new Response(html, { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  } });
}
self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (request.mode === "navigate" && ["/", "/index.html"].includes(url.pathname)) {
    event.respondWith(fetch(request, { signal: AbortSignal.timeout(8_000) }).catch(() => offlineEntry()));
    return;
  }
  const path = assetPath(request);
  if (!path || path === "/offline-shell.html") return;
  event.respondWith((async () => {
    const current = await (await caches.open(CACHE)).match(path);
    if (current) return current;
    for (const key of (await caches.keys()).filter(key => key.startsWith("leo-shell-"))) {
      const older = await (await caches.open(key)).match(path);
      if (older) return older;
    }
    // Only install populates caches. A missing path can never cache a login page.
    return fetch(request);
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type === "LEO_ACTIVATE_UPDATE") event.waitUntil(self.skipWaiting());
});
self.addEventListener("push", event => event.waitUntil((async () => {
  let payload;
  try { payload = event.data?.json(); } catch { return; }
  if (!payload || payload.version !== 1 || !["completion", "input", "error", "test"].includes(payload.kind) ||
      typeof payload.tag !== "string" || payload.tag.length > 500 || typeof payload.title !== "string" || typeof payload.body !== "string" ||
      payload.title.length > 200 || payload.body.length > 500 ||
      typeof payload.eventId !== "string" || payload.eventId.length > 500 ||
      payload.sessionId !== null && payload.sessionId !== undefined && !UUID.test(payload.sessionId) ||
      typeof payload.expiresAt !== "string" || !Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= Date.now()) return;
  await self.registration.showNotification(payload.title, {
    body: payload.body, tag: payload.tag ?? payload.eventId,
    icon: "/icons/leo-192.png", badge: "/icons/leo-192.png",
    data: { sessionId: payload.sessionId ?? null, eventId: payload.eventId },
  });
})()));
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const sessionId = event.notification.data?.sessionId;
    const hash = sessionId && UUID.test(sessionId) ? `#/agents/${sessionId}` : "#/agents";
    for (const client of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
      const url = new URL(client.url);
      if (url.origin === self.location.origin && ["/", "/index.html"].includes(url.pathname)) {
        client.postMessage({ type: "LEO_NAVIGATE", hash }); await client.focus(); return;
      }
    }
    await self.clients.openWindow("/" + hash);
  })());
});
