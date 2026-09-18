#!/usr/bin/env sh
# 키도 네트워크도 없이 도는 검증 전부. CI 기본값이고, 커밋 전에 이것만 돌리면 된다.
set -e
cd "$(dirname "$0")/.."
python3 scripts/build_assets.py --selftest    # 수집·정규화·집계·자산 검증
node scripts/test_rules.mjs                   # 판정 산술 7종
node scripts/test_verify.mjs                  # LLM 출력 검증층·오리진 경계
node scripts/test_contrast.mjs                # 색 대비 (다크모드 포함)
node scripts/test_anchors_docs.mjs            # 스냅샷 ↔ 문서·OG 메타 대조
node scripts/test_source.mjs                  # 소스 금지 패턴 (eval·비밀값·로그 경계)
echo "전부 통과"
