const VERSION = "2026-07-13.18";
const APP_CACHE = `cert-cache-app-${VERSION}`;
const RUNTIME_CACHE = `cert-cache-runtime-${VERSION}`;
const SNAPSHOT_KEY = "/__pwa/snapshot/domain-state";
const MODE_KEY = "/__pwa/mode";
const BOOTSTRAP_URL = "/api/bootstrap";
const APP_SHELL_URL = "/index.html";
const LOGIN_NETWORK_TIMEOUT_MS = 1500;

const PRECACHE_URLS = [
  "/",
  APP_SHELL_URL,
  "/manifest.webmanifest",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  BOOTSTRAP_URL
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => precacheAll(cache))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== APP_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => seedSnapshot())
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};

  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (data.type === "SET_CACHE_ONLY") {
    event.waitUntil(
      writeCacheOnly(Boolean(data.value))
        .then((mode) => reply(event, mode))
    );
    return;
  }

  if (data.type === "GET_MODE") {
    event.waitUntil(readCacheOnly().then((cacheOnly) => reply(event, { cacheOnly })));
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname === "/api/domain-state") {
    event.respondWith(handleDomainState(request));
    return;
  }

  if (url.pathname === BOOTSTRAP_URL) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(handleLoginNavigation());
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function handleLoginNavigation() {
  try {
    const response = await withTimeout(
      fetch(pwaRequest(APP_SHELL_URL, "app-shell", "network"), { cache: "no-store" }),
      LOGIN_NETWORK_TIMEOUT_MS,
      "app shell network timeout"
    );
    if (!response.ok) {
      throw new Error(`app shell HTTP ${response.status}`);
    }

    await storeAppShell(response.clone()).catch(() => {});
    const html = decorateAppShellHtml(await response.clone().text(), "login", "primary", null);
    return htmlResponse(html, "primary", 200);
  } catch (error) {
    return cachedErrorShellPage(error);
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout])
    .finally(() => clearTimeout(timeoutId));
}

async function cachedErrorShellPage(reason) {
  const response = await caches.match(APP_SHELL_URL) || await caches.match("/");
  if (response) {
    const html = decorateAppShellHtml(await response.clone().text(), "business-error", "cache", reason);
    return htmlResponse(html, "cache", 200);
  }

  return htmlResponse(emergencyErrorShellHtml(reason), "cache", 503);
}

async function storeAppShell(response) {
  const cache = await caches.open(APP_CACHE);
  await cache.put(APP_SHELL_URL, response.clone());
  await cache.put("/", response.clone());
}

function decorateAppShellHtml(html, pageState, source, reason) {
  const message = reason && reason.message ? reason.message : "login page fetch failed";
  return html
    .replace(/data-page-state="[^"]*"/, `data-page-state="${pageState}"`)
    .replace(/data-page-source="[^"]*"/, `data-page-source="${source}"`)
    .replace(/data-error-reason="[^"]*"/, `data-error-reason="${escapeAttribute(message)}"`);
}

function htmlResponse(html, source, status) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-PWA-Source": source,
      "X-PWA-Version": VERSION
    }
  });
}

function emergencyErrorShellHtml(reason) {
  const message = reason && reason.message ? reason.message : "login page fetch failed";
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PWA Login Error</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: #f5f2ec; color: #16222d; }
    main { width: min(520px, calc(100% - 28px)); border: 1px solid #d8d2c8; border-radius: 8px; padding: 20px; background: #fff; }
    strong, span { display: block; }
    span { margin-top: 8px; color: #65727f; line-height: 1.4; overflow-wrap: anywhere; }
  </style>
</head>
<body data-page-state="business-error" data-page-source="cache" data-app-version="${VERSION}" data-error-reason="${escapeAttribute(message)}">
  <main>
    <strong>Вход временно недоступен.</strong>
    <span>Показано сохраненное бизнес-сообщение. Обновите страницу позже.</span>
  </main>
</body>
</html>`;
}

async function handleDomainState(request) {
  if (await readCacheOnly()) {
    return cachedSnapshot("cacheOnly");
  }

  try {
    const response = await fetch(pwaRequest(request, "domain-state", "network"), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.clone().json();
    const snapshot = {
      ...data,
      source: "network",
      cachedAt: new Date().toISOString(),
      cacheVersion: VERSION
    };
    await storeSnapshot(snapshot);
    return jsonResponse(snapshot, 200, "network");
  } catch (error) {
    await writeCacheOnly(true);
    return cachedSnapshot(error && error.message ? error.message : "fetch failed");
  }
}

async function cacheFirst(requestOrUrl) {
  const request = typeof requestOrUrl === "string" ? new Request(requestOrUrl) : requestOrUrl;
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  if (await readCacheOnly()) {
    return new Response("cache miss", {
      status: 504,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-PWA-Source": "cache",
        "X-PWA-Version": VERSION
      }
    });
  }

  return fetch(pwaRequest(request, "cache-miss", "network"));
}

async function precacheAll(cache) {
  await Promise.all(PRECACHE_URLS.map(async (url) => {
    const response = await fetch(pwaRequest(precacheFetchUrl(url), "precache", "install"), { cache: "reload" });
    if (!response.ok) {
      throw new Error(`precache ${url} failed with HTTP ${response.status}`);
    }
    await cache.put(url, response);
  }));
}

function precacheFetchUrl(url) {
  const precacheUrl = new URL(url, self.location.origin);
  precacheUrl.searchParams.set("__pwa_precache_version", VERSION);
  precacheUrl.searchParams.set("__pwa_precache_ts", String(Date.now()));
  return `${precacheUrl.pathname}${precacheUrl.search}`;
}

async function seedSnapshot() {
  const runtime = await caches.open(RUNTIME_CACHE);
  const existing = await runtime.match(SNAPSHOT_KEY);
  if (existing) {
    return;
  }

  const bootstrap = await caches.match(BOOTSTRAP_URL);
  if (!bootstrap) {
    return;
  }

  const data = await bootstrap.clone().json();
  await storeSnapshot({
    ...data,
    source: "cache",
    cachedAt: new Date().toISOString(),
    cacheVersion: VERSION
  });
}

async function storeSnapshot(data) {
  const runtime = await caches.open(RUNTIME_CACHE);
  await runtime.put(SNAPSHOT_KEY, jsonResponse(data, 200, data.source || "cache"));
}

async function cachedSnapshot(reason) {
  const runtime = await caches.open(RUNTIME_CACHE);
  let response = await runtime.match(SNAPSHOT_KEY);

  if (!response) {
    await seedSnapshot();
    response = await runtime.match(SNAPSHOT_KEY);
  }

  if (!response) {
    return jsonResponse({
      ok: false,
      source: "cache",
      requestId: 0,
      origin: "cache",
      servedAt: new Date().toISOString(),
      cachedAt: new Date().toISOString(),
      fallbackReason: reason,
      message: "Кэш пока пуст."
    }, 503, "cache");
  }

  const data = await response.clone().json();
  return jsonResponse({
    ...data,
    source: "cache",
    fallbackReason: reason,
    cacheOnly: true
  }, 200, "cache");
}

async function readCacheOnly() {
  const runtime = await caches.open(RUNTIME_CACHE);
  const response = await runtime.match(MODE_KEY);
  if (!response) {
    return false;
  }

  try {
    const data = await response.json();
    return data.cacheOnly === true;
  } catch (_error) {
    return false;
  }
}

async function writeCacheOnly(value) {
  const runtime = await caches.open(RUNTIME_CACHE);
  const mode = {
    cacheOnly: value,
    changedAt: new Date().toISOString()
  };
  await runtime.put(MODE_KEY, jsonResponse(mode, 200, "cache"));
  return mode;
}

function jsonResponse(data, status, source) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-PWA-Source": source,
      "X-PWA-Version": VERSION
    }
  });
}

function pwaRequest(requestOrUrl, requestName, mode) {
  const request = typeof requestOrUrl === "string" ? new Request(requestOrUrl) : requestOrUrl;
  const headers = new Headers(request.headers);

  if (requestName === "app-shell") {
    headers.set("Accept", "text/html,application/xhtml+xml");
  } else if (!headers.has("Accept") && requestName !== "precache" && requestName !== "cache-miss") {
    headers.set("Accept", "application/json");
  }
  if (!headers.has("X-PWA-Client")) {
    headers.set("X-PWA-Client", "service-worker");
  }
  headers.set("X-PWA-Request", requestName);
  headers.set("X-PWA-Version", VERSION);
  headers.set("X-PWA-Mode", mode);
  headers.set("X-PWA-Service-Worker", "true");
  if (!headers.has("X-PWA-Trace")) {
    headers.set("X-PWA-Trace", `${VERSION}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  }

  return new Request(request, { headers });
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function reply(event, message) {
  if (event.ports && event.ports[0]) {
    event.ports[0].postMessage(message);
  }
}
