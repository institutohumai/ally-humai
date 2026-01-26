// === ALLY HUMAI - Content Script LinkedIn (Full + Certs + Skills + English Level) ===

// --- Configuración ---
const CONFIG = {
  POLL_INTERVAL_MS: 2000,
  RETRY_ATTEMPTS: 15,
  RETRY_DELAY_MS: 800,
  SCROLL_STEPS: 7, // Aumentado para llegar al fondo (Idiomas suele estar al final)
};

// --- Selectores ---
const SELECTORS = {
  OVERLAY_LINK: "a[href*='/overlay/about-this-profile/']",
  TOP_CARD_CONTAINERS: [
    "section[data-member-id]",
    "section.pv-top-card",
    ".artdeco-card",
  ],
  SHOW_MORE: ".inline-show-more-text__button",
};

// --- Estado Global ---
let isProcessing = false;
let observer = null;

// ========================================================
// 1. GESTIÓN DE CONTEXTO (IFRAMES)
// ========================================================

function getEffectiveLocation() {
  try {
    return window.top.location;
  } catch (e) {
    return window.location;
  }
}

function getProfileIdFromUrl() {
  const loc = getEffectiveLocation();
  const match = loc.pathname.match(/^\/in\/([^/]+)/);
  return match ? match[1] : null;
}

function getCanonicalProfilePath() {
  const loc = getEffectiveLocation();
  const match = loc.pathname.match(/^\/in\/[^/]+\/?/);
  return match ? match[0] : null;
}

function shouldRunInThisContext() {
  if (window.location.pathname.includes("/preload/")) return true;
  const preloadFrame = document.querySelector('iframe[src*="/preload/"]');
  if (window === window.top && preloadFrame) return false;
  return true;
}

// ========================================================
// 2. UTILIDADES VISUALES Y DE TEXTO
// ========================================================

function cleanString(input) {
  if (!input) return undefined;
  return input
    .replace(/\s+/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function randomJitter(min = 400, max = 1000) {
  return new Promise((res) =>
    setTimeout(res, Math.floor(Math.random() * (max - min + 1)) + min),
  );
}

function ensureHighlightStyle() {
  if (document.getElementById("ally-highlight-style")) return;
  const style = document.createElement("style");
  style.id = "ally-highlight-style";
  style.textContent = `
    .ally-highlight {
      text-decoration: underline;
      text-decoration-color: #2ecc71;
      text-decoration-thickness: 3px;
      text-underline-offset: 3px;
      background-color: rgba(46, 204, 113, 0.1);
      outline: none !important;
      box-shadow: none !important;
    }
    .inline-show-more-text__button:focus {
        outline: none !important;
        box-shadow: none !important;
    }
  `;
  document.head.appendChild(style);
}

function highlightElement(el) {
  if (!el || el.dataset.allyHighlighted === "true") return;
  ensureHighlightStyle();
  el.classList.add("ally-highlight");
  el.dataset.allyHighlighted = "true";
  el.blur();
}

// ========================================================
// 3. LÓGICA DE LOCALIZACIÓN
// ========================================================

async function locateTopCard() {
  for (let i = 0; i < CONFIG.RETRY_ATTEMPTS; i++) {
    const overlayLink = document.querySelector(SELECTORS.OVERLAY_LINK);
    if (overlayLink) {
      const card = overlayLink.closest("section");
      if (card) return card;
    }
    for (const selector of SELECTORS.TOP_CARD_CONTAINERS) {
      const card = document.querySelector(selector);
      if (card) return card;
    }
    if (i < CONFIG.RETRY_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, CONFIG.RETRY_DELAY_MS));
    }
  }
  return null;
}

// ========================================================
// 4. MOTORES DE EXTRACCIÓN
// ========================================================

async function extractText(selector, baseElement = document) {
  const el = baseElement.querySelector(selector);
  if (!el) return undefined;

  const moreBtn = el.querySelector(SELECTORS.SHOW_MORE);
  if (moreBtn) {
    moreBtn.click();
    await new Promise((r) => setTimeout(r, 50));
  }

  const text = cleanString(el.innerText || el.textContent);
  if (text) highlightElement(el);
  return text;
}

const FIELD_STRATEGIES = {
  name: [
    (card) =>
      card.querySelector(SELECTORS.OVERLAY_LINK)?.getAttribute("aria-label"),
    (card) => extractText("h1", card),
    () => extractText("main h1"),
  ],
  role: [
    (card) => extractText("div[data-test-id='top-card__headline']", card),
    (card) => extractText(".text-body-medium", card),
  ],
  location: [
    (card) => extractText("span[data-test-id='top-card__location']", card),
    (card) => extractText(".text-body-small.inline", card),
  ],
  linkedin_url: [() => getEffectiveLocation().href.split("?")[0]],
};

async function executeExtractors(topCard) {
  const data = {};
  for (const [field, strategies] of Object.entries(FIELD_STRATEGIES)) {
    for (const strategy of strategies) {
      try {
        const value = await strategy(topCard || document);
        if (value) {
          data[field] = cleanString(value);
          break;
        }
      } catch (e) {
        continue;
      }
    }
  }
  return data;
}

function extractListSection(sectionId, fieldMap) {
  const sectionAnchor = document.getElementById(sectionId);
  if (!sectionAnchor) return [];
  const section = sectionAnchor.closest("section");
  if (!section) return [];

  const items = section.querySelectorAll(
    "li.artdeco-list__item, li.pvs-list__paged-list-item",
  );

  return Array.from(items)
    .map((item) => {
      const result = {};
      let hasData = false;
      for (const [key, selector] of Object.entries(fieldMap)) {
        const el = item.querySelector(selector);
        if (el) {
          result[key] = cleanString(el.innerText);
          if (result[key]) {
            highlightElement(el);
            hasData = true;
          }
        }
      }
      return hasData ? result : null;
    })
    .filter(Boolean);
}

// ========================================================
// 5. NAVEGACIÓN Y COMUNICACIÓN
// ========================================================

async function humanScrollAndExpand() {
  console.log("[Ally] Scroll humano activado...");
  for (let i = 0; i < CONFIG.SCROLL_STEPS; i++) {
    window.scrollBy({ top: 300, behavior: "smooth" });
    await randomJitter(300, 600);
  }

  const btns = document.querySelectorAll(SELECTORS.SHOW_MORE);
  for (const btn of btns) {
    btn.click();
    await new Promise((r) => setTimeout(r, 20));
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function getVoyagerProfileJson(profileId) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "ALLY_GET_VOYAGER_PROFILE", profileId },
        (response) => resolve(response?.json || null),
      );
    } catch (e) {
      resolve(null);
    }
  });
}

function sendCandidate(candidate) {
  if (!candidate || !candidate.name) return;

  // Validar si el contexto de la extensión está disponible
  if (!chrome.runtime || !chrome.runtime.sendMessage) {
    console.error("[Ally] Error: Contexto de la extensión no disponible.");
    return;
  }

  try {
    chrome.runtime.sendMessage(
      { type: "ALLY_CANDIDATE", payload: candidate },
      (res) => {
        if (!chrome.runtime.lastError)
          console.log("[Ally] Candidato enviado:", candidate.name);
      },
    );
  } catch (e) {
    console.error("[Ally] Error de conexión:", e);
  }
}

// ========================================================
// 6. FLUJO PRINCIPAL
// ========================================================

async function gatherAndSend() {
  const topCard = await locateTopCard();

  if (!topCard) {
    if (window.location.pathname.includes("/preload/")) {
      console.warn("[Ally] Iframe cargado pero Top Card no encontrado.");
    }
    return null;
  }

  // 1. Extracción DOM Base
  let candidate = await executeExtractors(topCard);

  // 2. Enriquecimiento con API Voyager (Comentado)
  // const profileId = getProfileIdFromUrl();
  // if (profileId) {
  //   const voyagerData = await getVoyagerProfileJson(profileId);
  //   if (voyagerData) {
  //     console.log("[Ally] Fusionando datos de Voyager...");

  //     // Buscar nivel de inglés en Voyager
  //     const voyagerEnglish = voyagerData.languages?.find((l) =>
  //       /english|inglés|ingles|Inglés|English/i.test(l.name),
  //     );

  //     candidate = {
  //       ...candidate,
  //       headline: voyagerData.headline || candidate.role,
  //       location: voyagerData.locationName || candidate.location,
  //       alternative_cv: voyagerData.website,
  //       skills: voyagerData.skills?.map((s) => s.name).filter(Boolean),
  //       about: voyagerData.summary,
  //       level_of_english: voyagerEnglish
  //         ? voyagerEnglish.proficiency
  //         : undefined,
  //     };
  //   }
  // }

  // 3. Scroll y Listas
  await humanScrollAndExpand();

  // Experiencia
  candidate.work_experience = extractListSection("experience", {
    title: ".t-bold span[aria-hidden='true']",
    company: ".t-14.t-normal span[aria-hidden='true']",
    description: ".wOLGhQneMtuPCjjutWcjeQtdvnOeYMaMhs", // Selector para la descripción
    date_from: ".t-14.t-normal.t-black--light span[aria-hidden='true']:nth-of-type(1)", // Selector para la fecha de inicio
    date_to: ".t-14.t-normal.t-black--light span[aria-hidden='true']:nth-of-type(2)", // Selector para la fecha de fin
  });

  // Educación
  candidate.education = extractListSection("education", {
    institution: ".t-bold span[aria-hidden='true']",
    degree: ".t-14.t-normal span[aria-hidden='true']",
  });

  // Certificaciones
  candidate.certifications = extractListSection("licenses_and_certifications", {
    name: ".t-bold span[aria-hidden='true']",
    organization: ".t-14.t-normal span[aria-hidden='true']",
    issue_date: ".t-black--light span[aria-hidden='true']",
  });

  // Skills (DOM)
  const domSkillsObjects = extractListSection("skills", {
    name: ".t-bold span[aria-hidden='true']",
  });
  if (domSkillsObjects && domSkillsObjects.length > 0) {
    const scrapedSkills = domSkillsObjects.map((s) => s.name);
    candidate.skills = candidate.skills
      ? [...new Set([...candidate.skills, ...scrapedSkills])]
      : scrapedSkills;
  }

  // --- IDIOMAS / NIVEL DE INGLÉS (NUEVO) ---
  const languagesList = extractListSection("languages", {
    language: ".t-bold span[aria-hidden='true']",
    proficiency: ".t-14.t-normal.t-black--light span[aria-hidden='true']",
  });

  if (languagesList && languagesList.length > 0) {
    // Buscamos específicamente inglés
    const englishEntry = languagesList.find((l) =>
      /english|inglés|ingles|Inglés|English/i.test(l.language),
    );
    if (englishEntry && englishEntry.proficiency) {
      console.log(
        "[Ally] Nivel de inglés encontrado en DOM:",
        englishEntry.proficiency,
      );
      candidate.level_of_english = englishEntry.proficiency;
    }
  }

  // About
  const aboutAnchor = document.getElementById("about");
  if (aboutAnchor) {
    const aboutSection = aboutAnchor.closest("section");
    if (aboutSection) {
      const aboutTextEl = aboutSection.querySelector(
        ".wOLGhQneMtuPCjjutWcjeQtdvnOeYMaMhs",
      );
      if (aboutTextEl) {
        const text = cleanString(aboutTextEl.innerText);
        if (text) {
          candidate.about = text;
          highlightElement(aboutTextEl);
        }
      }
    }
  }

  return candidate;
}

async function processProfile() {
  if (isProcessing) return;
  if (!shouldRunInThisContext()) return;

  const loc = getEffectiveLocation();
  const canonicalPath = getCanonicalProfilePath();

  if (!canonicalPath || !/^\/in\/[^/]+\/?$/.test(loc.pathname)) return;
  if (sessionStorage.getItem("ally:lastSent") === canonicalPath) return;

  isProcessing = true;
  console.log(`[Ally] Iniciando en contexto: ${window.location.pathname}`);

  try {
    const candidate = await gatherAndSend();

    if (candidate && candidate.name) {
      sessionStorage.setItem("ally:lastSent", canonicalPath);
      // Asegurar que 'level_of_english' se envíe aunque esté vacío
      if (!candidate.level_of_english) {
        candidate.level_of_english = "";
      }
      sendCandidate(candidate);
    }
  } catch (error) {
    console.error("[Ally] Excepción:", error);
  } finally {
    isProcessing = false;
  }
}

// ========================================================
// 7. INICIALIZACIÓN
// ========================================================

function init() {
  observer = new MutationObserver(() => {
    processProfile();
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
    processProfile();
  } else {
    window.addEventListener("DOMContentLoaded", () => {
      observer.observe(document.body, { childList: true, subtree: true });
      processProfile();
    });
  }

  setInterval(processProfile, CONFIG.POLL_INTERVAL_MS);
}

init();
