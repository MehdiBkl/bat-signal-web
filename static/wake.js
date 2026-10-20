// Wake panel: signs each command in the browser and publishes it straight to the ntfy server,
// so it keeps working while the PC (which may serve this page) sleeps, once the page is installed.
(function () {
  "use strict";

  const SETTINGS_KEY = "batsignal.web.settings";
  const DB_NAME = "batsignal";
  // The ESP32 sends a heartbeat every 5 minutes: more than 12 minutes of silence = offline.
  const ONLINE_WITHIN_S = 12 * 60;
  // ntfy keeps messages for 12 hours.
  const HISTORY_WINDOW = "12h";
  // Static export (tools/export_static_site.py): hosted without the Bat-Signal server.
  const STANDALONE = !!document.querySelector('meta[name="bat-signal-standalone"]');

  const $ = (id) => document.getElementById(id);
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

  const loadKey = (name = "command") => dbRun("readonly", (s) => s.get(name));
  const saveKey = (key, name = "command") => dbRun("readwrite", (s) => s.put(key, name));
  const deleteKey = (name = "command") => dbRun("readwrite", (s) => s.delete(name));

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

  // ---- small UI helpers ----------------------------------------------------------
  function setMessage(text, level) {
    const el = $("wake-status");
    el.textContent = text;
    el.dataset.level = level || "";
  }

  function setSteps(states) {
    const list = $("steps");
    list.hidden = !states;
    if (!states) return;
    states.forEach((state, index) => {
      const item = list.querySelector(`[data-step="${index + 1}"]`);
      if (item) item.dataset.state = state;
    });
  }

  function setBusy(value) {
    busy = value;
    $("wake-button").disabled = value;
    $("sleep-button").disabled = value;
    $("wake-button").classList.toggle("busy", value);
    $("wake-button").setAttribute("aria-busy", String(value));
  }

  function setChip(chipId, textId, level, text) {
    const chip = $(chipId);
    const label = $(textId);
    if (!chip || !label) return;
    chip.dataset.level = level;
    label.textContent = text;
  }

  function twoDigits(n) { return String(n).padStart(2, "0"); }

  function clock(unix) {
    const d = new Date(unix * 1000);
    return `${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}`;
  }

  // "à l'instant", "il y a 7 min", "il y a 2 h 05", "il y a 3 j"
  function ago(seconds) {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return "à l'instant";
    const minutes = Math.round(s / 60);
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `il y a ${hours} h ${twoDigits(minutes % 60)}`;
    return `il y a ${Math.floor(hours / 24)} j`;
  }

  function describe(event) {
    const methods = [event.ble ? "Bluetooth" : null, event.wol ? "paquet magique" : null].filter(Boolean);
    return methods.length ? methods.join(" + ") : "aucune méthode";
  }

  // ---- ESP32 / PC state ----------------------------------------------------------
  async function refreshDevice() {
    const settings = loadSettings();
    const hint = $("esp-hint");
    if (!settings.ntfyUrl || !settings.statusTopic) {
      setChip("esp-chip", "esp-state", "", "ESP32 : non configuré");
      hint.hidden = true;
      return null;
    }
    try {
      const events = await fetchStatus(settings, HISTORY_WINDOW);
      const now = Date.now() / 1000;
      const latest = events.reduce((max, e) => Math.max(max, e.time), 0);
      const lastWake = events.filter((e) => e.kind === "wake").reduce((a, e) => (a && a.time > e.time ? a : e), null);
      $("last-wake").textContent = lastWake
        ? `Dernier réveil : ${clock(lastWake.time)} (${describe(lastWake)}), ${ago(now - lastWake.time)}.`
        : "";
      if (!latest) {
        setChip("esp-chip", "esp-state", "bad", `ESP32 : aucun signe depuis plus de ${HISTORY_WINDOW.replace("h", " h")}`);
        hint.textContent = "Vérifiez qu'il est alimenté et connecté au Wi-Fi 2,4 GHz (moniteur série), et que le sujet de statut est bien celui de config.h.";
        hint.hidden = false;
        return "none";
      }
      const age = now - latest;
      if (age <= ONLINE_WITHIN_S) {
        setChip("esp-chip", "esp-state", "good", `ESP32 en ligne · ${ago(age)}`);
        hint.hidden = true;
        return "online";
      }
      setChip("esp-chip", "esp-state", "bad", `ESP32 hors ligne · dernier signe à ${clock(latest)} (${ago(age)})`);
      hint.textContent = "Plus de battement depuis plus de 12 minutes : vérifiez l'alimentation de la carte, son Wi-Fi 2,4 GHz et son moniteur série.";
      hint.hidden = false;
      return "stale";
    } catch (e) {
      setChip("esp-chip", "esp-state", "warn", "ESP32 : état inconnu (ntfy injoignable ou token refusé)");
      hint.hidden = true;
      return null;
    }
  }

  async function pcIsUp() {
    if (STANDALONE) return false;
    try {
      const response = await fetch("/health", { cache: "no-store" });
      return response.ok;
    } catch (e) {
      return false;
    }
  }

  async function refreshPc() {
    if (STANDALONE || !$("pc-chip")) return;
    const up = await pcIsUp();
    setChip("pc-chip", "pc-state", up ? "good" : "bad", up ? "PC allumé" : "PC injoignable (veille ou éteint)");
  }

  function refreshAll() {
    refreshDevice();
    refreshPc();
  }

  // ---- actions -------------------------------------------------------------------
  let busy = false;

  async function wake() {
    if (busy) return;
    const settings = loadSettings();
    const key = await loadKey().catch(() => undefined);
    if (!settings.ntfyUrl || !key) {
      setMessage("Configurez d'abord le canal de réveil (Réglages).", "warn");
      $("settings").showModal();
      return;
    }
    setBusy(true);
    const started = Date.now();
    setSteps(["active", "pending", "pending"]);
    try {
      setMessage("Envoi du signal…");
      const message = await BatCore.signCommand(key, "WAKE", Math.floor(Date.now() / 1000));
      const published = await publish(settings, message);

      setSteps(["done", "active", "pending"]);
      setMessage("Signal envoyé, en attente de l'ESP32…");
      let reply;
      for (let i = 0; i < 18 && !reply; i++) {
        await sleep(2500);
        const events = await fetchStatus(settings, published.time).catch(() => []);
        reply = events.find((e) => (e.kind === "wake" || e.kind === "error") && e.time >= published.time);
      }
      if (!reply) {
        setSteps(["done", "error", "pending"]);
        const state = await refreshDevice();
        return setMessage(state === "online"
          ? "L'ESP32 est en ligne mais n'a pas accepté la commande : clé ou sujet différents, ou horloge décalée de plus de 60 s."
          : "L'ESP32 ne répond pas : éteint, hors Wi-Fi, ou pas encore flashé (voir docs/testing.md).", "bad");
      }
      if (reply.kind === "error") {
        setSteps(["done", "error", "pending"]);
        return setMessage("Erreur de l'ESP32 : " + reply.message, "bad");
      }

      setSteps(["done", "done", STANDALONE ? "pending" : "active"]);
      if (STANDALONE) {
        return setMessage(`Signal transmis (${describe(reply)}). Le PC devrait démarrer dans quelques secondes.`, "good");
      }
      setMessage(`ESP32 : signal envoyé (${describe(reply)}). Attente du démarrage du PC…`);
      for (let i = 0; i < 48; i++) {
        if (await pcIsUp()) {
          setSteps(["done", "done", "done"]);
          refreshPc();
          const seconds = Math.round((Date.now() - started) / 1000);
          return setMessage(`PC réveillé en ${seconds} s.`, "good");
        }
        await sleep(2500);
      }
      setMessage(`Signal envoyé (${describe(reply)}). Le PC n'a pas encore répondu.`, "warn");
    } catch (error) {
      setSteps(null);
      setMessage(error.message, "bad");
    } finally {
      setBusy(false);
      refreshDevice();
    }
  }

  // Suspend the PC. The PC-side listener (docs/sleep.md) obeys only a SLEEP signed with this key.
  async function sleepPc() {
    if (busy) return;
    const settings = loadSettings();
    const key = (await loadKey("sleep").catch(() => undefined)) || (await loadKey().catch(() => undefined));
    if (!settings.ntfyUrl || !key) {
      setMessage("Configurez d'abord le canal (Réglages).", "warn");
      $("settings").showModal();
      return;
    }
    if (!confirm("Mettre le PC en veille maintenant ?")) return;
    setBusy(true);
    setSteps(null);
    try {
      setMessage("Envoi de l'ordre de mise en veille…");
      const message = await BatCore.signCommand(key, "SLEEP", Math.floor(Date.now() / 1000));
      await publish(settings, message);
      if (STANDALONE) {
        return setMessage("Ordre de mise en veille envoyé : le PC doit s'endormir dans quelques secondes.", "good");
      }
      setMessage("Ordre envoyé, attente de la mise en veille…");
      for (let i = 0; i < 24; i++) {
        await sleep(2500);
        if (!(await pcIsUp())) {
          refreshPc();
          return setMessage("PC en veille.", "good");
        }
      }
      setMessage("Ordre envoyé, mais le PC répond encore : mise en veille à distance non activée ? (docs/sleep.md)", "warn");
    } catch (error) {
      setMessage(error.message, "bad");
    } finally {
      setBusy(false);
    }
  }

  // ---- settings ------------------------------------------------------------------
  async function saveSettings(event) {
    event.preventDefault();
    const error = $("settings-error");
    error.textContent = "";
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
      const sleepKeyText = $("sleep-key").value.trim();
      if (sleepKeyText) await saveKey(await BatCore.importKey(sleepKeyText), "sleep");
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      $("command-key").value = "";
      $("sleep-key").value = "";
      $("ntfy-token").value = "";
      $("generated").hidden = true;
      $("settings").close();
      setMessage("Réglages enregistrés.", "good");
      refreshAll();
    } catch (e) {
      error.textContent = e.message;
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
    if (!confirm("Effacer l'adresse, les sujets, le token et les clés de ce navigateur ?")) return;
    localStorage.removeItem(SETTINGS_KEY);
    await deleteKey().catch(() => undefined);
    await deleteKey("sleep").catch(() => undefined);
    fillSettings();
    setMessage("Réglages effacés.");
    refreshDevice();
  }

  function init() {
    if (STANDALONE) {
      const third = $("steps").querySelector('[data-step="3"]');
      if (third) third.hidden = true;
    }
    $("wake-button").addEventListener("click", wake);
    $("sleep-button").addEventListener("click", sleepPc);
    $("refresh").addEventListener("click", refreshAll);
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
    $("copy-key").addEventListener("click", () => {
      if (navigator.clipboard) navigator.clipboard.writeText($("generated-key").textContent).catch(() => undefined);
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAll(); });
    if ("serviceWorker" in navigator) navigator.serviceWorker.register(STANDALONE ? "sw.js" : "/sw.js").catch(() => undefined);
    fillSettings();
    refreshAll();
    setInterval(refreshAll, 60000);
    loadKey().then((key) => {
      if (!key || !loadSettings().ntfyUrl) setMessage("Configurez le canal de réveil (icône Réglages).", "warn");
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
