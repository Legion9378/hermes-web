# Hermes Web

Browser-Frontend für Hermes Agent auf einem Rechner, den du kontrollierst — ähnlich der Idee von `codex-web`, aber für Hermes Agent.

Ziel: Der Agent bleibt auf deinem Laptop/Home-Server/Mac mini aktiv, während du vom Browser oder iPhone über Tailscale/Caddy wieder einsteigst. Die UI rendert **keinen Terminal-CLI-Stream**, sondern spricht direkt mit dem Hermes API Server.

## Features

- Markdown- und Codeblock-Rendering
- sauberere Session-Liste und Session-Historie
- Stop/Cancel über Runs API, wenn Hermes im Stream eine `run_id` liefert
- einklappbare Toolcall-/Tooloutput-Cards
- Approval UI für riskante Aktionen, sofern der API Server Approval-Events liefert
- Bild-Upload über Hermes Session Chat Streaming (`input_image`)
- installierbarer `hermes-web` Startbefehl
- systemd User Service
- iOS/PWA-Metadaten + Service Worker
- Same-Origin Proxy `/hermes/*` → Hermes API Server, damit Safari/iOS kein CORS braucht
- Caddy-Subpath-Support, z. B. `http://host.tailnet.ts.net/ziel/`

## 1. Hermes API Server aktivieren

In `~/.hermes/.env` ergänzen:

```bash
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
API_SERVER_KEY=bitte-einen-langen-token-setzen
```

Gateway starten:

```bash
hermes gateway
```

Test:

```bash
curl http://127.0.0.1:8642/health \
  -H "Authorization: Bearer <dein-api-server-key>"
```

## 2. Hermes Web starten

Foreground:

```bash
cd ~/hermes-web
./bin/hermes-web
```

Oder direkt:

```bash
python3 serve.py --host 127.0.0.1 --port 4173 --hermes-api http://127.0.0.1:8642
```

## 3. Caddy unter `/ziel/`

Hermes Web unterstützt zwei Reverse-Proxy-Varianten.

### Variante A — Caddy strippt den Prefix, empfohlen

Caddyfile:

```caddyfile
host.tailxxxxx.ts.net {
  handle_path /ziel/* {
    reverse_proxy 127.0.0.1:4173
  }
}
```

Hermes Web läuft dann ohne Base-Path:

```bash
HERMES_WEB_BASE_PATH= hermes-web
```

Die App ist erreichbar unter:

```text
http://host.tailxxxxx.ts.net/ziel/
```

Die UI berechnet die API-Basis automatisch als:

```text
http://host.tailxxxxx.ts.net/ziel/hermes
```

Caddy strippt `/ziel`, der Python-Server sieht `/hermes/*` und proxyt an Hermes API Server.

### Variante B — Caddy strippt den Prefix nicht

Caddyfile:

```caddyfile
host.tailxxxxx.ts.net {
  handle /ziel/* {
    reverse_proxy 127.0.0.1:4173
  }
}
```

Dann Hermes Web mit Base-Path starten:

```bash
HERMES_WEB_BASE_PATH=/ziel hermes-web
```

Oder systemd-Unit anpassen:

```bash
systemctl --user edit hermes-web
```

Inhalt:

```ini
[Service]
Environment=HERMES_WEB_BASE_PATH=/ziel
```

Dann:

```bash
systemctl --user daemon-reload
systemctl --user restart hermes-web
```

## 4. Installieren

```bash
cd ~/hermes-web
./bin/install-hermes-web
```

Danach:

```bash
hermes-web
```

oder als user service:

```bash
systemctl --user enable --now hermes-web
systemctl --user status hermes-web
```

## 5. iPhone Installation

Erst installieren, wenn der normale Browser-Aufruf stabil ist. Hermes Web unterstützt vorher schon browserseitige Web-Kommandos:

```text
/help
/status
/new [Titel]
/model
/model <modell> --provider <provider>
```

Beispiel für Remote-Modellwechsel, wenn du unterwegs Limits erreichst:

```text
/model gpt-5.5 --provider openai-codex
```

Der Modellwechsel läuft über den lokalen Hermes-Web-Control-Endpoint `POST /__hermes_web/model`, ist mit demselben Bearer-Token wie die Hermes API geschützt und schreibt `model.provider` / `model.default` per `hermes config set`. `/model` ohne Argument öffnet im WebUI eine CLI-ähnliche Auswahl: Provider-Dropdown → Modell-Suche/-Liste → „Modell setzen“. Die Provider-/Modellliste kommt aus Hermes' eigener Inventory-Quelle (`build_models_payload(load_picker_context())`), nicht aus einer manuell gepflegten Liste. Wenn der Hermes-Web-Server selbst `API_SERVER_KEY` aus der Umgebung oder `~/.hermes/.env` kennt, injiziert er den Token serverseitig für `/hermes/*` und die Web-Control-Endpoints; die PWA muss den API-Key dann nicht im Browser speichern und nach einem Neustart nicht neu abfragen. Vollständige CLI-/Gateway-Slashcommands werden nicht blind durchgeschleift, weil sie an CLI- bzw. Messaging-State hängen und über den API Server nicht 1:1 dieselbe Semantik haben.

### Vorlesen

In den Einstellungen gibt es die Option **Antworten automatisch vorlesen** plus **Audio aktivieren** und **Vorlesen stoppen**. Zusätzlich bekommt jede Assistant-Antwort einen eigenen **Vorlesen**-Button, ähnlich wie bei Chat-UIs mit explizitem Audio-Control. Die erste Version nutzt die Browser-/iOS-SpeechSynthesis-Stimme lokal im Gerät. Auto-Vorlesen startet erst nach einer aktiven Audio-Freigabe durch den Nutzer, weil iOS/PWA-WebViews automatische Audioausgabe sonst häufig blockieren. Codeblöcke werden beim Vorlesen gekürzt/ersetzt.

1. Tailscale auf dem iPhone aktivieren.
2. Caddy-URL der Web-App in Safari öffnen, z. B. `http://host.tailxxxxx.ts.net/ziel/`.
3. Teilen → Zum Home-Bildschirm.
4. PWA vom Home-Screen öffnen.
5. ⚙ → API Token eintragen.

Wenn iOS alte Assets cached: Home-Screen-App löschen, Safari-Seite neu laden und erneut zum Home-Bildschirm hinzufügen. Cache-Version: `hermes-web-v4`.

## Sicherheit

Behandle jeden, der diese Web-UI erreichen kann, als jemanden, der Hermes auf deinem Host bedienen kann. Hermes kann je nach Toolset Terminal, Dateien, Browser und andere lokale Ressourcen verwenden. Deshalb: nur Tailnet/VPN oder Reverse Proxy mit Auth.

## Tests

```bash
node --test tests/app.test.mjs
node --check src/app.js
python3 -m py_compile serve.py
```
