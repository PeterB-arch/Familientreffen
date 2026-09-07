# Familienfest-Planer

Zeitplan- und Anmelde-Tool fuer euer Familienfest. Laeuft entweder direkt als
Docker-Container (z. B. auf einer Synology NAS ueber Container Manager) oder
als Home-Assistant-Add-on.

## Installation auf einer Synology NAS (Docker / Container Manager)

Kein Home Assistant noetig - laeuft eigenstaendig per Docker-Compose.

1. Diesen Repo-Ordner auf die NAS kopieren, z. B. per File Station nach
   `/docker/familienfest-planer` oder per `git clone` ueber SSH.
2. `.env.example` nach `.env` kopieren und `ADMIN_CODE`, `FAMILY_TOKEN` sowie
   `SESSION_SECRET` mit eigenen Werten fuellen (`.env` wird nicht eingecheckt).
   `SESSION_SECRET` einmalig festlegen und danach nie mehr aendern - sonst
   werden bei jedem Neustart alle Logins ungueltig. Ohne vollstaendige `.env`
   startet der Server bewusst nicht. `ADMIN_CODE`/`FAMILY_TOKEN` sind nur
   Startwerte - beides laesst sich spaeter jederzeit in der App selbst unter
   **Verwaltung → Zugangsdaten** aendern.
3. **Container Manager** öffnen → **Projekt** → **Erstellen** → als Pfad den
   kopierten Ordner auswaehlen (dort wird die `docker-compose.yml`
   automatisch erkannt) → Build starten.
4. Nach dem Start ist die App unter `http://<NAS-IP>:3000` erreichbar. Alle
   Daten liegen dauerhaft im `data`-Unterordner neben der `docker-compose.yml`
   (per Bind-Mount) - der bleibt auch bei Image-Updates/Neu-Builds erhalten
   und laesst sich ganz normal per NAS-Backup (Hyper Backup o. ae.) sichern.
5. Fuer Zugriff von unterwegs: wie bei jedem anderen NAS-Dienst per
   Reverse-Proxy (Synology-eigener Reverse Proxy oder z. B. Nginx) bzw. QuickConnect/DDNS
   auf Port `3000` einrichten.

## Installation als Home-Assistant-Add-on

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
