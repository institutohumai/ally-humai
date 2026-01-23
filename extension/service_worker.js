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
const LOG_PREFIX = "[Ally]";
const log = {
  info: (...args) => console.log(LOG_PREFIX, ...args),
  warn: (...args) => console.warn(LOG_PREFIX, ...args),
  error: (...args) => console.error(LOG_PREFIX, ...args),
};

let cachedConfig = null;
let configPromise = null;
let session = null;
let isProcessingQueue = false;
let lastSentLinkedIn = null;

// Ensure payloads carry the origin of this extension
function withSource(payload) {
  return { ...payload, source: "linkedin_extension" };
}

// Reinyecta el content script de Lovable en pestañas abiertas tras recargar la extensión
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
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            log.warn("No pudimos reinyectar script en pestaña Lovable", {
              tabId: tab.id,
              error: lastError.message,
            });
          } else {
            log.info("Content script reinjectado en pestaña Lovable", {
              tabId: tab.id,
            });
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
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            log.warn("No pudimos reinyectar script en pestaña LinkedIn", {
              tabId: tab.id,
              error: lastError.message,
            });
          } else {
            log.info("Content script reinjectado en pestaña LinkedIn", {
              tabId: tab.id,
            });
          }
        },
      );
    });
  });
}

// Snapshot the session state without throwing
async function getSessionSnapshot() {
  try {
    const stored = await loadSessionFromStorage();
    const current = stored || session;
    if (!current || isSessionExpired(current)) {
      return { active: false, userId: null };
    }
    return { active: true, userId: current.userId || null };
  } catch (error) {
    log.warn("No pudimos leer el estado de sesión para ping", String(error));
    return { active: false, userId: null };
  }
}

function broadcastToTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, message, () => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          // Silenciar errores típicos de tabs sin content script
          return;
        }
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
    a.expiresAt === b.expiresAt
  );
}

async function handleAuthFailure(reason) {
  log.warn("La sesión dejó de ser válida; se limpiará para volver a iniciar", {
    reason,
  });
  session = null;
  invalidateConfigCache();
  try {
    await clearStoredSession();
  } catch (error) {
    log.error("No pudimos limpiar la sesión guardada", String(error));
  }
  await updateBadge();
  notifySessionCleared();
}

chrome.runtime.onInstalled.addListener(async () => {
  log.info("Extensión instalada: preparando todo");
  await initializeExtension();
  reinjectLovableContentScripts();
  reinjectLinkedInContentScripts();
});

chrome.runtime.onStartup.addListener(async () => {
  log.info("Chrome inició: preparando Ally");
  await initializeExtension();
  reinjectLovableContentScripts();
  reinjectLinkedInContentScripts();
});

async function initializeExtension() {
  log.info("Iniciando Ally...");
  await loadSessionFromStorage();
  await updateBadge();
  await processPendingQueue();
  log.info("Ally listo");
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
        retries: 0,
      });

      // Limitar tamaño de cola
      if (queue.length > MAX_QUEUE_SIZE) {
        queue = queue.slice(-MAX_QUEUE_SIZE);
      }

      chrome.storage.local.set({ [PENDING_QUEUE_KEY]: queue }, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          log.error("No pudimos guardar en la cola", err.message || err);
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
    log.info("Cola no procesada", {
      isProcessingQueue,
      hasSession: Boolean(session),
    });
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
      log.info("Cola vacía; nada que reenviar");
      isProcessingQueue = false;
      await updateBadge();
      return;
    }

    log.info("Revisando cola de candidatos pendientes", {
      enCola: queue.length,
    });

    const successfulIndices = [];

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      try {
        await postCandidate(item.candidate);
        successfulIndices.push(i);
        log.info("Candidato pendiente enviado", { name: item.candidate?.name });
      } catch (error) {
        log.warn("No se pudo enviar un candidato en cola, se reintentará", {
          name: item.candidate?.name,
          error: String(error),
        });
        item.retries = (item.retries || 0) + 1;

        // Eliminar después de 3 reintentos
        if (item.retries >= 3) {
          successfulIndices.push(i);
          log.error("Se descartó un candidato tras 3 intentos", {
            name: item.candidate?.name,
          });
        }
      }
    }

    // Persistir la cola para conservar retries y descartar éxitos
    const newQueue =
      successfulIndices.length > 0
        ? queue.filter((_, index) => !successfulIndices.includes(index))
        : queue;
    await new Promise((resolve) => {
      chrome.storage.local.set({ [PENDING_QUEUE_KEY]: newQueue }, resolve);
    });
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
        log.error(
          "No pudimos leer la sesión guardada",
          lastError.message || lastError,
        );
        reject(lastError);
        return;
      }
      const stored = result?.[SESSION_STORAGE_KEY] || null;
      if (stored && stored.accessToken && stored.userId) {
        if (isSessionExpired(stored)) {
          log.warn(
            "La sesión guardada venció; se limpia para volver a iniciar",
            { userId: stored.userId },
          );
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
        log.error(
          "No pudimos guardar la sesión",
          lastError.message || lastError,
        );
        reject(lastError);
      } else {
        log.info("Sesión guardada", { userId: newSession?.userId });
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
        log.error(
          "No pudimos borrar la sesión",
          lastError.message || lastError,
        );
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
  log.info("Configuración se recargará la próxima vez");
}

async function ensureSession() {
  // Siempre intenta cargar la sesión desde el storage, incluso si session está en memoria
  const stored = await loadSessionFromStorage();
  if (stored && stored.accessToken && stored.userId) {
    if (isSessionExpired(stored)) {
      log.warn("Tu sesión expiró; vuelve a iniciar en la app");
      await handleAuthFailure("session expired");
      throw new Error("Sesión de Supabase expirada");
    }
    return stored;
  }
  log.warn("No hay sesión activa; inicia sesión en la app");
  throw new Error("Sesión de Supabase no configurada");
}

async function ensureBridgeConfig() {
  const currentSession = await ensureSession();

  if (cachedConfig) {
    return cachedConfig;
  }

  if (!configPromise) {
    log.info("Pidiendo configuración del bridge");
    const headers = {
      Authorization: `Bearer ${currentSession.accessToken}`,
    };
    if (currentSession.userId) {
      headers["X-Ally-User-Id"] = currentSession.userId;
    }

    configPromise = fetch(CONFIG_ENDPOINT, {
      method: "GET",
      headers,
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
        log.warn("No pudimos leer la configuración del bridge", String(error));
        invalidateConfigCache();
        throw error;
      });
  }

  return configPromise;
}

async function postCandidate(payload) {
  const body = withSource(payload);

  // Verificar que level_of_english esté presente en el payload
  if (!body.level_of_english) {
    log.warn("El payload no incluye level_of_english", body);
  }

  log.info("Enviando candidato al bridge", body);
  const [config, currentSession] = await Promise.all([
    ensureBridgeConfig(),
    ensureSession(),
  ]);

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${currentSession.accessToken}`,
    "X-Ally-Agency-ID": config.agency_id,
  };

  if (currentSession.userId) {
    headers["X-Ally-User-Id"] = currentSession.userId;
  }

  let response;
  try {
    response = await fetch(API_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (error) {
    log.error("Fallo de red al enviar candidato", { error: String(error) });
    notifyBridgeError(error?.message || String(error));
    throw error;
  }

  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 401 || response.status === 403) {
      await handleAuthFailure(`candidates ${response.status}`);
    }
    log.warn("El bridge respondió con error", {
      status: response.status,
      detail,
      name: body?.name,
      linkedin_url: body?.linkedin_url,
    });
    notifyBridgeError(detail || `status ${response.status}`);
    throw new Error(detail || `status ${response.status}`);
  }
  log.info("Candidato enviado con éxito");

  // Record last sent LinkedIn URL to prevent immediate duplicates
  if (body?.linkedin_url) {
    lastSentLinkedIn = body.linkedin_url;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ALLY_PING") {
    (async () => {
      const snapshot = await getSessionSnapshot();
      sendResponse({
        ok: true,
        active: snapshot.active,
        userId: snapshot.userId || null,
      });
    })();
    return true;
  }

  if (message?.type === "ALLY_SUPABASE_SESSION") {
    (async () => {
      try {
        const { accessToken, refreshToken, userId, expiresAt } =
          message.payload || {};
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

        log.info("Sesión recibida desde la app", {
          hasAccessToken: Boolean(accessToken),
          userId,
        });
        session = newSession;
        await persistSession(session);
        invalidateConfigCache();
        await updateBadge();
        await processPendingQueue();
        log.info(
          "Sesión actualizada y cola procesada tras recibir sesión nueva",
          { userId },
        );
        sendResponse({ ok: true });
      } catch (error) {
        log.error("La sesión recibida no es válida", String(error));
        sendResponse({ ok: false, detail: String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "ALLY_CLEAR_SESSION") {
    (async () => {
      try {
        log.info("Se pidió cerrar sesión");
        session = null;
        invalidateConfigCache();
        await clearStoredSession();
        await updateBadge();
        notifySessionCleared();
        sendResponse({ ok: true });
      } catch (error) {
        log.error("No pudimos cerrar sesión", String(error));
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
      log.info("Nuevo candidato recibido desde LinkedIn", {
        name: message.payload?.name,
        linkedin_url: message.payload?.linkedin_url,
      });

      // Deduplicate immediate repeats by linkedin_url
      if (
        message.payload?.linkedin_url &&
        message.payload.linkedin_url === lastSentLinkedIn
      ) {
        log.info("Candidato omitido: ya se envió este perfil recientemente", {
          linkedin_url: message.payload.linkedin_url,
        });
        sendResponse({
          ok: true,
          skipped: true,
          reason: "duplicate_linkedin_url",
        });
        return;
      }

      // Intentar enviar inmediatamente si hay sesión
      if (session) {
        try {
          log.info("Intentando enviar candidato inmediatamente", {
            hasSession: true,
            name: message.payload?.name,
          });
          await postCandidate(withSource(message.payload));
          await updateBadge();
          log.info("Candidato enviado al momento");
          sendResponse({ ok: true, sent: true });
          return;
        } catch (error) {
          log.warn("No se pudo enviar ahora; se guardará para reintentar", {
            error: error.message,
            name: message.payload?.name,
          });
          // Si falla, agregar a cola
        }
      }

      // Si no hay sesión o falló el envío, agregar a cola
      if (!session) {
        log.info("No hay sesión activa; se encola candidato", {
          name: message.payload?.name,
        });
      }
      await addToPendingQueue(withSource(message.payload));
      await updateBadge();
      log.info("Candidato guardado para enviar después");
      sendResponse({ ok: true, queued: true });
    } catch (error) {
      log.error("Tuvimos un problema procesando el candidato", String(error));
      const detail = error instanceof Error ? error.message : String(error);
      sendResponse({ ok: false, detail });
    }
  })();

  return true;
});
