let endTime = null;
let currentMinutes = 0;
let autoGroup = true;
let autoUngroup = true;
let isRunning = false;
let isGrouping = false;

const tabStates = {};
let ungroupQueue = new Map();
let isProcessingUngroup = false;
const UNGROUP_DELAY = 10000; // 10 seconds

// UTIL HELPERS
function clearTimer() {
  chrome.alarms.clear("inactiveTimer");
  isRunning = false;
  endTime = null;
}

function notifyPopup(message) {
  chrome.runtime.sendMessage(message, () => {
    if (chrome.runtime.lastError) {
      // ignore
    }
  });
}

function getStatus() {
  return {
    isRunning,
    currentMinutes,
    autoGroup,
    endTime,
  };
}

// Initialize tab states immediately on startup
async function initializeTabStates(existingInactiveGroupId = null) {
  const now = Date.now();

  try {
    const tabs = await chrome.tabs.query({});
    let normalTabCount = 0;
    let groupedTabCount = 0;

    for (const tab of tabs) {
      try {
        const window = await chrome.windows.get(tab.windowId);
        if (window.type === "normal") {
          const isInInactiveGroup =
            existingInactiveGroupId && tab.groupId === existingInactiveGroupId;

          if (isInInactiveGroup) {
            tabStates[tab.id] = {
              lastAccessed: now - 365 * 24 * 60 * 60 * 1000,
              isHidden: false,
              isActive: false,
            };
            groupedTabCount++;
          } else {
            tabStates[tab.id] = {
              lastAccessed: now,
              isHidden: false,
              isActive: tab.active,
            };
            normalTabCount++;
          }
        }
      } catch (err) {
        // Skip tab if window check fails
      }
    }
  } catch (err) {
    // Handle initialization error silently
  }
}

// GROUP INACTIVE TABS
async function groupInactiveTabs(minutes) {
  if (isGrouping) {
    notifyPopup({ type: "ERROR", message: "Grouping already in progress" });
    return;
  }

  isGrouping = true;

  const timeoutId = setTimeout(() => {
    isGrouping = false;
    notifyPopup({
      type: "ERROR",
      message: "Grouping timed out, please try again",
    });
  }, 30000);

  try {
    const now = Date.now();
    const tabs = await chrome.tabs.query({});

    const normalTabs = [];
    for (const tab of tabs) {
      try {
        const window = await chrome.windows.get(tab.windowId);
        if (window.type === "normal") {
          normalTabs.push(tab);
        }
      } catch (err) {
        // Skip tab
      }
    }

    for (const t of normalTabs) {
      if (!tabStates[t.id]) {
        tabStates[t.id] = {
          lastAccessed: t.lastAccessed || now,
          isHidden: false,
          isActive: t.active,
        };
      }
      if (t.active) {
        tabStates[t.id].lastAccessed = now;
        tabStates[t.id].isActive = true;
      }
    }

    const inactiveTabs = normalTabs.filter((t) => {
      const state = tabStates[t.id];
      if (!state) return false;

      const timeSinceAccess = now - state.lastAccessed;
      const isInactive = timeSinceAccess > minutes * 60 * 1000;

      return !t.active && !t.pinned && !t.audible && isInactive;
    });

    const stored = await chrome.storage.local.get("minGroupTabs");
    const minGroupTabs = stored.minGroupTabs || 5;

    if (inactiveTabs.length < minGroupTabs) {
      notifyPopup({ type: "NOT_ENOUGH_TABS", required: minGroupTabs });
      clearTimeout(timeoutId);
      return;
    }

    notifyPopup({ type: "GROUPING_STARTED" });

    const ids = inactiveTabs.map((t) => t.id);

    let targetGroupId = await getInactiveGroupId();
    targetGroupId = await validateGroupId(targetGroupId);

    if (!targetGroupId) {
      const groups = await chrome.tabGroups.query({});
      const existing = groups.find((g) => g.title === "Inactive Tabs");

      if (existing) {
        targetGroupId = existing.id;
        await saveInactiveGroupId(targetGroupId);
      }
    }

    if (!targetGroupId) {
      targetGroupId = await chrome.tabs.group({ tabIds: [ids[0]] });
      await chrome.tabGroups.update(targetGroupId, {
        title: "Inactive Tabs",
        collapsed: true,
      });
      await saveInactiveGroupId(targetGroupId);
      ids.shift();
    }

    if (ids.length > 0) {
      await chrome.tabs.group({ groupId: targetGroupId, tabIds: ids });
    }

    inactiveTabs.forEach((t) => {
      tabStates[t.id].isHidden = false;
      tabStates[t.id].isActive = false;
    });

    clearTimeout(timeoutId);
    notifyPopup({
      type: "GROUPING_COMPLETE",
      grouped: inactiveTabs.length,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    notifyPopup({ type: "ERROR", message: err.message });
  } finally {
    isGrouping = false;
  }
}

// AUTO START TIMER
function autoStartTimer(minutes) {
  if (isRunning) {
    return;
  }

  clearTimer();
  currentMinutes = minutes;
  autoGroup = true;
  endTime = Date.now() + minutes * 60 * 1000;
  isRunning = true;

  chrome.alarms.create("inactiveTimer", { delayInMinutes: minutes });
  notifyPopup({ type: "TIMER_STARTED", minutes });
}

// AUTO STOP TIMER
function autoStopTimer() {
  clearTimer();
  notifyPopup({ type: "STOPPED" });
}

function cleanupTabStates() {
  chrome.tabs.query({}, (tabs) => {
    const activeTabs = new Set(tabs.map((t) => t.id));
    const stateKeys = Object.keys(tabStates);

    stateKeys.forEach((tabIdStr) => {
      const tabId = parseInt(tabIdStr, 10);
      if (!activeTabs.has(tabId)) {
        delete tabStates[tabId];
      }
    });
  });
}

async function saveInactiveGroupId(groupId) {
  await chrome.storage.local.set({ inactiveGroupId: groupId });
}

async function getInactiveGroupId() {
  const data = await chrome.storage.local.get("inactiveGroupId");
  return data.inactiveGroupId || null;
}

async function validateGroupId(groupId) {
  if (!groupId) return null;

  try {
    const group = await chrome.tabGroups.get(groupId);
    if (group && group.title === "Inactive Tabs") {
      return groupId;
    }
  } catch (err) {
    // Group no longer exists
  }

  await chrome.storage.local.remove("inactiveGroupId");
  return null;
}

async function handleGroupNow(minutes) {
  if (isGrouping) {
    notifyPopup({ type: "ERROR", message: "Grouping already in progress" });
    return;
  }

  await groupInactiveTabs(minutes);
}

// Process ungroup queue with 10 second delay
async function processUngroupQueue() {
  if (isProcessingUngroup) return;

  isProcessingUngroup = true;
  const now = Date.now();

  try {
    const toDelete = [];

    for (const [tabId, activatedTime] of ungroupQueue.entries()) {
      // Check if 10 seconds have passed since tab was first activated
      if (now - activatedTime >= UNGROUP_DELAY) {
        try {
          if (autoUngroup) {
            const tab = await chrome.tabs.get(tabId);

            // Verify the tab is still active before ungrouping
            if (tab.active) {
              const groupId = tab.groupId;

              if (groupId && groupId !== -1) {
                const group = await chrome.tabGroups.get(groupId);

                if (group && group.title === "Inactive Tabs") {
                  await chrome.tabs.ungroup([tabId]);

                  const remaining = await chrome.tabs.query({ groupId });
                  if (remaining.length > 0) {
                    await chrome.tabGroups.update(groupId, { collapsed: true });
                  }
                }
              }
            } else {
              // Tab is no longer active, remove from queue without ungrouping
              toDelete.push(tabId);
            }
          }
          toDelete.push(tabId);
        } catch (err) {
          toDelete.push(tabId);
        }
      }
    }

    // Remove processed tabs from queue
    toDelete.forEach((tabId) => ungroupQueue.delete(tabId));
  } catch (err) {
    // Handle queue processing error
  } finally {
    isProcessingUngroup = false;
  }
}

// LISTENERS
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "GET_STATUS":
        sendResponse(getStatus());
        break;
      case "STOP":
        autoStopTimer();
        break;
      case "GROUP_NOW":
        await handleGroupNow(msg.minutes || currentMinutes || 30);
        break;
      case "FORCE_RESET":
        clearTimer();
        isGrouping = false;
        isProcessingUngroup = false;
        ungroupQueue.clear();

        let resetGroupId = null;
        try {
          const groups = await chrome.tabGroups.query({});
          const inactiveGroup = groups.find((g) => g.title === "Inactive Tabs");
          if (inactiveGroup) {
            resetGroupId = inactiveGroup.id;
          }
        } catch (err) {
          // Handle error silently
        }

        await initializeTabStates(resetGroupId);

        await chrome.storage.local.set({
          sessionReady: true,
          sessionStartTime: Date.now(),
        });

        notifyPopup({ type: "STOPPED" });
        sendResponse({ success: true });
        break;
      default:
      // Unknown message type
    }
  })();
  return true;
});

// Auto checker - runs every 2 minutes
chrome.runtime.onInstalled.addListener(async () => {
  isRunning = false;
  endTime = null;
  currentMinutes = 0;
  isGrouping = false;
  isProcessingUngroup = false;
  ungroupQueue.clear();
  Object.keys(tabStates).forEach((key) => delete tabStates[key]);

  await chrome.alarms.clearAll();

  let validGroupId = null;
  try {
    const groups = await chrome.tabGroups.query({});
    const inactiveGroup = groups.find((g) => g.title === "Inactive Tabs");

    if (inactiveGroup) {
      validGroupId = inactiveGroup.id;
      await saveInactiveGroupId(validGroupId);
    } else {
      const storedGroupId = await getInactiveGroupId();
      validGroupId = await validateGroupId(storedGroupId);
    }
  } catch (err) {
    // Handle error silently
  }

  await initializeTabStates(validGroupId);

  chrome.alarms.create("autoChecker", { periodInMinutes: 2 });
  chrome.alarms.create("cleanupStates", { periodInMinutes: 10 });
  chrome.alarms.create("ungroupProcessor", { periodInMinutes: 0.1 });

  await chrome.storage.local.set({
    sessionReady: true,
    sessionStartTime: Date.now(),
  });
});

chrome.runtime.onStartup.addListener(async () => {
  isRunning = false;
  endTime = null;
  currentMinutes = 0;
  isGrouping = false;
  isProcessingUngroup = false;
  ungroupQueue.clear();
  Object.keys(tabStates).forEach((key) => delete tabStates[key]);

  await chrome.alarms.clearAll();
  await initializeTabStates();

  const storedGroupId = await getInactiveGroupId();
  const validGroupId = await validateGroupId(storedGroupId);

  chrome.alarms.create("autoChecker", { periodInMinutes: 2 });
  chrome.alarms.create("cleanupStates", { periodInMinutes: 10 });
  chrome.alarms.create("ungroupProcessor", { periodInMinutes: 0.1 });

  await chrome.storage.local.set({
    sessionReady: true,
    sessionStartTime: Date.now(),
  });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "inactiveTimer") {
    await groupInactiveTabs(currentMinutes);
    clearTimer();
  }

  if (alarm.name === "autoChecker") {
    try {
      const allTabs = await chrome.tabs.query({});

      const normalTabsPromises = allTabs.map(async (tab) => {
        try {
          const window = await chrome.windows.get(tab.windowId);
          return window.type === "normal" ? tab : null;
        } catch {
          return null;
        }
      });

      const normalTabsResults = await Promise.all(normalTabsPromises);
      const normalTabs = normalTabsResults.filter((t) => t !== null);

      const countableTabs = normalTabs.filter((t) => {
        return (
          !t.pinned &&
          !t.audible &&
          (t.groupId === -1 || t.groupId === undefined)
        );
      });

      const stored = await chrome.storage.local.get([
        "minutes",
        "minGroupTabs",
      ]);
      const minutes = stored.minutes || 30;
      const minGroupTabs = stored.minGroupTabs || 5;

      if (countableTabs.length >= 10 && !isRunning) {
        autoStartTimer(minutes);
      }

      if (countableTabs.length < minGroupTabs && isRunning) {
        autoStopTimer();
      }
    } catch (err) {
      // Handle error silently
    }
  }

  if (alarm.name === "cleanupStates") {
    cleanupTabStates();
  }

  if (alarm.name === "ungroupProcessor") {
    await processUngroupQueue();
  }
});

chrome.tabs.onActivated.addListener(async (info) => {
  const tabId = info.tabId;
  const now = Date.now();

  if (tabStates[tabId]) {
    tabStates[tabId].isActive = true;
    tabStates[tabId].lastAccessed = now;
    tabStates[tabId].isHidden = false;
  } else {
    tabStates[tabId] = {
      lastAccessed: now,
      isHidden: false,
      isActive: true,
    };
  }

  try {
    const tab = await chrome.tabs.get(tabId);

    if (tab.groupId && tab.groupId !== -1) {
      const group = await chrome.tabGroups.get(tab.groupId);

      if (group && group.title === "Inactive Tabs") {
        // Only add to queue if not already there (don't reset timer)
        if (!ungroupQueue.has(tabId)) {
          ungroupQueue.set(tabId, now);
        }
      }
    }
  } catch (err) {
    // Handle error silently
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Update tab state on page load/navigation
  if (changeInfo.status === "complete" || changeInfo.url) {
    const now = Date.now();
    if (tabStates[tabId]) {
      tabStates[tabId].lastAccessed = now;
    } else {
      tabStates[tabId] = {
        lastAccessed: now,
        isHidden: false,
        isActive: tab.active,
      };
    }
  }

  // Remove from ungroup queue if tab becomes inactive while loading
  if (changeInfo.active === false && ungroupQueue.has(tabId)) {
    ungroupQueue.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabStates[tabId]) {
    delete tabStates[tabId];
  }

  ungroupQueue.delete(tabId);
});

chrome.tabGroups.onRemoved.addListener(async (group) => {
  const storedId = await getInactiveGroupId();
  if (storedId === group.id) {
    await chrome.storage.local.remove("inactiveGroupId");
  }
});

chrome.runtime.onSuspend.addListener(async () => {
  clearTimer();
  isGrouping = false;
  isProcessingUngroup = false;
  ungroupQueue.clear();
  Object.keys(tabStates).forEach((key) => delete tabStates[key]);

  await chrome.storage.local.set({
    sessionClean: true,
    lastCloseTime: Date.now(),
  });
});
