// === ALLY HUMAI - Service Worker (Final: Sleep Mode, No-Queue & Auto-Logout) ===

// Configuración API
// LOCAL:
// const API_BASE_URL = "http://localhost:8000";
// AWS (Cambiar para producción):
const API_BASE_URL = "https://vlux2ct9zi.execute-api.us-east-2.amazonaws.com";

const API_ENDPOINT = `${API_BASE_URL}/candidates`;

// Configuración Visual
const BADGE_SUCCESS_COLOR = "#2ecc71"; // Verde
const BADGE_ERROR_COLOR = "#e74c3c"; // Rojo
const SESSION_STORAGE_KEY = "ally:supabase-session";

// Configuración de Seguridad (Cinderella Protocol)
const AUTO_LOGOUT_DELAY = 10 * 60 * 1000; // 10 minutos
let logoutTimer = null;

// Logging helpers
const LOG_PREFIX = "[Ally SW]";
const log = {
  info: (...args) => console.log(LOG_PREFIX, ...args),
  warn: (...args) => console.warn(LOG_PREFIX, ...args),
  error: (...args) => console.error(LOG_PREFIX, ...args),
};

// Estado en memoria
let session = null;
let lastSentLinkedIn = null;

// Añadir fuente
function withSource(payload) {
  return { ...payload, source: "linkedin_extension" };
}

// --- GESTIÓN DE TIMEOUT (SEGURIDAD) ---

function resetInactivityTimer() {
  if (logoutTimer) clearTimeout(logoutTimer);

  // Solo iniciamos el timer si hay una sesión activa
  if (session) {
    // log.info("Reiniciando timer de inactividad (30 min)");
    logoutTimer = setTimeout(() => {
      handleAuthFailure("inactivity_timeout");
    }, AUTO_LOGOUT_DELAY);
  }
}

// --- COMUNICACIÓN CON PESTAÑAS ---

function broadcastToTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
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
  return (
    a.accessToken === b.accessToken &&
    a.userId === b.userId &&
    a.agencyId === b.agencyId
  );
}

// ESTA FUNCIÓN ES CLAVE PARA EL SLEEP MODE Y AUTO-LOGOUT
async function handleAuthFailure(reason) {
  session = null;
  if (logoutTimer) clearTimeout(logoutTimer); // Limpiar timer

  // 1. Borramos datos
  try {
    await chrome.storage.local.remove([SESSION_STORAGE_KEY]);
  } catch (error) {}

  await updateBadge();
  notifySessionCleared();

  // 2. ORDENAMOS A LINKEDIN QUE SE DETENGA (Sleep Mode)
  broadcastToTabs({ type: "ALLY_STOP_SCRAPING" });
  log.info("Cerrando sesión:", reason);
}

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

// --- BADGE ---
async function updateBadge() {
  if (session) {
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: BADGE_SUCCESS_COLOR });
    chrome.action.setTitle({ title: "Ally - Activo" });
  } else {
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: BADGE_ERROR_COLOR });
    chrome.action.setTitle({ title: "Desconectado" });
  }
}

// --- API POST (SIN COLA) ---

async function postCandidate(payload, tabId = null) {
  const currentSession = session || (await loadSessionFromStorage());

  if (!currentSession) throw new Error("No hay sesión activa");

  // >>> ACTIVIDAD DETECTADA: Reiniciamos el reloj de 30 minutos <<<
  resetInactivityTimer();

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${currentSession.accessToken}`,
  };

  if (currentSession.userId) headers["X-Ally-User-Id"] = currentSession.userId;
  if (currentSession.agencyId)
    headers["X-Ally-Agency-Id"] = currentSession.agencyId;

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
      // Si falla (ej: 429), lanzamos error para descartar candidato
      throw new Error(text || `Error ${response.status}`);
    }

    const responseJson = await response.json();
    const aiData = responseJson.data || {};

    if (payload?.linkedin_url) lastSentLinkedIn = payload.linkedin_url;
    log.info("Candidato procesado OK");

    // Feedback de éxito a la UI de LinkedIn
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: "ALLY_SUCCESS_NOTIFICATION",
        data: aiData,
      });
    }

    return aiData;
  } catch (error) {
    log.error("Fallo de envío (Candidato descartado):", error.message);
    notifyBridgeError(error.message);
    throw error;
  }
}

// --- CICLO DE VIDA ---

// Se ejecuta cuando el usuario abre Chrome
chrome.runtime.onStartup.addListener(async () => {
  log.info(
    "Chrome iniciado. Limpiando sesión por seguridad (Protocolo Cenicienta).",
  );
  // FORZAMOS EL APAGADO AL INICIO DEL NAVEGADOR
  await chrome.storage.local.remove([SESSION_STORAGE_KEY]);
  session = null;
  await updateBadge();
});

chrome.runtime.onInstalled.addListener(async () => {
  log.info("Ally Instalada.");
  await loadSessionFromStorage();
  await updateBadge();
  reinjectLovableContentScripts();
  reinjectLinkedInContentScripts();
});

// --- SEGURIDAD: Auto-apagado si se cierran todas las pestañas de Lovable ---
const LOVABLE_PATTERNS = [
  "preview--grow-agency-pro.lovable.app",
  "grow-agency-pro.lovable.app",
];

function isLovableTab(tab) {
  if (!tab?.url) return false;
  return LOVABLE_PATTERNS.some((pattern) => tab.url.includes(pattern));
}

async function checkLovableTabsExist() {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      const hasLovable = tabs.some(isLovableTab);
      resolve(hasLovable);
    });
  });
}

// Cuando se cierra una pestaña, verificamos si era de Lovable
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  // Solo verificamos si hay sesión activa
  if (!session) return;

  // Pequeño delay para permitir que Chrome actualice la lista de tabs
  setTimeout(async () => {
    const lovableStillOpen = await checkLovableTabsExist();
    if (!lovableStillOpen) {
      log.info("Todas las pestañas de Lovable cerradas. Desactivando extensión por seguridad.");
      await handleAuthFailure("lovable_tabs_closed");
    }
  }, 500);
});

// --- MESSAGE LISTENERS (EL CORAZÓN DEL SISTEMA) ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 1. PING (Usado por el Interruptor de Lovable)
  if (message?.type === "ALLY_PING") {
    (async () => {
      const stored = await loadSessionFromStorage();
      const active = !!stored && !isSessionExpired(stored);
      // Respondemos con la verdad
      sendResponse({ ok: true, active, userId: stored?.userId || null });
    })();
    return true;
  }

  // 2. SESIÓN UPDATE (Cuando prendes el interruptor)
  if (message?.type === "ALLY_SUPABASE_SESSION") {
    (async () => {
      try {
        const { accessToken, refreshToken, userId, expiresAt, agencyId } =
          message.payload || {};

        const newSession = {
          accessToken,
          refreshToken,
          userId,
          expiresAt,
          agencyId,
        };

        // Si cambia la sesión o reconecta
        session = newSession;
        log.info("Sesión de Lovable cargada", {
          userId,
          agencyId,
          expiresAt,
        });
        await persistSession(session);
        resetInactivityTimer(); // <--- ARRANCAR RELOJ AL CONECTAR
        await updateBadge();

        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, detail: error.message });
      }
    })();
    return true;
  }

  // 3. LOGOUT (Cuando apagas el interruptor)
  if (message?.type === "ALLY_CLEAR_SESSION") {
    handleAuthFailure("user_logout");
    sendResponse({ ok: true });
    return true;
  }

  // 4. CANDIDATO (Desde LinkedIn)
  if (message?.type === "ALLY_CANDIDATE") {
    (async () => {
      if (
        message.payload?.linkedin_url &&
        message.payload.linkedin_url === lastSentLinkedIn
      ) {
        return sendResponse({ ok: true, skipped: true });
      }

      const payload = message.payload;
      const senderTabId = sender?.tab?.id;

      try {
        // Intento único.
        await postCandidate(payload, senderTabId);
        await updateBadge();
        sendResponse({ ok: true, sent: true });
      } catch (e) {
        log.error("Error envío. No se reintenta.", e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});
