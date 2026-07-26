import {
  buildNameIndex,
  buildSuggestionIndex,
  findClosestName,
  matchExactName,
} from "./matcher.js";
import {
  collapseLocationGroups,
  remapCharacterGroups,
} from "./groups.js";
import {
  applyCharacterOverrides,
  buildLevelRosters,
  combineCharacters,
  validateCharacterPayload,
  validateLevelPayload,
} from "./levels.js";
import {
  loadProgressState,
  resetAllProgress,
  saveProgressState,
  setActiveDifficulty,
  updateLevelProgress,
} from "./progress.js";
import {
  loadSettings,
  saveSettings,
} from "./settings.js";
import { buildWikiUrl } from "./wiki.js";

const DEFAULT_PORTRAIT = "./assets/placeholders/default.svg";
const PORTRAIT_ASSET_ROOT = "./assets/";
const SPELLING_SUGGESTION_DELAY_MS = 120;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const LOCAL_PATH_PATTERN = /^[a-z0-9_./-]+$/i;
const HOUSE_PLACEHOLDERS = Object.freeze([
  ["arryn", "./assets/placeholders/arryn.svg"],
  ["baratheon", "./assets/placeholders/baratheon.svg"],
  ["greyjoy", "./assets/placeholders/greyjoy.svg"],
  ["lannister", "./assets/placeholders/lannister.svg"],
  ["martell", "./assets/placeholders/martell.svg"],
  ["stark", "./assets/placeholders/stark.svg"],
  ["targaryen", "./assets/placeholders/targaryen.svg"],
  ["tully", "./assets/placeholders/tully.svg"],
  ["tyrell", "./assets/placeholders/tyrell.svg"],
]);
const elements = {
  activeLevelLabel: getRequiredElement("active-level-label"),
  autoScrollToggle: getRequiredElement("auto-scroll-toggle"),
  changeLevelButton: getRequiredElement("change-level-button"),
  darkModeToggle: getRequiredElement("dark-mode-toggle"),
  filterList: getRequiredElement("house-filters"),
  form: getRequiredElement("name-form"),
  foundCount: getRequiredElement("found-count"),
  gameHeader: getRequiredElement("game-header"),
  gameView: getRequiredElement("game-view"),
  guessPane: getRequiredElement("guess-pane"),
  houseList: getRequiredElement("house-list"),
  input: getRequiredElement("name-input"),
  levelCards: getRequiredElement("level-cards"),
  levelPicker: getRequiredElement("level-picker"),
  loadingState: getRequiredElement("loading-state"),
  message: getRequiredElement("guess-message"),
  optionsButton: getRequiredElement("options-button"),
  optionsMenu: getRequiredElement("options-menu"),
  progress: getRequiredElement("game-progress"),
  progressLabel: getRequiredElement("progress-label"),
  resetButton: getRequiredElement("reset-button"),
  spellingHelperToggle: getRequiredElement("spelling-helper-toggle"),
  spellingSuggestion: getRequiredElement("spelling-suggestion"),
  timer: getRequiredElement("timer"),
  totalCount: getRequiredElement("total-count"),
};

const state = {
  activeLevel: null,
  allGroups: [],
  autoScrollEnabled: true,
  cardsByCharacterId: new Map(),
  characters: [],
  charactersById: new Map(),
  charactersByGroupId: new Map(),
  completedAt: null,
  darkModeEnabled: true,
  filterHouseId: "all",
  foundIds: new Set(),
  houses: [],
  levels: [],
  nameIndex: new Map(),
  progressState: null,
  rosterIdsByLevel: new Map(),
  rosters: new Map(),
  spellingHelperEnabled: true,
  spellingSuggestion: null,
  suggestionIndex: [],
  startedAt: null,
  timerIntervalId: null,
};

let resetConfirmationTimeoutId = null;
let skipNextEmptySubmit = false;
let spellingSuggestionTimeoutId = null;

elements.form.addEventListener("submit", handleGuess);
elements.input.addEventListener("input", handleGuessInput);
elements.spellingHelperToggle.addEventListener(
  "change",
  handleSpellingHelperToggle,
);
elements.autoScrollToggle.addEventListener("change", handleAutoScrollToggle);
elements.darkModeToggle.addEventListener("change", handleDarkModeToggle);
elements.spellingSuggestion.addEventListener(
  "click",
  applySpellingSuggestion,
);
elements.optionsButton.addEventListener("click", toggleOptionsMenu);
elements.changeLevelButton.addEventListener("click", () => showLevelPicker());
elements.resetButton.addEventListener("click", handleResetClick);
document.addEventListener("click", handleDocumentClick);
document.addEventListener("keydown", handleDocumentKeydown);

initialize();

async function initialize() {
  try {
    const settings = loadSettings(localStorage);
    state.autoScrollEnabled = settings.autoScrollEnabled;
    state.darkModeEnabled = settings.darkModeEnabled;
    state.spellingHelperEnabled = settings.spellingHelperEnabled;
    syncSettingsControls();
    applyTheme();
    const [
      housesPayload,
      charactersPayload,
      levelsPayload,
      showCharactersPayload,
      overridesPayload,
    ] = await Promise.all([
      loadJson("./data/houses.json"),
      loadJson("./data/characters.json"),
      loadJson("./data/levels.json"),
      loadJson("./data/show-characters.json"),
      loadJson("./data/character-overrides.json"),
    ]);
    const allGroups = uniqueById(
      extractCollection(housesPayload, "groups")
        .map(validateGroup)
        .filter(Boolean),
    );
    const groupIds = new Set(allGroups.map((group) => group.id));
    const existingCharacters = validateCharacterPayload(
      charactersPayload,
      groupIds,
    );
    const showCharacters = validateCharacterPayload(
      showCharactersPayload,
      groupIds,
    );
    const levels = validateLevelPayload(levelsPayload);
    const characters = applyCharacterOverrides(
      combineCharacters(existingCharacters, showCharacters),
      overridesPayload,
    );
    const rosters = buildLevelRosters(levels, characters);

    if (
      allGroups.length === 0 ||
      existingCharacters.length === 0 ||
      levels.length === 0 ||
      characters.length === 0 ||
      levels.some((level) => {
        const roster = rosters.get(level.id) ?? [];
        return level.includeAll
          ? roster.length !== characters.length
          : roster.length !== level.targetCount;
      })
    ) {
      throw new Error("The archive data is empty or invalid.");
    }

    state.allGroups = allGroups;
    state.levels = levels;
    state.rosters = rosters;
    state.rosterIdsByLevel = new Map(
      [...rosters].map(([levelId, roster]) => [
        levelId,
        new Set(roster.map((character) => character.id)),
      ]),
    );
    const expertLevel = levels.find((level) => level.includeAll);
    state.progressState = loadProgressState(
      localStorage,
      levels.map((level) => level.id),
      state.rosterIdsByLevel,
      expertLevel?.id ?? "",
    );

    renderLevelCards();
    startTimerUpdates();
    elements.loadingState.hidden = true;
    if (state.progressState.activeDifficulty !== null) {
      activateLevel(state.progressState.activeDifficulty, false);
    } else {
      showLevelPicker(false);
    }
  } catch {
    elements.loadingState.textContent =
      "The archives could not be opened. Please refresh and try again.";
    elements.loadingState.classList.add("state-message-error");
    elements.input.disabled = true;
    elements.form.querySelector("button").disabled = true;
  }
}

async function loadJson(path) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Data request failed with status ${response.status}.`);
  }

  return response.json();
}

function extractCollection(payload, key) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (
    payload !== null &&
    typeof payload === "object" &&
    Array.isArray(payload[key])
  ) {
    return payload[key];
  }

  return [];
}

function uniqueById(items) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function validateGroup(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    !ID_PATTERN.test(value.id) ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    typeof value.kind !== "string" ||
    value.kind.trim().length === 0 ||
    (value.region !== null && typeof value.region !== "string") ||
    typeof value.major !== "boolean" ||
    (value.source !== null && typeof value.source !== "object")
  ) {
    return null;
  }

  return Object.freeze({
    id: value.id,
    name: value.name.trim(),
    kind: value.kind.trim(),
    region: typeof value.region === "string" ? value.region.trim() : null,
    major: value.major,
    source: value.source,
  });
}

function groupCharacters(characters) {
  const charactersByGroupId = new Map();

  for (const character of characters) {
    const members =
      charactersByGroupId.get(character.primaryHouseId) ?? [];
    members.push(character);
    charactersByGroupId.set(character.primaryHouseId, members);
  }

  return charactersByGroupId;
}

function renderLevelCards() {
  elements.levelCards.replaceChildren();

  for (const level of state.levels) {
    const roster = state.rosters.get(level.id) ?? [];
    const levelProgress = state.progressState.levels[level.id];
    const card = document.createElement("button");
    card.type = "button";
    card.className = "level-card";
    card.addEventListener("click", () => activateLevel(level.id));

    const name = document.createElement("strong");
    name.className = "level-card-name";
    name.textContent = level.name;

    const count = document.createElement("span");
    count.className = "level-card-count";
    count.textContent = `${levelProgress.foundIds.length} of ${roster.length} found`;

    const description = document.createElement("span");
    description.className = "level-card-description";
    description.textContent = level.description;

    const action = document.createElement("span");
    action.className = "level-card-action";
    action.textContent =
      levelProgress.foundIds.length > 0 ? "Continue level" : "Start level";

    card.append(name, count, description, action);
    elements.levelCards.append(card);
  }
}

function activateLevel(levelId, saveSelection = true) {
  setOptionsMenuOpen(false);
  const level = state.levels.find((candidate) => candidate.id === levelId);
  const sourceRoster = state.rosters.get(levelId);
  if (!level || !sourceRoster || !state.progressState) {
    showLevelPicker(false);
    return;
  }

  state.activeLevel = level;
  state.progressState = setActiveDifficulty(
    state.progressState,
    levelId,
    state.levels.map((candidate) => candidate.id),
  );

  const populatedGroupIds = new Set(
    sourceRoster.map((character) => character.primaryHouseId),
  );
  const collapsedGroups = collapseLocationGroups(
    state.allGroups.filter((group) => populatedGroupIds.has(group.id)),
  );
  state.houses = collapsedGroups.groups;
  state.characters = remapCharacterGroups(
    sourceRoster,
    collapsedGroups.groupIdBySourceId,
  );
  state.charactersById = new Map(
    state.characters.map((character) => [character.id, character]),
  );
  state.charactersByGroupId = groupCharacters(state.characters);
  state.nameIndex = buildNameIndex(state.characters, state.houses);
  state.suggestionIndex = buildSuggestionIndex(state.characters);
  hideSpellingSuggestion();

  const levelProgress = state.progressState.levels[levelId];
  state.foundIds = new Set(levelProgress.foundIds);
  state.startedAt = levelProgress.startedAt;
  state.completedAt =
    state.foundIds.size === state.characters.length
      ? levelProgress.completedAt
      : null;
  state.filterHouseId =
    levelProgress.filterHouseId === "all" ||
    state.houses.some((house) => house.id === levelProgress.filterHouseId)
      ? levelProgress.filterHouseId
      : "all";

  renderFilters();
  renderHouses();
  setMessage("", "");
  updateInterface();
  elements.activeLevelLabel.textContent = level.name;
  elements.levelPicker.hidden = true;
  elements.gameHeader.hidden = false;
  elements.guessPane.hidden = false;
  elements.gameView.hidden = false;
  cancelResetConfirmation();

  if (saveSelection) {
    persistActiveProgress();
  }
  elements.input.value = "";
  elements.input.focus({ preventScroll: true });
}

function showLevelPicker(clearSelection = true) {
  setOptionsMenuOpen(false);
  hideSpellingSuggestion();
  if (clearSelection && state.progressState) {
    persistActiveProgress(false);
    state.progressState = setActiveDifficulty(
      state.progressState,
      null,
      state.levels.map((level) => level.id),
    );
    saveProgressState(localStorage, state.progressState);
  }

  state.activeLevel = null;
  elements.gameHeader.hidden = true;
  elements.guessPane.hidden = true;
  elements.gameView.hidden = true;
  elements.levelPicker.hidden = false;
  renderLevelCards();
  elements.levelPicker.focus({ preventScroll: true });
}

function persistActiveProgress(showWarning = true) {
  if (!state.activeLevel || !state.progressState) {
    return true;
  }

  state.progressState = updateLevelProgress(
    state.progressState,
    state.activeLevel.id,
    {
      foundIds: [...state.foundIds],
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      filterHouseId: state.filterHouseId,
    },
    state.rosterIdsByLevel,
  );
  const saved = saveProgressState(localStorage, state.progressState);
  if (!saved && showWarning) {
    setMessage("Progress could not be saved in this browser.", "warning");
  }
  return saved;
}

function renderFilters() {
  elements.filterList.replaceChildren();
  elements.filterList.append(createFilterButton("all", "All houses"));

  for (const group of state.houses) {
    elements.filterList.append(createFilterButton(group.id, group.name));
  }
}

function createFilterButton(houseId, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "filter-button";
  button.textContent = label;
  button.dataset.houseId = houseId;
  button.setAttribute(
    "aria-pressed",
    String(state.filterHouseId === houseId),
  );
  button.addEventListener("click", () => {
    state.filterHouseId = houseId;
    applyHouseFilter();
    persistActiveProgress();
  });
  return button;
}

function renderHouses() {
  elements.houseList.replaceChildren();
  state.cardsByCharacterId.clear();

  for (const house of state.houses) {
    const houseCharacters = state.charactersByGroupId.get(house.id) ?? [];
    const section = document.createElement("details");
    section.className = "house-section";
    section.dataset.houseId = house.id;
    section.open = house.major || house.kind === "fallback";

    const summary = document.createElement("summary");
    const crest = document.createElement("span");
    crest.className = "house-crest";
    crest.textContent = getHouseMark(house);
    crest.setAttribute("aria-hidden", "true");

    const heading = document.createElement("span");
    heading.className = "house-heading";
    const name = document.createElement("strong");
    name.textContent = house.name;
    const words = document.createElement("span");
    words.textContent = getGroupDescription(house);
    heading.append(name, words);

    const count = document.createElement("span");
    count.className = "house-count";
    count.dataset.houseCount = house.id;
    summary.append(crest, heading, count);

    const cards = document.createElement("div");
    cards.className = "character-grid";

    for (const character of houseCharacters) {
      const card = createCharacterCard(character, house);
      const existingCards = state.cardsByCharacterId.get(character.id) ?? [];
      existingCards.push(card);
      state.cardsByCharacterId.set(character.id, existingCards);
      cards.append(card);
    }

    section.append(summary, cards);
    elements.houseList.append(section);
  }

  applyHouseFilter();
}

function createCharacterCard(character, house) {
  const card = document.createElement("article");
  card.className = "character-card";

  if (state.foundIds.has(character.id)) {
    populateRevealedCard(card, character, house);
  } else {
    populateHiddenCard(card, house);
  }

  return card;
}

function populateHiddenCard(card, house) {
  card.replaceChildren();
  card.classList.remove("character-card-revealed");

  const silhouette = document.createElement("div");
  silhouette.className = "silhouette";
  silhouette.setAttribute("aria-hidden", "true");
  const mark = document.createElement("span");
  mark.className = "silhouette-mark";
  mark.textContent = getHouseMark(house);
  silhouette.append(mark);

  const hiddenName = document.createElement("p");
  hiddenName.className = "hidden-name";
  hiddenName.textContent = "Unknown";
  card.append(silhouette, hiddenName);
}

function populateRevealedCard(card, character, house) {
  card.replaceChildren();
  card.classList.add("character-card-revealed");

  const portrait = document.createElement("img");
  portrait.className = "portrait";
  portrait.alt = `Portrait of ${character.name}`;
  portrait.loading = "lazy";
  portrait.decoding = "async";
  const portraitCandidates = getPortraitCandidates(character, house);
  let portraitCandidateIndex = 0;
  portrait.src = portraitCandidates[portraitCandidateIndex];
  portrait.addEventListener("error", () => {
    portraitCandidateIndex += 1;
    if (portraitCandidateIndex < portraitCandidates.length) {
      portrait.src = portraitCandidates[portraitCandidateIndex];
    }
  });

  const details = document.createElement("div");
  details.className = "character-details";
  const name = document.createElement("h3");
  name.textContent = character.name;
  const allegiance = document.createElement("p");
  allegiance.textContent = house.name;
  details.append(name, allegiance);

  const wikiUrl = buildWikiUrl(character);
  const wikiLink = document.createElement("a");
  wikiLink.className = "character-card-link";
  wikiLink.href = wikiUrl ?? "https://awoiaf.westeros.org/";
  wikiLink.target = "_blank";
  wikiLink.rel = "noopener noreferrer";
  wikiLink.title = `Open ${character.name} on A Wiki of Ice and Fire`;
  wikiLink.setAttribute(
    "aria-label",
    `Read about ${character.name} on A Wiki of Ice and Fire`,
  );

  card.append(portrait, details, wikiLink);
}

function getPortraitCandidates(character, house) {
  const candidates = [];

  if (
    typeof character.portraitPath === "string" &&
    isSafeLocalPath(character.portraitPath)
  ) {
    candidates.push(`${PORTRAIT_ASSET_ROOT}${character.portraitPath}`);
  }

  candidates.push(getHousePlaceholder(house), DEFAULT_PORTRAIT);
  return [...new Set(candidates)];
}

function getHousePlaceholder(house) {
  const houseNameWords =
    house.name.toLocaleLowerCase("en-US").match(/\p{L}+/gu) ?? [];
  const placeholder = HOUSE_PLACEHOLDERS.find(([houseName]) =>
    houseNameWords.includes(houseName),
  );
  return placeholder?.[1] ?? DEFAULT_PORTRAIT;
}

function isSafeLocalPath(path) {
  return (
    path.length > 0 &&
    LOCAL_PATH_PATTERN.test(path) &&
    !path.startsWith("/") &&
    !path.includes("..")
  );
}

function getHouseMark(house) {
  const words = house.name.trim().split(/\s+/u);
  const initials = words
    .filter((word) => word.length > 0)
    .slice(-2)
    .map((word) => word[0])
    .join("");
  return initials.toLocaleUpperCase("en-US") || "•";
}

function getGroupDescription(group) {
  const kind =
    group.kind.length > 0
      ? `${group.kind[0].toLocaleUpperCase("en-US")}${group.kind.slice(1)}`
      : "Group";
  return [group.region, kind].filter(Boolean).join(" · ");
}

function handleSpellingHelperToggle() {
  state.spellingHelperEnabled = elements.spellingHelperToggle.checked;
  if (!state.spellingHelperEnabled) {
    hideSpellingSuggestion();
  } else {
    queueSpellingSuggestion(elements.input.value);
  }
  persistSettings();
}

function handleAutoScrollToggle() {
  state.autoScrollEnabled = elements.autoScrollToggle.checked;
  persistSettings();
}

function handleDarkModeToggle() {
  state.darkModeEnabled = elements.darkModeToggle.checked;
  applyTheme();
  persistSettings();
}

function syncSettingsControls() {
  elements.autoScrollToggle.checked = state.autoScrollEnabled;
  elements.darkModeToggle.checked = state.darkModeEnabled;
  elements.spellingHelperToggle.checked = state.spellingHelperEnabled;
}

function applyTheme() {
  document.documentElement.classList.toggle(
    "light-theme",
    !state.darkModeEnabled,
  );
}

function persistSettings() {
  const saved = saveSettings(localStorage, {
    autoScrollEnabled: state.autoScrollEnabled,
    darkModeEnabled: state.darkModeEnabled,
    spellingHelperEnabled: state.spellingHelperEnabled,
  });
  if (!saved) {
    setMessage("Options could not be saved in this browser.", "warning");
  }
}

function toggleOptionsMenu() {
  setOptionsMenuOpen(elements.optionsMenu.hidden);
}

function setOptionsMenuOpen(open) {
  elements.optionsMenu.hidden = !open;
  elements.optionsButton.setAttribute("aria-expanded", String(open));
}

function handleDocumentClick(event) {
  if (
    event.target instanceof Element &&
    !event.target.closest(".options-wrap")
  ) {
    setOptionsMenuOpen(false);
  }
}

function handleDocumentKeydown(event) {
  if (event.key === "Escape" && !elements.optionsMenu.hidden) {
    setOptionsMenuOpen(false);
    elements.optionsButton.focus({ preventScroll: true });
    return;
  }

  if (!shouldFocusGuessInput(event)) {
    return;
  }

  setOptionsMenuOpen(false);
  elements.input.focus({ preventScroll: true });
}

function shouldFocusGuessInput(event) {
  if (
    state.activeLevel === null ||
    elements.input.disabled ||
    event.defaultPrevented ||
    event.isComposing ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.key.length !== 1
  ) {
    return false;
  }

  const target = event.target;
  if (
    target === elements.input ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement &&
      !["button", "checkbox", "radio", "reset", "submit"].includes(
        target.type,
      )) ||
    (target instanceof HTMLElement && target.isContentEditable)
  ) {
    return false;
  }

  return !(
    event.key === " " &&
    target instanceof Element &&
    target.closest("button, a, input, label, summary")
  );
}

function queueSpellingSuggestion(guess) {
  hideSpellingSuggestion();
  if (!state.spellingHelperEnabled || !guess.trim()) {
    return;
  }

  spellingSuggestionTimeoutId = window.setTimeout(() => {
    spellingSuggestionTimeoutId = null;
    if (elements.input.value !== guess) {
      return;
    }
    const suggestion = findClosestName(guess, state.suggestionIndex);
    if (suggestion === null) {
      hideSpellingSuggestion();
      return;
    }
    showSpellingSuggestion(suggestion);
  }, SPELLING_SUGGESTION_DELAY_MS);
}

function showSpellingSuggestion(suggestion) {
  state.spellingSuggestion = suggestion;
  elements.spellingSuggestion.textContent = `Did you mean “${suggestion}”?`;
  elements.spellingSuggestion.setAttribute(
    "aria-label",
    `Use suggested spelling: ${suggestion}`,
  );
  elements.spellingSuggestion.hidden = false;
}

function hideSpellingSuggestion() {
  if (spellingSuggestionTimeoutId !== null) {
    window.clearTimeout(spellingSuggestionTimeoutId);
    spellingSuggestionTimeoutId = null;
  }
  state.spellingSuggestion = null;
  elements.spellingSuggestion.hidden = true;
  elements.spellingSuggestion.textContent = "";
  elements.spellingSuggestion.removeAttribute("aria-label");
}

function applySpellingSuggestion() {
  if (state.spellingSuggestion === null) {
    return;
  }

  const suggestion = state.spellingSuggestion;
  elements.input.value = suggestion;
  skipNextEmptySubmit = false;
  hideSpellingSuggestion();
  processGuess(suggestion, {
    announceAlreadyFound: true,
    announceNoMatch: true,
  });
}

function handleGuess(event) {
  event.preventDefault();
  if (skipNextEmptySubmit && !elements.input.value.trim()) {
    skipNextEmptySubmit = false;
    return;
  }

  skipNextEmptySubmit = false;
  processGuess(elements.input.value, {
    announceAlreadyFound: true,
    announceNoMatch: true,
  });
}

function handleGuessInput() {
  skipNextEmptySubmit = false;
  const guess = elements.input.value;
  if (!guess.trim()) {
    hideSpellingSuggestion();
    return;
  }

  if (state.startedAt === null) {
    state.startedAt = Date.now();
    persistActiveProgress();
  }

  const matchedIds = matchExactName(guess, state.nameIndex);
  if (matchedIds.length === 0) {
    queueSpellingSuggestion(guess);
    return;
  }
  hideSpellingSuggestion();

  if (
    processGuess(guess, {
      announceAlreadyFound: false,
      announceNoMatch: false,
      matchedIds,
    })
  ) {
    skipNextEmptySubmit = true;
  }
}

function processGuess(
  guess,
  { announceAlreadyFound, announceNoMatch, matchedIds = null },
) {
  if (!guess.trim()) {
    if (announceNoMatch) {
      setMessage("Enter a full character name.", "error");
      elements.input.focus();
    }
    return false;
  }

  if (state.startedAt === null) {
    state.startedAt = Date.now();
    persistActiveProgress();
  }

  const exactMatchIds = matchedIds ?? matchExactName(guess, state.nameIndex);
  const newlyFoundIds = exactMatchIds.filter((id) => !state.foundIds.has(id));

  if (exactMatchIds.length === 0) {
    if (announceNoMatch) {
      setMessage("No exact match. Check the full name and try again.", "error");
      persistActiveProgress();
    }
    return false;
  }
  hideSpellingSuggestion();

  if (newlyFoundIds.length === 0) {
    if (announceAlreadyFound) {
      setMessage("That name has already been claimed.", "warning");
      elements.input.select();
    }
    return false;
  }

  for (const id of newlyFoundIds) {
    state.foundIds.add(id);
    revealCharacter(id);
  }

  if (state.foundIds.size === state.characters.length) {
    state.completedAt = Date.now();
  }

  const revealedNames = newlyFoundIds
    .map((id) => state.charactersById.get(id)?.name)
    .filter(Boolean);
  setMessage(`Revealed: ${revealedNames.join(", ")}.`, "success");
  elements.input.value = "";
  updateInterface();
  persistActiveProgress();
  elements.input.focus({ preventScroll: true });
  scrollToRevealedCharacter(newlyFoundIds[0]);
  return true;
}

function revealCharacter(characterId) {
  const character = state.charactersById.get(characterId);
  if (!character) {
    return;
  }

  const house = state.houses.find(
    (candidate) => candidate.id === character.primaryHouseId,
  );
  if (!house) {
    return;
  }

  for (const card of state.cardsByCharacterId.get(characterId) ?? []) {
    populateRevealedCard(card, character, house);
    card.classList.remove("reveal-pulse");
    requestAnimationFrame(() => card.classList.add("reveal-pulse"));
  }
}

function scrollToRevealedCharacter(characterId) {
  const card = state.cardsByCharacterId.get(characterId)?.[0];
  if (!card) {
    return;
  }

  const section = card.closest(".house-section");
  if (section instanceof HTMLDetailsElement) {
    section.open = true;
    if (section.hidden && typeof section.dataset.houseId === "string") {
      state.filterHouseId = section.dataset.houseId;
      applyHouseFilter();
      persistActiveProgress();
    }
  }

  if (!state.autoScrollEnabled) {
    return;
  }

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      card.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "center",
        inline: "nearest",
      });
    });
  });
}

function updateInterface() {
  const foundCount = state.foundIds.size;
  const totalCount = state.characters.length;
  const percent = totalCount === 0 ? 0 : (foundCount / totalCount) * 100;

  elements.foundCount.textContent = String(foundCount);
  elements.totalCount.textContent = String(totalCount);
  elements.progress.max = Math.max(totalCount, 1);
  elements.progress.value = foundCount;
  elements.progress.textContent = `${Math.round(percent)}%`;
  elements.progressLabel.textContent = `${Math.round(percent)}%`;

  for (const house of state.houses) {
    const houseCharacters = state.charactersByGroupId.get(house.id) ?? [];
    const houseFoundCount = houseCharacters.filter((character) =>
      state.foundIds.has(character.id),
    ).length;
    const count = elements.houseList.querySelector(
      `[data-house-count="${house.id}"]`,
    );
    if (count) {
      count.textContent = `${houseFoundCount}/${houseCharacters.length}`;
      count.setAttribute(
        "aria-label",
        `${houseFoundCount} of ${houseCharacters.length} names found`,
      );
    }
  }

  if (totalCount > 0 && foundCount === totalCount) {
    setMessage("The realm is complete. Every recorded name is yours.", "success");
  }

  updateTimer();
}

function applyHouseFilter() {
  for (const section of elements.houseList.querySelectorAll(".house-section")) {
    section.hidden =
      state.filterHouseId !== "all" &&
      section.dataset.houseId !== state.filterHouseId;
  }

  for (const button of elements.filterList.querySelectorAll(".filter-button")) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.houseId === state.filterHouseId),
    );
  }
}

function startTimerUpdates() {
  updateTimer();
  if (state.timerIntervalId === null) {
    state.timerIntervalId = window.setInterval(updateTimer, 1000);
  }
}

function updateTimer() {
  const endTime = state.completedAt ?? Date.now();
  const elapsedMilliseconds =
    state.startedAt === null ? 0 : Math.max(0, endTime - state.startedAt);
  const elapsedSeconds = Math.floor(elapsedMilliseconds / 1000);
  elements.timer.textContent = formatDuration(elapsedSeconds);
  elements.timer.dateTime = `PT${elapsedSeconds}S`;
}

function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const minuteSeconds = `${String(minutes).padStart(2, "0")}:${String(
    seconds,
  ).padStart(2, "0")}`;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${minuteSeconds}`
    : minuteSeconds;
}

function handleResetClick() {
  if (elements.resetButton.dataset.confirming !== "true") {
    elements.resetButton.dataset.confirming = "true";
    elements.resetButton.textContent = "Confirm reset";
    setMessage(
      "Select Confirm reset to erase progress from every level.",
      "warning",
    );
    resetConfirmationTimeoutId = window.setTimeout(
      cancelResetConfirmation,
      5000,
    );
    return;
  }

  if (resetConfirmationTimeoutId !== null) {
    window.clearTimeout(resetConfirmationTimeoutId);
  }
  cancelResetConfirmation();

  if (!state.activeLevel || !state.progressState) {
    return;
  }

  state.progressState = resetAllProgress(state.progressState);
  state.foundIds.clear();
  state.startedAt = null;
  state.completedAt = null;
  state.filterHouseId = "all";
  hideSpellingSuggestion();
  saveProgressState(localStorage, state.progressState);

  for (const character of state.characters) {
    const house = state.houses.find(
      (candidate) => candidate.id === character.primaryHouseId,
    );
    if (!house) {
      continue;
    }
    for (const card of state.cardsByCharacterId.get(character.id) ?? []) {
      populateHiddenCard(card, house);
    }
  }

  applyHouseFilter();
  updateInterface();
  setMessage("Game reset. Names are hidden in every level.", "success");
  elements.input.value = "";
  elements.input.focus();
}

function cancelResetConfirmation() {
  if (resetConfirmationTimeoutId !== null) {
    window.clearTimeout(resetConfirmationTimeoutId);
  }
  elements.resetButton.dataset.confirming = "false";
  elements.resetButton.textContent = "Reset game";
  resetConfirmationTimeoutId = null;
}

function setMessage(message, type) {
  elements.message.textContent = message;
  elements.message.dataset.type = type;
}

function getRequiredElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Required interface element is missing: ${id}`);
  }
  return element;
}
