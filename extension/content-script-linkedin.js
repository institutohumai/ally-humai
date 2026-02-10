// === ALLY HUMAI - Content Script "AI Feeder" (V5: Full UI Feedback) ===

const CONFIG = {
  SCROLL_STEPS: 6,
  SCROLL_DELAY: 600, // Tiempo entre scrolleos
  CLICK_DELAY_MIN: 300, // Mínimo tiempo entre clics (Anti-Ban)
  CLICK_DELAY_MAX: 700, // Máximo tiempo entre clics (Anti-Ban)
  RENDER_WAIT: 800, // Tiempo extra para que el texto aparezca tras el clic
};

let isProcessing = false;
let isExtensionActive = false;
let stopFlag = false;
const pendingWaiters = new Set();

// --- HELPERS DE UBICACIÓN ---
function getEffectiveLocation() {
  try {
    return window.top.location;
  } catch (e) {
    return window.location;
  }
}

function getCanonicalProfilePath() {
  const loc = getEffectiveLocation();
  const match = loc.pathname.match(/^\/in\/([^/]+\/?)/);
  return match ? match[0] : null;
}

// --- HELPERS DE TIEMPO (HUMAN JITTER) ---
const wait = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingWaiters.delete(cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      pendingWaiters.delete(cancel);
      resolve();
    };
    pendingWaiters.add(cancel);
  });
const randomDelay = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

function flushPendingWaits() {
  pendingWaiters.forEach((cancel) => cancel());
  pendingWaiters.clear();
}

// Evita inyectar HTML al mostrar mensajes dinámicos
const sanitizeText = (text = "") =>
  text
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function removeStatusCard() {
  const card = document.getElementById("ally-status-card");
  if (card) card.remove();
}

function activateExtension() {
  const wasSleeping = stopFlag || !isExtensionActive;
  stopFlag = false;
  isExtensionActive = true;
  if (wasSleeping) console.info("[Ally] Sleep Mode desactivado");
}

function enterSleepMode(reason = "unknown") {
  if (!stopFlag || isExtensionActive)
    console.info("[Ally] Sleep Mode activado:", reason);
  stopFlag = true;
  isExtensionActive = false;
  isProcessing = false;
  flushPendingWaits();
  removeStatusCard();
}

function hasStopSignal() {
  return stopFlag || !isExtensionActive;
}

async function checkExtensionStatus() {
  return new Promise((resolve) => {
    if (!chrome?.runtime?.sendMessage) {
      enterSleepMode("runtime_unavailable");
      resolve(false);
      return;
    }

    try {
      chrome.runtime.sendMessage({ type: "ALLY_PING" }, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          console.warn("[Ally] Ping falló:", lastError.message);
          enterSleepMode("ping_error");
          resolve(false);
          return;
        }

        const active = response?.active === true;
        if (active) {
          activateExtension();
        } else {
          enterSleepMode("session_inactiva");
        }
        resolve(active);
      });
    } catch (error) {
      console.warn("[Ally] Ping exception:", error.message);
      enterSleepMode("ping_exception");
      resolve(false);
    }
  });
}

// ========================================================
// 1. SISTEMA DE NOTIFICACIONES (NUEVO: ESTADOS)
// ========================================================

function createOrUpdateCard(status, data = null) {
  // Buscamos si ya existe la tarjeta (para actualizarla en lugar de crear otra)
  let card = document.getElementById("ally-status-card");

  // Si no existe, la creamos desde cero
  if (!card) {
    card = document.createElement("div");
    card.id = "ally-status-card"; // ID genérico para estados

    // Estilos base
    Object.assign(card.style, {
      position: "fixed",
      top: "80px", // Debajo del nav de LinkedIn
      right: "20px",
      width: "280px",
      backgroundColor: "white",
      boxShadow: "0 4px 15px rgba(0,0,0,0.2)",
      borderRadius: "10px",
      padding: "16px",
      zIndex: "2147483647", // Máximo posible para que nada lo tape
      fontFamily:
        "-apple-system, system-ui, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      transition: "all 0.3s ease", // Transición suave entre colores/tamaños
      opacity: "0",
      transform: "translateX(20px)",
      borderLeft: "6px solid #ccc", // Color por defecto
    });

    document.body.appendChild(card);

    // Animación de entrada
    requestAnimationFrame(() => {
      card.style.opacity = "1";
      card.style.transform = "translateX(0)";
    });
  }

  card.dataset.state = status;

  // --- ESTADO: PROCESANDO (AZUL) ---
  if (status === "processing") {
    card.style.borderLeftColor = "#3498db"; // Azul
    card.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px;">
        <div class="ally-spinner" style="
            width: 18px; 
            height: 18px; 
            border: 3px solid #f3f3f3; 
            border-top: 3px solid #3498db; 
            border-radius: 50%; 
            animation: ally-spin 1s linear infinite;">
        </div>
        <div>
          <h3 style="margin:0; font-size:14px; font-weight:600; color:#2c3e50;">Analizando Perfil...</h3>
          <p style="margin:2px 0 0 0; font-size:11px; color:#7f8c8d;">Extrayendo info oculta</p>
        </div>
      </div>
      <style>@keyframes ally-spin {0% {transform: rotate(0deg);} 100% {transform: rotate(360deg);}}</style>
    `;
  }

  // --- ESTADO: ÉXITO (VERDE) ---
  else if (status === "success") {
    card.style.borderLeftColor = "#2ecc71"; // Verde
    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <h3 style="margin:0; font-size:15px; font-weight:700; color:#27ae60;">✅ Perfil Procesado</h3>
      </div>
      <div style="font-size:13px; color:#34495e;">
        <p style="margin: 4px 0;"><strong>Nombre:</strong> ${data.name || "Detectado"}</p>
        <p style="margin: 4px 0;"><strong>Inglés:</strong> ${data.level_of_english || "N/A"}</p>
        <p style="margin: 4px 0;"><strong>Skills:</strong> ${(data.skills || []).slice(0, 3).join(", ")}...</p>
        <p style="margin: 4px 0; color:#95a5a6; font-size:11px; text-align:right;">IA Powered by Gemini</p>
      </div>
    `;

    // Auto-ocultar después de 5 segundos
    setTimeout(() => {
      if (card) {
        card.style.opacity = "0";
        card.style.transform = "translateX(20px)";
        setTimeout(() => card.remove(), 500);
      }
    }, 5000);
  }

  // --- ESTADO: ERROR (ROJO) ---
  else if (status === "error") {
    const detail =
      sanitizeText(
        (data && (data.message || data.detail)) ||
          "No pudimos conectar con ALLY. Reintenta en unos segundos.",
      );

    card.style.borderLeftColor = "#e74c3c"; // Rojo
    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <h3 style="margin:0; font-size:15px; font-weight:700; color:#c0392b;">⚠️ Error al enviar</h3>
        <button data-ally-dismiss style="background:none; border:none; font-size:16px; cursor:pointer; color:#95a5a6;">×</button>
      </div>
      <p style="margin:4px 0; font-size:13px; color:#7f8c8d; line-height:1.4;">${detail}</p>
      <p style="margin:6px 0 0 0; font-size:11px; color:#bdc3c7;">Verifica tu conexión o vuelve a intentar luego.</p>
    `;

    const dismissButton = card.querySelector("[data-ally-dismiss]");
    if (dismissButton) {
      dismissButton.addEventListener("click", () => {
        card.style.opacity = "0";
        card.style.transform = "translateX(20px)";
        setTimeout(() => card.remove(), 500);
      });
    }
  }
}

// ========================================================
// 2. EXPANSIÓN INTELIGENTE (Igual que V4)
// ========================================================
async function expandContent() {
  if (hasStopSignal()) return;
  console.log("[Ally] Expandiendo información oculta...");

  const selectors = [
    "button.inline-show-more-text__button",
    ".pv-profile-section__see-more-inline",
    "#line-clamp-show-more-button",
  ];

  const potentialButtons = Array.from(
    document.querySelectorAll(selectors.join(",")),
  );
  const visibleButtons = potentialButtons.filter(
    (b) => b.offsetParent !== null,
  );

  for (const btn of visibleButtons) {
    if (hasStopSignal()) return;
    try {
      const text = btn.innerText.toLowerCase();
      if (
        text.includes("more") ||
        text.includes("más") ||
        text.includes("ver")
      ) {
        btn.click();
        await wait(randomDelay(CONFIG.CLICK_DELAY_MIN, CONFIG.CLICK_DELAY_MAX));
        if (hasStopSignal()) return;
      }
    } catch (e) {
      /* Ignorar errores */
    }
  }

  if (hasStopSignal()) return;
  await wait(CONFIG.RENDER_WAIT);
}

// ========================================================
// 3. SCROLL HUMANO (Igual que V4)
// ========================================================
async function humanScroll() {
  if (hasStopSignal()) return;
  console.log("[Ally] Scrolleando para cargar elementos...");
  for (let i = 0; i < CONFIG.SCROLL_STEPS; i++) {
    if (hasStopSignal()) return;
    window.scrollBy({ top: 400, behavior: "smooth" });
    await wait(CONFIG.SCROLL_DELAY + randomDelay(0, 200));
    if (hasStopSignal()) return;
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
  await wait(500);
  if (hasStopSignal()) return;
}

// ========================================================
// 4. EXTRACCIÓN Y EMPAQUETADO
// ========================================================
async function scrapeRawProfile() {
  await humanScroll();
  if (hasStopSignal()) return null;
  await expandContent();
  if (hasStopSignal()) return null;

  const rawText = document.body.innerText;
  const title = document.title || "";
  const nameParts = title.split(" | ")[0].split(" - ")[0];

  return {
    raw_text: rawText,
    linkedin_url: window.location.href.split("?")[0],
    known_name: nameParts.trim(),
  };
}

// ========================================================
// 5. ENVÍO Y COMUNICACIÓN
// ========================================================
function sendToBridge(payload) {
  if (hasStopSignal()) return;
  try {
    console.log("[Ally] Enviando perfil a procesar por IA...");
    chrome.runtime.sendMessage(
      { type: "ALLY_CANDIDATE", payload: payload },
      (res) => {
        if (!chrome.runtime.lastError)
          console.log("[Ally] Enviado correctamente.");
      },
    );
  } catch (e) {
    console.error("[Ally] Error de envío:", e);
  }
}

// Listener: Recibe el éxito y actualiza la tarjeta a VERDE
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "ALLY_SUCCESS_NOTIFICATION") {
    console.log("[Ally UI] Mostrando éxito");
    createOrUpdateCard("success", msg.data);
  }

  if (msg.type === "ALLY_BRIDGE_ERROR") {
    console.warn("[Ally UI] Error de red", msg.detail);
    createOrUpdateCard("error", { message: msg.detail });
  }

  if (msg.type === "ALLY_STOP_SCRAPING") {
    console.info("[Ally UI] Sleep Mode solicitado por el Service Worker");
    enterSleepMode("stop_signal");
  }

  if (msg.type === "ALLY_SESSION_CLEARED") {
    enterSleepMode("session_cleared");
  }
});

// ========================================================
// 6. BUCLE PRINCIPAL (MODIFICADO PARA ESTADOS)
// ========================================================
async function processProfile() {
  if (isProcessing) return;

  if (!isExtensionActive || stopFlag) {
    const active = await checkExtensionStatus();
    if (!active) return;
  }

  if (hasStopSignal()) return;

  const path = getCanonicalProfilePath();
  if (!path || sessionStorage.getItem("ally:lastSent") === path) return;

  isProcessing = true;
  try {
    // 1. Mostrar estado "PROCESANDO" (Azul) inmediatamente
    console.log("[Ally] Iniciando UI...");
    createOrUpdateCard("processing");
    if (hasStopSignal()) return;

    await wait(2000); // Espera inicial de carga
    if (hasStopSignal()) return;

    // 2. Ejecutar extracción (Scroll + Clicks)
    const payload = await scrapeRawProfile();
    if (!payload || hasStopSignal()) return;

    if (payload.raw_text.length > 500) {
      sendToBridge(payload);
      sessionStorage.setItem("ally:lastSent", path);
      // Nota: La tarjeta se quedará en "Procesando" hasta que
      // el listener de arriba reciba la respuesta "success" de la IA.
    } else {
      console.warn("[Ally] Texto insuficiente.");
      // Opcional: Podríamos quitar la tarjeta si falla,
      // pero por ahora dejamos que el usuario refresque.
    }
  } catch (e) {
    console.error("[Ally] Error:", e);
  } finally {
    isProcessing = false;
  }
}

// Observador de Navegación
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(processProfile, 3000);
  }
}).observe(document, { subtree: true, childList: true });

checkExtensionStatus();
setTimeout(processProfile, 3500);
