// Pure helpers of the web wake panel (no DOM): signing, validation, status parsing.
// Same wire format as the firmware, the iOS app and tools/bat_signal_cmd.py (docs/protocol.md).
(function (root) {
  "use strict";

  const MIN_KEY_LENGTH = 16;
  const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
  const COMMANDS = ["WAKE", "WAKE-BLE", "WAKE-WOL", "PAIR", "UNPAIR"];

  function toHex(buffer) {
    return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // The key is imported as NON-extractable: scripts can sign with it but never read it back.
  function importKey(keyText) {
    if (typeof keyText !== "string" || keyText.length < MIN_KEY_LENGTH) {
      return Promise.reject(new Error(`La clé doit faire au moins ${MIN_KEY_LENGTH} caractères.`));
    }
    return root.crypto.subtle.importKey(
      "raw", new TextEncoder().encode(keyText), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }

  // "<CMD> <unix time> <hex HMAC-SHA256(key, '<CMD>|<unix time>')>"
  async function signCommand(cryptoKey, command, unixSeconds) {
    if (!COMMANDS.includes(command)) throw new Error(`Commande inconnue : ${command}`);
    const data = new TextEncoder().encode(`${command}|${unixSeconds}`);
    const mac = await root.crypto.subtle.sign("HMAC", cryptoKey, data);
    return `${command} ${unixSeconds} ${toHex(mac)}`;
  }

  function generateKey() {
    const bytes = root.crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function isLocalHost(host) {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
    const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
  }

  // Returns the normalised base URL (no path), or throws. HTTPS, or HTTP for local/Tailscale hosts.
  function validateNtfyUrl(raw) {
    let url;
    try { url = new URL(String(raw).trim()); } catch (e) { throw new Error("Adresse ntfy invalide."); }
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      throw new Error("L'adresse ntfy ne doit contenir ni chemin, ni identifiant, ni paramètre.");
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
      throw new Error("HTTPS est requis (HTTP seulement pour localhost, le réseau local ou Tailscale).");
    }
    return url.origin;
  }

  function validateTopic(raw, name) {
    const topic = String(raw).trim();
    if (!TOPIC_PATTERN.test(topic)) {
      throw new Error(`Le sujet « ${name} » est invalide (lettres, chiffres, _ et -, 64 caractères max).`);
    }
    return topic;
  }

  // Parses the newline-delimited JSON of `?poll=1` into status events the ESP32 published.
  function parseStatusEvents(text) {
    const events = [];
    for (const line of String(text).split("\n")) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch (e) { continue; }
      if (message.event !== "message" || typeof message.time !== "number") continue;
      const tags = Array.isArray(message.tags) ? message.tags : [];
      const kind = ["heartbeat", "wake", "error", "boot"].find((k) => tags.includes(k));
      if (!kind) continue;
      events.push({
        kind, time: message.time, message: String(message.message || ""),
        ble: tags.includes("ble_ok"), wol: tags.includes("wol_ok"),
      });
    }
    return events;
  }

  const api = { MIN_KEY_LENGTH, COMMANDS, toHex, importKey, signCommand, generateKey,
    validateNtfyUrl, validateTopic, parseStatusEvents };
  root.BatCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
