let timerId = null;
let endTime = null;
let currentMinutes = 0;
let autoGroup = true;
let autoUngroup = true;
let focusedWindowId = null;

let hiddenQueue = [];
let hideIntervalId = null;
const tabStates = {};

// UTIL HELPERS
function clearTimer() {
  if (timerId) {
    clearTimeout(timerId);
    timerId = null;
    endTime = null;
    console.log("[Timer] Cleared");
  }
  if (hideIntervalId) {
    clearInterval(hideIntervalId);
    hideIntervalId = null;
    console.log("[Hider] Cleared");
  }
  hiddenQueue = [];
}

function notifyPopup(message) {
  chrome.runtime.sendMessage(message, () => {
    if (chrome.runtime.lastError) {
    }
  });
}

//  GROUP INACTIVE TABS
async function groupInactiveTabs(minutes) {
  try {
    const now = Date.now();
    const tabs = await chrome.tabs.query({ lastFocusedWindow: true });

    // Update tabStates
    for (const t of tabs) {
      if (!tabStates[t.id]) {
        tabStates[t.id] = {
          lastAccessed: t.lastAccessed || now,
          isHidden: false,
          isActive: t.active,
        };
      } else {
        if (t.active) tabStates[t.id].lastAccessed = now;
      }
    }

    // Find inactive tabs
    const inactiveTabs = tabs.filter((t) => {
      const state = tabStates[t.id];
      return (
        state && !t.active && now - state.lastAccessed > minutes * 60 * 1000
      );
    });

    console.log(
      `[Group] Found ${inactiveTabs.length} inactive tabs after ${minutes} min`
    );

    if (inactiveTabs.length < 5) {
      console.log("[Group] Not enough inactive tabs (need at least 5)");
      notifyPopup({ type: "NOT_ENOUGH_TABS" });
      return;
    }

    notifyPopup({ type: "GROUPING_STARTED" });

    const ids = inactiveTabs.map((t) => t.id);

    // Check if "Inactive Tabs" group exists
    let targetGroupId = null;
    const groups = await chrome.tabGroups.query({});
    const existing = groups.find((g) => g.title === "Inactive Tabs");

    if (existing) {
      targetGroupId = existing.id;
      console.log(
        `[Group] Reusing existing "Inactive Tabs" group (${targetGroupId})`
      );
    } else {
      targetGroupId = await chrome.tabs.group({ tabIds: [ids[0]] });
      await chrome.tabGroups.update(targetGroupId, {
        title: "Inactive Tabs",
        collapsed: true,
      });
      ids.shift(); // first one already grouped
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

    // Queue them for hiding
    hiddenQueue.push(...inactiveTabs.map((t) => t.id));
    inactiveTabs.forEach((t) => {
      tabStates[t.id].isHidden = false;
      tabStates[t.id].isActive = false;
    });

    // startHidingProcess();

    notifyPopup({
      type: "GROUPING_COMPLETE",
      grouped: inactiveTabs.length,
    });
  } catch (err) {
    console.error("[Error in groupInactiveTabs]", err);
    notifyPopup({ type: "ERROR", message: err.message });
  }
}

// HIDING PROCESS
// function startHidingProcess() {
//   if (hideIntervalId) clearInterval(hideIntervalId);

//   hideIntervalId = setInterval(async () => {
//     if (hiddenQueue.length === 0) {
//       console.log("[Hider] Queue empty, stopping...");
//       clearInterval(hideIntervalId);
//       hideIntervalId = null;
//       return;
//     }

//     const toHide = hiddenQueue.splice(0, 2);
//     try {
//       await chrome.tabs.hide(toHide);
//       toHide.forEach((id) => {
//         if (tabStates[id]) tabStates[id].isHidden = true;
//       });
//       console.log(`[Hider] Hidden tabs: ${toHide.join(", ")}`);
//     } catch (err) {
//       console.warn("[Hider] Error hiding tabs:", err.message);
//     }
//   }, 60 * 1000);
// }

//  START/STOP
function handleStart(minutes, group) {
  clearTimer();
  currentMinutes = minutes;
  autoGroup = group;

  endTime = Date.now() + minutes * 60 * 1000;
  console.log(`[Start] Timer set for ${minutes} min`);

  timerId = setTimeout(async () => {
    console.log("[Timer] Triggered, grouping inactive tabs...");
    await groupInactiveTabs(minutes);
    clearTimer();
  }, minutes * 60 * 1000);

  notifyPopup({ type: "TIMER_STARTED", minutes });
}

function handleStop() {
  console.log("[Stop] Manual stop");
  clearTimer();
  notifyPopup({ type: "STOPPED" });
}

async function handleGroupNow(minutes) {
  console.log(`[GroupNow] Manual trigger. Minutes=${minutes}`);
  await groupInactiveTabs(minutes);
}

//UNGROUP
async function ungroupAllTabs() {
  try {
    const groups = await chrome.tabGroups.query({});
    for (const g of groups) {
      const tabs = await chrome.tabs.query({ groupId: g.id });
      if (tabs.length > 0) {
        console.log(
          `[Ungroup] Releasing ${tabs.length} tabs from group ${g.title}`
        );
        await chrome.tabs.ungroup(tabs.map((t) => t.id));
      }
    }
  } catch (err) {
    console.warn("Ungroup error:", err.message);
  }
}

//  LISTENERS
chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "START":
      handleStart(msg.minutes, msg.autoGroup);
      break;
    case "STOP":
      handleStop();
      break;
    case "GROUP_NOW":
      handleGroupNow(msg.minutes);
      break;
    default:
      console.warn("[Message] Unknown type", msg.type);
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  focusedWindowId = windowId;
  console.log("[Window Focus] Changed to", windowId);
});

chrome.tabs.onActivated.addListener(async (info) => {
  const tabId = info.tabId;

  try {
    // 1) update local state
    if (tabStates[tabId]) {
      tabStates[tabId].isActive = true;
      tabStates[tabId].lastAccessed = Date.now();
      tabStates[tabId].isHidden = false;
    }

    // try {
    //   await chrome.tabs.show(tabId);
    //   console.log(`[Tab Active] Tab ${tabId} is now active and shown`);
    // } catch (e) {
    // }

    // 3) remove from the hiding queue if present prevent later re-hide
    const qIdx = hiddenQueue.indexOf(tabId);
    if (qIdx !== -1) hiddenQueue.splice(qIdx, 1);
    if (autoUngroup) {
      try {
        const tab = await chrome.tabs.get(tabId);
        const groupId = tab.groupId;
        if (groupId && groupId !== -1) {
          // get group info and check title
          const group = await chrome.tabGroups.get(groupId);
          if (group && group.title === "Inactive Tabs") {
            // ungroup this single tab
            await chrome.tabs.ungroup([tabId]);

            // collapse the group if it still has tabs
            const remaining = await chrome.tabs.query({ groupId });
            if (remaining.length > 0) {
              await chrome.tabGroups.update(groupId, { collapsed: true });
            }
            console.log(
              `[Ungroup] Tab ${tabId} removed from "Inactive Tabs"; group ${groupId} collapsed`
            );
          }
        }
      } catch (err) {
        console.warn("[Ungroup] error handling activated tab:", err.message);
      }
    }

    console.log(`[Tab Active] Tab ${tabId} activated and shown`);
  } catch (err) {
    console.warn("[Tab Active] handler error:", err.message);
  }
});

chrome.runtime.onSuspend.addListener(() => {
  console.log("[Suspend] Cleaning up");
  clearTimer();
});
