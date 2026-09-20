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
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
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
assert.equal(SINKS.length, 26,
  `dist/assets/app.js 의 innerHTML 자리가 26개에서 ${SINKS.length}개로 바뀌었다 — 새 자리가 esc() 를 지나는지 확인하고 이 숫자를 고친다`);
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

/* ── 배포물이 불러오는 자산은 전부 우리 것이다 ──────────────────────────────
 * 제3자 자산은 우리 모르게 바뀔 수 있고, Google Fonts 는 같은 URL 도 User-Agent 마다
 * 응답 해시가 달라 SRI 로 고정할 수도 없다(2026-09-19 실측). 그래서 런타임에 두지 않는다.
 * 사용자가 눌러서 나가는 <a href> 는 대상이 아니다 — 그것은 불러오는 자산이 아니다. */
for (const f of SRC.filter((x) => x.startsWith("dist/") && x.endsWith(".html"))) {
  for (const m of read(f).matchAll(/<(?:link|script|img)\b[^>]*\b(?:href|src)="(https?:\/\/[^"]+)"/g)) {
    // 우리 오리진을 가리키는 canonical 은 불러오는 자산이 아니라 선언이다
    if (m[1].startsWith("https://gaengsin-baseline.pages.dev")) continue;
    assert.fail(`${f}: 외부 오리진에서 자산을 불러온다 — ${m[1].slice(0, 70)}`);
  }
  for (const m of read(f).matchAll(/<link\b[^>]*rel="preconnect"[^>]*>/g))
    assert.fail(`${f}: 외부 오리진 preconnect 가 남아 있다 — ${m[0].slice(0, 70)}`);
  n++;
}
for (const f of SRC.filter((x) => x.endsWith(".css"))) {
  for (const m of read(f).matchAll(/url\(\s*["']?(https?:\/\/[^)"']+)/g))
    assert.fail(`${f}: CSS 가 외부 오리진 자산을 참조한다 — ${m[1].slice(0, 70)}`);
  n++;
}
/* CSP 도 같은 말을 해야 한다 */
/* ── 제3자 글꼴 고지가 배포물에 들어 있다 ─────────────────────────────────────
 * SIL OFL 1.1 은 글꼴을 재배포할 때 **라이선스 전문과 저작권 표시가 함께 가도록** 요구한다.
 * README 한 줄이나 COPYRIGHT.md 만으로는 충족되지 않는다 — 실제로 서버가 내보내는 자리에 있어야 한다.
 * 출처: google/fonts `ofl/atkinsonhyperlegible/OFL.txt`, 고정 리비전 1b22086d13bdbbf5ec63d01a39a49246e4ac355f
 * (받은 시각 2026-09-19, 4,352바이트). 07-FINAL-REVIEW F-13. */
/* 지문은 scripts/font-notice.json 에 둔다 — 소스에 긴 16진 문자열을 넣으면
 * 위의 "키일 수 있다" 규칙이 걸린다. 그 규칙을 약화시키지 않는 쪽을 골랐다. */
const NOTICE = JSON.parse(read("scripts/font-notice.json"));
const OFL_SHA256 = NOTICE.notice.sha256;
const FONT_SHA = NOTICE.fonts;

/** 글꼴 디렉터리 하나를 검사한다. 음성 대조를 위해 임의 경로를 받는다. */
export function checkFontNotice(dir) {
  const notice = join(dir, "OFL.txt");
  assert.ok(existsSync(notice), `글꼴과 같은 자리에 OFL.txt 가 없다: ${notice}`);
  const raw = readFileSync(notice);
  const text = raw.toString("utf8");
  assert.equal(createHash("sha256").update(raw).digest("hex"), OFL_SHA256,
    "OFL.txt 가 상류 원문과 다르다 — 전문은 그대로여야 한다(번역·요약·재작성 금지)");
  assert.ok(text.startsWith(NOTICE.notice.copyright_first_line),
    "저작권 표시 줄이 첫 줄에 없다");
  assert.ok(text.includes(NOTICE.notice.license_header),
    "라이선스 본문 표제가 없다");
  assert.ok(!/^\s*<(!doctype|html)/i.test(text), "HTML 문서가 OFL.txt 자리에 들어갔다");
  // 글꼴 파일이 하나도 바뀌지 않았다 — 고지는 이 파일들에 대한 것이다
  for (const [f, want] of Object.entries(FONT_SHA)) {
    const p = join(dir, f);
    assert.ok(existsSync(p), `글꼴 파일이 없다: ${f}`);
    assert.equal(createHash("sha256").update(readFileSync(p)).digest("hex"), want,
      `글꼴 파일이 바뀌었다: ${f} — 바뀌었으면 어느 고지가 맞는지 다시 확인한다`);
  }
}

{
  /* 배포물의 글꼴 옆에 OFL 전문과 저작권 표시가 있다 */
  const dir = join(ROOT, "dist/assets/fonts");
  checkFontNotice(dir);

  // CSS 가 참조하는 글꼴이 전부 이 디렉터리 안에 있다
  const css = read("dist/assets/app.css");
  const refs = [...css.matchAll(/url\("(fonts\/[^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, "CSS 에서 글꼴 참조를 찾지 못했다");
  for (const r of new Set(refs))
    assert.ok(existsSync(join(ROOT, "dist/assets", r)), `CSS 가 없는 글꼴을 참조한다: ${r}`);

  // 음성 대조 — 고지를 뺀 임시 사본에서는 이 검사가 반드시 깨진다.
  // 실제 작업 트리는 건드리지 않는다.
  const tmp = mkdtempSync(join(tmpdir(), "font-notice-"));
  try {
    cpSync(dir, tmp, { recursive: true });
    rmSync(join(tmp, "OFL.txt"));
    let threw = false;
    try { checkFontNotice(tmp); } catch { threw = true; }
    assert.ok(threw, "고지를 빼도 검사가 통과한다 — 이 검사는 아무것도 지키지 못한다");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  n += 2;   // ① 배포물의 고지·글꼴 지문 ② 고지를 빼면 깨지는지(음성 대조)
}

const headers = read("dist/_headers");
assert.match(headers, /style-src 'self';/, "_headers CSP 의 style-src 에 외부 오리진이 남아 있다");
assert.match(headers, /font-src 'self';/, "_headers CSP 의 font-src 에 외부 오리진이 남아 있다");
n += 2;

/* ── 판정 경로에 네트워크가 없다 ──────────────────────────────────────────── */
forbid(/\bfetch\s*\(/, "rules.js 는 순수 함수만 둔다 — 판정 경로에 네트워크가 들어오면 결정론이 깨진다",
  ["dist/assets/rules.js"]);

/* ── .env 가 추적되지 않는다 ──────────────────────────────────────────────── */
const ignore = read(".gitignore");
assert.match(ignore, /^\.env$/m, ".gitignore 에 .env 가 없다");
n++;


/* 문서가 이 건수를 적고 있다. 스스로 낡는 숫자는 검사로 묶거나 문서에서 뺀다.
 * **두 파일 다 본다** — 한쪽만 묶었더니 다른 쪽이 조용히 낡았다(05-TEST 가 source 를 17건으로
 * 적고 있었다. 실제는 24였고 그 사이 22를 거쳤다). */
for (const f of ["docs/05-TEST.md", "README.md"])
  assert.ok(readFileSync(new URL(`../${f}`, import.meta.url), "utf8").includes(`${n}건`),
    `${f} 가 소스 금지 패턴 건수를 ${n}건 으로 적고 있지 않다 — 검사를 늘렸으면 문서도 고친다`);

console.log(`source ok — ${n}건`);
