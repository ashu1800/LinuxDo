// Storage layer - chrome.storage.local wrapper with defaults
// All state persisted for service worker wake/sleep cycles

const STORAGE_KEYS = {
  SETTINGS: 'settings',
  STATE: 'state',
  ACTIVITY_LOG: 'activityLog'
};

const DEFAULT_SETTINGS = {
  apiKey: '',
  schedule: {
    Sun: { enabled: false, start: '09:00', end: '12:00', breakStart: '14:00', breakEnd: '18:00' },
    Mon: { enabled: true, start: '09:00', end: '12:00', breakStart: '14:00', breakEnd: '18:00' },
    Tue: { enabled: true, start: '09:00', end: '12:00', breakStart: '14:00', breakEnd: '18:00' },
    Wed: { enabled: true, start: '09:00', end: '12:00', breakStart: '14:00', breakEnd: '18:00' },
    Thu: { enabled: true, start: '09:00', end: '12:00', breakStart: '14:00', breakEnd: '18:00' },
    Fri: { enabled: true, start: '09:00', end: '12:00', breakStart: '14:00', breakEnd: '18:00' },
    Sat: { enabled: false, start: '09:00', end: '12:00', breakStart: '14:00', breakEnd: '18:00' }
  },
  selectedCategories: [],
  replyFrequency: 'moderate',
  replyLanguage: 'zh-CN',
  autoReplyComments: true,
  maxRepliesPerHour: 8,
  minReplyInterval: 5
};

const DEFAULT_STATE = {
  isPaused: false,
  trackedTopics: {},
  trackedNotifications: {},
  replyHistory: [],
  lastReplyTime: 0,
  replyCountThisHour: 0,
  replyHourStart: 0
};

async function getStorage() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.STATE,
    STORAGE_KEYS.ACTIVITY_LOG
  ]);
  return {
    settings: result[STORAGE_KEYS.SETTINGS] || freshDefaults(DEFAULT_SETTINGS),
    state: result[STORAGE_KEYS.STATE] || freshDefaults(DEFAULT_STATE),
    activityLog: result[STORAGE_KEYS.ACTIVITY_LOG] || []
  };
}

/**
 * Deep clone a defaults object to avoid shared array/object references
 */
function freshDefaults(obj) {
  return JSON.parse(JSON.stringify(obj));
}

async function getSettings() {
  const { settings } = await getStorage();
  return settings;
}

async function setSettings(partial) {
  const current = await getSettings();
  const merged = deepMerge(current, partial);
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: merged });
  return merged;
}

async function getState() {
  const { state } = await getStorage();
  return state;
}

async function setState(partial) {
  const current = await getState();
  const merged = deepMerge(current, partial);
  await chrome.storage.local.set({ [STORAGE_KEYS.STATE]: merged });
  return merged;
}

async function addActivity(entry) {
  const result = await chrome.storage.local.get([STORAGE_KEYS.ACTIVITY_LOG]);
  const log = result[STORAGE_KEYS.ACTIVITY_LOG] || [];
  log.unshift({
    time: Date.now(),
    ...entry
  });
  // Keep last 500 entries
  if (log.length > 500) log.length = 500;
  await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVITY_LOG]: log });
  return log;
}

async function getActivityLog() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.ACTIVITY_LOG]);
  return result[STORAGE_KEYS.ACTIVITY_LOG] || [];
}

async function resetState() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.STATE]: { ...DEFAULT_STATE, trackedTopics: {}, trackedNotifications: {}, replyHistory: [] },
    [STORAGE_KEYS.ACTIVITY_LOG]: []
  });
}

async function initStorage() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.STATE
  ]);
  if (!result[STORAGE_KEYS.SETTINGS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: freshDefaults(DEFAULT_SETTINGS) });
  }
  if (!result[STORAGE_KEYS.STATE]) {
    await resetState();
  }
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}