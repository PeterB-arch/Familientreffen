# Familienfest-Planer – Home Assistant Add-on

Zeitplan- und Anmelde-Tool fuer euer Familienfest, jetzt als Home-Assistant-Add-on.

## Installation

1. In Home Assistant: **Einstellungen → Add-ons → Add-on Store → ⋮ (oben rechts)
   → Repositories** → euer GitHub-Repo eintragen (URL des Repos, nicht des
   Unterordners).
2. Store neu laden, das Add-on **"Familienfest-Planer"** erscheint in der Liste.
3. Installieren, danach im **Konfiguration**-Tab die drei Werte anpassen:
   - `family_token` – der Token, mit dem sich jedes Familienmitglied einmalig
     einen eigenen Account (Benutzername + Passwort) anlegt
   - `admin_code` – dein persoenlicher Admin-Code (nicht weitergeben!)
   - `session_secret` – irgendein zufaelliger, langer Text (einmalig festlegen,
     danach nie mehr aendern, sonst werden alle Sessions ungueltig)
4. Add-on starten. Danach erscheint links in der Home-Assistant-Sidebar der
   Punkt **"Familienfest"** (Ingress) – darüber kannst du selbst und alle
   anderen Home-Assistant-Nutzer direkt zugreifen, bereits eingeloggt über HA.

## Zugriff fuer Familie ohne eigenen Home-Assistant-Account

Ingress funktioniert nur fuer Personen mit einem Login auf eurer HA-Instanz.
Damit Familienmitglieder ohne HA-Account trotzdem teilnehmen koennen, ist das
Add-on zusaetzlich ganz normal auf Port `3000` erreichbar – genau wie vorher
per Docker-Compose. Richte dafuer wie gehabt einen Reverse Proxy oder eine
DDNS-Adresse auf `<NAS-IP>:3000` ein und gib diesen Link an die Familie weiter,
zusammen mit dem `family_token` zur einmaligen Registrierung.

## Daten & Backups

Alle Anmeldungen liegen im Add-on-eigenen, dauerhaften `/data`-Ordner. Dieser
wird automatisch in jedes Supervisor-Backup (Einstellungen → System →
Backups) mit aufgenommen – ein manuelles Backup des `data`-Ordners ist bei
Add-on-Betrieb nicht mehr noetig.

## Neues Fest im naechsten Jahr

Add-on stoppen, im Dateisystem (z. B. per Studio-Code-Server- oder
Terminal-Add-on) `/addon_configs/<slug>/data.json` bzw. den Add-on-`/data`-
Ordner leeren, Add-on neu starten.
