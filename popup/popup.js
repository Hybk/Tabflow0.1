let isRunning = false;

document.addEventListener("DOMContentLoaded", () => {
  // Query DOM elements
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

  // Accessibility: live announcements
  statusEl.setAttribute("aria-live", "polite");

  // Load saved settings when popup opens
  chrome.storage.local.get(
    [STORAGE_KEYS.minutes, STORAGE_KEYS.autoGroup, "minGroupTabs"],
    (data) => {
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

      // Sync with background script state
      chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
        if (chrome.runtime.lastError) {
          setStatus("Idle", "idle");
          return;
        }

        if (response && response.isRunning) {
          isRunning = true;
          stopBtn.disabled = false;

          const remainingMs = response.endTime - Date.now();
          const remainingMins = Math.ceil(remainingMs / 60000);

          // Check for stuck timer
          if (remainingMins <= 0 && response.endTime) {
            console.warn("[Popup] Detected stuck timer, attempting recovery");
            chrome.runtime.sendMessage({ type: "FORCE_RESET" });
            setStatus("🔄 Recovering...", "idle", "System reset");
            setTimeout(() => {
              isRunning = false;
              stopBtn.disabled = true;
              setStatus("Idle", "idle", "Auto-starts at 10+ tabs");
            }, 1000);
          } else if (remainingMins > 0) {
            setStatus(
              `⏳ Timer Active`,
              "running",
              `${remainingMins} min remaining`
            );
          } else {
            setStatus(
              "⏳ Timer Active",
              "running",
              "Checking inactive tabs..."
            );
          }
        } else {
          isRunning = false;
          stopBtn.disabled = true;
          setStatus("Idle", "idle", "Auto-starts at 10+ tabs");
        }
      });
    }
  );

  // Auto-save slider changes
  sliderEl.addEventListener("input", () => {
    displayEl.textContent = sliderEl.value + " mins";
  });

  sliderEl.addEventListener("change", () => {
    const value = parseInt(sliderEl.value, 10);
    chrome.storage.local.set({ [STORAGE_KEYS.minutes]: value }, () => {
      setStatus(`Saved`, "idle", `Timeout: ${value} mins`);
      setTimeout(() => {
        setStatus(
          isRunning ? "Timer Active" : "Idle",
          isRunning ? "running" : "idle",
          isRunning ? "Auto-grouping enabled" : "Auto-starts at 10+ tabs"
        );
      }, 1500);
    });
  });

  // Auto-save min tabs changes
  minTabsEl.addEventListener("change", () => {
    const value = parseInt(minTabsEl.value, 10);
    if (value >= 1 && value <= 20) {
      chrome.storage.local.set({ minGroupTabs: value }, () => {
        setStatus("Saved", "idle", `Min tabs: ${value}`);
        setTimeout(() => {
          setStatus(
            isRunning ? "Timer Active" : "Idle",
            isRunning ? "running" : "idle",
            isRunning ? "Auto-grouping enabled" : "Auto-starts at 10+ tabs"
          );
        }, 1500);
      });
    }
  });

  // Auto-save checkbox changes
  groupCheckbox.addEventListener("change", () => {
    const checked = groupCheckbox.checked;
    chrome.storage.local.set({ [STORAGE_KEYS.autoGroup]: checked }, () => {
      setStatus("Saved", "idle", `Auto-group: ${checked ? "ON" : "OFF"}`);
      setTimeout(() => {
        setStatus(
          isRunning ? "Timer Active" : "Idle",
          isRunning ? "running" : "idle",
          isRunning ? "Auto-grouping enabled" : "Auto-starts at 10+ tabs"
        );
      }, 1500);
    });
  });

  // STOP BUTTON (only stops the timer, doesn't prevent auto-restart)
  stopBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "STOP" });

    stopBtn.disabled = true;
    isRunning = false;
    setStatus("🛑 Timer Stopped", "stopped", "Will auto-restart at 10+ tabs");

    setTimeout(() => {
      setStatus("Idle", "idle", "Auto-starts at 10+ tabs");
    }, 2000);
  });

  // GROUP NOW BUTTON
  groupNowBtn.addEventListener("click", () => {
    const minutes = parseInt(sliderEl.value, 10);

    chrome.runtime.sendMessage({
      type: "GROUP_NOW",
      minutes: minutes,
    });

    setStatus("📂 Grouping...", "running", "Please wait");
    setTimeout(() => {
      setStatus(
        isRunning ? "Timer Active" : "Idle",
        isRunning ? "running" : "idle",
        isRunning ? "Auto-grouping enabled" : "Auto-starts at 10+ tabs"
      );
    }, 2000);
  });

  // RECEIVE MESSAGES FROM BACKGROUND
  chrome.runtime.onMessage.addListener((message) => {
    console.log("Popup received:", message);

    switch (message.type) {
      case "TIMER_STARTED":
        isRunning = true;
        stopBtn.disabled = false;
        setStatus("⏳ Timer Active", "running", "Auto-grouping enabled");
        break;

      case "NOT_ENOUGH_TABS":
        setStatus(
          `ℹ️ Not Enough Tabs`,
          "idle",
          `Need ${message.required}+ inactive tabs`
        );
        setTimeout(() => {
          setStatus(
            isRunning ? "Timer Active" : "Idle",
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
        setStatus(msg, "idle", "Auto-starts at 10+ tabs");
        setTimeout(() => {
          setStatus(
            isRunning ? "Timer Active" : "Idle",
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
            isRunning ? "Timer Active" : "Idle",
            isRunning ? "running" : "idle",
            isRunning ? "Auto-grouping enabled" : "Auto-starts at 10+ tabs"
          );
        }, 3000);
        break;

      default:
        console.warn("Unknown message:", message);
    }
  });

  // Helper to update status with description
  function setStatus(text, state, description = "") {
    statusEl.textContent = text;
    statusEl.className = ""; // reset
    if (state) statusEl.classList.add(state);

    if (description) {
      statusDescEl.textContent = description;
    }
  }
});
