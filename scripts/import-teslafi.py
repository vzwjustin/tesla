#!/usr/bin/env python3
"""Merge a TeslaFi CSV(.gz) export with existing decoded history; no vehicle/network access."""
import argparse
import csv
import gzip
import json
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

NUMBERS = {
    'battery_level': 'Soc', 'energy_remaining': 'EnergyRemaining',
    'battery_range': 'RatedRange', 'ideal_battery_range': 'IdealBatteryRange',
    'pack_voltage': 'PackVoltage', 'lifetime_energy_used': 'LifetimeEnergyUsed',
    'odometer': 'Odometer', 'charge_limit_soc': 'ChargeLimitSoc',
    'charger_power': 'ChargerPower', 'charger_voltage': 'ChargerVoltage',
    'charger_actual_current': 'ChargeAmps', 'charge_energy_added': 'AddedEnergy',
    'battery_heater_on': 'BatteryHeaterOn', 'inside_temp': 'InsideTemp',
    'outside_temp': 'OutsideTemp', 'speed': 'VehicleSpeed',
}
TEXT = {'charging_state': 'ChargeState'}


def timestamp(value, utc_offset_hours):
    date = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
    if date.tzinfo is None:
        # ponytail: TeslaFi exports account-local time with no zone; fixed offset, wrong across a DST change.
        date = date.replace(tzinfo=timezone(timedelta(hours=utc_offset_hours)))
    return date.astimezone(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')


def convert(row):
    signals = {}
    for column, key in NUMBERS.items():
        raw = (row.get(column) or '').strip()
        if raw and raw.upper() not in ('NULL', 'NONE'):
            value = float(raw)
            if not math.isfinite(value):
                raise ValueError(f'Nonfinite value: {column}')
            signals[key] = value
    for column, key in TEXT.items():
        raw = (row.get(column) or '').strip()
        if raw and raw.upper() not in ('NULL', 'NONE'):
            signals[key] = raw
    return signals


def import_history(export, vin, existing, utc_offset_hours):
    points, sources = {}, {}
    counts = {'csvRows': 0, 'teslafiRecords': 0, 'existingRows': 0, 'mergedTimestampRows': 0}

    def add(at, data, origin):
        if at in points:
            counts['mergedTimestampRows'] += 1
        target = points.setdefault(at, {})
        target.update({k: v for k, v in data.items() if k != 'Source'})
        sources.setdefault(at, set()).update(origin.split('+'))

    with gzip.open(export, 'rt', encoding='utf-8-sig') if export.suffix == '.gz' else open(export, encoding='utf-8-sig') as source:
        for row in csv.DictReader(source):
            counts['csvRows'] += 1
            if row.get('vin') and row['vin'] != vin:
                raise ValueError('TeslaFi export contains a different VIN')
            if not (row.get('battery_level') or '').strip():
                continue  # Location/state-only rows carry no battery observation.
            counts['teslafiRecords'] += 1
            add(timestamp(row['Date'], utc_offset_hours), convert(row), 'teslafi_export')

    # Existing history is added last so it wins exact-time conflicts.
    for path in existing:
        with Path(path).expanduser().open() as source:
            for line in source:
                if not line.strip():
                    continue
                record = json.loads(line)
                if record.get('vin') != vin or not isinstance(record.get('data'), dict):
                    raise ValueError('Existing history must contain decoded records for this VIN only')
                counts['existingRows'] += 1
                add(timestamp(record['created_at'], utc_offset_hours), record['data'],
                    record['data'].get('Source', 'existing_history'))

    output = [{'vin': vin, 'created_at': at, 'data': {**points[at], 'Source': '+'.join(sorted(sources[at]))}}
              for at in sorted(points)]
    counts.update(records=len(output), first=output[0]['created_at'], last=output[-1]['created_at'])
    return output, counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('export', type=Path)
    parser.add_argument('--vin', required=True)
    parser.add_argument('--existing', type=Path, action='append', default=[])
    parser.add_argument('--utc-offset-hours', type=float, default=-5, help='TeslaFi local time offset (CDT = -5)')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    records, summary = import_history(args.export, args.vin, args.existing, args.utc_offset_hours)
    # Fail rather than overwrite history. A new import can be reviewed before activation.
    with open(args.output, 'x', encoding='utf-8', opener=lambda path, flags: os.open(path, flags, 0o600)) as out:
        for record in records:
            out.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + '\n')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
