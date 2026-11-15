"""Build the clean release and the explicitly authorized shared-key release.
No key values are printed. Existing projects and media are excluded.
"""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import json
import os
import re

ROOT = Path(__file__).resolve().parent.parent
PREFIX = '镜序工作台/'
NAMES = ['README.md', 'package.json', '.env.example', '.gitignore',
         '启动工作台.command', '启动工作台.bat', '创建桌面快捷方式.command', '创建桌面快捷方式.bat',
         '发给朋友-先看这里.txt', 'docs/使用说明.md', 'docs/工作台验收.md',
         'docs/公开发布与自动更新.md', 'docs/更新说明_2026-11-11.md', 'docs/豆包更新指令.txt']
FILES = [ROOT / name for name in NAMES]
for folder in ['src', 'public', 'test', 'prompts', 'scripts', '.github']:
    FILES.extend(p for p in (ROOT / folder).rglob('*') if p.is_file())
FILES = sorted(set(FILES))
ENV = (ROOT / '.env').read_bytes()
KEYS = []
for line in ENV.decode().splitlines():
    if re.match(r'^[A-Z_]*API_KEY=', line):
        value = line.split('=', 1)[1].strip()
        if value.startswith('"'):
            value = json.loads(value)
        elif value.startswith("'"):
            value = value[1:-1]
        if len(value) < 12:
            raise RuntimeError('Shared provider key is missing')
        KEYS.append(value.encode())
if len(KEYS) != 3:
    raise RuntimeError('Expected three shared provider keys')


def shared_text(data):
    text = data.decode('utf-8')
    replacements = {
        '三、配置自己的接口\n点击左下角“接口设置”，填写自己的三家 API Key：':
        '三、共用接口已预配置\n本共享包已在根目录 .env 中放入三家共用 API Key，无需重新填写：',
        '本包不带任何人的 Key、已有剧本、图片或视频。': '本共享包带有三家共用 Key；不带已有剧本、图片或视频。',
        '对方使用自己的 Key，无需复制 .env。': '本包中的 .env 已包含共用接口配置。',
        '首次在新电脑使用时，点击左下角“接口设置”，分别填入三家的 Key。': '本共享版本已预配置三家的共用 Key，无需另外填写。',
        '复制便携包，安装 Node.js 后启动。在新电脑的接口设置中填写 Key。': '复制共享包，安装 Node.js 后启动；包内 .env 已有共用 Key。',
        '便携包不包含 `.env`、现有项目、生成素材或视频。': '本共享包包含共用 `.env`，不含现有项目、生成素材或视频。',
        '新电脑在左下角“接口设置”分别填写 Key：': '本共享包已配置共用 Key，可在左下角“接口设置”查看配置状态：',
        '便携包包含界面、后台、启动入口和说明，不包含 Key 或现有素材。新电脑安装 Node.js 后，在界面填写 Key 即可。':
        '本共享包包含界面、后台、启动入口、说明和三家共用 Key，不包含现有项目或素材；安装 Node.js 后直接启动即可。',
    }
    for before, after in replacements.items():
        text = text.replace(before, after)
    return text.encode('utf-8')


def build(shared=False):
    target = ROOT / 'outputs' / ('镜序工作台_共享Key版.zip' if shared else '镜序工作台_便携包.zip')
    target.parent.mkdir(exist_ok=True)
    temporary = target.with_suffix('.tmp')
    try:
        with ZipFile(temporary, 'w', ZIP_DEFLATED) as archive:
            for path in FILES:
                data = path.read_bytes()
                if any(key in data for key in KEYS):
                    raise RuntimeError('Credentials found outside .env')
                if shared and path.suffix in ['.md', '.txt']:
                    data = shared_text(data)
                info = ZipInfo.from_file(path, PREFIX + str(path.relative_to(ROOT)))
                info.compress_type = ZIP_DEFLATED
                archive.writestr(info, data)
            if shared:
                for name, data, mode in [('.env', ENV, 0o100600), ('豆包安装指令.txt', (ROOT / 'docs/豆包安装指令_共享版.txt').read_bytes(), 0o100644)]:
                    info = ZipInfo(PREFIX + name)
                    info.create_system = 3
                    info.external_attr = mode << 16
                    info.compress_type = ZIP_DEFLATED
                    archive.writestr(info, data)
        with ZipFile(temporary) as archive:
            assert archive.testzip() is None
            assert all(not name.startswith(PREFIX + 'data/') for name in archive.namelist())
            if shared:
                assert archive.read(PREFIX + '.env') == ENV
            else:
                assert PREFIX + '.env' not in archive.namelist()
            assert all(not any(key in archive.read(name) for key in KEYS)
                       for name in archive.namelist() if name != PREFIX + '.env')
            for name in ['启动工作台.command', '创建桌面快捷方式.command']:
                assert (archive.getinfo(PREFIX + name).external_attr >> 16) & 0o111
            count = len(archive.namelist())
        os.chmod(temporary, 0o600 if shared else 0o644)
        temporary.replace(target)
        return {'file': target.name, 'files': count, 'bytes': target.stat().st_size, 'verified': True}
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    print(json.dumps([build(), build(shared=True)], ensure_ascii=False))
