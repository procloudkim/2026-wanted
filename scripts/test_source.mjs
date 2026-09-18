/* 소스 금지 패턴 검사.  실행: node scripts/test_source.mjs
 *
 * Why: 정적 분석이 0건이었다(06-NIST-REVIEW §4-D / SSDF PW.7.1). 린터를 들이려면
 * npm 의존성이 생기고, 이 저장소는 package.json 이 없는 것이 설계다. 그래서
 * **찾을 수 있는 것만 정확히 찾는** 작은 검사를 둔다 — 넓은 분석이 아니라 좁은 금지 목록이다.
 *
 * ponytail: 데이터 흐름을 따라가지 않는다. 문자열 검사로 잡히는 종류만 잡는다.
 * 진짜 정적 분석이 필요해지면 그때 도구를 들인다.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const walk = (dir, out = []) => {
  for (const e of readdirSync(join(ROOT, dir))) {
    if (e === "__pycache__" || e === "node_modules") continue;
    const rel = `${dir}/${e}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
};
const SRC = [...walk("dist"), ...walk("functions"), ...walk("scripts")]
  .filter((f) => /\.(js|mjs|html|css|py|sh)$/.test(f));
const read = (f) => readFileSync(join(ROOT, f), "utf8");

let n = 0;
const forbid = (re, why, files = SRC) => {
  for (const f of files) {
    const m = read(f).match(re);
    assert.equal(m?.[0] ?? null, null, `${f}: ${why}\n  → ${String(m?.[0]).slice(0, 90)}`);
  }
  n++;
};

/* ── 실행 경로에 문자열을 넣지 않는다 ─────────────────────────────────────── */
forbid(/\beval\s*\(/, "eval 은 쓰지 않는다");
forbid(/new\s+Function\s*\(/, "new Function 은 쓰지 않는다");
forbid(/document\.write\s*\(/, "document.write 는 쓰지 않는다");
/* innerHTML 자리는 자동으로 안전을 증명할 수 없다 — 템플릿 안의 어느 조각이 esc() 를 지나는지는
 * 문자열 검사로 못 본다. 대신 **자리 수를 고정**해서 새 자리가 조용히 늘지 않게 한다.
 * 늘거나 줄면 사람이 그 자리를 보고 이 숫자를 고친다. 그것이 여기서 할 수 있는 정직한 최대치다. */
const SINKS = [...read("dist/assets/app.js").matchAll(/\.innerHTML\s*=\s*([^\n]*)/g)].map((m) => m[1].trim());
assert.equal(SINKS.length, 24,
  `dist/assets/app.js 의 innerHTML 자리가 24개에서 ${SINKS.length}개로 바뀌었다 — 새 자리가 esc() 를 지나는지 확인하고 이 숫자를 고친다`);
for (const rhs of SINKS) {
  // 맨 변수를 그대로 넣는 자리는 el() 헬퍼 하나뿐이고, 거기 들어가는 문자열은 호출부에서 만든다.
  const bare = /^[a-zA-Z_$][\w$]*\s*;/.test(rhs);
  assert.ok(!bare || rhs === "html;", `innerHTML 에 변수를 그대로 대입한다 — 템플릿과 esc() 를 쓴다\n  → ${rhs.slice(0, 80)}`);
}
n += 2;

/* ── 비밀값이 소스에 없다 ─────────────────────────────────────────────────── */
forbid(/\bsk-[A-Za-z0-9_-]{20,}/, "OpenAI 키 형태의 문자열이 소스에 있다");
forbid(/["'][0-9a-f]{40,}["']/, "긴 16진 문자열이 소스에 있다 — 키일 수 있다");
forbid(/DATA_GO_KR_SERVICE_KEY\s*=\s*["'][^"']+["']/, "원천 API 키가 소스에 박혀 있다");

/* ── 전송 경계 ────────────────────────────────────────────────────────────── */
// www.w3.org 네임스페이스는 가져오는 주소가 아니라 식별자다 — SVG 규격이 이 문자열을 요구한다.
forbid(/http:\/\/(?!localhost|127\.0\.0\.1|www\.w3\.org\/)/, "배포물에 http:// 링크가 있다 — 혼합 콘텐츠",
  SRC.filter((f) => f.startsWith("dist/")));
for (const f of SRC.filter((f) => f.endsWith(".html"))) {
  for (const a of read(f).match(/<a\b[^>]*target="_blank"[^>]*>/g) || []) {
    assert.match(a, /rel="[^"]*noopener/, `${f}: target="_blank" 에 rel="noopener" 가 없다\n  → ${a.slice(0, 90)}`);
    n++;
  }
}

/* ── 함수가 사용자 내용을 밖으로 내보내지 않는다 ─────────────────────────────
 * 로그는 "무슨 일이 있었는지"만 남긴다. 문장·금액·오리진·IP 가 한 글자도 나가면 안 된다.
 * 이 검사가 있어야 "로그에 남기지 않는다"는 약속이 주석이 아니라 규칙이 된다. */
const ALLOWED_LOG = /^console\.log\(JSON\.stringify\(\{ ev, code, ms: Date\.now\(\) - t0 \}\)\)$/;
for (const f of SRC.filter((s) => s.startsWith("functions/"))) {
  for (const line of read(f).split("\n")) {
    const c = line.trim().match(/console\.\w+\([^;]*\)/);
    if (!c) continue;
    assert.match(c[0], ALLOWED_LOG,
      `${f}: 허용되지 않은 로그 호출 — 함수는 {ev, code, ms} 만 내보낸다\n  → ${c[0].slice(0, 90)}`);
    n++;
  }
}
forbid(/console\.\w+\([^)]*\b(text|body|parsed|content|opening|closing|origin|ip)\b/,
  "사용자 내용·식별자가 로그로 나간다", SRC.filter((f) => f.startsWith("functions/")));

/* ── 판정 경로에 네트워크가 없다 ──────────────────────────────────────────── */
forbid(/\bfetch\s*\(/, "rules.js 는 순수 함수만 둔다 — 판정 경로에 네트워크가 들어오면 결정론이 깨진다",
  ["dist/assets/rules.js"]);

/* ── .env 가 추적되지 않는다 ──────────────────────────────────────────────── */
const ignore = read(".gitignore");
assert.match(ignore, /^\.env$/m, ".gitignore 에 .env 가 없다");
n++;

console.log(`source ok — ${n}건`);
