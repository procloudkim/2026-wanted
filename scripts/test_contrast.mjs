/* 색 대비 검증. app.css 의 토큰을 직접 읽어서 잰다.  실행: node scripts/test_contrast.mjs
 * 토큰을 바꾸면 화면보다 여기가 먼저 깨진다. 다크모드는 스크린샷으로 확인되지 않아 수치로 잡는다. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../dist/assets/app.css", import.meta.url), "utf8");

/** :root 블록과 다크모드 블록에서 토큰을 뽑는다. */
function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})/g)) out[m[1]] = m[2];
  return out;
}
const light = tokens(css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)")));
const darkBlock = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
const dark = { ...light, ...tokens(darkBlock.slice(0, darkBlock.indexOf("\n}\n"))) };

const lum = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/* [전경, 배경, 최소비] — 텍스트 4.5, UI 경계 3.0 (WCAG 2.2 AA) */
const PAIRS = [
  ["fg", "bg", 4.5], ["card-fg", "card", 4.5],
  ["muted-fg", "card", 4.5], ["muted-fg", "bg", 4.5], ["muted-fg", "muted", 4.5],
  ["secondary", "card", 4.5],
  ["accent", "card", 4.5], ["on-accent", "accent", 4.5],
  ["on-primary", "primary", 4.5],
  ["danger", "card", 4.5], ["danger", "muted", 4.5], ["on-danger", "danger", 4.5],
  ["ok", "muted", 4.5],
  // 경계가 의미를 갖는 곳. 구분선(--border)은 장식이라 대상이 아니다.
  ["border-ctl", "bg", 3], ["border-ctl", "card", 3], ["border-ctl", "muted", 3],
  ["ring", "bg", 3], ["ring", "card", 3],
];

let n = 0;
for (const [theme, t] of [["light", light], ["dark", dark]]) {
  for (const [fg, bg, need] of PAIRS) {
    assert.ok(t[fg] && t[bg], `${theme}: 토큰 없음 ${fg}/${bg}`);
    const r = ratio(t[fg], t[bg]);
    assert.ok(r >= need, `${theme} ${fg}/${bg} = ${r.toFixed(2)} (기준 ${need})`);
    n++;
  }
}

/* 두 테마 모두 정의되어야 한다 — 한쪽만 만들면 다른 쪽에서 글자가 사라진다 */
for (const k of ["bg", "fg", "card", "card-fg", "muted", "muted-fg", "border", "border-ctl",
                 "accent", "on-accent", "danger", "ok", "ring", "primary", "on-primary"])
  assert.ok(light[k] && dark[k], `토큰 ${k} 가 한쪽 테마에만 있다`);

/* body 에 명시적 배경이 있어야 한다 — 없으면 다크모드에서 흰 바탕에 흰 글자가 된다 */
assert.match(css, /body\s*\{[^}]*background:\s*var\(--bg\)/);


/* 문서가 이 건수를 적고 있다. 스스로 낡는 숫자는 검사로 묶거나 문서에서 뺀다.
 * **두 파일 다 본다** — 한쪽만 묶었더니 다른 쪽이 조용히 낡았다(05-TEST 가 source 를 17건으로
 * 적고 있었다. 실제는 24였고 그 사이 22를 거쳤다). */
for (const f of ["docs/05-TEST.md", "README.md"])
  assert.ok(readFileSync(new URL(`../${f}`, import.meta.url), "utf8").includes(`${n}쌍`),
    `${f} 가 색 대비 건수를 ${n}쌍 으로 적고 있지 않다 — 검사를 늘렸으면 문서도 고친다`);

console.log(`contrast ok — ${n}쌍 (light/dark 각 ${PAIRS.length}쌍)`);
