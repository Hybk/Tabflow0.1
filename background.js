let timerId = null;
let endTime = null;
let currentMinutes = 0;
let autoUngroup = true;
let saveGroup = null;
let focusedWindowId = null;

// UTIL HELPERS
function clearTimer() {
  if (timerId) {
    clearTimeout(timerId);
    timerId = null;
    endTime = null;
  }
}

// Send message to popup (if open)
function notifyPopup(message) {
  chrome.runtime.sendMessage(message, () => {
    if (chrome.runtime.lastError) {
      // Popup may not be open, ignore
    }
  });
}

//  TAB GROUPING LOGIC
async function groupInactiveTabs(minutes) {
  try {
    const now = Date.now();
    const tabs = await chrome.tabs.query({ lastFocusedWindow: true });

    const inactiveTabs = tabs.filter(
      (t) =>
        !t.active &&
        t.lastAccessed &&
        now - t.lastAccessed > minutes * 60 * 1000
    );

    if (inactiveTabs.length <= 5) {
      notifyPopup({ type: "NOT_ENOUGH_TABS" });
      return;
    }

    notifyPopup({ type: "GROUPING_STARTED" });

    let groupedCount = 0;
    let skippedCount = 0;

    // Group by domain
    const domainGroups = {};
    for (const tab of inactiveTabs) {
      try {
        const url = new URL(tab.url);
        const domain = url.hostname;
        if (!domainGroups[domain]) domainGroups[domain] = [];
        domainGroups[domain].push(tab.id);
      } catch (e) {
        skippedCount++;
      }
    }

    for (const domain of Object.keys(domainGroups)) {
      const ids = domainGroups[domain];
      if (ids.length > 0) {
        await chrome.tabs.group({ tabIds: ids });
        groupedCount += ids.length;
      }
    }

    notifyPopup({
      type: "GROUPING_COMPLETE",
      grouped: groupedCount,
      skipped: skippedCount,
    });
  } catch (err) {
    notifyPopup({ type: "ERROR", message: err.message });
  }
}

//  HANDLE START
function handleStart(minutes, ungroup) {
  clearTimer();
  currentMinutes = minutes;
  autoUngroup = ungroup;

  endTime = Date.now() + minutes * 60 * 1000;

  timerId = setTimeout(async () => {
    await groupInactiveTabs(minutes);
    clearTimer();
  }, minutes * 60 * 1000);

  notifyPopup({ type: "TIMER_STARTED", minutes });
}

// HANDLE STOP
function handleStop() {
  clearTimer();
  notifyPopup({ type: "STOPPED" });
}

//  GROUP NOW
async function handleGroupNow(minutes, ungroup) {
  await groupInactiveTabs(minutes);
}

// UNGROUP IF NEEDED
async function ungroupAllTabs() {
  try {
    const groups = await chrome.tabGroups.query({});
    for (const group of groups) {
      const tabs = await chrome.tabs.query({ groupId: group.id });
      const ids = tabs.map((t) => t.id);
      if (ids.length > 0) {
        await chrome.tabs.ungroup(ids);
      }
    }
  } catch (err) {
    console.warn("Ungroup error:", err.message);
  }
}

// HANDLE MESSAGES FROM POPUP
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "START":
      handleStart(msg.minutes, msg.autoUngroup);
      break;
    case "STOP":
      handleStop();
      break;
    case "GROUP_NOW":
      handleGroupNow(msg.minutes, msg.autoUngroup);
      break;
  }
});

// WINDOW FOCUS TRACKING
chrome.windows.onFocusChanged.addListener((windowId) => {
  focusedWindowId = windowId;
});

// CLEANUP ON SUSPEND
chrome.runtime.onSuspend.addListener(() => {
  clearTimer();
});
