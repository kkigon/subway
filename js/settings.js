/* ============================================================
   settings.js — 로컬 게임 설정
   ============================================================ */

const GameSettings = (() => {
  const SOUND_KEY = "subwaySoundEnabled";
  const listeners = [];
  let soundEnabled = true;

  try {
    soundEnabled = localStorage.getItem(SOUND_KEY) !== "false";
  } catch (e) {}

  function isSoundEnabled() { return soundEnabled; }

  function notify() {
    listeners.forEach(fn => { try { fn(soundEnabled); } catch (e) {} });
  }

  function setSoundEnabled(enabled) {
    soundEnabled = !!enabled;
    try { localStorage.setItem(SOUND_KEY, String(soundEnabled)); } catch (e) {}
    renderSoundToggle();
    notify();
    return soundEnabled;
  }

  function onSoundChange(fn) {
    if (typeof fn === "function") listeners.push(fn);
  }

  function renderSoundToggle() {
    const button = document.querySelector("#settings-sound-toggle");
    const label = document.querySelector("#settings-sound-status");
    if (button) button.setAttribute("aria-checked", String(soundEnabled));
    if (label) label.textContent = soundEnabled ? "ON" : "OFF";
  }

  function closeSettings() {
    const modal = document.querySelector("#settings-modal");
    if (!modal) return;
    modal.classList.remove("show");
    if (!document.querySelector(".modal-backdrop.show")) document.body.classList.remove("modal-open");
    document.querySelector("#btn-settings")?.focus();
  }

  function openSettings() {
    const modal = document.querySelector("#settings-modal");
    if (!modal) return;
    renderSoundToggle();
    modal.classList.add("show");
    document.body.classList.add("modal-open");
    document.querySelector("#settings-sound-toggle")?.focus();
  }

  document.addEventListener("DOMContentLoaded", () => {
    renderSoundToggle();
    document.querySelector("#btn-settings")?.addEventListener("click", openSettings);
    document.querySelector("#settings-close")?.addEventListener("click", closeSettings);
    document.querySelector("#settings-sound-toggle")?.addEventListener("click", () => setSoundEnabled(!soundEnabled));
    document.querySelector("#settings-modal")?.addEventListener("click", event => {
      if (event.target.id === "settings-modal") closeSettings();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && document.querySelector("#settings-modal.show")) closeSettings();
    });
  });

  return { isSoundEnabled, setSoundEnabled, onSoundChange, openSettings, closeSettings };
})();
