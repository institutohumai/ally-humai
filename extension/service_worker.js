const API_BASE_URL = "http://localhost:8000";
const API_ENDPOINT = `${API_BASE_URL}/candidates`;
const CONFIG_ENDPOINT = `${API_BASE_URL}/config`;
const BADGE_ALERT_COLOR = "#f39c12";
const BADGE_CLEAR_COLOR = "#2ecc71";
const SESSION_STORAGE_KEY = "ally:supabase-session";

let cachedConfig = null;
let configPromise = null;
let session = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setBadgeBackgroundColor({ color: BADGE_CLEAR_COLOR });
  loadSessionFromStorage().catch(() => {
    session = null;
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setBadgeBackgroundColor({ color: BADGE_CLEAR_COLOR });
  loadSessionFromStorage().catch(() => {
    session = null;
  });
});

async function loadSessionFromStorage() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([SESSION_STORAGE_KEY], (result) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(lastError);
        return;
      }
      const stored = result?.[SESSION_STORAGE_KEY] || null;
      if (stored && stored.accessToken && stored.userId) {
        session = stored;
        resolve(stored);
        return;
      }
      session = null;
      resolve(null);
    });
  });
}

async function persistSession(newSession) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [SESSION_STORAGE_KEY]: newSession }, () => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(lastError);
      } else {
        resolve();
      }
    });
  });
}

async function clearStoredSession() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove([SESSION_STORAGE_KEY], () => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(lastError);
      } else {
        resolve();
      }
    });
  });
}

function invalidateConfigCache() {
  cachedConfig = null;
  configPromise = null;
}

async function ensureSession() {
  // Siempre intenta cargar la sesión desde el storage, incluso si session está en memoria
  const stored = await loadSessionFromStorage();
  if (stored && stored.accessToken && stored.userId) {
    return stored;
  }
  throw new Error("Sesión de Supabase no configurada");
}

async function ensureBridgeConfig() {
  const currentSession = await ensureSession();

  if (cachedConfig) {
    return cachedConfig;
  }

  if (!configPromise) {
    const headers = {
      Authorization: `Bearer ${currentSession.accessToken}`
    };
    if (currentSession.userId) {
      headers["X-Ally-User-Id"] = currentSession.userId;
    }

    configPromise = fetch(CONFIG_ENDPOINT, {
      method: "GET",
      headers
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`config status ${response.status}`);
        }
        const data = await response.json();
        if (!data?.agency_id) {
          throw new Error("config missing agency_id");
        }
        cachedConfig = data;
        return cachedConfig;
      })
      .catch((error) => {
        invalidateConfigCache();
        throw error;
      });
  }

  return configPromise;
}

async function postCandidate(payload) {
  const [config, currentSession] = await Promise.all([
    ensureBridgeConfig(),
    ensureSession()
  ]);

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${currentSession.accessToken}`,
    "X-Ally-Agency-ID": config.agency_id
  };

  if (currentSession.userId) {
    headers["X-Ally-User-Id"] = currentSession.userId;
  }

  const response = await fetch(API_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `status ${response.status}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ALLY_SUPABASE_SESSION") {
    (async () => {
      try {
        const { accessToken, refreshToken, userId, expiresAt } = message.payload || {};
        if (!accessToken || !userId) {
          throw new Error("Faltan accessToken o userId");
        }
        session = { accessToken, refreshToken, userId, expiresAt };
        await persistSession(session);
        invalidateConfigCache();
        chrome.action.setBadgeText({ text: "" });
        chrome.action.setBadgeBackgroundColor({ color: BADGE_CLEAR_COLOR });
        sendResponse({ ok: true });
      } catch (error) {
        console.error("Ally Humai sesión inválida", error);
        sendResponse({ ok: false, detail: String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "ALLY_CLEAR_SESSION") {
    (async () => {
      try {
        session = null;
        invalidateConfigCache();
        await clearStoredSession();
        sendResponse({ ok: true });
      } catch (error) {
        console.error("Ally Humai error al limpiar sesión", error);
        sendResponse({ ok: false, detail: String(error) });
      }
    })();
    return true;
  }

  if (message?.type !== "ALLY_CANDIDATE") {
    return;
  }

  (async () => {
    try {
      await postCandidate(message.payload);
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setBadgeBackgroundColor({ color: BADGE_CLEAR_COLOR });
      sendResponse({ ok: true });
    } catch (error) {
      invalidateConfigCache();
      console.warn("Ally Humai bridge rejected candidate", error);
      chrome.action.setBadgeBackgroundColor({ color: BADGE_ALERT_COLOR });
      chrome.action.setBadgeText({ text: "!" });
      const detail = error instanceof Error ? error.message : String(error);
      sendResponse({ ok: false, detail });
    }
  })();

  return true;
});
