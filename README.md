# Tesla Battery MCP

**Tesla Battery MCP** is a local, read-only Model Context Protocol server for Claude Desktop and Cursor. It uses the official Tesla Fleet API for one-off vehicle snapshots and can analyze a locally retained, decoded Fleet Telemetry JSON Lines file for rich history. It never wakes a vehicle, issues commands, changes charging, or reports data as measured when Tesla does not expose it.

## What it measures

Tesla Fleet Telemetry documents useful pack-level signals, including usable state of charge, **Energy Remaining** in kWh, pack voltage/current, high-voltage isolation resistance, brick-voltage minimum and maximum, module-temperature minimum and maximum, and charging data. The MCP presents the values with their source fields and marks calculated values such as pack power, voltage spread, and temperature spread as derived. Tesla documents the brick and module extrema, but not an array of every cell or brick voltage, so this MCP cannot construct a genuine all-cell heat map. [1]

The server offers a live snapshot tool for a single `vehicle_data` request and local-telemetry tools for the deeper battery envelope and history. Tesla recommends telemetry rather than repeatedly polling live vehicle data because it avoids unnecessary wakes and provides high-frequency change-based data. [2]

## Battery degradation calculation

The server implements an **energy-based state-of-health (SOH)** calculation. Capacity SOH is conventionally defined as the present maximum capacity divided by the original rated capacity. [3] At a pack level, energy retention is more practical when the signals available are energy and state of charge. Tesla documents `EnergyRemaining` as nominal battery-pack energy in kWh and `Soc` as usable state of charge as a percentage of total capacity. [1]

For each paired Fleet Telemetry record, the MCP estimates nominal full-pack energy:

> **E<sub>full,estimated</sub> = EnergyRemaining ÷ (Soc ÷ 100)**

It uses the median across the selected telemetry window to limit the impact of individual measurements:

> **E<sub>current</sub> = median(E<sub>full,estimated</sub>)**

With an explicit, evidence-backed as-new energy reference, it calculates:

> **SOH<sub>energy</sub> = 100 × E<sub>current</sub> ÷ E<sub>new</sub>**
>
> **Degradation = 100 − SOH<sub>energy</sub>**

This is a transparent adaptation of the energy-retention definition. It does not claim to reproduce Tesla’s on-screen Battery Health Test. Tesla’s own test can take up to 24 hours, uses Battery Management System data, and reports energy retention against its proprietary expectation for the vehicle’s battery type, age, and use. Tesla does not document an API field containing that result. [4]

A numerical degradation result is therefore unlocked only after `tesla_battery_set_energy_baseline` receives an **as-new** kWh reference and evidence. The baseline can be a delivery-time measurement, manufacturer documentation, or another traceable new-condition result. An `observed` baseline is accepted but yields only change since that observation. The MCP reports a coefficient of variation for the inferred energy samples so a user can inspect data consistency rather than treating every calculation as equally reliable.

Academic work on vehicle-level energy-based SOH emphasizes controlled, reproducible measurement conditions. It recommends fixed charging conditions and explains that direct measurements are more accurate than corrections based solely on an estimated state-of-charge interval. [5] This MCP does not produce a hidden confidence score or a proprietary health verdict because it lacks Tesla’s internal BMS model and the API does not expose all needed diagnostics.

## Adjustable health-model suite

The `tesla_battery_health_models` tool adds six independently inspectable models plus an optional composite screening index. Every invocation returns the chosen inputs, qualifying records, formulas, and caveats. The caller can adjust the minimum state-of-charge span, accepted telemetry gap, current-step filter, brick and thermal thresholds, and a separate weight for each composite component.

| Model | Calculation | Required reference or policy | Interpretation boundary |
|---|---|---|---|
| **Energy retention** | `median(EnergyRemaining ÷ (Soc ÷ 100))` | As-new kWh energy reference | Primary API-based energy-retention model; not Tesla’s private Health Test result. |
| **Coulomb-counted capacity** | `∫ abs(PackCurrent) dt ÷ observed SOC fraction` | As-new Ah reference; monotonic SOC window | Pack-capacity estimate. It depends on telemetry sampling, BMS SOC calibration, and comparable operating conditions. |
| **Rated-range retention** | `median(RatedRange ÷ (Soc ÷ 100))` | As-new 100% rated-range reference | A useful range proxy, not a direct capacity measurement. |
| **Brick-voltage envelope** | `(BrickVoltageMax − BrickVoltageMin) × 1000` | User-set warning and critical mV policy thresholds | A max–min envelope. Tesla does not expose each cell or brick value through Fleet API. |
| **Thermal envelope** | `ModuleTempMax − ModuleTempMin` | User-set warning and critical °C policy thresholds | A max–min thermal uniformity signal that varies with ambient conditions and thermal management. |
| **Apparent pack resistance** | `median(abs(ΔPackVoltage ÷ ΔPackCurrent) × 1000)` | Optional as-new mΩ reference; current-step and gap filters | A comparative screening proxy, not a controlled DC internal-resistance measurement. |

The **user-weighted composite** normalizes only the available model components:

> **Composite screening index = Σ(component score × user weight) ÷ Σ(user weight)**

For energy, capacity, and range, a component score is its retention percentage, capped at 100. Brick and thermal scores need a user-provided critical policy threshold, while the resistance score requires a reference. The composite is intentionally described as a **user policy index**, not an official Tesla metric or a validated state-of-health diagnosis.

Use `tesla_battery_health_model_catalog` to review every formula and its signal requirements. Use `tesla_battery_set_health_reference` to store a kWh, Ah, mile, or mΩ reference alongside its source and evidence. A reference of type `observed` measures change since that observation, whereas only `as_new` supports a degradation-since-new statement.

## Prerequisites

A Tesla developer application is required. Tesla uses a Developer **Client ID** and **Client Secret**, then an OAuth authorization-code flow with the `vehicle_device_data` and `offline_access` scopes. It does not support a generic standalone API key for this personal-vehicle flow. Refresh tokens are single use and rotate, so the MCP writes the current rotated token into a mode-`0600` local cache. [6]

For the history, brick-envelope, and degradation tools, configure Tesla Fleet Telemetry on a compatible vehicle and retain decoded telemetry records as JSON Lines. Tesla requires a public telemetry server, a hosted application public key, virtual-key pairing, and supported firmware. The local stdio MCP reads the resulting local record file; it is not itself the public telemetry server. [2] [7]

## Local installation

Install on the computer that runs Claude Desktop or Cursor:

```bash
cd /path/to/tesla-battery-mcp
pnpm install --frozen-lockfile=false
pnpm build
chmod 700 run-mcp.sh
mkdir -p ~/.config/tesla-battery-mcp
cp .env.example ~/.config/tesla-battery-mcp/.env
chmod 600 ~/.config/tesla-battery-mcp/.env
```

Edit `~/.config/tesla-battery-mcp/.env` locally. Set `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`, and the correct `TESLA_BASE_URL` for the vehicle region. The public client secret and rotating tokens must remain in that private file or cache, not in a MCP configuration file, source repository, chat, or command-line argument.

Register `http://127.0.0.1:43189/callback` as the callback URL in the Tesla developer application. Then run the OAuth helper **on the same Windows or macOS/Linux computer that will host the dashboard**. It prints an official Tesla sign-in link. Enter Tesla credentials only on the `auth.tesla.com` page; this MCP never receives or logs the password. After consent, the browser returns to the loopback callback and the helper writes a restricted local token cache.

```bash
./run-oauth.sh
```

On Windows, double-click `run-oauth.cmd` or run it from Command Prompt. Open the printed authorization URL on that same computer and complete the Tesla sign-in and consent screen. The helper validates the OAuth state and accepts only a `127.0.0.1`/`localhost` callback. Tesla requires the developer application's Client ID, Client Secret, matching callback URL, and `offline_access` scope for the token exchange; those must be configured locally before the link can be generated. [6]

The `run-mcp.sh` launcher sources the same private environment file every time the MCP client starts it. On Windows, use `run-mcp.cmd`.

## Claude Desktop and Cursor configuration

Copy the entry in `claude_desktop_config.example.json` into Claude Desktop’s MCP configuration, replacing `/absolute/path/to/tesla-battery-mcp` with the real absolute folder. For Cursor, copy the equivalent entry in `cursor_mcp.example.json` into its MCP configuration. Restart the MCP client after editing its configuration.

The resulting configuration contains only the local launcher path. It deliberately contains no API key, client secret, refresh token, or raw access token.

## Fleet Telemetry record requirements

Set `TESLA_TELEMETRY_FILE` to a decoded JSONL file that includes `vin` plus a timestamp and selected Tesla telemetry fields. For deep battery and degradation work, configure at least the following fields in the Tesla Fleet Telemetry service:

```text
Soc, EnergyRemaining, PackVoltage, PackCurrent,
BrickVoltageMin, BrickVoltageMax, NumBrickVoltageMin, NumBrickVoltageMax,
ModuleTempMin, ModuleTempMax, NumModuleTempMin, NumModuleTempMax,
IsolationResistance, BatteryHeaterOn, ChargeState,
ChargeLimitSoc, ChargerPower, AcChargingPower, DcChargingPower,
ChargerVoltage, ChargeAmps, TimeToFullCharge,
DcChargingEnergyIn, AcChargingEnergyIn, LifetimeEnergyUsed, Odometer
```

Tesla’s official reference server can emit decoded records through a supported dispatcher. Configure it and a durable local or network pipeline so the JSONL file supplied to this MCP contains decoded records. Treat the file as sensitive vehicle telemetry. [7]

## Optional Scan My Tesla and OBD/CAN diagnostics

The MCP can supplement Fleet API telemetry with an optional **direct BMS evidence source** for Model 3/Y 2020+. This path is entirely opt-in and on demand. It supports three ways to bring locally controlled diagnostic information into the MCP:

1. **Scan My Tesla exports.** Import a local CSV or JSON export with `tesla_scanmytesla_import_diagnostics`. The importer recognizes BMS labels such as nominal full-pack energy, nominal energy remaining, usable full pack, brick-voltage extrema, and module-temperature extrema. It retains any unrecognized values as raw evidence rather than guessing their meaning. Scan My Tesla documents CSV logging and its current Android releases write logs to Downloads. [8]

2. **TeslaLogger diagnostic exports.** Scan My Tesla can send selected live data to TeslaLogger through its documented token route. The app routes this through a German HTTPS service, after which TeslaLogger retains the data. This MCP reads only a local export supplied by the user; it does not send a token, connect to the relay, or upload diagnostic data. [9] [10]

3. **Direct Bluetooth/serial CAN capture.** On Windows, pair a compatible Bluetooth Classic adapter and provide its COM port. On macOS, provide a compatible serial/RFCOMM device path if the adapter creates one. `tesla_scanmytesla_capture_passive_can` uses short ELM/STN adapter configuration commands and `ATMA` monitoring. It sends **no Tesla CAN frame**, wakes no vehicle, and runs only for the caller-selected capture duration. It decodes only verified open Model 3/Y mappings: `0x352` for nominal pack energy, `0x332` for BMS extrema, and `0x401` for brick-voltage groups. [11] [12]

The direct path requires a **Model 3/Y internal-CAN wiring harness**, not merely the ordinary OBD-II port. Scan My Tesla states that the normal OBD-II port exposes only 12 V and the VIN; the internal battery data are on the vehicle CAN bus. Use a correct vehicle-specific harness and a compatible adapter. Faster STN1110-class adapters or Wi-Fi CAN bridges are preferred for wide logs because slower ELM327 adapters can drop less-frequent packets. [8] [13]

### BMS constrained calibration policy

`tesla_battery_bms_constrained_calibration` implements the selected constrained policy. It calculates:

> **BMS energy retention = 100 × direct BMS Nominal Full Pack kWh ÷ evidence-backed as-new kWh reference**

It runs only after the caller confirms that the direct reading and reference are comparable and adds a condition note. It does **not** silently overwrite the normal Fleet API health-model suite. Most importantly, it never uses `Full pack when new` in this formula. Scan My Tesla explains that its former comparison of that signal with nominal full pack was removed after it was proven incorrect. The MCP retains it only as visibly excluded raw evidence if a user export contains it. [8]

Scan My Tesla and this MCP normally cannot share one active Bluetooth Classic serial adapter. Run the direct capture only after disconnecting the app, or use an export/TeslaLogger route while the app is connected. A Wi-Fi CAN bridge is an alternative where its manufacturer supports multiple clients, but its interface and access policy still need to be configured by the owner.

### Source selection and no-hardware fallback

**Fleet API is the default for every user.** No Scan My Tesla adapter, harness, Android device, local export, or Bluetooth pairing is required to use `tesla_battery_health_by_source` with `sourceMode: fleet_api_only`. The tool uses Fleet Telemetry history when available. If a history file has not been configured, it falls back further to one live `vehicle_data` snapshot and explains that it cannot calculate a longitudinal health result from a single observation.

Optional BMS hardware never blocks Fleet API use. When a caller chooses `auto_prefer_bms_when_available`, `compare_fleet_and_bms`, or `bms_constrained_calibration` but an export, port, or adapter is unavailable, the MCP returns the Fleet API result plus a labeled `not_available_falling_back_to_fleet_api` BMS status. It does not fabricate BMS diagnostics or fail the whole request.

| Mode | Hardware badge | Health-result behavior |
|---|---|---|
| `fleet_api_only` | **None** | Default. Uses official Fleet API/Fleet Telemetry only. |
| `auto_prefer_bms_when_available` | **Optional:** Android export, TeslaLogger export, or CAN hardware | Adds BMS detail if available; Fleet API remains the primary health result. |
| `compare_fleet_and_bms` | **Optional:** same as above | Presents Fleet and BMS values side by side with provenance and no automatic reconciliation. |
| `bms_constrained_calibration` | **Required:** direct BMS source plus evidence-backed new-condition energy reference | Adds a separately labeled BMS nominal-energy retention calculation only after user-confirmed comparable conditions. |

Use `tesla_battery_source_catalog` to see these requirements inside the MCP client. The `tesla_battery_health_by_source` tool exposes the selection in one request. It records the effective source, fallback state, and any unavailable optional hardware in its response.

## Available MCP tools

| Tool | Use |
|---|---|
| `tesla_list_vehicles` | Lists authorized vehicles without waking or controlling them. |
| `tesla_battery_live_snapshot` | Retrieves one live API snapshot and derives only transparent pack metrics. |
| `tesla_battery_telemetry_snapshot` | Returns the latest retained telemetry dashboard, including brick and thermal envelopes when available. |
| `tesla_battery_envelope_history` | Summarizes reported battery, charging, pack, brick, thermal, and lifetime signals over a selected time window. |
| `tesla_battery_degradation` | Calculates energy-based SOH/degradation only if paired `Soc` and `EnergyRemaining` records exist and an auditable baseline is configured. |
| `tesla_battery_set_energy_baseline` | Records an evidence-backed local energy reference; it never changes Tesla data. |
| `tesla_battery_degradation_evidence` | Distinguishes API-derived evidence from Tesla’s proprietary Battery Health Test. |
| `tesla_battery_health_model_catalog` | Lists every adjustable model, its formula, input requirements, and boundaries. |
| `tesla_battery_set_health_reference` | Stores auditable energy, capacity, range, or resistance references in the restricted local configuration. |
| `tesla_battery_health_models` | Returns all six configurable models plus the user-weighted composite screening index. |
| `tesla_scanmytesla_import_diagnostics` | Imports local Scan My Tesla CSV/JSON or TeslaLogger diagnostic exports without uploading them. |
| `tesla_scanmytesla_list_serial_ports` | Lists available local serial devices before a direct Bluetooth/serial capture. |
| `tesla_scanmytesla_capture_passive_can` | Runs a short passive Model 3/Y ELM/STN CAN capture and decodes verified battery messages only. |
| `tesla_battery_bms_constrained_calibration` | Uses direct BMS nominal energy with a saved as-new kWh reference and explicit comparable-condition confirmation. |
| `tesla_battery_source_catalog` | Lists Fleet API and optional BMS sources with a concise hardware requirement badge. |
| `tesla_battery_health_by_source` | Uses Fleet API by default, optionally adds BMS evidence, and automatically returns a labeled Fleet API fallback when BMS hardware or data are unavailable. |

## Local dashboard

The package includes a local browser dashboard that calls the **same source-aware data service** as the MCP tools. It does not invent sample values. With no Scan My Tesla hardware, it shows Fleet API data and explicitly marks direct BMS evidence as optional and unconfigured. With Fleet Telemetry history, it adds the health-model status and retains Fleet-versus-BMS provenance.

The dashboard binds only to `127.0.0.1` by default and requires a local bearer token. Generate two separate local tokens, add them to the private `.env`, then build and start it:

```bash
openssl rand -hex 32  # Set this as TESLA_DASHBOARD_TOKEN
openssl rand -hex 32  # Set this as TESLA_HTTP_MCP_TOKEN
pnpm build
./run-dashboard.sh
```

Open the local URL once with the dashboard token, for example:

```text
http://127.0.0.1:4760/?token=<TESLA_DASHBOARD_TOKEN>
```

The first local visit exchanges the query token for a loopback-only HTTP-only cookie. The page’s **Sync & refresh** button (labelled **Refresh** when sync is not configured) makes a fresh read; it does not schedule a background poll. When `TESLA_TELEMETRY_VPS` is set, each refresh first pulls the server’s telemetry file with `telemetry.sh sync`; when it is unset, sync is skipped and the local file is read as is. When configured, `TESLA_SCANMYTESLA_EXPORT_FILE`, `TESLA_TESLALOGGER_EXPORT_FILE`, or `TESLA_DIRECT_CAN_PORT` adds optional BMS evidence. The direct CAN setting starts a short passive capture on refresh, so never set it while Scan My Tesla is using the same Bluetooth Classic adapter.

The dashboard has four tabs:

| Tab | Contents |
|---|---|
| **Overview** | A *needs attention* strip, state-of-health scenarios, warranty projection, at-a-glance tiles, telemetry charts with a **24 h / 7 d / 30 d / 90 d** range selector, and pack voltage and cell balance. |
| **Health** | SOH at each full charge with its fade trend, the SOH calculation, vehicle alerts, health models, derived analytics, and optional direct-BMS evidence. |
| **Charging** | Energy charged per day by session type (home, other AC, DC fast), reconstructed charge sessions, and Supercharger history, each downloadable as CSV. |
| **Data** | Export (full summary JSON, sessions CSV, Supercharger CSV), all readings, raw telemetry signals, the history table, warranty, and raw provenance. |

The *needs attention* strip lists only checks backed by data already on the page, each with its evidence: telemetry freshness, a failed sync, battery or charging alerts in the last 7 days, the median brick-voltage spread (a screening policy of <10 / 10–30 / >30 mV, not a Tesla limit), and, for LFP packs, days since the last completed 100% charge. Tesla’s Model 3 manual recommends that LFP packs fully charge to 100% at least once a week; the page detects LFP from brick voltage (peak ≤3.7 V after reaching ≥95% SOC) and shows no such advice for nickel packs.

Chart ranges end at the newest telemetry record rather than the current time, so a sleeping car still shows its last day of data. Series are downsampled to at most 600 points per signal by keeping each bucket’s minimum and maximum, so short peaks such as DC fast-charge power survive. Parsed telemetry is cached in memory and reused until a telemetry file’s size, modification time, or inode changes (an append, a rewrite, or `telemetry.sh sync`), so switching chart ranges and repeat refreshes skip re-reading the file; the dashboard, cluster, and MCP tools share this cache. Exports are generated in the browser from data already loaded; nothing is uploaded. The page is served with a per-response Content-Security-Policy nonce, so only its own script can run.

On Windows, use `run-dashboard.cmd`. On macOS or Linux, use `run-dashboard.sh`. The dashboard requires Node.js and the same local private environment file as the stdio MCP. Keep the bind address at `127.0.0.1`; do not expose the dashboard to a network or the public internet.

## Claude, Gemini, and ChatGPT access

All three clients can read the same Tesla battery data through MCP, but their connection models differ.

| Client | Recommended path | Configuration artifact | Important boundary |
|---|---|---|---|
| **Claude Desktop** | Local stdio MCP | `claude_desktop_config.example.json` or `claude_desktop_config.windows.example.json` | Runs the local read-only MCP process. Claude Desktop’s current Desktop Extensions workflow also supports custom local extensions. [14] |
| **Gemini CLI** | Local stdio MCP | `gemini_cli_settings.example.json` or `gemini_cli_settings.windows.example.json` | Gemini CLI supports stdio MCP natively. It can alternatively use the loopback HTTP endpoint with `gemini_cli_http_settings.example.json`. [15] |
| **ChatGPT** | OpenAI Secure MCP Tunnel to the local stdio server | `chatgpt_secure_tunnel.example.sh` | ChatGPT cannot connect to a local MCP server directly. Its tunnel keeps the Tesla MCP private and reaches it through an outbound-only HTTPS connection. [16] [17] |

### Claude Desktop

Copy the local entry from `claude_desktop_config.example.json` into the local Claude Desktop MCP configuration and replace the placeholder path. On Windows, use the Windows template, which invokes `run-mcp.cmd`. The configuration contains only a launcher path; Tesla secrets stay in the private `.env` and token-cache files.

### Gemini CLI

Merge `gemini_cli_settings.example.json` into the relevant Gemini CLI `settings.json` file, replace the absolute path, and start Gemini CLI. The template leaves `trust` as `false`, so Gemini asks before tool use. Gemini CLI also supports Streamable HTTP; start `./run-http-mcp.sh` and use `gemini_cli_http_settings.example.json` only when an HTTP endpoint is preferred. That endpoint is loopback-only and requires `TESLA_HTTP_MCP_TOKEN`.

### ChatGPT Secure MCP Tunnel

ChatGPT Developer Mode connects to remote MCP apps, not a local machine directly. Use the official Secure MCP Tunnel rather than opening an inbound port:

1. Create a private tunnel in OpenAI Platform tunnel settings and associate it with the intended ChatGPT workspace.
2. Obtain the tunnel runtime API key and tunnel identifier. Keep both out of source control and the `.env` file for Tesla.
3. On the computer that can reach the Tesla MCP, set `CONTROL_PLANE_API_KEY` and `OPENAI_TUNNEL_ID`, replace the package path in `chatgpt_secure_tunnel.example.sh`, and run the commands.
4. Run `tunnel-client doctor --profile tesla-battery-local --explain` before testing.
5. In ChatGPT Developer Mode, create an app, select **Tunnel**, and choose the associated private tunnel.

Secure MCP Tunnel requires the applicable OpenAI tunnel permissions and ChatGPT Developer Mode access. Current ChatGPT availability and workspace role requirements vary by plan; consult the linked OpenAI documentation before setup. [16] [17]

## Validation

Run the protocol-level smoke check after building:

```bash
pnpm smoke
pnpm smoke:http
pnpm test
```

The first check starts the stdio server, runs MCP tool discovery, and verifies that all documented tools are registered. The second validates the token-protected Streamable HTTP MCP companion. `pnpm test` builds and runs the analytics, SOH, CAN, cluster, dashboard, and telemetry-cache checks against fixtures. None of these call Tesla or require vehicle credentials.

## Privacy and safety boundaries

The MCP is intentionally read-only. It excludes wake, lock, start, climate, charge-control, or other vehicle-command endpoints. Tesla notes that Fleet Telemetry can reveal behavioral information even when explicit location fields are not collected. Use a VIN allowlist, collect the minimum fields and cadence needed, retain telemetry securely, and avoid adding location telemetry unless it is essential. [7]

## References

[1]: https://developer.tesla.com/docs/fleet-api/fleet-telemetry/available-data "Tesla Fleet API: Available Data"
[2]: https://developer.tesla.com/docs/fleet-api/fleet-telemetry "Tesla Fleet API: Fleet Telemetry"
[3]: https://www.biologic.net/topics/battery-states-state-of-charge-soc-state-of-health-soh/ "BioLogic: State of Charge and State of Health"
[4]: https://www.tesla.com/ownersmanual/modely/en_us/GUID-B9807218-7291-4F68-9AFF-7C525CF498F3.html "Tesla Model Y Owner's Manual: High Voltage Battery Health"
[5]: https://www.nature.com/articles/s44406-025-00010-8 "Why we need a standardized state of health measurement procedure for electric vehicle battery packs"
[6]: https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens "Tesla Fleet API: Third-Party Tokens"
[7]: https://github.com/teslamotors/fleet-telemetry "Tesla Fleet Telemetry Reference Server"
[8]: https://www.scanmytesla.com/faq "Scan My Tesla FAQ"
[9]: https://www.scanmytesla.com/privacy-policy "Scan My Tesla Privacy Policy"
[10]: https://github.com/bassmaster187/TeslaLogger/blob/master/docs/en/faq/scanmytesla.md "TeslaLogger Scan My Tesla Integration"
[11]: https://github.com/joshwardell/model3dbc "Model 3 and Model Y CAN DBC Definitions"
[12]: https://docs.kernel.org/networking/device_drivers/can/can327.html "Linux Kernel can327 ELM327 CAN Driver Documentation"
[13]: https://www.scanmytesla.com/adapter-speed-and-filters "Scan My Tesla Adapter Speed and Filters"
[14]: https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop "Claude Desktop: Local MCP Servers"
[15]: https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html "Gemini CLI: MCP Servers"
[16]: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt "ChatGPT: Developer Mode and MCP Apps"
[17]: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels "OpenAI: Secure MCP Tunnel"
