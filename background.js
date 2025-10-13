let endTime = null;
let currentMinutes = 0;
let autoGroup = true;
let autoUngroup = true;
let isRunning = false;
let isGrouping = false;

const tabStates = {};
let ungroupQueue = new Map();
let isProcessingUngroup = false;
const UNGROUP_DELAY = 5000;

// UTIL HELPERS
function clearTimer() {
  chrome.alarms.clear("inactiveTimer");
  isRunning = false;
  endTime = null;
  console.log("[Timer] Cleared (inactiveTimer)");
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
  console.log("[Init] Initializing tab states...");
  const now = Date.now();

  try {
    const tabs = await chrome.tabs.query({});
    let normalTabCount = 0;
    let groupedTabCount = 0;

    for (const tab of tabs) {
      try {
        const window = await chrome.windows.get(tab.windowId);
        if (window.type === "normal") {
          // Check if tab is in the "Inactive Tabs" group
          const isInInactiveGroup =
            existingInactiveGroupId && tab.groupId === existingInactiveGroupId;

          if (isInInactiveGroup) {
            // Tab is already grouped - give it a very old timestamp so it stays grouped
            tabStates[tab.id] = {
              lastAccessed: now - 365 * 24 * 60 * 60 * 1000, // 1 year ago
              isHidden: false,
              isActive: false,
            };
            groupedTabCount++;
            console.log(
              `[Init] Tab ${tab.id} is in "Inactive Tabs" group - preserving`
            );
          } else {
            // Regular ungrouped tab  (fresh start)
            tabStates[tab.id] = {
              lastAccessed: now,
              isHidden: false,
              isActive: tab.active,
            };
            normalTabCount++;
          }
        }
      } catch (err) {
        console.warn(`[Init] Could not get window for tab ${tab.id}`);
      }
    }

    console.log(
      `[Init] Initialized ${normalTabCount} ungrouped tabs, preserved ${groupedTabCount} grouped tabs`
    );
  } catch (err) {
    console.error("[Init] Error initializing tab states:", err);
  }
}

// GROUP INACTIVE TABS
async function groupInactiveTabs(minutes) {
  if (isGrouping) {
    console.log("[Group] Already grouping, skipping duplicate call");
    notifyPopup({ type: "ERROR", message: "Grouping already in progress" });
    return;
  }

  isGrouping = true;

  const timeoutId = setTimeout(() => {
    console.error(
      "[Group] Operation timed out after 30 seconds, force unlocking"
    );
    isGrouping = false;
    notifyPopup({
      type: "ERROR",
      message: "Grouping timed out, please try again",
    });
  }, 30000);

  try {
    const now = Date.now();
    const tabs = await chrome.tabs.query({});

    // Filter tabs to only include those in normal windows
    const normalTabs = [];
    for (const tab of tabs) {
      try {
        const window = await chrome.windows.get(tab.windowId);
        if (window.type === "normal") {
          normalTabs.push(tab);
        }
      } catch (err) {
        console.warn(`[Group] Could not get window for tab ${tab.id}`);
      }
    }

    // Update tabStates for all normal tabs
    for (const t of normalTabs) {
      if (!tabStates[t.id]) {
        tabStates[t.id] = {
          lastAccessed: t.lastAccessed || now,
          isHidden: false,
          isActive: t.active,
        };
      }
      // Update active tab's last accessed time
      if (t.active) {
        tabStates[t.id].lastAccessed = now;
        tabStates[t.id].isActive = true;
      }
    }

    // Find inactive tabs (only from normal windows)
    const inactiveTabs = normalTabs.filter((t) => {
      const state = tabStates[t.id];
      if (!state) return false;

      const timeSinceAccess = now - state.lastAccessed;
      const isInactive = timeSinceAccess > minutes * 60 * 1000;

      return !t.active && !t.pinned && !t.audible && isInactive;
    });

    console.log(
      `[Group] Found ${inactiveTabs.length} inactive tabs after ${minutes} min`
    );

    const stored = await chrome.storage.local.get("minGroupTabs");
    const minGroupTabs = stored.minGroupTabs || 5;

    if (inactiveTabs.length < minGroupTabs) {
      console.log(
        `[Group] Not enough inactive tabs (need at least ${minGroupTabs})`
      );
      notifyPopup({ type: "NOT_ENOUGH_TABS", required: minGroupTabs });
      clearTimeout(timeoutId);
      return;
    }

    notifyPopup({ type: "GROUPING_STARTED" });

    const ids = inactiveTabs.map((t) => t.id);

    // Check stored group ID first
    let targetGroupId = await getInactiveGroupId();
    targetGroupId = await validateGroupId(targetGroupId);

    // If no valid stored group, search for existing group
    if (!targetGroupId) {
      const groups = await chrome.tabGroups.query({});
      const existing = groups.find((g) => g.title === "Inactive Tabs");

      if (existing) {
        targetGroupId = existing.id;
        await saveInactiveGroupId(targetGroupId);
        console.log(
          `[Group] Found existing "Inactive Tabs" group (${targetGroupId})`
        );
      }
    }

    // Create new group if still none found
    if (!targetGroupId) {
      targetGroupId = await chrome.tabs.group({ tabIds: [ids[0]] });
      await chrome.tabGroups.update(targetGroupId, {
        title: "Inactive Tabs",
        collapsed: true,
      });
      await saveInactiveGroupId(targetGroupId);
      ids.shift();
      console.log(
        `[Group] Created new "Inactive Tabs" group (${targetGroupId})`
      );
    }

    // Add remaining inactive tabs into the group
    if (ids.length > 0) {
      await chrome.tabs.group({ groupId: targetGroupId, tabIds: ids });
    }

    console.log(
      `[Group] Grouped ${inactiveTabs.length} tabs into "Inactive Tabs"`
    );

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
    console.error("[Error in groupInactiveTabs]", err);
    notifyPopup({ type: "ERROR", message: err.message });
  } finally {
    isGrouping = false;
  }
}

// AUTO START TIMER
function autoStartTimer(minutes) {
  if (isRunning) {
    console.log("[AutoStart] Timer already running, skipping");
    return;
  }

  clearTimer();
  currentMinutes = minutes;
  autoGroup = true;
  endTime = Date.now() + minutes * 60 * 1000;
  isRunning = true;

  console.log(`[AutoStart] Timer started for ${minutes} min`);
  chrome.alarms.create("inactiveTimer", { delayInMinutes: minutes });
  notifyPopup({ type: "TIMER_STARTED", minutes });
}

// AUTO STOP TIMER
function autoStopTimer() {
  console.log("[AutoStop] Stopping timer");
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

    console.log(
      `[Cleanup] Removed ${
        stateKeys.length - Object.keys(tabStates).length
      } closed tabs from state`
    );
  });
}

async function saveInactiveGroupId(groupId) {
  await chrome.storage.local.set({ inactiveGroupId: groupId });
  console.log(`[Storage] Saved inactive group ID: ${groupId}`);
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
    console.log(`[Validate] Group ${groupId} no longer exists`);
  }

  await chrome.storage.local.remove("inactiveGroupId");
  return null;
}

async function handleGroupNow(minutes) {
  if (isGrouping) {
    console.log("[GroupNow] Already grouping, ignoring");
    notifyPopup({ type: "ERROR", message: "Grouping already in progress" });
    return;
  }

  console.log(`[GroupNow] Manual trigger. Minutes=${minutes}`);
  await groupInactiveTabs(minutes);
}

// Process ungroup queue with 5 second delay
async function processUngroupQueue() {
  if (isProcessingUngroup) return;

  isProcessingUngroup = true;
  const now = Date.now();

  try {
    for (const [tabId, activatedTime] of ungroupQueue.entries()) {
      if (now - activatedTime >= UNGROUP_DELAY) {
        try {
          if (autoUngroup) {
            const tab = await chrome.tabs.get(tabId);
            const groupId = tab.groupId;

            if (groupId && groupId !== -1) {
              const group = await chrome.tabGroups.get(groupId);

              if (group && group.title === "Inactive Tabs") {
                await chrome.tabs.ungroup([tabId]);
                console.log(
                  `[Ungroup] Tab ${tabId} removed from "Inactive Tabs" after 5s delay`
                );

                const remaining = await chrome.tabs.query({ groupId });
                if (remaining.length > 0) {
                  await chrome.tabGroups.update(groupId, { collapsed: true });
                  console.log(
                    `[Ungroup] Group ${groupId} collapsed (${remaining.length} tabs remaining)`
                  );
                }
              }
            }
          }

          ungroupQueue.delete(tabId);
        } catch (err) {
          console.warn(`[Ungroup] Error processing tab ${tabId}:`, err.message);
          ungroupQueue.delete(tabId);
        }
      }
    }
  } catch (err) {
    console.error("[Ungroup] Queue processing error:", err);
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
        console.log("[Force Reset] Clearing all state and resetting extension");
        clearTimer();
        isGrouping = false;
        isProcessingUngroup = false;
        ungroupQueue.clear();

        // Find inactive group before reinitializing
        let resetGroupId = null;
        try {
          const groups = await chrome.tabGroups.query({});
          const inactiveGroup = groups.find((g) => g.title === "Inactive Tabs");
          if (inactiveGroup) {
            resetGroupId = inactiveGroup.id;
          }
        } catch (err) {
          console.error("[Force Reset] Error finding group:", err);
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
        console.warn("[Message] Unknown type", msg.type);
    }
  })();
  return true;
});

// Auto checker - runs every 2 minutes
chrome.runtime.onInstalled.addListener(async () => {
  console.log("[Extension] Installed/Updated - Full initialization...");

  isRunning = false;
  endTime = null;
  currentMinutes = 0;
  isGrouping = false;
  isProcessingUngroup = false;
  ungroupQueue.clear();
  Object.keys(tabStates).forEach((key) => delete tabStates[key]);

  await chrome.alarms.clearAll();

  // First, find and validate the inactive group BEFORE initializing tab states
  let validGroupId = null;
  try {
    const groups = await chrome.tabGroups.query({});
    const inactiveGroup = groups.find((g) => g.title === "Inactive Tabs");

    if (inactiveGroup) {
      validGroupId = inactiveGroup.id;
      await saveInactiveGroupId(validGroupId);

      const groupedTabs = await chrome.tabs.query({ groupId: validGroupId });
      console.log(
        `[Install] Found existing "Inactive Tabs" group (${validGroupId}) with ${groupedTabs.length} tabs`
      );
    } else {
      // Check stored ID as fallback
      const storedGroupId = await getInactiveGroupId();
      validGroupId = await validateGroupId(storedGroupId);
    }
  } catch (err) {
    console.error("[Install] Error finding inactive group:", err);
  }

  await initializeTabStates(validGroupId);

  chrome.alarms.create("autoChecker", { periodInMinutes: 2 });
  chrome.alarms.create("cleanupStates", { periodInMinutes: 10 });
  chrome.alarms.create("ungroupProcessor", { periodInMinutes: 0.1 });

  await chrome.storage.local.set({
    sessionReady: true,
    sessionStartTime: Date.now(),
  });

  console.log("[Install] Extension ready");
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("[Extension] Browser started - Full reset and initialization...");

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

  if (validGroupId) {
    console.log(
      `[Startup] Found existing "Inactive Tabs" group (${validGroupId})`
    );
  } else {
    console.log("[Startup] No existing inactive group found");
  }

  chrome.alarms.create("autoChecker", { periodInMinutes: 2 });
  chrome.alarms.create("cleanupStates", { periodInMinutes: 10 });
  chrome.alarms.create("ungroupProcessor", { periodInMinutes: 0.1 });

  await chrome.storage.local.set({
    sessionReady: true,
    sessionStartTime: Date.now(),
  });

  console.log("[Startup] Extension ready - fresh session started");
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "inactiveTimer") {
    console.log("[Alarm] inactiveTimer triggered, grouping inactive tabs...");
    await groupInactiveTabs(currentMinutes);
    clearTimer();
  }

  if (alarm.name === "autoChecker") {
    try {
      const allTabs = await chrome.tabs.query({});

      // Only count tabs in normal windows
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

      console.log(
        `[AutoChecker] Ungrouped tabs: ${countableTabs.length}, running: ${isRunning}`
      );

      if (countableTabs.length >= 10 && !isRunning) {
        console.log(
          "[AutoChecker] ≥10 ungrouped tabs detected. Auto-starting timer..."
        );
        autoStartTimer(minutes);
      }

      if (countableTabs.length < minGroupTabs && isRunning) {
        console.log(
          `[AutoChecker] <${minGroupTabs} ungrouped tabs detected. Auto-stopping...`
        );
        autoStopTimer();
      }
    } catch (err) {
      console.warn("[AutoChecker] Error:", err.message);
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
        ungroupQueue.set(tabId, now);
        console.log(
          `[Tab Active] Tab ${tabId} in "Inactive Tabs" - added to ungroup queue (will process in 5s)`
        );
      }
    }
  } catch (err) {
    console.warn(
      `[Tab Active] Error checking group for tab ${tabId}:`,
      err.message
    );
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
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
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabStates[tabId]) {
    delete tabStates[tabId];
    console.log(`[TabState] Removed state for closed tab ${tabId}`);
  }

  ungroupQueue.delete(tabId);
});

chrome.tabGroups.onRemoved.addListener(async (group) => {
  const storedId = await getInactiveGroupId();
  if (storedId === group.id) {
    await chrome.storage.local.remove("inactiveGroupId");
    console.log(`[Group] "Inactive Tabs" group removed, cleared storage`);
  }
});

chrome.runtime.onSuspend.addListener(async () => {
  console.log("[Suspend] Cleaning up and resetting state...");

  clearTimer();
  isGrouping = false;
  isProcessingUngroup = false;
  ungroupQueue.clear();
  Object.keys(tabStates).forEach((key) => delete tabStates[key]);

  await chrome.storage.local.set({
    sessionClean: true,
    lastCloseTime: Date.now(),
  });

  console.log("[Suspend] Extension state reset complete");
});
