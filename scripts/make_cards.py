#!/usr/bin/env python3
"""공유 카드(dist/og.png)와 README 커버(docs/assets/cover.png)를 anchors.json 의 현재 값으로 다시 만든다.

실행: python3 scripts/make_cards.py
쓰는 것: 표준 라이브러리와 설치된 google-chrome(없으면 chromium). 네트워크와 키는 쓰지 않는다.
템플릿: scripts/cards.html (?kind=og | ?kind=cover). 커버 오른쪽은 실제 첫 화면(dist/index.html)을 담는다.

데이터를 다시 모으면 이미지 안 숫자가 낡는다. 예전에는 손으로 만든 정적 파일이라 검사가 읽지 못했다.
그래서 렌더된 카드의 숫자가 anchors 와 같은지(--dump-dom)와 PNG 크기가 판형과 같은지를 여기서 확인한다.
"""
import http.server
import json
import os
import shutil
import struct
import subprocess
import sys
import threading
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
KINDS = {"og": ((1200, 630), "dist/og.png"), "cover": ((1600, 900), "docs/assets/cover.png")}


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    assert head[:8] == b"\x89PNG\r\n\x1a\n", f"{path}: PNG 가 아니다"
    return struct.unpack(">II", head[16:24])


def chrome(binary, args):
    # 가상 시간 예산 안에서 fetch 와 iframe 이 끝난다. 끝나지 못하면 아래 data-ready 검사가 잡는다
    run = subprocess.run([binary, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
                          "--force-device-scale-factor=1", "--virtual-time-budget=10000", *args],
                         capture_output=True, text=True, timeout=180)
    return run.stdout


def main():
    binary = shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser")
    if not binary:
        sys.exit("google-chrome(또는 chromium)이 없다")
    a = json.load(open(os.path.join(ROOT, "dist/data/anchors.json"), encoding="utf-8"))
    rec, unrec = f"{a['recorded']['over5']:.2f}%", f"{a['unrecorded']['over5']:.2f}%"
    want = {"og": [rec, unrec, f"{a['recorded']['n']:,}건", f"{a['unrecorded']['n']:,}건", a["asof"]],
            "cover": [f'data-shot="{rec}|{unrec}"', a["asof"]]}

    root = os.path.realpath(ROOT)
    allowed_dir, allowed_file = os.path.join(root, "dist") + os.sep, os.path.join(root, "scripts", "cards.html")

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=ROOT, **kwargs)

        def send_head(self):
            # 저장소 루트에는 .env 가 있다. 카드가 읽는 두 자리만 연다.
            # 요청 문자열이 아니라 풀린 경로로 본다 — /dist/../.env 도 접두어 검사는 통과한다
            p = os.path.realpath(self.translate_path(self.path))
            if p != allowed_file and not p.startswith(allowed_dir):
                self.send_error(404)
                return None
            return super().send_head()

        def log_message(self, *args):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Quiet)   # 이 기계 안에서만 연다
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{srv.server_address[1]}"
    base = f"{origin}/scripts/cards.html"
    try:
        # .env 가 없는 클론에서도 증명되게, 늘 있는 파일로 막힘을 확인한다
        for probe in ("/README.md", "/dist/../README.md", "/dist/%2e%2e/README.md", "/scripts/make_cards.py"):
            try:
                urllib.request.urlopen(origin + probe, timeout=5)
                sys.exit(f"{probe} 가 열려 있다 — 카드 서버는 dist/ 와 템플릿만 내보내야 한다")
            except urllib.error.HTTPError as e:
                assert e.code == 404, f"{probe}: {e.code}"
        for kind, ((w, h), out) in KINDS.items():
            url, size = f"{base}?kind={kind}", f"--window-size={w},{h}"
            dom = chrome(binary, ["--dump-dom", size, url])
            assert 'data-ready="1"' in dom, f"{kind}: 카드가 값을 다 채우지 못했다(anchors.json 또는 첫 화면을 읽지 못함)"
            for s in want[kind]:
                assert s in dom, f"{kind}: 렌더된 카드에 {s} 가 없다"
            path = os.path.join(ROOT, out)
            chrome(binary, [f"--screenshot={path}", size, url])
            assert png_size(path) == (w, h), f"{out}: 크기가 {png_size(path)} 다 — {w}×{h} 여야 한다"
            print(f"{out}: {w}×{h}, {os.path.getsize(path):,}B")
    finally:
        srv.shutdown()
    print("cards ok")


if __name__ == "__main__":
    main()
