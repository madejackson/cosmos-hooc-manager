# cosmos-hooc-manager

**HOOC Connect Manager für Cosmos** — Web-UI, Image-Import und Watchdog für den
[HOOC Connect](https://hooc.me) (BAB-tec) Embedded-Gateway-Container, im
Cosmos/Asera-Design (dunkel/hell, `#B01419`/`#690C0F`, Public Sans).

## Was es tut

Der HOOC Connect Client (`hooc-connect`, ein SoftEther-VPN-Gateway von BAB-tec
für Modbus/Smart-Home-Fernzugriff) wird normalerweise per wget-Link aus dem
HOOC-Portal als Docker-Image geliefert und per Einzeiler installiert:

```sh
docker run --name hooc-connect --detach --device /dev/net/tun \
  --cap-add NET_ADMIN --cap-add NET_BIND_SERVICE --network host \
  --restart unless-stopped hooc/connect-SERIAL:VERSION
```

Dieser Manager macht daraus einen **Cosmos-Servapp** mit Web-UI:

| Funktion | Detail |
|---|---|
| 📥 **Install / Update** | wget-Link aus dem HOOC-Portal → Download → `docker load` → Container-Start |
| 📊 **Status** | Container-State, Image (aktiviert vs. generisch), Serial, VPN-Status, Uptime, Logs |
| 🔁 **Start / Stop / Restart / Uninstall** | Lifecycle-Buttons |
| 🛡️ **Watchdog** | prüft alle 30 s und startet/erstellt `hooc-connect` neu (wie `hooc watchdog`) |
| 🌐 **HOOC Web UI** | die integrierte HOOC-Oberfläche (Status & Aktivierung) unter `/hooc/` — wie beim HOOC Gateway Manager |

## Install (Marketplace-Template)

Der Servapp benutzt **Host-Network + NET_ADMIN + `/dev/net/tun`** für den
`hooc-connect`-Container (identisch zum Original-Befehl), und mountet den
**Docker-Socket**, damit der Manager Images laden und Container verwalten kann.

> ⚠️ **Sicherheit:** Der Docker-Socket-Mount gibt dem Manager vollen
> Container-Zugriff — nur auf vertrauenswürdigen Hosts installieren.

### Manuell (ohne Store)

```sh
git clone https://github.com/madejackson/cosmos-hooc-manager
docker build -f docker/Dockerfile -t ghcr.io/madejackson/cosmos-hooc-manager:latest .
docker run -d --name cosmos-hooc-manager --restart unless-stopped \
  -p 8095:8095 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v hooc-manager-data:/data \
  ghcr.io/madejackson/cosmos-hooc-manager:latest
```

Dann `http://<host>:8095` öffnen.

## Benutzung

1. Im **HOOC-Portal** (portal.hooc.me) → Konfiguration → Plattform → Docker Image
   → wget-Link kopieren.
2. Im Manager **Install / Update** einfügen → *Installieren*.
3. Der Manager lädt das Image (aktiviert, mit dir zugewiesenem Serial), importiert
   es und startet `hooc-connect`.
4. Status beobachten, Watchdog aktivieren, HOOC-Web-UI unter „HOOC Web UI" öffnen.

### Wichtig zu HardwareID

Der HOOC-Client generiert die **HardwareID** aus den MAC-Adressen der
Host-NICs + `/etc/machine-id` (siehe `config/hardware_id.go` im HOOC-Code).
Der generische `hooc/connect-generic`-Image kann in einem Container ohne
NIC-Zugriff keine HWID bilden → **auf einem OpenWrt-Router (mit echten
Interfaces) installieren**, wo der Container per `--network host` alle
Host-Interfaces sieht. Der Manager zeigt die HWID an, sobald verfügbar.

## API

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/status` | Status, Images, Container, Task, Watchdog-Events |
| POST | `/api/install` | `{wget, bridge}` → Download+Load+Run |
| POST | `/api/start` `/api/stop` `/api/restart` | Lifecycle |
| POST | `/api/watchdog` | `{enable: bool}` |
| DELETE | `/api/uninstall` | Container entfernen |
| GET | `/hooc/*` | Proxy zur HOOC-Web-UI |

## Entwicklung

```sh
node server/index.js          # startet auf :8095 (DATA_DIR steuerbar)
```

## Lizenz

MIT © Asera / madejackson
