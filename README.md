# Bat-Signal web

Static wake page for Bat-Signal (no server, no secret). The command key, the ntfy topics and the
optional ntfy token are typed in the page and kept in the visitor's browser only. Without the key
nobody can wake the PC: every command is signed (HMAC-SHA256) in the browser and checked by the ESP32.
