let isRunning = false;
let currentStep = 1;

// Update inactive tab count in header
async function updateInactiveCount() {
  try {
    const sessionData = await chrome.storage.local.get("sessionReady");
    if (!sessionData.sessionReady) {
      console.log("[Popup] Session not ready, skipping count update");
      const countEl = document.getElementById("inactiveCount");
      if (countEl) countEl.textContent = "0";
      return;
    }

    // First try to find the group by name
    let groupId = null;
    try {
      const groups = await chrome.tabGroups.query({});
      const inactiveGroup = groups.find((g) => g.title === "Inactive Tabs");

      if (inactiveGroup) {
        groupId = inactiveGroup.id;
      } else {
        // Fallback to stored ID
        groupId = await getInactiveGroupId();
      }
    } catch (err) {
      console.warn("Error finding group:", err);
      groupId = await getInactiveGroupId();
    }

    if (groupId) {
      const tabs = await chrome.tabs.query({ groupId: groupId });
      const countEl = document.getElementById("inactiveCount");
      if (countEl) {
        countEl.textContent = tabs.length;

        countEl.style.transform = "scale(1.3)";
        setTimeout(() => {
          countEl.style.transform = "scale(1)";
        }, 200);
      }
    } else {
      const countEl = document.getElementById("inactiveCount");
      if (countEl) {
        countEl.textContent = "0";
      }
    }
  } catch (err) {
    console.warn("Error updating inactive count:", err);
    const countEl = document.getElementById("inactiveCount");
    if (countEl) countEl.textContent = "0";
  }
}

async function getInactiveGroupId() {
  const data = await chrome.storage.local.get("inactiveGroupId");
  return data.inactiveGroupId || null;
}

// Onboarding Functions
function initOnboarding() {
  const onboardingEl = document.getElementById("onboarding");
  const mainPopupEl = document.getElementById("mainPopup");

  if (!onboardingEl || !mainPopupEl) {
    console.error("Onboarding or main popup element not found");
    return;
  }

  const onboardingBtns = onboardingEl.querySelectorAll(".onboarding-btn");
  onboardingBtns.forEach((btn) => {
    btn.addEventListener("click", function () {
      const action = this.getAttribute("data-action");
      if (action === "next") {
        nextStep();
      } else if (action === "complete") {
        completeOnboarding();
      }
    });
  });
}

function nextStep() {
  const steps = document.querySelectorAll(".onboarding-step");
  const dots = document.querySelectorAll(".dot");

  if (!steps.length || !dots.length) return;

  steps[currentStep - 1].classList.remove("active");
  dots[currentStep - 1].classList.remove("active");

  currentStep++;

  if (currentStep <= steps.length) {
    steps[currentStep - 1].classList.add("active");
    dots[currentStep - 1].classList.add("active");
  }
}

function completeOnboarding() {
  chrome.storage.local.set({ onboardingComplete: true }, () => {
    const onboardingEl = document.getElementById("onboarding");
    const mainPopupEl = document.getElementById("mainPopup");

    if (onboardingEl) onboardingEl.classList.add("hidden");
    if (mainPopupEl) mainPopupEl.style.display = "block";

    setTimeout(() => {
      updateInactiveCount();
    }, 500);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initOnboarding();

  chrome.storage.local.get(["onboardingComplete", "sessionReady"], (data) => {
    const onboardingEl = document.getElementById("onboarding");
    const mainPopupEl = document.getElementById("mainPopup");

    if (!data.onboardingComplete) {
      if (onboardingEl) onboardingEl.classList.remove("hidden");
      if (mainPopupEl) mainPopupEl.style.display = "none";
    } else {
      if (onboardingEl) onboardingEl.classList.add("hidden");
      if (mainPopupEl) mainPopupEl.style.display = "block";

      if (data.sessionReady) {
        // Wait a bit longer for group validation to complete
        setTimeout(() => {
          updateInactiveCount();
        }, 800);
      }
    }
  });

  const sliderEl = document.getElementById("inputValue");
  const displayEl = document.getElementById("currentValue");
  const stopBtn = document.getElementById("stopBtn");
  const groupNowBtn = document.getElementById("GroupNow");
  const groupCheckbox = document.getElementById("groupCheck");
  const statusEl = document.getElementById("status");
  const statusDescEl = document.getElementById("statusDesc");
  const minTabsEl = document.getElementById("minTabs");

  const STORAGE_KEYS = {
    minutes: "minutes",
    autoGroup: "autoGroup",
  };

  if (statusEl) {
    statusEl.setAttribute("aria-live", "polite");
  }

  chrome.storage.local.get(
    [
      STORAGE_KEYS.minutes,
      STORAGE_KEYS.autoGroup,
      "minGroupTabs",
      "sessionReady",
    ],
    (data) => {
      if (!data.sessionReady) {
        console.log("[Popup] Session not ready yet, waiting...");
        setStatus("🔄 Starting...", "idle", "Initializing extension");

        setTimeout(() => {
          chrome.storage.local.get("sessionReady", (d) => {
            if (d.sessionReady) {
              initializePopupState(data);
            }
          });
        }, 1000);
        return;
      }

      initializePopupState(data);
    }
  );

  function initializePopupState(data) {
    if (data[STORAGE_KEYS.minutes]) {
      sliderEl.value = data[STORAGE_KEYS.minutes];
      displayEl.textContent = data[STORAGE_KEYS.minutes] + " mins";
    } else {
      sliderEl.value = 30;
      displayEl.textContent = "30 mins";
    }

    if (data[STORAGE_KEYS.autoGroup] !== undefined) {
      groupCheckbox.checked = data[STORAGE_KEYS.autoGroup];
    } else {
      groupCheckbox.checked = true;
    }

    if (data.minGroupTabs !== undefined) {
      minTabsEl.value = data.minGroupTabs;
    } else {
      minTabsEl.value = 5;
    }

    syncWithBackground();
  }

  function syncWithBackground(retryCount = 0) {
    chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("[Popup] Could not get status:", chrome.runtime.lastError);

        if (retryCount < 3) {
          const delay = Math.pow(2, retryCount) * 500;
          console.log(
            `[Popup] Retrying in ${delay}ms (attempt ${retryCount + 1}/3)`
          );
          setTimeout(() => syncWithBackground(retryCount + 1), delay);
        } else {
          setStatus("Idle", "idle", "Auto-starts at 10+ tabs");
          updateInactiveCount();
        }
        return;
      }

      if (response && response.isRunning) {
        isRunning = true;
        stopBtn.disabled = false;

        const remainingMs = response.endTime - Date.now();
        const remainingMins = Math.ceil(remainingMs / 60000);

        if (remainingMins <= 0 && response.endTime) {
          console.warn("[Popup] Detected stuck timer, attempting recovery");
          chrome.runtime.sendMessage({ type: "FORCE_RESET" });
          setStatus("🔄 Recovering...", "idle", "System reset");
          setTimeout(() => {
            isRunning = false;
            stopBtn.disabled = true;
            setStatus("Idle", "idle", "Auto-starts at 10+ tabs");
            updateInactiveCount();
          }, 1000);
        } else if (remainingMins > 0) {
          setStatus(
            `⏳ Timer Active`,
            "running",
            `${remainingMins} min remaining`
          );
        } else {
          setStatus("⏳ Timer Active", "running", "Checking inactive tabs...");
        }
      } else {
        isRunning = false;
        stopBtn.disabled = true;
        setStatus("Idle", "idle", "Auto-starts at 10+ tabs");
      }

      updateInactiveCount();
    });
  }

  sliderEl.addEventListener("input", () => {
    displayEl.textContent = sliderEl.value + " mins";
  });

  sliderEl.addEventListener("change", () => {
    const value = parseInt(sliderEl.value, 10);
    chrome.storage.local.set({ [STORAGE_KEYS.minutes]: value }, () => {
      setStatus(`✅ Saved`, "idle", `Timeout: ${value} mins`);
      setTimeout(() => {
        setStatus(
          isRunning ? "⏳ Timer Active" : "Idle",
          isRunning ? "running" : "idle",
          isRunning ? "Auto-grouping enabled" : "Auto-starts at 10+ tabs"
        );
      }, 1500);
    });
  });

  minTabsEl.addEventListener("change", () => {
    const value = parseInt(minTabsEl.value, 10);
    if (value >= 1 && value <= 20) {
      chrome.storage.local.set({ minGroupTabs: value }, () => {
        setStatus("✅ Saved", "idle", `Min tabs: ${value}`);
        setTimeout(() => {
          setStatus(
            isRunning ? "⏳ Timer Active" : "Idle",
            isRunning ? "running" : "idle",
            isRunning ? "Auto-grouping enabled" : "Auto-starts at 10+ tabs"
          );
        }, 1500);
      });
    }
  });

  groupCheckbox.addEventListener("change", () => {
    const checked = groupCheckbox.checked;
    chrome.storage.local.set({ [STORAGE_KEYS.autoGroup]: checked }, () => {
      setStatus("✅ Saved", "idle", `Auto-group: ${checked ? "ON" : "OFF"}`);
      setTimeout(() => {
        setStatus(
          isRunning ? "⏳ Timer Active" : "Idle",
          isRunning ? "running" : "idle",
          isRunning ? "Auto-grouping enabled" : "Auto-starts at 10+ tabs"
        );
      }, 1500);
    });
  });

  stopBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "STOP" });

    stopBtn.disabled = true;
    isRunning = false;
    setStatus("🛑 Timer Stopped", "stopped", "Will auto-restart at 10+ tabs");

    setTimeout(() => {
      setStatus("Idle", "idle", "Auto-starts at 10+ tabs");
    }, 2000);
  });

  groupNowBtn.addEventListener("click", () => {
    const minutes = parseInt(sliderEl.value, 10);

    chrome.runtime.sendMessage({
      type: "GROUP_NOW",
      minutes: minutes,
    });

    setStatus("📂 Grouping...", "running", "Please wait");

    setTimeout(() => {
      updateInactiveCount();
    }, 1500);
  });

  chrome.runtime.onMessage.addListener((message) => {
    console.log("Popup received:", message);

    switch (message.type) {
      case "TIMER_STARTED":
        isRunning = true;
        stopBtn.disabled = false;
        setStatus("⏳ Timer Active", "running", "Auto-grouping enabled");
        updateInactiveCount();
        break;

      case "NOT_ENOUGH_TABS":
        setStatus(
          `ℹ️ Not Enough Tabs`,
          "idle",
          `Need ${message.required}+ inactive tabs`
        );
        setTimeout(() => {
          setStatus(
            isRunning ? "⏳ Timer Active" : "Idle",
            isRunning ? "running" : "idle",
            isRunning ? "Auto-grouping enabled" : "Auto-starts at 10+ tabs"
          );
        }, 3000);
        break;

      case "GROUPING_STARTED":
        setStatus("📂 Grouping Tabs...", "running", "Please wait");
        break;

      case "GROUPING_COMPLETE":
        const msg = `✅ Grouped ${message.grouped} tab${
          message.grouped !== 1 ? "s" : ""
        }`;
        setStatus(msg, "idle", "Successfully organized!");
        updateInactiveCount();
        setTimeout(() => {
          setStatus(
            isRunning ? "⏳ Timer Active" : "Idle",
            isRunning ? "running" : "idle",
            isRunning ? "Auto-grouping enabled" : "Auto-starts at 10+ tabs"
          );
        }, 3000);
        break;

      case "STOPPED":
        isRunning = false;
        stopBtn.disabled = true;
        setStatus(
          "🛑 Timer Stopped",
          "stopped",
          "Will auto-restart at 10+ tabs"
        );
        setTimeout(() => {
          setStatus("Idle", "idle", "Auto-starts at 10+ tabs");
        }, 2000);
        break;

      case "ERROR":
        setStatus(`⚠️ Error`, "error", message.message);
        setTimeout(() => {
          setStatus(
            isRunning ? "⏳ Timer Active" : "Idle",
            isRunning ? "running" : "idle",
            isRunning ? "Auto-grouping enabled" : "Auto-starts at 10+ tabs"
          );
        }, 3000);
        break;

      default:
        console.warn("Unknown message:", message);
    }
  });

  function setStatus(text, state, description = "") {
    if (!statusEl) return;

    // Map emoji to icon paths
    const iconMap = {
      "🔄": "../icons/loading.png",
      "⏳": "../icons/sand-clock.png",
      "🛑": "../icons/stop-button.png",
      // ℹ️: "../icons/info.png",
      "📂": "../icons/folder(1).png",
      "✅": "../icons/check.png",
      "⚠️": "../icons/warning.png",
    };

    // Replace emoji with icon if found
    let displayText = text;
    for (const [emoji, iconPath] of Object.entries(iconMap)) {
      if (text.includes(emoji)) {
        displayText = text.replace(
          emoji,
          `<img src="${iconPath}" alt="${emoji}" style="width: 16px; height: 16px; vertical-align: middle; margin-right: 4px;">`
        );
        break;
      }
    }

    statusEl.innerHTML = displayText;
    statusEl.className = "";
    if (state) statusEl.classList.add(state);

    if (description && statusDescEl) {
      statusDescEl.textContent = description;
    }
  }

  setInterval(updateInactiveCount, 5000);
});
