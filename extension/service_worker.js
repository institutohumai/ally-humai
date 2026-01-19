const API_BASE_URL = "http://localhost:8000";
const API_ENDPOINT = `${API_BASE_URL}/candidates`;
const CONFIG_ENDPOINT = `${API_BASE_URL}/config`;
const BADGE_SUCCESS_COLOR = "#2ecc71";
const BADGE_PENDING_COLOR = "#f39c12";
const BADGE_ERROR_COLOR = "#e74c3c";
const SESSION_STORAGE_KEY = "ally:supabase-session";
const PENDING_QUEUE_KEY = "ally:pending-candidates";
const MAX_QUEUE_SIZE = 50;

// Logging helpers for consistent context
const LOG_PREFIX = "[ServiceWorker]";
const log = {
  info: (...args) => console.log(LOG_PREFIX, ...args),
  warn: (...args) => console.warn(LOG_PREFIX, ...args),
  error: (...args) => console.error(LOG_PREFIX, ...args)
};

let cachedConfig = null;
let configPromise = null;
let session = null;
let isProcessingQueue = false;
let lastSentLinkedIn = null;

function isSessionExpired(sess) {
  if (!sess?.expiresAt) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec >= sess.expiresAt;
}

function isSameSession(a, b) {
  if (!a || !b) return false;
  return a.accessToken === b.accessToken && a.userId === b.userId && a.expiresAt === b.expiresAt;
}

async function handleAuthFailure(reason) {
  log.warn("Auth failure → clearing session", { reason });
  session = null;
  invalidateConfigCache();
  try {
    await clearStoredSession();
  } catch (error) {
    log.error("Error clearing stored session after auth failure", String(error));
  }
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(async () => {
  log.info("onInstalled → initializeExtension");
  await initializeExtension();
});

chrome.runtime.onStartup.addListener(async () => {
  log.info("onStartup → initializeExtension");
  await initializeExtension();
});

async function initializeExtension() {
  log.info("initializeExtension: start");
  await loadSessionFromStorage();
  await updateBadge();
  await processPendingQueue();
  log.info("initializeExtension: done");
}

async function updateBadge() {
  const queueSize = await getPendingQueueSize();
  
  if (queueSize > 0) {
    chrome.action.setBadgeText({ text: queueSize.toString() });
    chrome.action.setBadgeBackgroundColor({ color: BADGE_PENDING_COLOR });
    chrome.action.setTitle({ title: `${queueSize} candidato(s) en cola` });
  } else if (session) {
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setBadgeBackgroundColor({ color: BADGE_SUCCESS_COLOR });
    chrome.action.setTitle({ title: "Ally Humai - Activo" });
  } else {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: BADGE_ERROR_COLOR });
    chrome.action.setTitle({ title: "Inicia sesión en Lovable" });
  }
}

async function getPendingQueueSize() {
  return new Promise((resolve) => {
    chrome.storage.local.get([PENDING_QUEUE_KEY], (result) => {
      const queue = result?.[PENDING_QUEUE_KEY] || [];
      resolve(queue.length);
    });
  });
}

async function addToPendingQueue(candidate) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([PENDING_QUEUE_KEY], (result) => {
      let queue = result?.[PENDING_QUEUE_KEY] || [];
      queue.push({
        candidate,
        timestamp: Date.now(),
        retries: 0
      });
      
      // Limitar tamaño de cola
      if (queue.length > MAX_QUEUE_SIZE) {
        queue = queue.slice(-MAX_QUEUE_SIZE);
      }
      
      chrome.storage.local.set({ [PENDING_QUEUE_KEY]: queue }, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          log.error("addToPendingQueue: storage error", err.message || err);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });
}

async function processPendingQueue() {
  if (isProcessingQueue || !session) {
    return;
  }
  
  isProcessingQueue = true;
  
  try {
    const queue = await new Promise((resolve) => {
      chrome.storage.local.get([PENDING_QUEUE_KEY], (result) => {
        resolve(result?.[PENDING_QUEUE_KEY] || []);
      });
    });
    
    if (queue.length === 0) {
      isProcessingQueue = false;
      await updateBadge();
      return;
    }
    
    log.info("processPendingQueue: start", { count: queue.length });
    
    const successfulIndices = [];
    
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      try {
        await postCandidate(item.candidate);
        successfulIndices.push(i);
        log.info("Queued candidate sent", { name: item.candidate?.name });
      } catch (error) {
        log.warn("Error sending queued candidate", { name: item.candidate?.name, error: String(error) });
        item.retries = (item.retries || 0) + 1;
        
        // Eliminar después de 3 reintentos
        if (item.retries >= 3) {
          successfulIndices.push(i);
          log.error("Candidate dropped after 3 retries", { name: item.candidate?.name });
        }
      }
    }
    
    // Remover candidatos exitosos de la cola
    if (successfulIndices.length > 0) {
      const newQueue = queue.filter((_, index) => !successfulIndices.includes(index));
      await new Promise((resolve) => {
        chrome.storage.local.set({ [PENDING_QUEUE_KEY]: newQueue }, resolve);
      });
    }
    
  } finally {
    isProcessingQueue = false;
    await updateBadge();
  }
}

async function loadSessionFromStorage() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([SESSION_STORAGE_KEY], (result) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        log.error("loadSessionFromStorage: error", lastError.message || lastError);
        reject(lastError);
        return;
      }
      const stored = result?.[SESSION_STORAGE_KEY] || null;
      if (stored && stored.accessToken && stored.userId) {
        if (isSessionExpired(stored)) {
          log.warn("loadSessionFromStorage: expired session, clearing", { userId: stored.userId });
          chrome.storage.local.remove([SESSION_STORAGE_KEY], () => {
            session = null;
            resolve(null);
          });
          return;
        }
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
        log.error("persistSession: error", lastError.message || lastError);
        reject(lastError);
      } else {
        log.info("persistSession: stored", { userId: newSession?.userId });
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
        log.error("clearStoredSession: error", lastError.message || lastError);
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
  log.info("Config cache invalidated");
}

async function ensureSession() {
  // Siempre intenta cargar la sesión desde el storage, incluso si session está en memoria
  const stored = await loadSessionFromStorage();
  if (stored && stored.accessToken && stored.userId) {
    if (isSessionExpired(stored)) {
      log.warn("ensureSession: session expired");
      await handleAuthFailure("session expired");
      throw new Error("Sesión de Supabase expirada");
    }
    return stored;
  }
  log.warn("ensureSession: missing Supabase session");
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
          if (response.status === 401 || response.status === 403) {
            await handleAuthFailure(`config ${response.status}`);
          }
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
        log.warn("ensureBridgeConfig: failed", String(error));
        invalidateConfigCache();
        throw error;
      });
  }

  return configPromise;
}

async function postCandidate(payload) {
  log.info("postCandidate: sending", { name: payload?.name, linkedin_url: payload?.linkedin_url });
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
    if (response.status === 401 || response.status === 403) {
      await handleAuthFailure(`candidates ${response.status}`);
    }
    log.warn("postCandidate: bridge error", { status: response.status, detail });
    throw new Error(detail || `status ${response.status}`);
  }
  log.info("postCandidate: candidate sent");

  // Record last sent LinkedIn URL to prevent immediate duplicates
  if (payload?.linkedin_url) {
    lastSentLinkedIn = payload.linkedin_url;
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
        const newSession = { accessToken, refreshToken, userId, expiresAt };
        if (isSessionExpired(newSession)) {
          log.warn("Session update ignored: expired", { userId });
          sendResponse({ ok: false, detail: "Sesión expirada" });
          return;
        }

        if (isSameSession(newSession, session)) {
          sendResponse({ ok: true, unchanged: true });
          return;
        }

        log.info("Session update received", { hasAccessToken: Boolean(accessToken), userId });
        session = newSession;
        await persistSession(session);
        invalidateConfigCache();
        await updateBadge();
        await processPendingQueue();
        sendResponse({ ok: true });
      } catch (error) {
        log.error("Session update invalid", String(error));
        sendResponse({ ok: false, detail: String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "ALLY_CLEAR_SESSION") {
    (async () => {
      try {
        log.info("Session clearing requested");
        session = null;
        invalidateConfigCache();
        await clearStoredSession();
        await updateBadge();
        sendResponse({ ok: true });
      } catch (error) {
        log.error("Error clearing session", String(error));
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
      log.info("Candidate received", { name: message.payload?.name, linkedin_url: message.payload?.linkedin_url });

      // Deduplicate immediate repeats by linkedin_url
      if (message.payload?.linkedin_url && message.payload.linkedin_url === lastSentLinkedIn) {
        log.info("Candidate skipped (duplicate linkedin_url)", { linkedin_url: message.payload.linkedin_url });
        sendResponse({ ok: true, skipped: true, reason: "duplicate_linkedin_url" });
        return;
      }
      
      // Intentar enviar inmediatamente si hay sesión
      if (session) {
        try {
          await postCandidate(message.payload);
          await updateBadge();
          log.info("Candidate sent immediately");
          sendResponse({ ok: true, sent: true });
          return;
        } catch (error) {
          log.warn("Immediate send failed, queuing", { error: error.message });
          // Si falla, agregar a cola
        }
      }
      
      // Si no hay sesión o falló el envío, agregar a cola
      await addToPendingQueue(message.payload);
      await updateBadge();
      log.info("Candidate queued for later send");
      sendResponse({ ok: true, queued: true });
      
    } catch (error) {
      log.error("Error processing candidate", String(error));
      const detail = error instanceof Error ? error.message : String(error);
      sendResponse({ ok: false, detail });
    }
  })();

  return true;
});
