"""Package only the public update builder's explicit program allowlist.
Never reads .env or data. This script can run in a clean GitHub checkout.
"""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import json
import base64
import hashlib
import subprocess

ROOT = Path(__file__).resolve().parent.parent
subprocess.run(['node', str(ROOT / 'scripts/build-update.mjs')], cwd=ROOT, check=True, capture_output=True)
manifest = json.loads((ROOT / 'outputs/jingxu-update.json').read_text())
program = {}
for item in manifest['files']:
    data = base64.b64decode(item['content'], validate=True)
    assert hashlib.sha256(data).hexdigest() == item['sha256']
    program[item['path']] = data

source = dict(program)
for name in ['.env.example', '.gitignore', 'scripts/build-update.mjs', 'scripts/package-public.py', '.github/workflows/release.yml']:
    source[name] = (ROOT / name).read_bytes()
manual = dict(program)
manual['豆包更新指令.txt'] = (ROOT / 'docs/豆包更新指令.txt').read_bytes()

def build(name, entries):
    target = ROOT / 'outputs' / name
    temporary = target.with_suffix('.tmp')
    try:
        with ZipFile(temporary, 'w', ZIP_DEFLATED) as archive:
            for path, data in sorted(entries.items()):
                assert path != '.env' and not path.startswith(('data/', 'outputs/'))
                info = ZipInfo('镜序工作台/' + path)
                info.create_system = 3
                info.external_attr = (0o100755 if path.endswith('.command') else 0o100644) << 16
                info.compress_type = ZIP_DEFLATED
                archive.writestr(info, data)
        with ZipFile(temporary) as archive:
            assert archive.testzip() is None
        temporary.replace(target)
        return {'file': name, 'files': len(entries), 'bytes': target.stat().st_size}
    finally:
        temporary.unlink(missing_ok=True)

if __name__ == '__main__':
    print(json.dumps([build('镜序工作台_GitHub源码包.zip', source), build('镜序工作台_更新包_1.1.0.zip', manual)], ensure_ascii=False))
