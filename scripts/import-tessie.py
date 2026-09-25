#!/usr/bin/env python3
"""Merge a Tessie ZIP with existing decoded history; no vehicle/network access."""
import argparse
import csv
import io
import json
import math
import os
from pathlib import Path
import re
from datetime import datetime, timezone
from zipfile import ZipFile

NUMBERS = {
    'Lifetime Energy Used (kWh)': 'LifetimeEnergyUsed',
    'Energy Remaining (kWh)': 'EnergyRemaining',
    'Pack Current (A)': 'PackCurrent', 'Pack Voltage (V)': 'PackVoltage',
    'Min Battery Module Temp (°C)': 'ModuleTempMin',
    'Max Battery Module Temp (°C)': 'ModuleTempMax',
    'Battery Level (%)': 'BatteryLevel', 'Usable Battery Level (%)': 'Soc',
    'Battery Range (mi)': 'RatedRange', 'Ideal Battery Range (mi)': 'IdealBatteryRange',
    'Charge Rate (mph)': 'ChargeRateMilePerHour', 'Charger Current (A)': 'ChargeAmps',
    'Charger Phases': 'ChargerPhases', 'Charger Power (kW)': 'ChargerPower',
    'Charger Voltage (V)': 'ChargerVoltage', 'Inside Temp (°C)': 'InsideTemp',
    'Outside Temp (°C)': 'OutsideTemp', 'Odometer (mi)': 'Odometer',
    'Speed (mph)': 'VehicleSpeed', 'Latitude': 'Latitude', 'Longitude': 'Longitude',
    'Front Left Tire Pressure (Bar)': 'TpmsPressureFl',
    'Front Right Tire Pressure (Bar)': 'TpmsPressureFr',
    'Rear Left Tire Pressure (Bar)': 'TpmsPressureRl',
    'Rear Right Tire Pressure (Bar)': 'TpmsPressureRr',
}
BOOLEANS = {'Climate Enabled': 'IsClimateOn', 'Locked': 'Locked',
            'Sentry Mode': 'SentryMode', 'Fast Charger Present': 'FastChargerPresent'}
TEXT = {'Charging State': 'ChargeState', 'Shift State': 'Gear',
        'Fast Charger Type': 'FastChargerType', 'Fast Charger Brand': 'FastChargerBrand'}


def timestamp(value):
    date = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
    if date.tzinfo is None:
        date = date.replace(tzinfo=timezone.utc)  # Tessie headers explicitly specify UTC.
    return date.astimezone(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')


def convert(row):
    signals = {}
    for column, raw in row.items():
        if column == 'Timestamp (UTC)':
            continue
        if raw is None:
            raise ValueError(f'Missing CSV cell: {column}')
        raw = raw.strip()
        if not raw:
            continue  # Missing is not zero, false, or a carried-forward observation.
        if column in NUMBERS:
            value = float(raw)
            if not math.isfinite(value):
                raise ValueError(f'Nonfinite value: {column}')
            signals[NUMBERS[column]] = value
        elif column in BOOLEANS:
            if raw.lower() not in ('t', 'f', 'true', 'false', '1', '0'):
                raise ValueError(f'Invalid boolean: {column}')
            signals[BOOLEANS[column]] = raw.lower() in ('t', 'true', '1')
        elif column in TEXT:
            signals[TEXT[column]] = raw
        else:
            raise ValueError(f'Unmapped Tessie column: {column}')
    return signals


def import_history(archive, vin, existing=()):
    if not re.fullmatch(r'[A-HJ-NPR-Z0-9]{17}', vin):
        raise ValueError('A valid 17-character VIN is required')
    points, sources, files = {}, {}, {}
    counts = {'csvRows': 0, 'existingRows': 0, 'mergedTimestampRows': 0, 'conflictingValues': 0}

    def add(at, data, origin, source_file):
        if not data:
            return
        at = timestamp(at)
        if at in points:
            counts['mergedTimestampRows'] += 1
        target = points.setdefault(at, {})
        for key, value in data.items():
            if key == 'Source':
                continue
            if key in target and target[key] != value:
                counts['conflictingValues'] += 1
            target[key] = value
        sources.setdefault(at, set()).update(origin.split('+'))
        files.setdefault(at, set()).add(source_file)

    with ZipFile(archive) as zipped:
        # Re-exported older imports have lower priority than Tessie's native state tables.
        members = sorted((i for i in zipped.infolist() if i.filename.endswith('.csv')),
                         key=lambda i: (not Path(i.filename).name.startswith('imported_states'), i.filename))
        if not members:
            raise ValueError('No CSV files found in Tessie ZIP')
        for member in members:
            with zipped.open(member) as binary:
                reader = csv.DictReader(io.TextIOWrapper(binary, encoding='utf-8-sig'))
                expected = set(NUMBERS) | set(BOOLEANS) | set(TEXT) | {'Timestamp (UTC)'}
                unknown = set(reader.fieldnames or ()) - expected
                if 'Timestamp (UTC)' not in (reader.fieldnames or ()) or unknown:
                    raise ValueError(f'Unsupported columns in {member.filename}: {sorted(unknown)}')
                for row in reader:
                    counts['csvRows'] += 1
                    origin = 'tessie_reexport' if Path(member.filename).name.startswith('imported_states') else 'tessie_export'
                    add(row['Timestamp (UTC)'], convert(row), origin, member.filename)

    for path in existing:
        with Path(path).expanduser().open() as source:
            for line in source:
                if not line.strip():
                    continue
                record = json.loads(line)
                if record.get('vin') != vin or not isinstance(record.get('data'), dict):
                    raise ValueError('Existing history must contain decoded records for this VIN only')
                counts['existingRows'] += 1
                # Existing history wins exact-time conflicts, preserving fractional SOC precision.
                add(record.get('created_at') or record.get('timestamp'), record['data'],
                    record['data'].get('Source', 'existing_history'), Path(path).name)

    output = [{'vin': vin, 'created_at': at,
               'data': {**points[at], 'Source': '+'.join(sorted(sources[at]))},
               'provenance': {'sourceFiles': sorted(files[at])}}
              for at in sorted(points)]
    if not output:
        raise ValueError('No nonempty telemetry records found')
    counts.update(records=len(output), first=output[0]['created_at'], last=output[-1]['created_at'],
                  fields=sorted({key for p in output for key in p['data']}))
    return output, counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--vin', required=True)
    parser.add_argument('--existing', type=Path, action='append', default=[])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    records, summary = import_history(args.archive, args.vin, args.existing)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Fail rather than overwrite history. A new import can be reviewed before activation.
    with open(args.output, 'x', encoding='utf-8', opener=lambda path, flags: os.open(path, flags, 0o600)) as out:
        try:
            for record in records:
                out.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + '\n')
        except BaseException:
            args.output.unlink(missing_ok=True)
            raise
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
