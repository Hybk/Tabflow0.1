// Popup UI logic for Tabflow
let isRunning = false;
let startDebounce = false;

document.addEventListener("DOMContentLoaded", () => {
  // Query DOM elements
  const sliderEl = document.getElementById("inputValue");
  const displayEl = document.getElementById("currentValue");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const groupNowBtn = document.getElementById("GroupNow");
  const ungroupCheckbox = document.getElementById("ungroupCheck");
  const statusEl = document.getElementById("status");

  const STORAGE_KEYS = {
    minutes: "minutes",
    autoUngroup: "autoUngroup",
  };

  // Accessibility: live announcements
  statusEl.setAttribute("aria-live", "polite");

  // Load saved settings when popup opens
  chrome.storage.local.get(
    [STORAGE_KEYS.minutes, STORAGE_KEYS.autoUngroup],
    (data) => {
      if (data[STORAGE_KEYS.minutes]) {
        sliderEl.value = data[STORAGE_KEYS.minutes];
        displayEl.textContent = data[STORAGE_KEYS.minutes] + " mins";
      } else {
        sliderEl.value = 30;
        displayEl.textContent = "30 mins";
      }

      if (data[STORAGE_KEYS.autoUngroup] !== undefined) {
        ungroupCheckbox.checked = data[STORAGE_KEYS.autoUngroup];
      } else {
        ungroupCheckbox.checked = true;
      }

      setStatus("Idle", "idle");
    }
  );

  // Save slider live changes
  sliderEl.addEventListener("input", () => {
    displayEl.textContent = sliderEl.value + " mins";
  });

  sliderEl.addEventListener("change", () => {
    const value = parseInt(sliderEl.value, 10);
    chrome.storage.local.set({ [STORAGE_KEYS.minutes]: value }, () => {
      setStatus(`Saved: ${value} mins`, "idle");
      setTimeout(() => setStatus("Idle", "idle"), 1000);
    });
  });

  // Save checkbox changes
  ungroupCheckbox.addEventListener("change", () => {
    const checked = ungroupCheckbox.checked;
    chrome.storage.local.set({ [STORAGE_KEYS.autoUngroup]: checked }, () => {
      setStatus(`Ungroup on click: ${checked ? "ON" : "OFF"}`, "idle");
      setTimeout(() => setStatus("Idle", "idle"), 1000);
    });
  });

  // START BUTTON
  startBtn.addEventListener("click", () => {
    if (startDebounce || isRunning) return;
    const minutes = parseInt(sliderEl.value, 10);

    if (isNaN(minutes) || minutes < 1) {
      setStatus("⚠️ Choose at least 1 minute", "error");
      return;
    }

    startDebounce = true;

    const msg = {
      type: "START",
      minutes,
      autoUngroup: ungroupCheckbox.checked,
    };

    chrome.runtime.sendMessage(msg);

    // Optimistic UI update
    startBtn.disabled = true;
    stopBtn.disabled = false;
    isRunning = true;
    setStatus(`⏳ Timer started — will group after ${minutes} mins`, "running");

    setTimeout(() => {
      startDebounce = false;
    }, 500);
  });

  // STOP BUTTON
  stopBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "STOP" });

    // Update UI immediately
    startBtn.disabled = false;
    stopBtn.disabled = true;
    isRunning = false;
    setStatus("🛑 Stopped", "stopped");
  });

  //  GROUP NOW BUTTON
  groupNowBtn.addEventListener("click", () => {
    const msg = {
      type: "GROUP_NOW",
      minutes: parseInt(sliderEl.value, 10),
      autoUngroup: ungroupCheckbox.checked,
    };

    chrome.runtime.sendMessage(msg);

    // Temporary busy state
    setStatus("📂 Grouping now...", "running");
    setTimeout(() => {
      setStatus(
        isRunning ? "⏳ Running..." : "Idle",
        isRunning ? "running" : "idle"
      );
    }, 1500);
  });

  // RECEIVE MESSAGES FROM BACKGROUND
  chrome.runtime.onMessage.addListener((message) => {
    console.log("Popup received:", message);
    startDebounce = false;

    switch (message.type) {
      case "TIMER_STARTED":
        isRunning = true;
        startBtn.disabled = true;
        stopBtn.disabled = false;
        setStatus("⏳ Timer started", "running");
        break;

      case "NOT_ENOUGH_TABS":
        isRunning = false;
        startBtn.disabled = false;
        stopBtn.disabled = true;
        setStatus("⚠️ Not enough tabs — need more than 5", "error");
        break;

      case "GROUPING_STARTED":
        setStatus("📂 Grouping...", "running");
        break;

      case "GROUPING_COMPLETE":
        isRunning = false;
        startBtn.disabled = false;
        stopBtn.disabled = true;
        setStatus(
          `✅ Grouped ${message.grouped} tabs (skipped ${message.skipped})`,
          "idle"
        );
        break;

      case "STOPPED":
        isRunning = false;
        startBtn.disabled = false;
        stopBtn.disabled = true;
        setStatus("🛑 Stopped", "stopped");
        break;

      case "ERROR":
        isRunning = false;
        startBtn.disabled = false;
        stopBtn.disabled = true;
        setStatus(`❌ Error: ${message.message}`, "error");
        break;

      default:
        console.warn("Unknown message:", message);
    }
  });

  // Helper to update status with class
  function setStatus(text, state) {
    statusEl.textContent = text;
    statusEl.className = ""; // reset
    if (state) statusEl.classList.add(state);
  }
});
