const DIAG_KEY = "telegramDiagnostics";
const MAX_DIAG_ENTRIES = 60;
const MEDIA_DIAG_KEY = "mediaDiagnostics";
const MAX_MEDIA_ENTRIES = 80;

const REQUEST_HEADER_ALLOWLIST = new Set([
  "range",
  "referer",
  "origin",
  "accept",
  "accept-encoding",
  "accept-language",
  "user-agent",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest"
]);

const RESPONSE_HEADER_ALLOWLIST = new Set([
  "content-range",
  "content-length",
  "content-type",
  "accept-ranges",
  "cache-control",
  "date",
  "server"
]);

const pendingRequests = new Map();
const pendingMediaRequests = new Map();
let writeQueue = Promise.resolve();

const storageGet = (key) =>
  new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(result);
    });
  });

const storageSet = (value) =>
  new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve();
    });
  });

const trimEntries = (entries, maxEntries = MAX_DIAG_ENTRIES) => {
  if (entries.length <= maxEntries) return entries;
  return entries.slice(0, maxEntries);
};

const headerListHas = (headers, name) => {
  if (!Array.isArray(headers)) return false;
  const target = name.toLowerCase();
  return headers.some((header) => header?.name?.toLowerCase() === target);
};

const headerListToObject = (headers, allowlist) => {
  const out = {};
  if (!Array.isArray(headers)) return out;
  headers.forEach((header) => {
    if (!header?.name) return;
    const key = header.name.toLowerCase();
    if (!allowlist.has(key)) return;
    out[key] = header.value || "";
  });
  return out;
};

const appendEntry = (entry, key = DIAG_KEY, maxEntries = MAX_DIAG_ENTRIES) => {
  writeQueue = writeQueue
    .then(async () => {
      const current = await storageGet(key);
      const entries = Array.isArray(current[key]) ? current[key] : [];
      entries.unshift(entry);
      await storageSet({ [key]: trimEntries(entries, maxEntries) });
    })
    .catch((err) => {
      console.warn("Diagnostics append failed", err);
    });
  return writeQueue;
};

const buildRequestInfo = (details) => {
  const headers = headerListToObject(details.requestHeaders, REQUEST_HEADER_ALLOWLIST);
  return {
    headers,
    hasCookie: headerListHas(details.requestHeaders, "cookie")
  };
};

const buildResponseInfo = (details) => ({
  statusCode: details.statusCode ?? null,
  statusLine: details.statusLine || null,
  fromCache: !!details.fromCache,
  headers: headerListToObject(details.responseHeaders, RESPONSE_HEADER_ALLOWLIST)
});

const buildBaseEntry = (details, phase, scope) => {
  const entry = {
    id: details.requestId || `req-${Date.now()}`,
    time: Date.now(),
    source: "webRequest",
    phase,
    url: details.url,
    method: details.method || "GET",
    type: details.type || null,
    tabId: Number.isFinite(details.tabId) ? details.tabId : null,
    initiator: details.initiator || details.documentUrl || details.originUrl || null
  };
  if (scope) {
    entry.scope = scope;
  }
  return entry;
};

export const recordTelegramRequest = (details) => {
  try {
    const entry = {
      ...buildBaseEntry(details, "request"),
      request: buildRequestInfo(details)
    };
    pendingRequests.set(details.requestId, entry);
  } catch (err) {
    console.warn("Diagnostics request record failed", err);
  }
};

export const recordTelegramResponse = (details) => {
  try {
    const existing = pendingRequests.get(details.requestId);
    const response = buildResponseInfo(details);
    if (existing) {
      pendingRequests.delete(details.requestId);
      appendEntry({
        ...existing,
        phase: "request+response",
        response,
        responseTime: Date.now()
      });
      return;
    }
    appendEntry({
      ...buildBaseEntry(details, "response"),
      response
    });
  } catch (err) {
    console.warn("Diagnostics response record failed", err);
  }
};

export const recordMediaRequest = (details, meta = {}) => {
  try {
    const entry = {
      ...buildBaseEntry(details, "request", "media"),
      request: buildRequestInfo(details)
    };
    if (meta.note) entry.note = meta.note;
    pendingMediaRequests.set(details.requestId, entry);
  } catch (err) {
    console.warn("Media diagnostics request record failed", err);
  }
};

export const recordMediaResponse = (details, meta = {}) => {
  try {
    const existing = pendingMediaRequests.get(details.requestId);
    const response = buildResponseInfo(details);
    const entry = existing
      ? {
          ...existing,
          phase: "request+response",
          response,
          responseTime: Date.now()
        }
      : {
          ...buildBaseEntry(details, "response", "media"),
          response
        };
    if (existing) {
      pendingMediaRequests.delete(details.requestId);
    }
    if (meta.note) entry.note = meta.note;
    appendEntry(entry, MEDIA_DIAG_KEY, MAX_MEDIA_ENTRIES);
  } catch (err) {
    console.warn("Media diagnostics response record failed", err);
  }
};

export const recordMediaFetch = (payload) => {
  const entry = {
    id: `fetch-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    time: Date.now(),
    source: "extension-fetch",
    phase: "fetch",
    url: payload.url,
    method: payload.method || "GET",
    scope: "media",
    request: {
      headers: payload.range ? { range: payload.range } : {},
      referrer: payload.referrer || null
    },
    response: {
      statusCode: payload.status ?? null,
      headers: {
        "content-type": payload.contentType || "",
        "content-length": payload.contentLength || ""
      }
    },
    error: payload.error || null,
    note: payload.note || null,
    detail: payload.detail || null
  };
  appendEntry(entry, MEDIA_DIAG_KEY, MAX_MEDIA_ENTRIES);
};

export const recordTelegramFetch = (payload) => {
  const entry = {
    id: `fetch-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    time: Date.now(),
    source: "extension-fetch",
    phase: "fetch",
    url: payload.url,
    method: "GET",
    request: {
      headers: payload.range ? { range: payload.range } : {},
      referrer: payload.referrer || null
    },
    response: {
      statusCode: payload.status ?? null,
      headers: {
        "content-range": payload.contentRange || "",
        "content-type": payload.contentType || "",
        "content-length": payload.contentLength || ""
      }
    },
    error: payload.error || null,
    note: payload.note || null
  };
  appendEntry(entry);
};

export const clearTelegramDiagnostics = async () => {
  await storageSet({ [DIAG_KEY]: [] });
};

export const clearMediaDiagnostics = async () => {
  await storageSet({ [MEDIA_DIAG_KEY]: [] });
};

const formatHeaderBlock = (headers) => {
  const keys = Object.keys(headers || {});
  if (!keys.length) return "  (none)";
  return keys
    .sort()
    .map((key) => `  ${key}: ${headers[key]}`)
    .join("\n");
};

const formatEntry = (entry, index) => {
  const lines = [];
  const time = entry.time ? new Date(entry.time).toISOString() : "unknown";
  lines.push(`#${index + 1} ${time} source=${entry.source} phase=${entry.phase}`);
  lines.push(`url: ${entry.url}`);
  if (entry.method) lines.push(`method: ${entry.method}`);
  if (entry.type) lines.push(`type: ${entry.type}`);
  if (entry.scope) lines.push(`scope: ${entry.scope}`);
  if (entry.tabId !== null) lines.push(`tabId: ${entry.tabId}`);
  if (entry.initiator) lines.push(`initiator: ${entry.initiator}`);
  if (entry.request) {
    lines.push("request headers:");
    lines.push(formatHeaderBlock(entry.request.headers || {}));
    if (entry.request.hasCookie !== undefined) {
      lines.push(`  has-cookie: ${entry.request.hasCookie}`);
    }
    if (entry.request.referrer) {
      lines.push(`  referrer: ${entry.request.referrer}`);
    }
  }
  if (entry.response) {
    if (entry.response.statusCode !== null && entry.response.statusCode !== undefined) {
      lines.push(`status: ${entry.response.statusCode}`);
    }
    if (entry.response.statusLine) {
      lines.push(`status-line: ${entry.response.statusLine}`);
    }
    lines.push("response headers:");
    lines.push(formatHeaderBlock(entry.response.headers || {}));
  }
  if (entry.error) {
    lines.push(`error: ${entry.error}`);
  }
  if (entry.note) {
    lines.push(`note: ${entry.note}`);
  }
  if (entry.detail) {
    lines.push("detail:");
    String(entry.detail)
      .split("\n")
      .forEach((line) => lines.push(`  ${line}`));
  }
  return lines.join("\n");
};

export const getTelegramDiagnosticsText = async () => {
  const data = await storageGet(DIAG_KEY);
  const entries = Array.isArray(data[DIAG_KEY]) ? data[DIAG_KEY] : [];
  const manifest = chrome.runtime.getManifest();
  const lines = [];
  lines.push("Telegram diagnostics");
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push(`extension: ${manifest.name} ${manifest.version}`);
  if (self?.navigator?.userAgent) {
    lines.push(`user-agent: ${self.navigator.userAgent}`);
  }
  lines.push(`entries: ${entries.length}`);
  lines.push("");
  entries.forEach((entry, index) => {
    lines.push(formatEntry(entry, index));
    lines.push("");
  });
  return lines.join("\n").trim();
};

export const getMediaDiagnosticsText = async () => {
  const data = await storageGet(MEDIA_DIAG_KEY);
  const entries = Array.isArray(data[MEDIA_DIAG_KEY]) ? data[MEDIA_DIAG_KEY] : [];
  const manifest = chrome.runtime.getManifest();
  const lines = [];
  lines.push("Media diagnostics");
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push(`extension: ${manifest.name} ${manifest.version}`);
  if (self?.navigator?.userAgent) {
    lines.push(`user-agent: ${self.navigator.userAgent}`);
  }
  lines.push(`entries: ${entries.length}`);
  lines.push("");
  entries.forEach((entry, index) => {
    lines.push(formatEntry(entry, index));
    lines.push("");
  });
  return lines.join("\n").trim();
};
