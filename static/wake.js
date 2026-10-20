// Wake panel: signs the command in the browser and publishes it straight to the ntfy server,
// so it works while the PC (which serves this page) sleeps, once the page is installed/cached.
(function () {
  "use strict";

  const SETTINGS_KEY = "batsignal.web.settings";
  const DB_NAME = "batsignal";
  const $ = (id) => document.getElementById(id);
  // Static export (tools/export_static_site.py): hosted without the Bat-Signal server.
  const STANDALONE = !!document.querySelector('meta[name="bat-signal-standalone"]');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---- storage -------------------------------------------------------------------
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("keys");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function dbRun(mode, action) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const store = db.transaction("keys", mode).objectStore("keys");
      const request = action(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  const loadKey = () => dbRun("readonly", (s) => s.get("command"));
  const saveKey = (key) => dbRun("readwrite", (s) => s.put(key, "command"));
  const deleteKey = () => dbRun("readwrite", (s) => s.delete("command"));

  // ---- ntfy ----------------------------------------------------------------------
  function headers(settings, extra) {
    const h = Object.assign({}, extra);
    if (settings.token) h.Authorization = "Bearer " + settings.token;
    return h;
  }

  async function publish(settings, message) {
    const response = await fetch(settings.ntfyUrl + "/", {
      method: "POST",
      headers: headers(settings, { "Content-Type": "application/json" }),
      body: JSON.stringify({ topic: settings.commandTopic, title: "Bat-Signal", message, priority: 4 }),
    });
    if (response.status === 401 || response.status === 403) throw new Error("Accès refusé par ntfy (token).");
    if (!response.ok) throw new Error("ntfy a répondu HTTP " + response.status + ".");
    return response.json();
  }

  async function fetchStatus(settings, since) {
    const url = `${settings.ntfyUrl}/${settings.statusTopic}/json?poll=1&since=${encodeURIComponent(since)}`;
    const response = await fetch(url, { headers: headers(settings) });
    if (!response.ok) throw new Error("ntfy a répondu HTTP " + response.status + ".");
    return BatCore.parseStatusEvents(await response.text());
  }

  // ---- UI ------------------------------------------------------------------------
  function setStatus(text, level) {
    const el = $("wake-status");
    el.textContent = text;
    el.dataset.level = level || "";
  }

  function describe(event) {
    const methods = [event.ble ? "Bluetooth" : null, event.wol ? "paquet magique" : null].filter(Boolean);
    return methods.length ? methods.join(" + ") : "aucune méthode";
  }

  async function pcIsUp() {
    try {
      const response = await fetch("/health", { cache: "no-store" });
      return response.ok;
    } catch (e) {
      return false;
    }
  }

  // The ESP32 publishes a heartbeat every 5 minutes: older than 12 minutes = offline.
  const ONLINE_WITHIN_S = 12 * 60;

  async function refreshDevice() {
    const el = $("esp-state");
    const settings = loadSettings();
    if (!settings.ntfyUrl || !settings.statusTopic) { el.textContent = ""; return null; }
    try {
      const events = await fetchStatus(settings, "30m");
      const latest = events.reduce((max, e) => Math.max(max, e.time), 0);
      if (!latest) {
        el.textContent = "ESP32 : aucun signe depuis 30 min (éteint, hors Wi-Fi, ou pas encore flashé).";
        el.dataset.level = "bad";
        return "none";
      }
      const minutes = Math.max(0, Math.round((Date.now() / 1000 - latest) / 60));
      const online = Date.now() / 1000 - latest <= ONLINE_WITHIN_S;
      el.textContent = online ? `ESP32 : en ligne (vu il y a ${minutes} min).`
        : `ESP32 : hors ligne (dernier signe il y a ${minutes} min).`;
      el.dataset.level = online ? "good" : "bad";
      return online ? "online" : "stale";
    } catch (e) {
      el.textContent = "ESP32 : état inconnu (ntfy injoignable ou token refusé).";
      el.dataset.level = "warn";
      return null;
    }
  }

  let busy = false;

  async function wake() {
    if (busy) return;
    const settings = loadSettings();
    const key = await loadKey().catch(() => undefined);
    if (!settings.ntfyUrl || !key) {
      setStatus("Configurez d'abord le canal de réveil (Réglages).", "warn");
      $("settings").showModal();
      return;
    }
    busy = true;
    $("wake-button").disabled = true;
    const started = Date.now();
    try {
      setStatus("Envoi du signal…");
      const message = await BatCore.signCommand(key, "WAKE", Math.floor(Date.now() / 1000));
      const published = await publish(settings, message);

      setStatus("Signal envoyé, en attente de l'ESP32…");
      let reply;
      for (let i = 0; i < 18 && !reply; i++) {
        await sleep(2500);
        const events = await fetchStatus(settings, published.time).catch(() => []);
        reply = events.find((e) => (e.kind === "wake" || e.kind === "error") && e.time >= published.time);
      }
      if (!reply) {
        const state = await refreshDevice();
        return setStatus(state === "online"
          ? "L'ESP32 est en ligne mais n'a pas accepté la commande : clé ou sujet différents, ou horloge décalée de plus de 60 s."
          : "L'ESP32 est hors ligne : éteint, hors Wi-Fi, ou pas encore flashé (voir docs/testing.md).", "bad");
      }
      if (reply.kind === "error") return setStatus("Erreur de l'ESP32 : " + reply.message, "bad");

      if (STANDALONE) {
        return setStatus(`ESP32 : signal envoyé (${describe(reply)}). Le PC devrait démarrer dans quelques secondes.`, "good");
      }
      setStatus(`ESP32 : signal envoyé (${describe(reply)}). Attente du démarrage du PC…`);
      for (let i = 0; i < 48; i++) {
        if (await pcIsUp()) {
          const seconds = Math.round((Date.now() - started) / 1000);
          return setStatus(`PC réveillé en ${seconds} s.`, "good");
        }
        await sleep(2500);
      }
      setStatus(`Signal envoyé (${describe(reply)}). Le PC n'a pas encore répondu.`, "warn");
    } catch (error) {
      setStatus(error.message, "bad");
    } finally {
      busy = false;
      $("wake-button").disabled = false;
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    const message = $("settings-error");
    message.textContent = "";
    try {
      const previous = loadSettings();
      const settings = {
        ntfyUrl: BatCore.validateNtfyUrl($("ntfy-url").value),
        commandTopic: BatCore.validateTopic($("command-topic").value, "commande"),
        statusTopic: BatCore.validateTopic($("status-topic").value, "statut"),
        token: $("ntfy-token").value.trim() || previous.token || "",
      };
      const keyText = $("command-key").value.trim();
      if (keyText) await saveKey(await BatCore.importKey(keyText));
      else if (!(await loadKey())) throw new Error("La clé de commande est requise.");
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      $("command-key").value = "";
      $("ntfy-token").value = "";
      $("generated").hidden = true;
      $("settings").close();
      setStatus("Réglages enregistrés.");
      refreshDevice();
    } catch (error) {
      message.textContent = error.message;
    }
  }

  function fillSettings() {
    const settings = loadSettings();
    $("ntfy-url").value = settings.ntfyUrl || "https://ntfy.sh";
    $("command-topic").value = settings.commandTopic || "";
    $("status-topic").value = settings.statusTopic || "";
    $("settings-error").textContent = "";
  }

  async function resetAll() {
    if (!confirm("Effacer l'adresse, les sujets, le token et la clé de ce navigateur ?")) return;
    localStorage.removeItem(SETTINGS_KEY);
    await deleteKey().catch(() => undefined);
    fillSettings();
    setStatus("Réglages effacés.");
  }

  function init() {
    $("wake-button").addEventListener("click", wake);
    $("open-settings").addEventListener("click", () => { fillSettings(); $("settings").showModal(); });
    $("close-settings").addEventListener("click", () => $("settings").close());
    $("settings-form").addEventListener("submit", saveSettings);
    $("reset-settings").addEventListener("click", resetAll);
    $("generate-key").addEventListener("click", () => {
      const key = BatCore.generateKey();
      $("command-key").value = key;
      $("generated-key").textContent = key;
      $("generated").hidden = false;
    });
    if ("serviceWorker" in navigator) navigator.serviceWorker.register(STANDALONE ? "sw.js" : "/sw.js").catch(() => undefined);
    fillSettings();
    refreshDevice();
    setInterval(refreshDevice, 60000);
    loadKey().then((key) => { if (!key || !loadSettings().ntfyUrl) setStatus("Configurez le canal de réveil (Réglages)."); });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
