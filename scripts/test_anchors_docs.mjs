/* 문서·화면의 수치가 스냅샷과 같은가.  실행: node scripts/test_anchors_docs.mjs
 *
 * 왜 있는가: 수치의 단일 출처는 dist/data/anchors.json 인데 문서와 OG 메타만 손으로 적혀 있다.
 * 데이터를 다시 모으면 화면은 자동으로 따라가고 문서만 조용히 낡는다. 그 조용함을 여기서 깬다.
 *
 * 무엇을 하지 않는가: 재계산하지 않는다. 스냅샷의 값을 그대로 포맷해서 **전사됐는지만** 본다.
 * 계산이 맞는지는 build_assets.py --selftest 와 test_rules.mjs 가 본다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const A = JSON.parse(read("dist/data/anchors.json"));
const IDX = JSON.parse(read("dist/data/index.json"));

/* 표시 포맷은 rules.js 와 같아야 한다. 한 글자라도 다르면 "문서에 없다"가 되어 잘못 실패한다. */
const n = (v) => v.toLocaleString("ko-KR");
const p = (v) => `${v.toFixed(2)}%`;
const money = (v) => `${v.toLocaleString("ko-KR")}만원`;
const eok = (v) => `${n(Math.round(v / 10000))}억원`;   // 만원 → 억원 (문서는 "약 6,254억원"처럼 쓴다)
const rows = (v) => `${n(v)}행`;
const gun = (v) => `${n(v)}건`;

const at = (path) => path.split(".").reduce((o, k) => o[k], A);
const COHORTS = IDX.gu.reduce((s, g) => s + g.cohorts, 0);
const BUILDINGS = IDX.gu.reduce((s, g) => s + g.buildings, 0);

/* ── ① 전사 검사 ──────────────────────────────────────────────────────────
 * "이 파일은 이 값을 이 표기로 담고 있어야 한다." 스냅샷이 바뀌면 새 값이 문서에 없어서 깨진다. */
const REQUIRE = {
  "README.md": [
    ["build.rows", n], ["total_n", n],
    ["recorded.n", n], ["recorded.over5", p], ["recorded.p90", p],
    ["unrecorded.n", n], ["unrecorded.over5", p], ["unrecorded.p90", p],
    ["all.at5", p], ["excess_median", money],
    ["by_kind.아파트.n", n], ["by_kind.아파트.nr.over5", p], ["by_kind.아파트.nr.p90", p],
    ["by_kind.단독다가구.n", n], ["by_kind.단독다가구.nr.over5", p], ["by_kind.단독다가구.nr.p90", p],
    ["by_kind.연립다세대.n", n], ["by_kind.연립다세대.nr.over5", p], ["by_kind.연립다세대.nr.p90", p],
    ["by_kind.오피스텔.n", n], ["by_kind.오피스텔.nr.over5", p], ["by_kind.오피스텔.nr.p90", p],
    ["all.over5", p], ["blank_ctype.n", rows], ["blank_ctype.pct", p],
  ],
  "docs/01-PRD.md": [
    ["build.rows", n], ["total_n", n],
    ["recorded.n", n], ["recorded.over5", p], ["recorded.p90", p],
    ["unrecorded.n", n], ["unrecorded.over5", p], ["unrecorded.p90", p],
    ["all.at5", p], ["all.over5", p], ["excess_median", money],
    ["ladder.1", p],
    ["over.n", n], ["over.excess_sum", eok],
    ["market_gap.n", n], ["market_gap.share_pct", p], ["market_gap.gap_median", money], ["market_gap.below_pct", p],
  ],
  "docs/02-SPEC.md": [
    ["total_n", n], ["recorded.n", n], ["recorded.over5", p],
    ["unrecorded.n", n], ["unrecorded.over5", p], ["excess_median", money],
    ["all.at5", p], ["convert.n", n], ["convert.p25", p], ["convert.p50", p], ["convert.p75", p],
    ["ladder.1", p], ["ladder.3", p],
    ["market_gap.n", n], ["market_gap.share_pct", p], ["market_gap.gap_median", money], ["market_gap.below_pct", p],
    ["blank_ctype.n", rows], ["blank_ctype.pct", p], ["build.dropped_outliers", gun],
    // §5.3-1 유형별 표. 아파트만 1단계(단지)가 있고 나머지는 3단계에서 시작한다
    ...["아파트", "오피스텔", "연립다세대", "단독다가구"].flatMap((k) => [
      [`by_kind.${k}.n`, n], [`by_kind.${k}.nr.over5`, p], [`by_kind.${k}.nr.p90`, p],
      [`by_kind.${k}.ladder.${k === "아파트" ? 1 : 3}`, p],
    ]),
  ],
  "docs/03-ARCHITECTURE.md": [["build.rows", n], ["total_n", n], ["build.dropped_outliers", gun]],
  "docs/05-TEST.md": [
    ["total_n", n], ["fill.renewal_rows", n], ["fill.prev_deposit_missing_pct", p],
    ["fill.by_kind.아파트.rr_token_pct", p], ["fill.by_kind.단독다가구.rr_token_pct", p],
    ["build.dropped_outliers", gun],
  ],
  // OG·트위터 메타. 화면 본문은 anchors 에서 채우는데 메타만 손으로 적혀 있다.
  "dist/index.html": [
    ["recorded.n", n], ["recorded.over5", p], ["unrecorded.n", n], ["unrecorded.over5", p],
  ],
};

/* 누락은 모아서 한 번에 보고한다. 데이터를 다시 모으면 수십 개가 한꺼번에 바뀌는데,
 * 첫 누락에서 멈추면 고칠 목록을 한 줄씩 캐내야 했다. */
let checks = 0;
const misses = [];
for (const [file, items] of Object.entries(REQUIRE)) {
  const text = read(file);
  for (const [path, fmt] of items) {
    const want = fmt(at(path));
    if (!text.includes(want)) misses.push(`${file}: anchors.${path} = ${want}`);
    checks++;
  }
}

/* README 의 자산 규모는 anchors 가 아니라 index.json 합계다. */
for (const [file, want, what] of [
  ["README.md", n(COHORTS), "코호트 수"], ["README.md", n(BUILDINGS), "건물 색인 수"],
  ["docs/03-ARCHITECTURE.md", n(COHORTS), "코호트 수"], ["docs/03-ARCHITECTURE.md", n(BUILDINGS), "건물 색인 수"],
]) {
  if (!read(file).includes(want)) misses.push(`${file}: ${what} ${want} (index.json 합계)`);
  checks++;
}
/* 행사 기록 있는 쪽의 유형별 5% 초과는 범위로 적는다(02-SPEC §5.3-1 "0.32~0.58%"). */
{
  const rr = Object.values(A.by_kind).map((k) => k.rr.over5);
  const want = `${Math.min(...rr).toFixed(2)}~${Math.max(...rr).toFixed(2)}%`;
  if (!read("docs/02-SPEC.md").includes(want)) misses.push(`docs/02-SPEC.md: by_kind.*.rr.over5 범위 = ${want}`);
  checks++;
}
assert.equal(misses.length, 0,
  `스냅샷 값 ${misses.length}개가 본문에 없다. 스냅샷을 다시 만들었으면 이 값들을 문서에 옮긴다:\n  ${misses.join("\n  ")}`);

/* ── ② 금지 검사 ──────────────────────────────────────────────────────────
 * 초기 탐색 계열(서울시 파일)과 중간 표본의 값이 현 계열 문장에 남아 있으면 안 된다.
 * 모수가 다른 숫자를 한 문장에 섞는 것이 이 제품에서 가장 조용한 거짓말이다.
 * 의도적으로 쓰는 자리는 <!-- 계열:서울시파일 --> ... <!-- /계열 --> 로 감싼다. */
const LEGACY = [
  ["61,368", "서울시 파일 계열 모수"], ["28,543", "서울시 파일 행사 기록 있음"],
  ["32,825", "서울시 파일 행사 기록 없음"], ["34.47%", "서울시 파일 초과 비율"],
  ["0.41%", "서울시 파일 초과 비율"], ["2,600만원", "서울시 파일 초과 차액 중앙값"],
  ["43.41%", "서울시 파일 정확히 5%"], ["25.22%", "서울시 파일 단독다가구 주소 결측"],
  ["422,672", "서울시 파일 행 수"], ["106,596", "서울시 파일 결측 행 수"],
  ["77.8%", "서울시 파일 코호트 3건 이상 비율"], ["26,211", "서울시 파일 비교 가능 건수"],
  ["6,500만원", "서울시 파일 시세 차액"], ["83.1%", "서울시 파일 시세 이하 비율"],
  ["5,878억", "서울시 파일 초과 차액 합계"], ["84배", "서울시 파일 두 집단 배율"],
  ["21.5%", "서울시 파일 해석 무관 초과율"],
  // "18.18%"(서울시 파일 상위 10%)는 뺐다. 2026-10-25 스냅샷의 아파트 상위 10% 인상률이 우연히 같은 값이라
  // 금지하면 정상 값을 막는다. 옛 계열 값의 남용은 계열 표시(<!-- 계열:서울시파일 -->)와 문맥으로 본다.
  ["543건", "두 출처 표기 불일치 건수"],
  ["40,460", "국토부 아파트 3개월 표본 모수"], ["17,562", "그 표본의 정확히 5%"],
  ["65.11%", "3개월 표본 코호트 비율"], ["41.77%", "3개월 표본 코호트 비율"],
  ["39.09%", "3개월 표본 코호트 비율"], ["9.02%", "3개월 표본 코호트 비율"],
  ["49.45%", "3개월 표본 단독다가구 초과율"], ["42.84%", "3개월 표본 채움률"],
  ["49.02%", "3개월 표본 채움률"], ["31.55%", "3개월 표본 채움률"],
  ["73,896", "출처 미상 갱신 행 수"],
  ["6.27%", "옛 환산 분포 중앙값"], ["5.17%", "옛 환산 분포 p25"], ["9.44%", "옛 환산 분포 p75"],
  ["n=600", "옛 환산 분포 표본"], ["600건", "옛 환산 분포 표본"],
];

const SCAN = ["README.md", "docs/00-INDEX.md", "docs/00-GLOSSARY.md", "docs/STYLE.md", "docs/01-PRD.md", "docs/02-SPEC.md", "docs/03-ARCHITECTURE.md",
  "docs/05-TEST.md", "dist/index.html", "dist/assets/app.js", "dist/assets/rules.js",
  "functions/api/parse.js", "functions/api/draft.js", "functions/api/_llm.js",
  "scripts/build_assets.py", "scripts/test_rules.mjs", "scripts/test_verify.mjs"];
// docs/04-API.md 는 대상이 아니다. 그 문서는 API 를 직접 두드려 본 **측정 기록**이고,
// 거기 적힌 숫자는 화면에 쓰는 값이 아니라 재현했을 때 나와야 하는 기대값이다.

const strip = (t) => t.replace(/<!-- 계열:서울시파일 -->[\s\S]*?<!-- \/계열 -->/g, " ");

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

for (const file of SCAN) {
  const text = strip(read(file));
  for (const [token, why] of LEGACY) {
    // 앞자리에 숫자·부호가 붙으면 다른 수다. "-6,500만원"(포맷 예시)을 "6,500만원"으로 읽지 않는다.
    const m = text.match(new RegExp(`(?<![\\d,.\\-])${esc(token)}`));
    assert.equal(m, null, `${file}: "${token}"(${why})이 현 계열 문장에 남아 있다.\n  ${
      text.slice(Math.max(0, m?.index - 60), m?.index + 60).replace(/\n/g, " ")}\n  의도한 인용이면 <!-- 계열:서울시파일 --> 로 감싼다.`);
    checks++;
  }
}

/* ── ③ 모수 문자열 ────────────────────────────────────────────────────────
 * 값만 맞고 모수가 빠지면 DR4 위반이다. 화면은 anchors.scope 를 그대로 출력해야 한다. */
assert.ok(read("dist/assets/app.js").includes("anchors.scope"),
  "app.js 가 anchors.scope 를 화면에 내보내지 않는다 (02-SPEC DR4)");
assert.ok(!read("dist/assets/rules.js").match(/=\s*\{\s*n:\s*\d+,\s*p25:/),
  "rules.js 에 분포 상수가 다시 박혔다. 분포는 anchors 에서 읽는다");
checks += 2;


/* ── 프레임워크 (STYLE §4) ────────────────────────────────────────────────
 * 릴리스가 장을 추가하면서 Why 를 빼먹는 일이 실제로 있었다 — 커밋 09d07f5 가 넣은
 * 02-SPEC §6.0-A 와 04-API §7.0 이 둘 다 무표기였고 둘 다 그 장의 Why 앞에 꽂혔다.
 * 규칙만으로는 또 일어난다.
 *
 * ponytail: 낱말 하나만 본다. "Why 가 있는가"이지 "그 Why 가 이유인가"가 아니다.
 * 사람이 읽어야 하는 것은 그대로 남는다 — 이 검사는 **빠뜨림**만 잡는다. */
for (const file of ["docs/01-PRD.md", "docs/02-SPEC.md", "docs/03-ARCHITECTURE.md",
                    "docs/04-API.md", "docs/05-TEST.md"]) {
  for (const sec of read(file).split(/^## /m).slice(1)) {
    const head = sec.split("\n")[0].trim();
    const body = sec.slice(head.length);
    assert.ok(/\b(Why|What|How)\b/.test(head) || /\bWhy\b/.test(body)
              || /<!-- 프레임워크밖:(색인|기록|부재)[^>]*-->/.test(sec),
      `${file}: "## ${head}" 에 Why 도 프레임워크밖 표시도 없다 (STYLE §4).\n` +
      `  정하는 장이면 Why 를, 색인·기록·부재 목록이면 표시를 머리에 단다.`);
    checks++;
  }
}

/* 문서가 이 건수를 적고 있다. 스스로 낡는 숫자는 검사로 묶거나 문서에서 뺀다.
 * **두 파일 다 본다** — 한쪽만 묶었더니 다른 쪽이 조용히 낡았다(05-TEST 가 source 를 17건으로
 * 적고 있었다. 실제는 24였고 그 사이 22를 거쳤다). */
for (const f of ["docs/05-TEST.md", "README.md"])
  assert.ok(readFileSync(new URL(`../${f}`, import.meta.url), "utf8").includes(`${checks}건`),
    `${f} 가 앵커·문서 대조 건수를 ${checks}건 으로 적고 있지 않다 — 검사를 늘렸으면 문서도 고친다`);

console.log(`anchors·문서 대조 ok — ${checks}건`);
