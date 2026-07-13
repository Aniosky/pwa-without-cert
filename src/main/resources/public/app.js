const elements = {
  installState: document.querySelector("#installState"),
  appVersion: document.querySelector("#appVersion"),
  liveCard: document.querySelector("#liveCard"),
  cacheCard: document.querySelector("#cacheCard"),
  liveTitle: document.querySelector("#liveTitle"),
  liveMeta: document.querySelector("#liveMeta"),
  cacheTitle: document.querySelector("#cacheTitle"),
  cacheMeta: document.querySelector("#cacheMeta"),
  sourceTitle: document.querySelector("#sourceTitle"),
  sourceBadge: document.querySelector("#sourceBadge"),
  originValue: document.querySelector("#originValue"),
  requestValue: document.querySelector("#requestValue"),
  servedValue: document.querySelector("#servedValue"),
  cacheValue: document.querySelector("#cacheValue"),
  refreshButton: document.querySelector("#refreshButton"),
  networkButton: document.querySelector("#networkButton"),
  cacheOnlySwitch: document.querySelector("#cacheOnlySwitch"),
  requestLog: document.querySelector("#requestLog"),
  liveCount: document.querySelector("#liveCount"),
  cacheCount: document.querySelector("#cacheCount")
};

const APP_VERSION = "2026-07-13.13";
const SW_URL = `/sw.js?v=${encodeURIComponent(APP_VERSION)}`;
const SW_CACHE_MODE_VERSION = APP_VERSION;
const SW_CACHE_MODE_KEY = `cert-cache-sw-cache-mode-${SW_CACHE_MODE_VERSION}`;

const state = {
  liveCount: 0,
  cacheCount: 0,
  serviceWorkerReady: false,
  busy: false
};

init();

async function init() {
  renderInstallState();
  renderAppVersion();
  bindControls();

  if ("serviceWorker" in navigator) {
    try {
      await connectServiceWorker();
      state.serviceWorkerReady = true;
      const mode = await messageServiceWorker({ type: "GET_MODE" });
      elements.cacheOnlySwitch.checked = Boolean(mode.cacheOnly);
      await ensureServiceWorkerBypassesHttpCache();
    } catch (error) {
      appendLog("error", "service worker", error.message || "registration failed");
    }
  } else {
    appendLog("error", "service worker", "not supported");
  }

  await refreshDomainState();
}

function renderAppVersion() {
  elements.appVersion.textContent = `v${APP_VERSION}`;
}

function renderInstallState() {
  const standalone = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  elements.installState.textContent = standalone ? "Home Screen" : "Safari";
}

function bindControls() {
  elements.refreshButton.addEventListener("click", () => refreshDomainState());
  elements.networkButton.addEventListener("click", async () => {
    await setCacheOnly(false);
    await refreshDomainState();
  });
  elements.cacheOnlySwitch.addEventListener("change", async (event) => {
    await setCacheOnly(event.target.checked);
    await refreshDomainState({ preferCache: event.target.checked });
  });
}

async function registerServiceWorker() {
  const registration = await navigator.serviceWorker.register(SW_URL, { scope: "/", updateViaCache: "none" });
  localStorage.setItem(SW_CACHE_MODE_KEY, "none");
  await navigator.serviceWorker.ready;

  if (!navigator.serviceWorker.controller) {
    await Promise.race([
      new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })),
      new Promise((resolve) => setTimeout(resolve, 1200))
    ]);
  }

  if (registration.waiting) {
    registration.waiting.postMessage({ type: "SKIP_WAITING" });
  }
}

async function connectServiceWorker() {
  if (navigator.serviceWorker.controller) {
    await navigator.serviceWorker.ready;
    return;
  }

  await registerServiceWorker();
}

async function ensureServiceWorkerBypassesHttpCache() {
  if (localStorage.getItem(SW_CACHE_MODE_KEY) === "none") {
    return;
  }

  const registration = await navigator.serviceWorker.getRegistration("/");
  if (registration && registration.updateViaCache === "none") {
    localStorage.setItem(SW_CACHE_MODE_KEY, "none");
    return;
  }

  await registerServiceWorker();
}

async function refreshDomainState(options = {}) {
  if (state.busy) {
    return;
  }

  state.busy = true;
  setBusy(true);

  try {
    const response = await fetch(`/api/domain-state?ts=${Date.now()}`, {
      cache: "no-store",
      headers: pwaRequestHeaders(
        "domain-state",
        elements.cacheOnlySwitch.checked || options.preferCache === true ? "cache-only" : "network"
      )
    });
    const data = await response.json();
    const headerSource = response.headers.get("X-PWA-Source");
    const source = normalizeSource(headerSource || data.source);
    renderSnapshot(data, source, options.preferCache === true);
  } catch (error) {
    await setCacheOnly(true, { silent: true });
    renderNetworkFailure(error);
  } finally {
    state.busy = false;
    setBusy(false);
  }
}

function pwaRequestHeaders(requestName, mode) {
  return {
    "Accept": "application/json",
    "X-PWA-Client": "app",
    "X-PWA-Request": requestName,
    "X-PWA-Version": APP_VERSION,
    "X-PWA-Mode": mode,
    "X-PWA-Trace": `${APP_VERSION}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };
}

async function setCacheOnly(value, options = {}) {
  elements.cacheOnlySwitch.checked = value;
  if (!state.serviceWorkerReady) {
    return;
  }

  try {
    await messageServiceWorker({ type: "SET_CACHE_ONLY", value });
    if (!value) {
      await ensureServiceWorkerBypassesHttpCache();
    }
  } catch (error) {
    if (!options.silent) {
      appendLog("error", "cache mode", error.message || "message failed");
    }
  }
}

function renderSnapshot(data, source, preferredCache) {
  const isCache = source === "cache" || preferredCache;
  const isNetwork = source === "network" || source === "domain";

  elements.cacheOnlySwitch.checked = isCache;
  elements.liveCard.classList.toggle("is-active", isNetwork);
  elements.cacheCard.classList.toggle("is-active", isCache);
  elements.sourceBadge.textContent = isCache ? "cache" : "domain";
  elements.sourceTitle.textContent = isCache ? "Кэшированный снимок" : "Ответ домена";

  elements.originValue.textContent = data.origin || "-";
  elements.requestValue.textContent = String(data.requestId ?? "-");
  elements.servedValue.textContent = formatDate(data.servedAt);
  elements.cacheValue.textContent = data.cachedAt ? formatDate(data.cachedAt) : "-";

  if (isNetwork) {
    state.liveCount += 1;
    elements.liveTitle.textContent = "Запрос прошёл";
    elements.liveMeta.textContent = `Ответ #${data.requestId} сохранён`;
    elements.cacheTitle.textContent = "Снимок обновлён";
    elements.cacheMeta.textContent = data.cachedAt ? formatDate(data.cachedAt) : "только что";
    appendLog("network", `domain #${data.requestId}`, data.origin || "origin");
  } else {
    state.cacheCount += 1;
    elements.liveTitle.textContent = "Запросы остановлены";
    elements.liveMeta.textContent = "Новые обращения к домену не выполняются";
    elements.cacheTitle.textContent = "Работает из кэша";
    elements.cacheMeta.textContent = `Снимок #${data.requestId ?? 0}`;
    appendLog("cache", `cache #${data.requestId ?? 0}`, data.fallbackReason || "cache only");
  }

  elements.liveCount.textContent = String(state.liveCount);
  elements.cacheCount.textContent = String(state.cacheCount);
}

function renderNetworkFailure(error) {
  state.cacheCount += 1;
  elements.cacheOnlySwitch.checked = true;
  elements.liveCard.classList.remove("is-active");
  elements.cacheCard.classList.add("is-active");
  elements.sourceBadge.textContent = "cache";
  elements.sourceTitle.textContent = "Сеть недоступна";
  elements.cacheTitle.textContent = "Кэш активирован";
  elements.cacheMeta.textContent = "Следующие запросы пойдут без сети";
  elements.liveTitle.textContent = "TLS/сеть отклонены";
  elements.liveMeta.textContent = error.message || "fetch failed";
  elements.cacheCount.textContent = String(state.cacheCount);
  appendLog("error", "network", error.message || "fetch failed");
}

function appendLog(source, title, detail) {
  const row = document.createElement("li");
  const time = document.createElement("time");
  const strong = document.createElement("strong");
  const badge = document.createElement("span");

  time.textContent = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date());
  strong.textContent = `${title} · ${detail}`;
  badge.className = `log-source ${source === "cache" ? "cache" : source === "error" ? "error" : ""}`;
  badge.textContent = source;

  row.append(time, strong, badge);
  elements.requestLog.prepend(row);

  while (elements.requestLog.children.length > 8) {
    elements.requestLog.lastElementChild.remove();
  }
}

function setBusy(value) {
  elements.refreshButton.disabled = value;
  elements.networkButton.disabled = value;
}

function normalizeSource(source) {
  if (source === "cache" || source === "cache-only" || source === "bootstrap-cache") {
    return "cache";
  }
  if (source === "network" || source === "domain") {
    return "network";
  }
  return source || "unknown";
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function messageServiceWorker(message) {
  return new Promise((resolve, reject) => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) {
      reject(new Error("service worker controller is not available"));
      return;
    }

    const channel = new MessageChannel();
    const timeout = setTimeout(() => reject(new Error("service worker message timeout")), 1800);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      resolve(event.data || {});
    };
    controller.postMessage(message, [channel.port2]);
  });
}
