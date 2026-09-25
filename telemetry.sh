#!/usr/bin/env bash
# Control the Fleet Telemetry server on your VPS and pull its records locally.
# Usage: telemetry.sh on|off|status|sync
set -euo pipefail

VPS="${TESLA_TELEMETRY_VPS:?Set TESLA_TELEMETRY_VPS, e.g. ubuntu@your-vps}"
REMOTE_FILE=/opt/fleet-telemetry/data/telemetry.jsonl
LOCAL_FILE="$HOME/.local/share/tesla-battery-mcp/fleet-telemetry.jsonl"

case "${1:-status}" in
  on)     ssh "$VPS" 'sudo systemctl start fleet-telemetry && systemctl is-active fleet-telemetry' ;;
  off)    ssh "$VPS" 'sudo systemctl stop fleet-telemetry; systemctl is-active fleet-telemetry || true' ;;
  status) ssh "$VPS" "systemctl is-active fleet-telemetry; sudo wc -l $REMOTE_FILE 2>/dev/null | cut -d\" \" -f1 | xargs echo records:; sudo tail -n1 $REMOTE_FILE 2>/dev/null | grep -o '\"CreatedAt\":\"[^\"]*\"' || true" ;;
  sync)
    mkdir -p "$(dirname "$LOCAL_FILE")"
    ssh "$VPS" "sudo cat $REMOTE_FILE 2>/dev/null" > "$LOCAL_FILE.$$.tmp" && mv "$LOCAL_FILE.$$.tmp" "$LOCAL_FILE"
    chmod 600 "$LOCAL_FILE"
    echo "synced $(wc -l < "$LOCAL_FILE" | tr -d ' ') records to $LOCAL_FILE" ;;
  configure)
    # Push the signed telemetry config to the car (expires after 364 days; re-run to renew).
    cd "$(dirname "$0")"
    set -a; source "$HOME/.config/tesla-battery-mcp/.env"; set +a
    P="$HOME/.config/tesla-battery-mcp/proxy"
    T=$(node --input-type=module -e 'import { getAccessToken } from "./dist/teslaApi.js"; console.log(await getAccessToken());')
    VIN=$(curl -s -H "Authorization: Bearer $T" "$TESLA_BASE_URL/api/1/vehicles" | python3 -c 'import sys,json;print(json.load(sys.stdin)["response"][0]["vin"])')
    "$HOME/.local/bin/tesla-http-proxy" -key-file "$HOME/.config/tesla-battery-mcp/tesla-private-key.pem" -cert "$P/tls.crt" -tls-key "$P/tls.key" -port 4443 -host 127.0.0.1 > "$P/proxy.log" 2>&1 &
    PID=$!; trap 'kill $PID 2>/dev/null' EXIT; sleep 2
    BODY=$(VIN=$VIN CA_FILE="$P/telemetry-ca.crt" python3 -c '
import json,os,time
f=lambda s:{"interval_seconds":s}
fields={k:f(60) for k in ["Soc", "BatteryLevel", "EnergyRemaining", "BrickVoltageMin", "BrickVoltageMax", "NumBrickVoltageMin", "NumBrickVoltageMax", "ModuleTempMin", "ModuleTempMax", "NumModuleTempMin", "NumModuleTempMax", "IsolationResistance", "ChargeState", "ChargeLimitSoc", "ChargerPhases", "ChargeAmps", "ChargerVoltage", "ACChargingEnergyIn", "DCChargingEnergyIn", "RatedRange", "EstBatteryRange", "IdealBatteryRange", "TimeToFullCharge", "BatteryHeaterOn", "DetailedChargeState", "LifetimeEnergyUsed", "LifetimeEnergyUsedDrive", "LifetimeEnergyGainedRegen", "LifetimeEnergyChargedKwh", "NominalFullPackEnergyKwh", "BrickSocMinPercent", "BMSState", "BmsFullchargecomplete", "NotEnoughPowerToHeat", "DCDCEnable", "ExpectedEnergyPercentAtTripArrival", "DiStateR", "DiHeatsinkTR", "DiStatorTempR", "DiInverterTR", "DiAxleSpeedR", "Gear", "InsideTemp", "OutsideTemp", "HvacACEnabled", "HvacFanSpeed", "PreconditioningEnabled", "DefrostForPreconditioning", "ClimateKeeperMode", "CabinOverheatProtectionMode", "FastChargerPresent", "FastChargerType", "ChargingCableType", "ChargeCurrentRequest", "ChargeCurrentRequestMax", "ChargeEnableRequest", "ChargePortColdWeatherMode", "EstimatedHoursToChargeTermination", "ChargeRateMilePerHour", "ChargePortDoorOpen", "ChargePortLatch", "ScheduledChargingPending", "Odometer", "Version", "SentryMode", "Hvil", "DriveRail", "GradeEstimatePercent", "DiTorquemotor", "TpmsPressureFl", "TpmsPressureFr", "TpmsPressureRl", "TpmsPressureRr", "TpmsHardWarnings", "TpmsSoftWarnings", "HvacAutoMode", "HvacLeftTemperatureRequest", "HvacSteeringWheelHeatLevel", "WiperHeatEnabled", "DefrostMode", "ScheduledChargingMode", "ScheduledChargingStartTime", "ScheduledDepartureTime", "CarType", "Trim", "EfficiencyPackage", "SoftwareUpdateInProgress", "LocatedAtHome"]}
fields.update({k:f(2) for k in ["PackVoltage", "PackCurrent"]})
fields.update({k:f(10) for k in ["BrickVoltageMin", "BrickVoltageMax", "NumBrickVoltageMin", "NumBrickVoltageMax", "Soc", "EnergyRemaining", "ModuleTempMin", "ModuleTempMax"]})
fields.update({k:f(10) for k in ["VehicleSpeed", "DiMotorCurrentR", "DiTorqueActualR", "DiVBatR", "LongitudinalAcceleration", "PedalPosition", "BrakePedalPos", "HvacPower", "ACChargingPower", "DCChargingPower"]})
print(json.dumps({"vins":[os.environ["VIN"]],"config":{"hostname":os.environ["TESLA_TELEMETRY_HOSTNAME"],"port":4443,"ca":open(os.environ["CA_FILE"]).read(),"fields":fields,"alert_types":["service"],"exp":int(time.time())+364*86400}}))')
    curl -s --cacert "$P/tls.crt" -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d "$BODY" https://localhost:4443/api/1/vehicles/fleet_telemetry_config | sed "s/$VIN/<VIN>/g"; echo ;;
  *) echo "usage: $0 on|off|status|sync|configure" >&2; exit 1 ;;
esac
