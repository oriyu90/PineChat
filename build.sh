#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "=== Pine Chat ビルド ==="
echo "Node: $(node --version)"
echo "npm:  $(npm --version)"

# アイコン生成
mkdir -p assets
python3 - << 'PY'
import struct, zlib, os
def png(sz):
    def ch(tag,data):
        c=zlib.crc32(tag+data)&0xffffffff
        return struct.pack('>I',len(data))+tag+data+struct.pack('>I',c)
    rows=b''
    for y in range(sz):
        rows+=b'\x00'
        for x in range(sz):
            v=18+int((x+y)/(2*sz)*20)
            rows+=bytes([v,v,v])
    d=b'\x89PNG\r\n\x1a\n'
    d+=ch(b'IHDR',struct.pack('>IIBBBBB',sz,sz,8,2,0,0,0))
    d+=ch(b'IDAT',zlib.compress(rows))
    d+=ch(b'IEND',b'')
    return d
s='assets/icon.iconset'
os.makedirs(s,exist_ok=True)
for n in [16,32,64,128,256,512]:
    open(f'{s}/icon_{n}x{n}.png','wb').write(png(n))
    open(f'{s}/icon_{n}x{n}@2x.png','wb').write(png(n*2))
print("アイコン生成完了")
PY

command -v iconutil &>/dev/null && iconutil -c icns assets/icon.iconset -o assets/icon.icns 2>/dev/null && echo "icns生成完了" || echo "iconutilなし（スキップ）"

# 依存パッケージ
echo "パッケージインストール中..."
npm install 2>&1 | tail -5

echo "インストール済みElectron: $(./node_modules/.bin/electron --version 2>/dev/null || echo '不明')"

# ビルド
echo "DMGビルド中..."
npx electron-builder --mac dmg 2>&1

ls dist/*.dmg 2>/dev/null && echo "✓ ビルド成功: $(ls dist/*.dmg)" || { echo "✗ ビルド失敗"; exit 1; }
open dist/ 2>/dev/null || true
