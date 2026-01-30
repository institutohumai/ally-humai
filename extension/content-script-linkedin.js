// === ALLY HUMAI - Content Script LinkedIn (v4.1 - Fusionada y Robusta) ===

// --- Configuración ---
const CONFIG = {
  POLL_INTERVAL_MS: 2000,
  RETRY_ATTEMPTS: 15,
  RETRY_DELAY_MS: 800,
  SCROLL_STEPS: 8, // Scroll profundo para llegar a idiomas/proyectos
};

// --- Selectores ---
const SELECTORS = {
  OVERLAY_LINK: "a[href*='/overlay/about-this-profile/']",
  TOP_CARD_CONTAINERS: [
    "section[data-member-id]",
    "section.pv-top-card",
    ".artdeco-card",
  ],
  SHOW_MORE: "button[class*='inline-show-more-text__button']",

  // --- MEJORA: Selector de Atributo ---
  // Usamos [class*='...'] para que detecte "inline-show-more-text--is-collapsed"
  // aunque LinkedIn le cambie el sufijo. Mantenemos tu fallback .t-14.t-normal.t-black
  EXPANDABLE_TEXT: "[class*='inline-show-more-text'], .t-14.t-normal.t-black",
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

function getCanonicalProfilePath() {
  const loc = getEffectiveLocation();
  const match = loc.pathname.match(/^\/in\/([^/]+\/?)/);
  return match ? match[0] : null;
}

function getProfileIdFromUrl() {
  const loc = getEffectiveLocation();
  const match = loc.pathname.match(/^\/in\/([^/]+)/);
  return match ? match[1] : null;
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
    }
    *:focus { outline: none !important; box-shadow: none !important; }
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
    if (overlayLink) return overlayLink.closest("section");
    for (const selector of SELECTORS.TOP_CARD_CONTAINERS) {
      const card = document.querySelector(selector);
      if (card) return card;
    }
    await new Promise((r) => setTimeout(r, CONFIG.RETRY_DELAY_MS));
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
    (card) => extractText("div.text-body-medium", card), // Prioridad semántica
    (card) => extractText("div[data-test-id='top-card__headline']", card),
  ],
  location: [
    (card) => extractText("span.text-body-small.inline", card), // Prioridad semántica
    (card) => extractText("span[data-test-id='top-card__location']", card),
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

// Modificación en la función extractListSection para mejorar la extracción de work_experience
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
      const result = {
        title: null,
        company: null,
        description: null,
        date_range: null,
      };
      let hasData = false;

      for (const [key, selector] of Object.entries(fieldMap)) {
        let el = item.querySelector(selector);

        // Lógica especial para descripciones (manteniendo SELECTORS.EXPANDABLE_TEXT)
        if (!el && key === "description") {
          el = item.querySelector(SELECTORS.EXPANDABLE_TEXT);
        }

        if (el) {
          const visualSpan =
            el.tagName === "SPAN"
              ? el
              : el.querySelector("span[aria-hidden='true']");
          const rawText = visualSpan ? visualSpan.innerText : el.innerText;
          const cleanText = cleanString(rawText);

          // Evitar duplicados internos
          const isDuplicate = Object.values(result).includes(cleanText);

          if (cleanText && !isDuplicate) {
            result[key] = cleanText;
            highlightElement(visualSpan || el);
            hasData = true;
          }
        }
      }

      // Validar que al menos uno de los campos tenga datos
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
  if (!chrome.runtime || !chrome.runtime.sendMessage) return;

  try {
    chrome.runtime.sendMessage(
      { type: "ALLY_CANDIDATE", payload: candidate },
      (res) => {
        if (!chrome.runtime.lastError)
          console.log("[Ally] Candidato enviado:", candidate.name);
      },
    );
  } catch (e) {
    console.error("[Ally] Error envío:", e);
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

  // 2. Voyager (API)
  const profileId = getProfileIdFromUrl();
  if (profileId) {
    const voyagerData = await getVoyagerProfileJson(profileId);
    if (voyagerData) {
      console.log("[Ally] Fusionando datos de Voyager...");
      const voyagerEnglish = voyagerData.languages?.find((l) =>
        /english|inglés|ingles/i.test(l.name),
      );
      candidate = {
        ...candidate,
        headline: voyagerData.headline || candidate.role,
        location: voyagerData.locationName || candidate.location,
        alternative_cv: voyagerData.website,
        skills: voyagerData.skills?.map((s) => s.name).filter(Boolean),
        about: voyagerData.summary,
        level_of_english: voyagerEnglish
          ? voyagerEnglish.proficiency
          : undefined,
      };
    }
  }

  // 3. Scroll
  await humanScrollAndExpand();

  // Experiencia
  candidate.work_experience = extractListSection("experience", {
    title: ".t-bold span[aria-hidden='true']",
    company: ".t-14.t-normal span[aria-hidden='true']",
    description: SELECTORS.EXPANDABLE_TEXT,
    date_range: ".t-black--light span[aria-hidden='true']:first-child",
  });

  // Educación
  candidate.education = extractListSection("education", {
    institution: ".t-bold span[aria-hidden='true']",
    degree: ".t-14.t-normal span[aria-hidden='true']",
    description: SELECTORS.EXPANDABLE_TEXT,
  });

  // Certificaciones
  candidate.certifications = extractListSection("licenses_and_certifications", {
    name: ".t-bold span[aria-hidden='true']",
    organization: ".t-14.t-normal span[aria-hidden='true']",
    issue_date: ".t-black--light span[aria-hidden='true']",
  });

  // Proyectos
  candidate.projects = extractListSection("projects", {
    title: ".t-bold span[aria-hidden='true']",
    date: ".t-black--light span[aria-hidden='true']",
    description: SELECTORS.EXPANDABLE_TEXT,
  });

  // Skills (DOM)
  const domSkills = extractListSection("skills", {
    name: ".t-bold span[aria-hidden='true']",
  });
  if (domSkills.length > 0) {
    const skillsList = domSkills.map((s) => s.name);
    candidate.skills = candidate.skills
      ? [...new Set([...candidate.skills, ...skillsList])]
      : skillsList;
  }

  // --- IDIOMAS (Consolidado) ---
  const languagesList = extractListSection("languages", {
    language: ".t-bold span[aria-hidden='true']",
    description: ".t-14.t-normal.t-black--light span[aria-hidden='true']", // Selector actualizado
  });

  if (languagesList && languagesList.length > 0) {
    candidate.languages = languagesList.map((lang) => ({
      language: lang.language,
      description: lang.description || "",
    }));

    // Buscar el idioma "Inglés" y asignar su descripción a level_of_english
    const englishEntry = languagesList.find((l) =>
      /english|inglés|Ingles|English|Inglés|ingles/i.test(l.language),
    );
    if (englishEntry && englishEntry.description) {
      candidate.level_of_english = englishEntry.description;
    } else {
      candidate.level_of_english = ""; // Vacío si no se encuentra descripción
    }

    console.log("[Ally] Idiomas recopilados:", candidate.languages);
  }

  // About (Con selector robusto para evitar clases hash)
  const aboutAnchor = document.getElementById("about");
  if (aboutAnchor) {
    const aboutSection = aboutAnchor.closest("section");
    if (aboutSection) {
      const aboutTextEl = aboutSection.querySelector(SELECTORS.EXPANDABLE_TEXT);
      if (aboutTextEl) {
        const visualText =
          aboutTextEl.querySelector("span[aria-hidden='true']") || aboutTextEl;
        const text = cleanString(visualText.innerText);
        if (text) {
          candidate.about = text;
          highlightElement(aboutTextEl);
        }
      }
    }
  }

  return candidate;
}

// --- Loop ---
async function processProfile() {
  if (isProcessing) return;
  if (!shouldRunInThisContext()) return;

  const loc = getEffectiveLocation();
  const canonicalPath = getCanonicalProfilePath();

  if (!canonicalPath || !/^\/in\/[^/]+\/?$/.test(loc.pathname)) return;
  if (sessionStorage.getItem("ally:lastSent") === canonicalPath) return;

  isProcessing = true;
  console.log(`[Ally] Procesando: ${window.location.pathname}`);

  try {
    const candidate = await gatherAndSend();
    if (candidate && candidate.name) {
      sessionStorage.setItem("ally:lastSent", canonicalPath);
      if (!candidate.level_of_english) candidate.level_of_english = "";
      sendCandidate(candidate);
    }
  } catch (error) {
    console.error("[Ally] Error:", error);
  } finally {
    isProcessing = false;
  }
}

// --- Init ---
function init() {
  observer = new MutationObserver(() => processProfile());
  if (document.body)
    observer.observe(document.body, { childList: true, subtree: true });
  else
    window.addEventListener("DOMContentLoaded", () =>
      observer.observe(document.body, { childList: true, subtree: true }),
    );
  setInterval(processProfile, CONFIG.POLL_INTERVAL_MS);
}

init();
