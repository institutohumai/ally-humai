// === ALLY HUMAI - Content Script "AI Feeder" (V5: Full UI Feedback) ===

const CONFIG = {
  SCROLL_STEPS: 6,
  SCROLL_DELAY: 600, // Tiempo entre scrolleos
  CLICK_DELAY_MIN: 300, // Mínimo tiempo entre clics (Anti-Ban)
  CLICK_DELAY_MAX: 700, // Máximo tiempo entre clics (Anti-Ban)
  RENDER_WAIT: 800, // Tiempo extra para que el texto aparezca tras el clic
  MIN_TEXT_LENGTH: 500, // Mínimo de caracteres para enviar al bridge
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

// Ally Design System Colors
const ALLY_COLORS = {
  primary: '#2b44ff',           // hsl(233, 100%, 58%)
  primaryForeground: '#ffffff',
  secondary: 'hsl(180, 65%, 45%)',
  accent: 'hsl(25, 95%, 55%)',  // Orange for CTAs
  background: '#ffffff',
  foreground: 'hsl(220, 15%, 20%)',
  muted: 'hsl(220, 10%, 96%)',
  mutedText: 'hsl(220, 10%, 45%)',
  border: 'hsl(220, 13%, 91%)',
  destructive: 'hsl(0, 84%, 60%)',
};

function createOrUpdateCard(status, data = null) {
  // Buscamos si ya existe la tarjeta (para actualizarla en lugar de crear otra)
  let card = document.getElementById("ally-status-card");

  // Si no existe, la creamos desde cero
  if (!card) {
    card = document.createElement("div");
    card.id = "ally-status-card"; // ID genérico para estados

    // Estilos base - Ally Design System
    Object.assign(card.style, {
      position: "fixed",
      top: "80px", // Debajo del nav de LinkedIn
      right: "20px",
      width: "300px",
      backgroundColor: ALLY_COLORS.background,
      boxShadow: "0 8px 24px hsl(220 15% 20% / 0.16)", // Large shadow
      borderRadius: "12px", // Large radius
      padding: "20px",
      zIndex: "2147483647", // Máximo posible para que nada lo tape
      fontFamily: "'Euclid Circular B', system-ui, -apple-system, sans-serif",
      transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)", // Smooth transition
      opacity: "0",
      transform: "translateX(20px)",
      border: `1px solid ${ALLY_COLORS.border}`,
    });

    document.body.appendChild(card);

    // Animación de entrada
    requestAnimationFrame(() => {
      card.style.opacity = "1";
      card.style.transform = "translateX(0)";
    });
  }

  card.dataset.state = status;

  // --- ESTADO: PROCESANDO (AZUL PRIMARIO) ---
  if (status === "processing") {
    card.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px;">
        <div class="ally-spinner" style="
            width: 20px; 
            height: 20px; 
            border: 3px solid ${ALLY_COLORS.muted}; 
            border-top: 3px solid ${ALLY_COLORS.primary}; 
            border-radius: 50%; 
            animation: ally-spin 1s linear infinite;">
        </div>
        <div>
          <h3 style="margin:0; font-size:14px; font-weight:600; color:${ALLY_COLORS.foreground};">Analizando Perfil...</h3>
          <p style="margin:4px 0 0 0; font-size:12px; color:${ALLY_COLORS.mutedText};">Extrayendo información con IA</p>
        </div>
      </div>
      <style>@keyframes ally-spin {0% {transform: rotate(0deg);} 100% {transform: rotate(360deg);}}</style>
    `;
  }

  // --- ESTADO: ÉXITO ---
  else if (status === "success") {
    chrome.storage.local.get(['allyJobs'], (result) => {
      const jobs = result.allyJobs || [];
      
      const jobOptions = jobs.map(job => {
        return `<option value="${job.id}">${sanitizeText(job.title)} en ${sanitizeText(job.company)}</option>`;
      }).join('');

      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <div style="width: 32px; height: 32px; background: ${ALLY_COLORS.primary}; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
              <span style="color: white; font-size: 16px;">✓</span>
            </div>
            <div>
              <h3 style="margin:0; font-size:15px; font-weight:600; color:${ALLY_COLORS.foreground};">Perfil Procesado</h3>
              <p style="margin:2px 0 0 0; font-size:11px; color:${ALLY_COLORS.mutedText};">Listo para asignar</p>
            </div>
          </div>
          <button id="ally-close-btn" style="background:none; border:none; font-size:18px; cursor:pointer; color:${ALLY_COLORS.mutedText}; padding:0; line-height:1; transition: color 0.2s;">×</button>
        </div>
        
        <div style="background:${ALLY_COLORS.muted}; border-radius:8px; padding:12px; margin-bottom:16px;">
          <p style="margin: 0 0 6px 0; font-size:13px; color:${ALLY_COLORS.foreground};"><strong>${data.name || "Candidato"} ${data.lastname || ""}</strong></p>
          <p style="margin: 0 0 4px 0; font-size:12px; color:${ALLY_COLORS.mutedText};">Inglés: ${data.level_of_english || "No especificado"}</p>
          <p style="margin: 0; font-size:12px; color:${ALLY_COLORS.mutedText};">Skills: ${(data.skills || []).slice(0, 3).join(", ") || "N/A"}</p>
        </div>
        
        <div style="margin-bottom: 12px;">
          <label style="display:block; font-size:12px; font-weight:500; color:${ALLY_COLORS.foreground}; margin-bottom:6px;">Asignar a puesto</label>
          <select id="ally-job-select" style="
            width:100%; 
            height:40px; 
            padding:0 12px; 
            border:1px solid ${ALLY_COLORS.border}; 
            border-radius:8px; 
            font-size:13px; 
            font-family:inherit;
            color:${ALLY_COLORS.foreground};
            background:white;
            cursor:pointer;
            transition: border-color 0.2s, box-shadow 0.2s;
            outline:none;
          ">
            <option value="">Solo guardar en Base de Datos</option>
            ${jobOptions}
          </select>
        </div>
        
        <button id="ally-apply-btn" style="
          width:100%; 
          height:40px; 
          background:${ALLY_COLORS.primary}; 
          color:white; 
          border:none; 
          border-radius:8px; 
          font-size:14px; 
          font-weight:500; 
          font-family:inherit;
          cursor:pointer;
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        ">Confirmar</button>
        
        <p style="margin: 12px 0 0 0; color:${ALLY_COLORS.mutedText}; font-size:10px; text-align:center;">Powered by Ally AI</p>
        
        <style>
          #ally-job-select:focus { border-color: ${ALLY_COLORS.primary}; box-shadow: 0 0 0 3px hsl(233 100% 58% / 0.1); }
          #ally-apply-btn:hover { opacity: 0.9; transform: translateY(-1px); }
          #ally-apply-btn:active { transform: translateY(0); }
          #ally-close-btn:hover { color: ${ALLY_COLORS.foreground}; }
        </style>
      `;

      // Event listener para cerrar manualmente
      const closeBtn = card.querySelector('#ally-close-btn');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          card.style.opacity = '0';
          card.style.transform = 'translateX(20px)';
          setTimeout(() => card.remove(), 300);
        });
      }

      // Event listener para confirmar postulación
      const applyBtn = card.querySelector('#ally-apply-btn');
      if (applyBtn) {
        applyBtn.addEventListener('click', () => {
          const select = card.querySelector('#ally-job-select');
          const selectedJobId = select ? select.value : '';

          if (selectedJobId) {
            applyBtn.textContent = 'Asignando...';
            applyBtn.style.opacity = '0.7';
            applyBtn.disabled = true;
            
            chrome.runtime.sendMessage({
              type: 'ALLY_ASSIGN_JOB',
              payload: { candidate_id: data.id, job_id: selectedJobId }
            }, (response) => {
              if (response?.ok) {
                applyBtn.textContent = '¡Añadido!';
                applyBtn.style.background = ALLY_COLORS.secondary;
                setTimeout(() => {
                  card.style.opacity = '0';
                  card.style.transform = 'translateX(20px)';
                  setTimeout(() => card.remove(), 300);
                }, 800);
              } else {
                console.error('[Ally UI] Error asignando job:', response?.error);
                applyBtn.textContent = 'Error asignando a puesto';
                applyBtn.style.background = ALLY_COLORS.destructive;
                applyBtn.style.opacity = '1';
                applyBtn.disabled = false;
                setTimeout(() => {
                  applyBtn.textContent = 'Reintentar';
                  applyBtn.style.background = ALLY_COLORS.primary;
                }, 2000);
              }
            });
          } else {
            card.style.opacity = '0';
            card.style.transform = 'translateX(20px)';
            setTimeout(() => card.remove(), 300);
          }
        });
      }
    });
  }

  // --- ESTADO: ERROR ---
  else if (status === "error") {
    const detail = sanitizeText(
      (data && (data.message || data.detail)) ||
        "No pudimos conectar con ALLY. Reintenta en unos segundos.",
    );

    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 32px; height: 32px; background: ${ALLY_COLORS.destructive}; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
            <span style="color: white; font-size: 16px;">!</span>
          </div>
          <h3 style="margin:0; font-size:15px; font-weight:600; color:${ALLY_COLORS.foreground};">Error al procesar</h3>
        </div>
        <button data-ally-dismiss style="background:none; border:none; font-size:18px; cursor:pointer; color:${ALLY_COLORS.mutedText}; padding:0; line-height:1;">×</button>
      </div>
      <p style="margin:0 0 8px 0; font-size:13px; color:${ALLY_COLORS.mutedText}; line-height:1.5;">${detail}</p>
      <p style="margin:0; font-size:11px; color:${ALLY_COLORS.mutedText};">Verifica tu conexión o reintenta.</p>
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

    if (payload.raw_text.length >= CONFIG.MIN_TEXT_LENGTH) {
      sendToBridge(payload);
      sessionStorage.setItem("ally:lastSent", path);
      // Nota: La tarjeta se quedará en "Procesando" hasta que
      // el listener de arriba reciba la respuesta "success" de la IA.
    } else {
      console.info(
        `[Ally] Perfil con poca información: (${payload.raw_text.length}/${CONFIG.MIN_TEXT_LENGTH}).`,
      );
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
