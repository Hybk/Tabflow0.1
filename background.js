let endTime = null;
let currentMinutes = 0;
let autoGroup = true;
let autoUngroup = true;
let isRunning = false;
let isGrouping = false;

const tabStates = {};
let ungroupQueue = new Map(); // tabId -> timestamp when activated
let isProcessingUngroup = false;
const UNGROUP_DELAY = 5000; // 5 seconds delay before ungrouping

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
async function initializeTabStates() {
  console.log("[Init] Initializing tab states...");
  const now = Date.now();

  try {
    const tabs = await chrome.tabs.query({});

    for (const tab of tabs) {
      tabStates[tab.id] = {
        lastAccessed: tab.lastAccessed || now,
        isHidden: false,
        isActive: tab.active,
      };
    }

    console.log(`[Init] Initialized ${tabs.length} tabs`);
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

    // Update tabStates for all tabs
    for (const t of tabs) {
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

    // Find inactive tabs
    const inactiveTabs = tabs.filter((t) => {
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

// AUTO START TIMER (removed manual mode)
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
    // Check all items in queue
    for (const [tabId, activatedTime] of ungroupQueue.entries()) {
      // Only ungroup if 5 seconds have passed
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

                // Collapse group if it still has tabs
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

          // Remove from queue after processing
          ungroupQueue.delete(tabId);
        } catch (err) {
          console.warn(`[Ungroup] Error processing tab ${tabId}:`, err.message);
          ungroupQueue.delete(tabId); // Remove errored tabs from queue
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
  switch (msg.type) {
    case "GET_STATUS":
      sendResponse(getStatus());
      return true;
    case "STOP":
      autoStopTimer();
      break;
    case "GROUP_NOW":
      handleGroupNow(msg.minutes || currentMinutes || 30);
      break;
    case "FORCE_RESET":
      clearTimer();
      isGrouping = false;
      isProcessingUngroup = false;
      ungroupQueue.clear();
      notifyPopup({ type: "STOPPED" });
      sendResponse({ success: true });
      break;
    default:
      console.warn("[Message] Unknown type", msg.type);
  }
});

// Auto checker - runs every 2 minutes
chrome.runtime.onInstalled.addListener(async () => {
  console.log("[Extension] Installed/Updated - Initializing...");

  // Initialize tab states immediately
  await initializeTabStates();

  // Set up alarms
  chrome.alarms.create("autoChecker", { periodInMinutes: 2 });
  chrome.alarms.create("cleanupStates", { periodInMinutes: 10 });
  chrome.alarms.create("ungroupProcessor", { periodInMinutes: 0.1 }); // Check every 6 seconds
});

// Also initialize on startup
chrome.runtime.onStartup.addListener(async () => {
  console.log("[Extension] Browser started - Initializing...");
  await initializeTabStates();
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
      const countableTabs = allTabs.filter((t) => !t.pinned && !t.audible);

      const stored = await chrome.storage.local.get([
        "minutes",
        "minGroupTabs",
      ]);
      const minutes = stored.minutes || 30;
      const minGroupTabs = stored.minGroupTabs || 5;

      console.log(
        `[AutoChecker] Tabs: ${countableTabs.length}, running: ${isRunning}`
      );

      // Auto-start when >= 10 tabs
      if (countableTabs.length >= 10 && !isRunning) {
        console.log("[AutoChecker] ≥10 tabs detected. Auto-starting timer...");
        autoStartTimer(minutes);
      }

      // Auto-stop when < minGroupTabs (default 5)
      if (countableTabs.length < minGroupTabs && isRunning) {
        console.log(
          `[AutoChecker] <${minGroupTabs} tabs detected. Auto-stopping...`
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

// Track tab activation with 5 second delay
chrome.tabs.onActivated.addListener(async (info) => {
  const tabId = info.tabId;
  const now = Date.now();

  // Update tab state immediately
  if (tabStates[tabId]) {
    tabStates[tabId].isActive = true;
    tabStates[tabId].lastAccessed = now;
    tabStates[tabId].isHidden = false;
  } else {
    // Create state if doesn't exist
    tabStates[tabId] = {
      lastAccessed: now,
      isHidden: false,
      isActive: true,
    };
  }

  // Only add to ungroup queue if tab is in "Inactive Tabs" group
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

// Update lastAccessed when tab is updated (e.g., navigation)
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

  // Remove from ungroup queue
  ungroupQueue.delete(tabId);
});

chrome.tabGroups.onRemoved.addListener(async (group) => {
  const storedId = await getInactiveGroupId();
  if (storedId === group.id) {
    await chrome.storage.local.remove("inactiveGroupId");
    console.log(`[Group] "Inactive Tabs" group removed, cleared storage`);
  }
});

chrome.runtime.onSuspend.addListener(() => {
  console.log("[Suspend] Cleaning up");
  clearTimer();
});
