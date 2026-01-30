// === ALLY HUMAI - Service Worker (Stateless & Agency Identity) ===

// Configuración API
// LOCAL:
// const API_BASE_URL = "http://localhost:8000";
// AWS:
const API_BASE_URL = "https://vlux2ct9zi.execute-api.us-east-2.amazonaws.com";
const API_ENDPOINT = `${API_BASE_URL}/candidates`;

// Configuración Visual
const BADGE_SUCCESS_COLOR = "#2ecc71";
const BADGE_PENDING_COLOR = "#f39c12";
const BADGE_ERROR_COLOR = "#e74c3c";
const SESSION_STORAGE_KEY = "ally:supabase-session";
const PENDING_QUEUE_KEY = "ally:pending-candidates";
const MAX_QUEUE_SIZE = 50;

// Logging helpers
const LOG_PREFIX = "[Ally]";
const log = {
  info: (...args) => console.log(LOG_PREFIX, ...args),
  warn: (...args) => console.warn(LOG_PREFIX, ...args),
  error: (...args) => console.error(LOG_PREFIX, ...args),
};

// Estado en memoria
let session = null;
let isProcessingQueue = false;
let lastSentLinkedIn = null;

// Añadir fuente
function withSource(payload) {
  return { ...payload, source: "linkedin_extension" };
}

// --- COMUNICACIÓN CON PESTAÑAS ---

function broadcastToTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, message, () => {
        if (chrome.runtime.lastError) return;
      });
    });
  });
}

function notifySessionCleared() {
  broadcastToTabs({ type: "ALLY_SESSION_CLEARED" });
}

function notifyBridgeError(detail) {
  broadcastToTabs({ type: "ALLY_BRIDGE_ERROR", detail });
}

// --- INYECCIÓN DE SCRIPTS ---

function reinjectLovableContentScripts() {
  const lovableUrls = [
    "https://preview--grow-agency-pro.lovable.app/*",
    "https://grow-agency-pro.lovable.app/*",
  ];
  chrome.tabs.query({ url: lovableUrls }, (tabs) => {
    tabs.forEach((tab) => {
      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id, allFrames: true },
          files: ["content-script-lovable.js"],
        },
        () => {
          if (chrome.runtime.lastError) {
            /* Silenciar error */
          }
        },
      );
    });
  });
}

function reinjectLinkedInContentScripts() {
  const linkedinUrls = ["https://www.linkedin.com/*", "https://linkedin.com/*"];
  chrome.tabs.query({ url: linkedinUrls }, (tabs) => {
    tabs.forEach((tab) => {
      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id, allFrames: true },
          files: ["content-script-linkedin.js"],
        },
        () => {
          if (chrome.runtime.lastError) {
            /* Silenciar error */
          }
        },
      );
    });
  });
}

// --- GESTIÓN DE SESIÓN ---

function isSessionExpired(sess) {
  if (!sess?.expiresAt) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec >= sess.expiresAt;
}

function isSameSession(a, b) {
  if (!a || !b) return false;
  // Comparamos también agencyId para detectar cambios de organización
  return (
    a.accessToken === b.accessToken &&
    a.userId === b.userId &&
    a.agencyId === b.agencyId
  );
}

async function handleAuthFailure(reason) {
  log.warn("Sesión inválida, cerrando:", reason);
  session = null;

  try {
    await clearStoredSession();
  } catch (error) {
    log.error("Error limpiando storage", error);
  }

  await updateBadge();
  notifySessionCleared();
}

// --- ALMACENAMIENTO ---

async function loadSessionFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get([SESSION_STORAGE_KEY], (result) => {
      const stored = result?.[SESSION_STORAGE_KEY];
      if (stored && isSessionExpired(stored)) {
        handleAuthFailure("expired_on_load");
        resolve(null);
      } else {
        session = stored || null;
        resolve(session);
      }
    });
  });
}

async function persistSession(newSession) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SESSION_STORAGE_KEY]: newSession }, resolve);
  });
}

async function clearStoredSession() {
  return new Promise((resolve) => {
    chrome.storage.local.remove([SESSION_STORAGE_KEY], resolve);
  });
}

// --- COLA DE CANDIDATOS ---

async function getPendingQueueSize() {
  return new Promise((resolve) => {
    chrome.storage.local.get([PENDING_QUEUE_KEY], (result) => {
      resolve((result?.[PENDING_QUEUE_KEY] || []).length);
    });
  });
}

async function addToPendingQueue(candidate) {
  return new Promise((resolve) => {
    chrome.storage.local.get([PENDING_QUEUE_KEY], (result) => {
      let queue = result?.[PENDING_QUEUE_KEY] || [];

      // Evitar duplicados exactos en cola
      if (
        !queue.some((i) => i.candidate.linkedin_url === candidate.linkedin_url)
      ) {
        queue.push({ candidate, timestamp: Date.now(), retries: 0 });
      }

      if (queue.length > MAX_QUEUE_SIZE) queue = queue.slice(-MAX_QUEUE_SIZE);

      chrome.storage.local.set({ [PENDING_QUEUE_KEY]: queue }, resolve);
    });
  });
}

async function processPendingQueue() {
  if (isProcessingQueue || !session) return;
  isProcessingQueue = true;

  try {
    const queue = await new Promise((resolve) =>
      chrome.storage.local.get([PENDING_QUEUE_KEY], (r) =>
        resolve(r?.[PENDING_QUEUE_KEY] || []),
      ),
    );

    if (queue.length === 0) return;
    log.info(`Procesando cola (${queue.length} items)...`);

    const successfulIndices = [];
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      try {
        await postCandidate(item.candidate);
        successfulIndices.push(i);
        log.info("Item de cola enviado:", item.candidate.name);
      } catch (error) {
        log.warn("Fallo reintento de cola:", error.message);
        item.retries = (item.retries || 0) + 1;
        if (item.retries >= 3) {
          successfulIndices.push(i); // Descartar si falla 3 veces
          log.error(
            "Descartando candidato por fallos reiterados:",
            item.candidate.name,
          );
        }
      }
    }

    const newQueue = queue.filter(
      (_, index) => !successfulIndices.includes(index),
    );
    await new Promise((resolve) =>
      chrome.storage.local.set({ [PENDING_QUEUE_KEY]: newQueue }, resolve),
    );
  } finally {
    isProcessingQueue = false;
    await updateBadge();
  }
}

// --- CICLO DE VIDA ---

chrome.runtime.onInstalled.addListener(async () => {
  log.info("Extensión instalada.");
  await initializeExtension();
  reinjectLovableContentScripts();
  reinjectLinkedInContentScripts();
});

chrome.runtime.onStartup.addListener(async () => {
  log.info("Chrome iniciado.");
  await initializeExtension();
});

async function initializeExtension() {
  await loadSessionFromStorage();
  await updateBadge();
  await processPendingQueue();
}

async function updateBadge() {
  const queueSize = await getPendingQueueSize();

  if (queueSize > 0) {
    chrome.action.setBadgeText({ text: queueSize.toString() });
    chrome.action.setBadgeBackgroundColor({ color: BADGE_PENDING_COLOR });
    chrome.action.setTitle({ title: `${queueSize} en cola` });
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

// --- API POST (FIX PRINCIPAL) ---

async function postCandidate(payload) {
  // Aseguramos tener la sesión más reciente
  const currentSession = session || (await loadSessionFromStorage());

  if (!currentSession) throw new Error("No hay sesión activa");

  // AQUÍ ES DONDE PASAMOS LOS HEADERS DE IDENTIDAD
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${currentSession.accessToken}`,
  };

  // Inyectamos los IDs para el Bridge Server -> Supabase
  if (currentSession.userId) headers["X-Ally-User-Id"] = currentSession.userId;
  if (currentSession.agencyId)
    headers["X-Ally-Agency-Id"] = currentSession.agencyId;

  // Verificamos antes de enviar (útil para debug)
  if (!currentSession.agencyId) {
    log.warn(
      "Enviando candidato SIN Agency ID (puede fallar si Supabase lo requiere)",
    );
  }

  try {
    const response = await fetch(API_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(withSource(payload)),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        await handleAuthFailure(`api_${response.status}`);
      }
      const text = await response.text();
      // Pasamos el mensaje de error para mostrarlo
      throw new Error(text || `Error ${response.status}`);
    }

    if (payload?.linkedin_url) lastSentLinkedIn = payload.linkedin_url;
    log.info("Candidato enviado OK", { candidato: payload }); // Log detallado del candidato
  } catch (error) {
    log.error("Fallo de red:", error.message);
    notifyBridgeError(error.message); // Notificar al usuario
    throw error;
  }
}

// --- MESSAGE LISTENERS ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 1. PING (Estado para Lovable)
  if (message?.type === "ALLY_PING") {
    (async () => {
      // Obtenemos snapshot fresco
      const stored = await loadSessionFromStorage();
      const active = !!stored && !isSessionExpired(stored);
      sendResponse({
        ok: true,
        active,
        userId: stored?.userId || null,
      });
    })();
    return true;
  }

  // 2. RECIBIR SESIÓN (Desde content script Lovable)
  if (message?.type === "ALLY_SUPABASE_SESSION") {
    (async () => {
      try {
        const { accessToken, refreshToken, userId, expiresAt, agencyId } =
          message.payload || {};

        if (!accessToken || !userId) {
          throw new Error("Datos de sesión incompletos");
        }
        console.log("accessToken:", accessToken);
        const newSession = {
          accessToken,
          refreshToken,
          userId,
          expiresAt,
          agencyId,
        };

        if (isSessionExpired(newSession)) {
          log.warn("Intento de login con token expirado");
          sendResponse({ ok: false, detail: "Token expirado" });
          return;
        }

        if (!isSameSession(newSession, session)) {
          log.info("Guardando sesión. Usuario:", userId, "Agencia:", agencyId);
          session = newSession;
          await persistSession(session);
          await updateBadge();
          await processPendingQueue();
        }

        sendResponse({ ok: true });
      } catch (error) {
        log.error("Error procesando sesión:", error.message);
        sendResponse({ ok: false, detail: error.message });
      }
    })();
    return true;
  }

  // 3. LOGOUT
  if (message?.type === "ALLY_CLEAR_SESSION") {
    handleAuthFailure("user_logout");
    sendResponse({ ok: true });
    return true;
  }

  // 4. RECIBIR CANDIDATO (Desde content script LinkedIn)
  if (message?.type === "ALLY_CANDIDATE") {
    (async () => {
      // Anti-rebote simple
      if (
        message.payload?.linkedin_url &&
        message.payload.linkedin_url === lastSentLinkedIn
      ) {
        return sendResponse({ ok: true, skipped: true });
      }

      const payload = message.payload;

      // Si hay sesión, intentamos envío directo
      if (session && !isSessionExpired(session)) {
        try {
          await postCandidate(payload);
          log.info("[Ally] Candidato enviado OK", { candidato: payload }); // Log detallado del candidato
          await updateBadge();
          sendResponse({ ok: true, sent: true });
          return;
        } catch (e) {
          // Fallo silencioso, cae al encolado
        }
      } else {
        log.info("Sin sesión o fallo de red, encolando...", {
          candidato: payload,
        }); // Log detallado al encolar
      }

      // Encolar
      await addToPendingQueue(payload);
      await updateBadge();
      sendResponse({ ok: true, queued: true });
    })();
    return true;
  }
});
