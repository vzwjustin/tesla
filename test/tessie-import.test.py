import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from zipfile import ZipFile

spec = importlib.util.spec_from_file_location('tessie_import', Path(__file__).parents[1] / 'scripts/import-tessie.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    archive = root / 'tessie.zip'
    with ZipFile(archive, 'w') as zipped:
        zipped.writestr('battery_states.csv', 'Timestamp (UTC),Pack Voltage (V),Pack Current (A),Energy Remaining (kWh)\n2026-08-07 21:20:16,400,-20,30\n2026-08-07 21:20:16,400,-20,30\n')
        zipped.writestr('charging_states.csv', 'Timestamp (UTC),Usable Battery Level (%),Charger Power (kW)\n2026-08-07 21:20:16,50,0\n2026-08-07 21:22:16,49,\n')
        zipped.writestr('vehicle_states.csv', 'Timestamp (UTC),Locked,Sentry Mode\n2026-08-07 21:20:16,1,0\n')
        zipped.writestr('driving_states.csv', 'Timestamp (UTC),Latitude,Longitude,Speed (mph)\n2026-08-07 21:20:16,0,0,0\n')
    vin = '5YJ3E1EA0PF000001'
    old = root / 'existing.jsonl'
    old.write_text(json.dumps({'vin': vin, 'created_at': '2026-08-07T21:20:16Z', 'data': {'Soc': 50.25, 'Source': 'teslafi_export'}}) + '\n')
    rows, summary = module.import_history(archive, vin, [old])
    assert len(rows) == 2 and summary['conflictingValues'] == 1
    p = rows[0]
    assert p['created_at'] == '2026-08-07T21:20:16.000000Z'
    assert p['data']['Soc'] == 50.25 and p['data']['PackCurrent'] == -20
    assert p['data']['ChargerPower'] == 0 and p['data']['Latitude'] == 0
    assert p['data']['Locked'] is True and p['data']['SentryMode'] is False
    assert 'tessie_export' in p['data']['Source'] and 'teslafi_export' in p['data']['Source']
    assert 'ChargerPower' not in rows[1]['data'] and 'PackVoltage' not in rows[1]['data']
    assert len(p['provenance']['sourceFiles']) == 5
    for bad in [{'Pack Current (A)': 'NaN'}, {'Locked': 'maybe'}, {'New unknown signal': '1'}]:
        try:
            module.convert(bad)
        except ValueError:
            pass
        else:
            raise AssertionError('Invalid/unknown value was silently accepted')
    try:
        module.import_history(archive, '5YJ3E1EA0PF000002', [old])
    except ValueError:
        pass
    else:
        raise AssertionError('Wrong-vehicle history was accepted')
    output = root / 'combined.jsonl'
    command = [sys.executable, str(Path(__file__).parents[1] / 'scripts/import-tessie.py'),
               str(archive), '--vin', vin, '--existing', str(old), '--output', str(output)]
    subprocess.run(command, check=True, capture_output=True)
    assert len(output.read_text().splitlines()) == 2 and output.stat().st_mode & 0o777 == 0o600
    before = output.read_bytes()
    assert subprocess.run(command, capture_output=True).returncode != 0
    assert output.read_bytes() == before
print('Tessie import checks passed')
