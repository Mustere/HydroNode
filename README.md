# HydroNode

**HydroNode** is an asynchronous smart irrigation system built on the ESP8266 (Wemos D1 Mini) with a web interface, written in C++ using PlatformIO.

The device controls a water pump on a schedule or manually via a web dashboard accessible from a phone or computer on the local network — no cloud or third-party services required.

## Features

- **Pump control** — manual start for a specific volume (mL) or an indefinite on/off mode
- **Watering schedule** — up to 35 independent slots with configurable time and volume, with protection against double-triggering on the same day
- **Web interface** — an HTML/CSS/JS dashboard served directly from the controller via LittleFS
- **Flexible Wi-Fi** — client mode (STA) connecting to a home network, or a standalone access point (AP); if the STA connection fails, the device automatically falls back to a recovery access point, `HydroNode_RECOVERY`
- **Time sync** — accurate time via NTP (`pool.ntp.org`), with the timezone set in POSIX format
- **OTA firmware updates** — upload a new `.bin` file directly through the web interface, no cable required
- **Persistent settings** — Wi-Fi configuration and the watering schedule are stored on the LittleFS filesystem and survive reboots

## Hardware

| Component | Purpose |
|---|---|
| Wemos D1 Mini (ESP8266) | main controller |
| Relay / MOSFET module | pump switching |
| Water pump | connected to `GPIO14` through a power switch |

> Pump throughput is set via the `PUMP_FLOW_RATE` constant in `src/PumpManager.cpp` (mL/sec) and is used to calculate run time for a given volume. Recalibrate this value if you swap the pump for a different model.

## Project structure

```
HydroNode/
├── src/                     # firmware source code
│   ├── main.cpp             # entry point: initialization, setup/loop
│   ├── ConfigManager.cpp    # Wi-Fi settings read/write (LittleFS + JSON)
│   ├── PumpManager.cpp      # pump control, run-time calculation by volume
│   ├── Scheduler.cpp        # watering schedule, duplicate-trigger protection
│   ├── TimeManager.cpp      # NTP time sync
│   └── WebInterface.cpp     # HTTP server, REST API, OTA updates
├── include/                 # module header files
├── data/                    # web interface files (uploaded to LittleFS)
│   ├── index.html
│   ├── style.css
│   ├── script.js
│   └── config.json          # Wi-Fi settings and schedule (created automatically)
├── docs/                    # ESP8266/ESP32 datasheets and related documentation
└── platformio.ini           # PlatformIO project configuration
```

## Build and flash

The project is built with [PlatformIO](https://platformio.org/) (VS Code extension or CLI).

1. Clone the repository and open the folder in PlatformIO.
2. Connect the Wemos D1 Mini via USB.
3. Upload the filesystem (the web interface from the `data/` folder):
   ```bash
   pio run --target uploadfs
   ```
4. Build and flash the firmware:
   ```bash
   pio run --target upload
   ```
5. Open the serial monitor to view logs:
   ```bash
   pio device monitor
   ```

Dependencies (pulled in automatically via `platformio.ini`):
- `ESP32Async/ESPAsyncTCP`
- `ESP32Async/ESPAsyncWebServer`
- `bblanchon/ArduinoJson ^7.0.0`

## First boot

On first boot (no `config.json` file yet), the device starts its own access point:

- **SSID:** `HydroNode_AP`
- **Password:** `12345678`

Connect to this network, open `192.168.4.1` in a browser, and enter your home network credentials under "Wi-Fi Settings", switching the mode to "Client (STA)". After saving, the controller reboots and connects to the specified network.

If it fails to connect to the saved network (e.g. the router is off), the device automatically starts the recovery access point `HydroNode_RECOVERY` with the password `12345678`.

## Web interface

Once connected to the network, the dashboard is available at the device's IP address (printed to the serial monitor at startup) and provides:

- Wi-Fi configuration (STA/AP, SSID, password);
- manual pump start/stop, including watering by a specific volume;
- watering schedule editing (time, volume, slot active/inactive);
- firmware upload (`.bin`) via OTA.

### REST API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/get-status` | current pump state |
| `GET` | `/api/get-schedule` | current watering schedule |
| `POST` | `/api/save-wifi` | save Wi-Fi settings (triggers a reboot) |
| `POST` | `/api/save-schedule` | save the watering schedule |
| `POST` | `/api/toggle-pump` | manual pump control (on/off, or run by volume) |
| `POST` | `/api/update` | upload new firmware (OTA) |
| `GET` | `/heap` | debug output of free heap memory |

The server also exposes an `AsyncWebSocket` (`/ws`) and `Server-Sent Events` (`/events`) for real-time time and status updates.

## License

This project is distributed under the GNU GPL v3 license — see the [LICENSE](LICENSE) file.
