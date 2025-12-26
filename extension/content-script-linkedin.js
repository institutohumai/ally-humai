
// === INICIO: Código migrado desde content.js ===
const POLL_INTERVAL_MS = 1500;

console.log("[Ally] Content script loaded", window.location.href);

const TOP_CARD_SELECTOR = "section[data-member-id]";
const REQUIRED_SECTIONS = ["experience", "education"];
const MAX_SECTION_ATTEMPTS = 3;
const sectionAttemptMap = new Map();
const sectionStateMap = new Map();

const PROFILE_PATH_REGEX = /^\/in\/[^/]+\/?$/;

function getTopCard() {
	return document.querySelector(TOP_CARD_SELECTOR);
}

function getCanonicalProfilePath(pathname) {
	const match = pathname.match(/^\/in\/[^/]+\/?/);
	return match ? match[0] : null;
}

function getProfileMeta(property) {
	const meta = document.querySelector(`meta[property="${property}"]`);
	const content = meta?.getAttribute("content");
	return content ? content.trim() : undefined;
}

function parseOgTitle() {
	const ogTitle = getProfileMeta("og:title");
	if (!ogTitle) {
		return undefined;
	}
	const cleaned = ogTitle.replace(/\| LinkedIn$/i, "").trim();
	const parts = cleaned.split(" - ").map(part => part.trim()).filter(Boolean);
	if (parts.length === 0) {
		return undefined;
	}
	const [rawName, ...rest] = parts;
	return {
		name: rawName,
		headline: rest.length > 0 ? rest.join(" - ") : undefined
	};
}

function selectTopCardText(selectors) {
	const topCard = getTopCard();
	if (!topCard) {
		return undefined;
	}
	for (const selector of selectors) {
		const value = selectTextWithin(topCard, selector);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function selectTopCardAttr(selectors, attr, transform) {
	const topCard = getTopCard();
	if (!topCard) {
		return undefined;
	}
	for (const selector of selectors) {
		const value = selectAttrWithin(topCard, selector, attr, transform);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function getSectionFromAnchor(anchorId) {
	const anchor = document.getElementById(anchorId);
	if (!anchor) {
		return undefined;
	}
	const section = anchor.closest("section");
	if (!section) {
		return undefined;
	}
	return { anchor, section };
}

function ensureSectionReady(sectionId) {
	const info = getSectionFromAnchor(sectionId);
	if (!info) {
		sectionStateMap.set(sectionId, "ready");
		return true;
	}

	const { anchor, section } = info;
	if (!section.dataset.allyPrepared) {
		anchor.scrollIntoView({ block: "center" });
		section.dataset.allyPrepared = "true";
	}

	const expandButton = section.querySelector("button[aria-controls][aria-expanded='false']");
	if (expandButton && !expandButton.dataset.allyClicked) {
		expandButton.dataset.allyClicked = "true";
		expandButton.click();
	}

	const items = section.querySelectorAll("li.artdeco-list__item, li.pvs-list__item, li.pvs-list__paged-list-item");
	if (items.length === 0) {
		const attempts = (sectionAttemptMap.get(sectionId) || 0) + 1;
		sectionAttemptMap.set(sectionId, attempts);
		if (attempts >= MAX_SECTION_ATTEMPTS) {
			sectionStateMap.set(sectionId, "ready");
			return true;
		}
		sectionStateMap.set(sectionId, "pending");
		return false;
	}

	sectionStateMap.set(sectionId, "ready");
	sectionAttemptMap.set(sectionId, MAX_SECTION_ATTEMPTS);
	return true;
}

function areRequiredSectionsReady() {
	for (const sectionId of REQUIRED_SECTIONS) {
		if (sectionStateMap.get(sectionId) === "pending") {
			return false;
		}
	}
	return true;
}

function canUseRuntime() {
	if (typeof chrome === "undefined") {
		return false;
	}
	try {
		return Boolean(chrome.runtime && chrome.runtime.id);
	} catch (error) {
		return false;
	}
}

const fieldExtractors = {
	name: [
		() => {
			const og = parseOgTitle();
			return og?.name;
		},
		() => selectTopCardText([
			"h1 span[aria-hidden='true']",
			"h1"
		]),
		() => selectText("main [role='main'] h1[aria-level='1']")
	],
	role: [
		() => {
			const og = parseOgTitle();
			return og?.headline;
		},
		() => selectTopCardText([
			"div[data-test-id='top-card__headline'] span[aria-hidden='true']",
			"div[data-test-id='top-card__headline']",
			"div[aria-label*='Headline'] span[aria-hidden='true']"
		]),
		() => selectText("div.text-body-medium.break-words")
	],
	organization: [
		() => selectTopCardText([
			"div[data-test-id='current-company'] span[aria-hidden='true']",
			"div[data-test-id='current-company']",
			"li[aria-label*='empresa actual'] span[aria-hidden='true']",
			"li[aria-label*='current company'] span[aria-hidden='true']"
		]),
		() => selectText("div.pv-text-details__right-panel a")
	],
	location: [
		() => selectTopCardText([
			"span[data-test-id='top-card__location']",
			"li[aria-label*='ubicación'] span[aria-hidden='true']",
			"li[aria-label*='location'] span[aria-hidden='true']"
		]),
		() => selectText("span[data-anonymize=person-address]")
	],
	phone: [
		() => selectTopCardAttr(["a[href^='tel:']"], "href", href => href.replace("tel:", ""))
	],
	email: [
		() => selectTopCardAttr(["a[href^='mailto:']"], "href", href => href.replace("mailto:", ""))
	],
	linkedin_url: [
		() => getProfileMeta("og:url")?.split("?")[0],
		() => window.location.href.split("?")[0],
		() => selectAttr("a[href^='https://www.linkedin.com/in/']", "href")
	]
};

function selectText(selector) {
	const el = document.querySelector(selector);
	if (!el) {
		return undefined;
	}
	const text = (el.innerText || el.textContent || "").trim();
	if (!text) {
		return undefined;
	}
	highlightElement(el);
	return text;
}

function selectAttr(selector, attr, transform) {
	const el = document.querySelector(selector);
	if (!el) {
		return undefined;
	}
	const value = el.getAttribute(attr);
	if (!value) {
		return undefined;
	}
	const normalized = transform ? transform(value) : value;
	if (!normalized) {
		return undefined;
	}
	const result = normalized.trim();
	if (!result) {
		return undefined;
	}
	highlightElement(el);
	return result;
}

let highlightStyleInjected = false;

function ensureHighlightStyle() {
	if (highlightStyleInjected) {
		return;
	}
	if (!document || !document.head) {
		return;
	}
	const style = document.createElement("style");
	style.id = "ally-highlight-style";
	style.textContent = `
		.ally-highlight {
			text-decoration: underline;
			text-decoration-color: #2ecc71;
			text-decoration-thickness: 2px;
			text-underline-offset: 4px;
			text-decoration-skip-ink: auto;
		}
	`;
	document.head.appendChild(style);
	highlightStyleInjected = true;
}

function highlightElement(el) {
	if (!el || el.dataset.allyHighlighted === "true") {
		return;
	}
	ensureHighlightStyle();
	el.classList.add("ally-highlight");
	el.dataset.allyHighlighted = "true";
}

function selectTextWithin(root, selector) {
	if (!root) {
		return undefined;
	}
	const el = root.querySelector(selector);
	return getElementText(el);
}

function selectAttrWithin(root, selector, attr, transform) {
	if (!root) {
		return undefined;
	}
	const el = root.querySelector(selector);
	if (!el) {
		return undefined;
	}
	const value = el.getAttribute(attr);
	if (!value) {
		return undefined;
	}
	const normalized = transform ? transform(value) : value;
	if (!normalized) {
		return undefined;
	}
	const result = normalized.trim();
	if (!result) {
		return undefined;
	}
	highlightElement(el);
	return result;
}

function getElementText(el) {
	if (!el) {
		return undefined;
	}
	const text = (el.innerText || el.textContent || "").trim();
	if (!text) {
		return undefined;
	}
	highlightElement(el);
	return text;
}

function deriveLastName(fullName) {
	if (!fullName) {
		return undefined;
	}
	const parts = fullName.split(/\s+/).filter(Boolean);
	if (parts.length < 2) {
		return undefined;
	}
	return parts.slice(1).join(" ");
}

function extractPortfolioLink() {
	const topCard = getTopCard();
	if (!topCard) {
		return undefined;
	}
	const anchors = topCard.querySelectorAll("a[href^='http']");
	for (const anchor of anchors) {
		const href = anchor.href;
		if (!href) {
			continue;
		}
		if (href.includes("linkedin.com")) {
			continue;
		}
		highlightElement(anchor);
		return href;
	}
	return undefined;
}

function parseDateRange(raw) {
	if (!raw) {
		return { date_from: undefined, date_to: undefined };
	}
	const [range] = raw.split("·");
	if (!range) {
		return { date_from: raw, date_to: undefined };
	}
	const [from, to] = range.split(" - ").map(part => part?.trim()).filter(Boolean);
	return {
		date_from: from || undefined,
		date_to: to || undefined
	};
}

function extractWorkExperience() {
	const info = getSectionFromAnchor("experience");
	if (!info) {
		return [];
	}
	const { section } = info;

	const items = Array.from(
		section.querySelectorAll("li.artdeco-list__item, li.pvs-list__item, li.pvs-list__paged-list-item")
	);
	const experiences = [];

	for (const item of items) {
		const title = selectTextWithin(
			item,
			"div.display-flex.align-items-center div.t-bold span[aria-hidden='true'], div.t-bold span[aria-hidden='true'], div.t-bold"
		);

		const company = selectTextWithin(
			item,
			"span.t-14.t-normal span[aria-hidden='true'], span.t-14.t-normal"
		);

		if (!title && !company) {
			continue;
		}

		const metaNodes = item.querySelectorAll("span.t-14.t-normal.t-black--light, span.t-14.t-normal.t-black--light span[aria-hidden='true']");
		const metaTexts = Array.from(metaNodes)
			.map(getElementText)
			.filter(Boolean);

		let dateText;
		let location;

		for (const meta of metaTexts) {
			if (!dateText && /\d|actualidad|Actualidad|presente|Present/i.test(meta)) {
				dateText = meta;
			} else if (!location && !/·/.test(meta) && !/\d/.test(meta)) {
				location = meta;
			}
		}

		const { date_from, date_to } = parseDateRange(dateText);

		const description = selectTextWithin(
			item,
			".inline-show-more-text--is-collapsed, .inline-show-more-text--is-collapsed-with-line-clamp"
		);

		experiences.push({
			title: title || undefined,
			company: company || undefined,
			date_from,
			date_to,
			location: location || undefined,
			description: description || undefined
		});
	}

	return experiences;
}

function extractEducation() {
	const info = getSectionFromAnchor("education");
	if (!info) {
		return [];
	}
	const { section } = info;

	const items = Array.from(
		section.querySelectorAll("li.artdeco-list__item, li.pvs-list__item, li.pvs-list__paged-list-item")
	);
	const entries = [];

	for (const item of items) {
		const institution = selectTextWithin(
			item,
			"div.t-bold span[aria-hidden='true'], div.t-bold"
		);
		if (!institution) {
			continue;
		}

		const degree = selectTextWithin(item, "span.t-14.t-normal span[aria-hidden='true'], span.t-14.t-normal");
		const dateText = selectTextWithin(item, "span.t-14.t-normal.t-black--light span[aria-hidden='true'], span.t-14.t-normal.t-black--light");
		const { date_from, date_to } = parseDateRange(dateText);

		entries.push({
			institution,
			degree: degree || undefined,
			date_from,
			date_to
		});
	}

	return entries;
}

function extractEnglishLevel() {
	const info = getSectionFromAnchor("languages");
	if (!info) {
		return undefined;
	}
	const { section } = info;

	const items = Array.from(
		section.querySelectorAll("li.artdeco-list__item, li.pvs-list__item, li.pvs-list__paged-list-item")
	);
	for (const item of items) {
		const language = selectTextWithin(item, "div.t-bold span[aria-hidden='true'], div.t-bold");
		if (!language) {
			continue;
		}
		if (!/english|inglés/i.test(language)) {
			continue;
		}
		const level = selectTextWithin(item, "span.t-14.t-normal.t-black--light span[aria-hidden='true'], span.t-14.t-normal.t-black--light");
		return level || language;
	}

	return undefined;
}

function gatherCandidate() {
	if (!document.body) {
		console.warn("[Ally] Document not ready; skipping scrape");
		return undefined;
	}

	const candidate = {};

	for (const [key, extractors] of Object.entries(fieldExtractors)) {
		for (const extractor of extractors) {
			const value = extractor();
			if (value) {
				candidate[key] = value;
				break;
			}
		}
	}

	if (!candidate.name) {
		console.warn("[Ally] Waiting for profile name before scraping", window.location.pathname);
		return undefined;
	}

	highlightName();

	if (candidate.linkedin_url) {
		candidate.linkedin_url = candidate.linkedin_url.split("?")[0];
		highlightLinkedInUrl(candidate.linkedin_url);
	}

	const lastName = deriveLastName(candidate.name);
	if (lastName) {
		candidate.last_name = lastName;
	}

	if (candidate.location) {
		candidate.place_of_residency = candidate.location;
	}

	const experienceReady = ensureSectionReady("experience");
	const educationReady = ensureSectionReady("education");
	ensureSectionReady("languages");

	if (!areRequiredSectionsReady()) {
		console.debug("[Ally] Waiting for lazy sections to load", {
			experienceReady,
			educationReady
		});
		return undefined;
	}

	const portfolio = extractPortfolioLink();
	if (portfolio) {
		candidate.alternative_cv = portfolio;
	}

	if (experienceReady) {
		const experiences = extractWorkExperience();
		if (experiences.length > 0) {
			candidate.work_experience = experiences;
		}
	}

	if (educationReady) {
		const education = extractEducation();
		if (education.length > 0) {
			candidate.education = education;
		}
	}

	const englishLevel = extractEnglishLevel();
	if (englishLevel) {
		candidate.english_level = englishLevel;
	}

	if (!experienceReady || !educationReady) {
		console.debug("[Ally] Proceeding without optional sections", {
			experienceReady,
			educationReady
		});
	}

	console.log("[Ally] Candidate scraped", candidate);
	return candidate;
}

function highlightLinkedInUrl(url) {
	if (!url) {
		return;
	}
	let linkEl = document.querySelector(`a[href^="${url}"]`);
	if (!linkEl) {
		try {
			const relative = new URL(url).pathname;
			linkEl = document.querySelector(`a[href^="${relative}"]`);
		} catch (error) {
			// Ignore malformed URLs
		}
	}
	if (!linkEl) {
		linkEl = document.querySelector("a[href^='https://www.linkedin.com/in/']");
	}
	if (linkEl) {
		highlightElement(linkEl);
	}
}

function highlightName() {
	const topCard = getTopCard();
	if (!topCard) {
		return;
	}
	const nameEl = topCard.querySelector("h1 span[aria-hidden='true'], h1");
	if (!nameEl) {
		return;
	}
	highlightElement(nameEl);
}

function sendCandidate(candidate) {
	if (!canUseRuntime()) {
		console.warn("[Ally] Extension context unavailable; skipping send");
		return;
	}

	try {
		chrome.runtime.sendMessage({ type: "ALLY_CANDIDATE", payload: candidate }, (response) => {
			if (chrome.runtime.lastError) {
				console.error("Ally Humai bridge messaging error", chrome.runtime.lastError.message);
				return;
			}
			if (!response?.ok) {
				console.warn("Ally Humai bridge rejected candidate", response?.detail);
				return;
			}
			console.info("Ally Humai candidate sent", candidate.linkedin_url || candidate.name);
		});
	} catch (error) {
		console.error("[Ally] Failed to send candidate", error);
	}
}

function processProfile() {
	if (!document || !document.body) {
		return;
	}

	const pathname = window.location.pathname;
	const canonicalProfilePath = getCanonicalProfilePath(pathname);
	if (!canonicalProfilePath) {
		return;
	}

	if (!PROFILE_PATH_REGEX.test(pathname)) {
		console.debug("[Ally] Skipping non-root profile view", pathname);
		return;
	}

	if (!getTopCard()) {
		console.debug("[Ally] Waiting for LinkedIn top card");
		return;
	}

	console.debug("[Ally] Processing profile", canonicalProfilePath);

	const lastSent = sessionStorage.getItem("ally:lastSent");
	if (lastSent === canonicalProfilePath) {
		return;
	}

	const candidate = gatherCandidate();
	if (!candidate) {
		console.debug("[Ally] Candidate data incomplete", canonicalProfilePath);
		return;
	}

	sessionStorage.setItem("ally:lastSent", canonicalProfilePath);
	console.log("[Ally] Sending candidate", canonicalProfilePath);
	sendCandidate(candidate);
}

const observer = new MutationObserver(() => {
	processProfile();
});

observer.observe(document.body, { childList: true, subtree: true });
setInterval(processProfile, POLL_INTERVAL_MS);
processProfile();
// === FIN: Código migrado desde content.js ===
