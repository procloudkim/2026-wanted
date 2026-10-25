/* 판정 산술 검증. 네트워크·키 없이 돈다.  실행: node scripts/test_rules.mjs
 * 기대값은 docs/02-SPEC.md §3 의 검증 표를 그대로 옮긴 것이다. 표가 바뀌면 여기가 먼저 깨져야 한다. */
import assert from "node:assert/strict";
import * as R from "../dist/assets/rules.js";
import { areaM2 as serverAreaM2 } from "../functions/api/_llm.js";
import { readFileSync, existsSync } from "node:fs";

/* 화면이 읽는 것과 같은 스냅샷. 상수를 따로 두면 기준일·모수가 어긋난다. */
const A = JSON.parse(readFileSync(new URL("../dist/data/anchors.json", import.meta.url), "utf8"));

const D = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
let n = 0, golden = 0;
const t = (name, fn) => { fn(); n++; };
// 골든셋 검사는 따로 센다. 골든셋은 저장소 밖(decisions/, gitignore)이라 깨끗한 클론과 CI 에는 없고,
// 같이 세면 문서에 적은 건수가 환경마다 달라져 CI 에서만 깨진다(2026-10-25 실측: 로컬 34 / 클론 32).
const tg = (name, fn) => { fn(); golden++; };

/* ── 반올림: 사사오입. 파이썬 은행원 반올림과 갈리는 자리를 고정한다 ───────── */
t("반올림은 사사오입", () => {
  assert.equal(R.round0(0.5), 1);      // 은행원 반올림이면 0 이 된다
  assert.equal(R.round0(1.5), 2);
  assert.equal(R.round0(2.5), 3);
  assert.equal(R.round2(5.005), 5.01);
  assert.equal(R.round0(-0.5), -1);
  assert.equal(R.round1(34.4699), 34.5);
});

t("최근접 순위법", () => {
  assert.equal(R.nearestRank([100, 300], 50), 300);   // k = floor(0.5+0.5) = 1
  assert.equal(R.nearestRank([500, 1000, 2000], 50), 1000);
  assert.equal(R.nearestRank([500, 1000, 2000], 90), 2000);
  assert.equal(R.nearestRank([], 50), null);
});

/* ── R1 인상률 ─────────────────────────────────────────────────────────────── */
t("R1 — 연우의 +8%", () => {
  const r = R.r1Rate(60000, 64800);
  assert.equal(r.rate_pct, 8.0);
  assert.equal(r.is_over_cap, true);
  assert.equal(r.is_exact_cap, false);
});

t("R1 — 정확히 5%는 초과가 아니다 (정수 비교)", () => {
  // 실수로 rate > 0.05 를 쓰면 이 계약이 초과로 잘못 분류된다. 갱신의 43%가 여기에 몰려 있다.
  for (const prev of [10000, 33333, 85691, 7]) {
    const now = prev + prev / 20;
    if (!Number.isInteger(now)) continue;
    const r = R.r1Rate(prev, now);
    assert.equal(r.is_exact_cap, true, `prev=${prev}`);
    assert.equal(r.is_over_cap, false, `prev=${prev}`);
  }
  assert.equal(R.r1Rate(20000, 21001).is_over_cap, true);
  assert.equal(R.r1Rate(20000, 21000).is_over_cap, false);
});

t("R1 — 감액과 경계값", () => {
  assert.equal(R.r1Rate(50000, 45000).rate_pct, -10);        // 감액은 정상 값이다
  assert.equal(R.r1Rate(0, 10000).error, "E-RATE-DIV0");
  assert.equal(R.r1Rate(10000, 10000, 0, 50).error, "E_RENT_TYPE_MIXED");
  assert.equal(R.r1Rate(10000, 10000, 30, 0).error, "E_RENT_TYPE_MIXED");
});

/* ── R2 상한 대비 초과 차액 ────────────────────────────────────────────────── */
t("R2 — 종전 6억, 제시 6억 4,800", () => {
  const c = R.r2Cap(60000, 64800);
  assert.equal(c.deposit, 63000);
  assert.equal(c.excess, 1800);
  assert.equal(c.over, true);
});

t("R2 — 상한액은 버림, 초과 차액은 정확한 상한 기준", () => {
  const c = R.r2Cap(10001, 12000);
  assert.equal(c.deposit, 10501);                       // 10001×21/20 = 10501.05 → 버림
  assert.equal(c.excess, R.round0(12000 - 10501.05));   // 버림값이 아니라 정확값 기준
  assert.equal(c.excess, 1499);
});

t("R2 — 초과가 아니면 차액을 0으로 두고 음수를 '여유'로 포장하지 않는다", () => {
  const c = R.r2Cap(60000, 61000);
  assert.equal(c.over, false);
  assert.equal(c.excess, 0);
});

/* ── R3 코호트 백분위 ──────────────────────────────────────────────────────── */
t("R3 — 상위 X%는 행사 기록이 없는 갱신 안에서 센다(동률 포함)", () => {
  const rec = { rr: [0, 500, 500], nr: [300, 500, 800, 2000], rt: 2, nt: 1, ro: 0, no: 2 };
  const r = R.r3Percentile(rec, 10000, 10500);          // 내 인상률 = 정확히 5.00%
  assert.equal(r.n, 4);                                 // 행사 기록 있는 3건은 표본이 아니다
  // 나보다 크거나 같은 것: 500 + 800 + 2000 = 3건 → 75.0% (합쳤다면 5/7 = 71.4%)
  assert.equal(r.top_share_pct, 75.0);
  assert.equal(r.median_pct, 8.0);
  assert.equal(r.p90_pct, 20.0);
  assert.deepEqual(r.recorded, { n: 3, within_cap_pct: 100.0 });
});

t("R3 — 5% 초과·동률은 벡터가 아니라 레코드의 정수 비교 결과를 쓴다", () => {
  // 벡터에는 500 이 2건 있지만 그중 1건은 실제로 5.0026% 다(빌드가 정수 비교로 세어 no=2).
  // 벡터에서 세면 초과 1건이 되어, R1 이 "초과"라고 판정한 계약이 분포에서 사라진다.
  const rec = { rr: [500, 500], nr: [500, 500, 900], rt: 2, nt: 1, ro: 0, no: 2 };
  const r = R.r3Percentile(rec, 10000, 10500);
  assert.equal(r.tie_at_cap_n, 1);                      // 벡터의 500 은 2건이지만 동률은 1건
  assert.equal(r.over_cap_n, 2);
  assert.deepEqual(r.recorded, { n: 2, within_cap_pct: 100.0 });
});

t("R3 — 데모 코호트: 행사 기록 있는 갱신을 섞으면 제시안이 드물어 보인다", () => {
  // README 의 데모(강남구 대치동 전용 80-90㎡, 9억 → 9억 7,200만원)와 같은 값이다.
  // 자산을 다시 만들면 이 숫자와 README 문장을 같이 고친다.
  const shard = JSON.parse(readFileSync(new URL("../dist/data/cohort/11680.json", import.meta.url), "utf8"));
  const rec = shard.cohorts["아파트|11680|대치동||80-90"];
  const r = R.r3Percentile(rec, 90000, 97200);
  assert.equal(r.n, 103);
  assert.equal(r.top_share_pct, 47.6);
  assert.equal(r.median_pct, 7.37);
  assert.deepEqual(r.recorded, { n: 187, within_cap_pct: 100.0 });
  // 예전 구현(두 벡터를 합침)은 같은 제시를 290건 중 상위 16.9% 로 낸다(2026-10-25 스냅샷)
  const merged = [...rec.rr, ...rec.nr];
  assert.equal(merged.length, 290);
  assert.equal(R.round1((merged.filter((x) => x >= 800).length / merged.length) * 100), 16.9);
});

t("R3 — 정수 비교와 실수 비교는 만원 단위 정수에서는 갈리지 않는다", () => {
  // 명세는 실수 비교가 정확히 5%인 계약을 초과로 오분류한다고 적었지만,
  // 금액이 만원 단위 정수인 한 재현되지 않았다(prev 12만까지 전수). 정수 비교를 쓰는 이유는
  // 오분류를 고쳐서가 아니라 반올림 방식에 의존하지 않기 위해서다.
  let checked = 0;
  for (let prev = 20; prev <= 120000; prev += 20) {
    const now = prev + prev / 20;
    if (!Number.isInteger(now)) continue;
    assert.equal(((now - prev) / prev) * 100 > 5, R.r1Rate(prev, now).is_over_cap, `prev=${prev}`);
    checked++;
  }
  assert.ok(checked > 5000);
});

t("R3 — 표본 3건 미만이면 백분위를 만들지 않는다", () => {
  assert.equal(R.r3Percentile({ rr: [500], nr: [600] }, 10000, 10500).need_widen, true);
  // 행사 기록 있는 갱신은 표본을 채우지 않는다 — 합쳐서 4건이어도 기록 없는 쪽이 1건이면 넓힌다
  const r = R.r3Percentile({ rr: [500, 500, 500], nr: [600] }, 10000, 10500);
  assert.equal(r.need_widen, true);
  assert.equal(r.n, 1);
});

t("R3 — 양 끝은 반올림한 비율이 아니라 건수로 가린다", () => {
  const rec = { nr: [100, 200, 300] };                   // 1% · 2% · 3%
  assert.equal(R.r3Percentile(rec, 10000, 10400).above_n, 0);   // 4% 는 어느 것보다도 높다
  assert.equal(R.r3Percentile(rec, 10000, 10050).above_n, 3);   // 0.5% 는 셋 모두가 같거나 높다
  // 2,425건 중 1건이면 0.04% 라 비율로는 0.0 이 된다(실측 최대 표본: 송파구 아파트 전체)
  const r = R.r3Percentile({ nr: [...Array(2424).fill(100), 900] }, 10000, 10900);
  assert.equal(r.top_share_pct, 0);
  assert.equal(r.above_n, 1);
});

/* ── R5 이탈 차액 ──────────────────────────────────────────────────────────── */
t("R5 — 표본 5건 미만이면 카드를 만들지 않는다", () => {
  assert.equal(R.r5Market(71000, 4, 64800), null);
  assert.equal(R.r5Market(null, 12, 64800), null);
  const m = R.r5Market(71000, 12, 64800);
  assert.equal(m.gap, 6200);
  assert.equal(m.gap_pct, 8.7);
});

/* ── R2-1 자릿수 사고 탐지 ────────────────────────────────────────────────── */
t("R2-1 — 비율 검사로는 못 잡는 자릿수 오류를 바깥 기준이 잡는다", () => {
  // "2억4천"을 24억으로 읽은 경우. 종전·제시가 같은 배율이라 인상률은 정상(+5%)이다.
  assert.equal(R.r1Rate(240000, 252000).rate_pct, 5);        // 비율만 보면 완벽히 정상
  assert.equal(R.r2Cap(240000, 252000).over, false);
  // 같은 코호트의 신규 전세 중앙값이 2억 5천이면 10배 가까이 벗어난다
  const off = R.depositLooksOff(240000, 25000);
  assert.equal(off.kind, "HIGH");
  assert.equal(off.ratio, 9.6);
  assert.equal(off.median, 25000);
});

t("R2-1 — 되묻기이지 버리기가 아니다", () => {
  // 3배 이내는 통과시킨다. 진짜로 분포 밖인 계약이 존재한다
  assert.equal(R.depositLooksOff(70000, 25000), null);       // 2.8배
  assert.equal(R.depositLooksOff(9000, 25000), null);        // 0.36배
  assert.equal(R.depositLooksOff(75001, 25000).kind, "HIGH"); // 3.0배 초과
  assert.equal(R.depositLooksOff(8333, 25000).kind, "LOW");   // 1/3 미만
  // 기준이 없으면 판정하지 않는다 — 없는 근거로 되묻지 않는다
  assert.equal(R.depositLooksOff(240000, null), null);
  assert.equal(R.depositLooksOff(240000, 0), null);
  assert.equal(R.depositLooksOff(0, 25000), null);
});

/* ── R6 법정 기한 (02-SPEC §3.7 검증 표 그대로) ────────────────────────────── */
t("R6 — 개월 계산과 말일 보정", () => {
  const cases = [
    ["2026-12-20", "2026-06-20", "2026-10-19"],   // 대응일(10-20)의 전날
    ["2027-01-15", "2026-07-15", "2026-11-14"],
    ["2026-11-30", "2026-05-30", "2026-09-29"],
    ["2026-12-31", "2026-06-30", "2026-10-30"],   // 6월은 31일이 없다
    ["2026-04-30", "2025-10-30", "2026-02-27"],   // 2월 말일(28일)로 보정한 뒤 그 전날
  ];
  for (const [exp, start, dl] of cases) {
    const w = R.r6Window(D(exp), D("2026-09-18"));
    assert.equal(iso(w.start), start, exp);
    assert.equal(iso(w.deadline), dl, exp);
  }
});

t("R6 — 마감은 대응일의 전날이다 (기대값은 바깥에서 가져온다)", () => {
  // 예전 표는 코드와 기대값을 같은 사람이 써서 하루 늦은 마감(대응일)이 그대로 통과했다.
  // 아래 셋은 이 저장소 밖의 해석이다(확인 2026-10-25). 판례는 찾지 못했다.
  //  서울시 마을변호사: 만료일 2020-09-30 → "1개월 전인 2020년 8월 29일까지" 도달
  //    https://mediahub.seoul.go.kr/archives/1294440
  //  국토부 인용 보도: 만기 1월 9일 → "12월 9일 0시 전까지", 곧 12월 8일까지
  //    https://kyeonggi.com/article/202011301147368
  //  2개월 기준 해설: 만기 12월 15일 → 10월 14일까지 (bokduckbbang.com)
  const old = (exp) => R.r6Window(D(exp), D("2020-01-01"), D("2019-01-01")).note.alt_deadline;
  assert.equal(iso(old("2020-09-30")), "2020-08-29");
  assert.equal(iso(old("2021-01-09")), "2020-12-08");
  assert.equal(iso(R.r6Window(D("2026-12-15"), D("2026-09-18")).deadline), "2026-10-14");
});

t("R6 — 남은 일수와 경고 단계", () => {
  const w = R.r6Window(D("2026-12-20"), D("2026-09-18"));
  assert.equal(w.d_day, 31);
  assert.equal(w.stage, "OPEN");
  assert.equal(R.r6Window(D("2026-12-20"), D("2026-10-19")).stage, "TODAY");
  assert.equal(R.r6Window(D("2026-12-20"), D("2026-10-18")).stage, "D1");
  assert.equal(R.r6Window(D("2026-12-20"), D("2026-10-16")).stage, "D3");
  // 대응일(10-20) 당일은 이미 늦다. 예전 구현은 이날을 "오늘이 마지막입니다"로 냈다.
  assert.equal(R.r6Window(D("2026-12-20"), D("2026-10-20")).stage, "PASSED");
  assert.equal(R.r6Window(D("2026-12-20"), D("2026-10-20")).d_day, -1);
});

t("R6 — 2020-12-10 이전 체결분은 이른 날짜를 마감으로 안내한다", () => {
  const w = R.r6Window(D("2026-12-20"), D("2026-09-18"), D("2020-06-01"));
  assert.equal(iso(w.deadline), "2026-10-19");           // 2개월 기준이 더 이르다
  assert.equal(iso(w.note.alt_deadline), "2026-11-19");
  assert.equal(R.r6Window(D("2026-12-20"), D("2026-09-18"), D("2021-01-01")).note, null);
});

/* ── R7 환산 ───────────────────────────────────────────────────────────────── */
t("R7 — 세린의 두 조건", () => {
  const a = R.r7Convert(24000, 0, 24000, 60);            // 보증금 유지 + 월 60
  assert.equal(a.kind, "NET_ADD");
  assert.equal(a.annual_rate_pct, 3.0);
  assert.equal(a.compare_to_distribution, false);        // 분포와 비교하지 않는다

  const b = R.r7Convert(24000, 0, 14000, 60);            // 감액 1억 + 월 60
  assert.equal(b.kind, "CONVERT");
  assert.equal(b.annual_rate_pct, 7.2);
  assert.equal(b.compare_to_distribution, true);
  // 분포는 스냅샷에서 온다. 계열이 바뀌면 이 자리도 바뀌고, 문서의 같은 예시 문장도 함께 바뀌어야 한다.
  assert.ok(A.convert.p25 <= A.convert.p50 && A.convert.p50 <= A.convert.p75, "분위수가 단조가 아니다");
  assert.ok(b.annual_rate_pct > A.convert.p25 && b.annual_rate_pct < A.convert.p50,
    `연 7.2% 는 p25(${A.convert.p25}%)와 중앙값(${A.convert.p50}%) 사이여야 한다`);
});

t("R7 — 보증금과 월세가 둘 다 오르면 전환율을 내지 않는다", () => {
  assert.equal(R.r7Convert(24000, 0, 26000, 60).kind, "BOTH_UP");
  assert.equal(R.r7Convert(24000, 0, 26000, 60).annual_rate_pct, null);
  assert.equal(R.r7Convert(24000, 0, 14000, 0), null);
});

t("R7 — 분자는 늘어난 월세다(지금 월세를 뺀다)", () => {
  // 월 50만원을 그대로 내는 조건이 "월세를 새로 붙인 순증"으로 나오던 결함(2026-10-25)
  assert.equal(R.r7Convert(24000, 50, 24000, 50).kind, "NO_RENT_INCREASE");
  // 월세를 없애고 보증금을 올리는 조건도 카드가 비지 않는다 — null 이면 화면에 아무 계산도 없다
  assert.equal(R.r7Convert(10000, 50, 20000, 0).kind, "NO_RENT_INCREASE");
  const a = R.r7Convert(24000, 50, 24000, 80);           // 보증금 유지 + 월 30 인상
  assert.equal(a.kind, "NET_ADD");
  assert.equal(a.add, 30);
  assert.equal(a.annual_rate_pct, 1.5);                  // 360 ÷ 24,000
  const b = R.r7Convert(24000, 50, 14000, 110);          // 감액 1억 + 월 60 인상 — 세린 ②와 같은 전환율
  assert.equal(b.kind, "CONVERT");
  assert.equal(b.annual_rate_pct, 7.2);
});

/* ── 코호트 키: 파이썬 빌드와 문자열까지 같아야 한다 ───────────────────────── */
t("면적 구간은 겹치지 않는 10㎡ 하한 구간", () => {
  assert.equal(R.band(50.6), "50-60");
  assert.equal(R.band(59.99), "50-60");
  assert.equal(R.band(60.0), "60-70");
  assert.equal(R.band(0), null);
  assert.equal(R.band(null), null);
});

t("폴백 사다리 — 유형별 최상위 단계", () => {
  const apt = { kind: "아파트", sgg: "11440", umd: "성산동", seq: "11440-2118", area: 50.6 };
  assert.deepEqual(R.keysFor(apt).map(([lv]) => lv), [1, 2, 3, 4, 5]);
  assert.equal(R.keysFor(apt)[0][1], "아파트|11440|성산동|11440-2118|50-60");
  // 연립다세대·단독다가구는 단지 단위 표본이 성립하지 않는다
  assert.deepEqual(R.keysFor({ ...apt, kind: "단독다가구", seq: "" }).map(([lv]) => lv), [3, 4, 5]);
  assert.deepEqual(R.keysFor({ ...apt, area: null }).map(([lv]) => lv), [2, 4, 5]);
});

t("폴백 사다리 — 어느 단계에서 몇 건이 나왔는지 전부 남긴다", () => {
  const key = { kind: "아파트", sgg: "11440", umd: "성산동", seq: "11440-2118", area: 50.6 };
  const cohorts = {
    "아파트|11440|성산동|11440-2118|50-60": { rr: [500, 500, 500], nr: [600] },  // 기록 없는 1건, 미달
    "아파트|11440|성산동|11440-2118|": { rr: [500, 500], nr: [600, 700, 800] },  // 3건, 통과
  };
  const w = R.widen(cohorts, key, 3, R.rateN);
  assert.equal(w.level, 2);
  assert.equal(w.widened, true);
  assert.deepEqual(w.trail.map((s) => s.n), [1, 3]);     // 합치면 1단계도 4건이라 넓히지 않았을 것이다
  assert.equal(w.trail[0].label, "단지·면적대");

  const none = R.widen({}, key, 3, R.rateN);
  assert.equal(none.rec, null);
  assert.equal(none.trail.length, 5);                    // 끝까지 내려가고 판정 불가로 끝낸다
});

t("R3 표본 수는 행사 기록이 없는 갱신만 센다", () => {
  assert.equal(R.rateN({ rr: [500, 900], nr: [-100, 700] }), 2);
  assert.equal(R.rateN({ rr: [500], nr: null }), 0);
});

/* ── 표시 포맷 (DR6) ───────────────────────────────────────────────────────── */
t("금액 표기", () => {
  assert.equal(R.fmtMoney(64800), "6억 4,800만원");
  assert.equal(R.fmtMoney(63000), "6억 3,000만원");
  assert.equal(R.fmtMoney(1800), "1,800만원");
  assert.equal(R.fmtMoney(10000), "1억원");   // 만원 자리가 없으면 "1억"이 아니라 "1억원"
  assert.equal(R.fmtMoney(90000), "9억원");
  assert.equal(R.fmtMoney(-6500), "-6,500만원");
  assert.equal(R.fmtMoney(null), "—");
  assert.equal(R.fmtPct(31.95), "31.95%");
  assert.equal(R.fmtPct(2.0, 1), "2.0%");
  assert.equal(R.fmtN(85691), "85,691");
  assert.equal(R.fmtN(undefined), "—");   // fmtMoney·fmtPct 와 같은 방어를 쓴다
  assert.equal(R.fmtN(NaN), "—");
});

/* ── 금액 입력 읽기 — 화면 결함 A2·A11 의 회귀 검사 ─────────────────────── */
t("금액 칸은 만원 단위 정수만 받는다", () => {
  assert.equal(R.intOf("60000"), 60000);
  assert.equal(R.intOf("60,000"), 60000);   // 천 단위 쉼표와 공백은 지운다
  assert.equal(R.intOf(" 60 000 "), 60000);
  assert.equal(R.intOf("-100"), -100);
  assert.equal(R.intOf(0), 0);

  // 소수를 받으면 정확히 +5.00% 인 계약이 "5% 초과"로 뒤집힌다
  assert.ok(Number.isNaN(R.intOf("60000.4")));
  assert.equal(R.r1Rate(60000, 63000).is_over_cap, false);
  assert.equal(R.r1Rate(60000, 63000.02).is_over_cap, true, "소수가 새면 여기서 뒤집힌다");

  // Number() 는 받아들이지만 사용자가 친 금액이 아니다
  assert.ok(Number.isNaN(R.intOf("1e5")));
  assert.ok(Number.isNaN(R.intOf("0x10")));
  assert.ok(Number.isNaN(R.intOf("")));
  assert.ok(Number.isNaN(R.intOf(null)));
  assert.ok(Number.isNaN(R.intOf("육만")));
});

/* ── 문장에서 금액 읽기 ─────────────────────────────────────────────────────
 * 합격 기준은 처리율이 아니라 **조용한 오수락 0건**이다. 아래 표의 모든 문장에 대해
 * 파서는 "정확한 값" 또는 "읽지 않음" 둘 중 하나여야 한다. 틀린 값을 내면 실패다.
 *
 * 읽지 않는 문장은 언어 모델(/api/parse)로 넘어가고 거기서 다시 범위 검사와
 * 신뢰도 게이트를 지난다. 읽지 않는 것은 비용이지만 되돌릴 수 있다. */
const PASTES = [
  // [문장, 기대 — null 이면 "읽지 않아야 한다"]
  ["전세 3억5천인데 3억8천으로 올려달라고 하시네요", { cur: 35000, next: 38000, rent: 0 }],
  ["보증금 3억에서 3억2천으로 올리고 싶다고 하시네요", { cur: 30000, next: 32000, rent: null }],
  ["3억5천 → 3억8천", { cur: 35000, next: 38000, rent: null }],
  ["전세 5억인데 5억5천으로 올려달래요", { cur: 50000, next: 55000, rent: 0 }],
  ["6억에서 6억4800만원으로", { cur: 60000, next: 64800, rent: null }],
  ["35,000만원에서 38,000만원으로 올려주세요", { cur: 35000, next: 38000, rent: null }],
  ["5천만에서 6천만으로", { cur: 5000, next: 6000, rent: null }],
  // 세린 — 보증금 유지 + 월세. 감액분 0이라 R7 이 순증으로 분기한다
  ["전세 2억4천에서 2억4천 유지하고 월세 60 받겠다고", { cur: 24000, next: 24000, rent: 60 }],
  ["전세 3억5천에서 3억8천으로. 월 60만원도 달라네요", { cur: 35000, next: 38000, rent: 60 }],
  // 날짜가 섞여도 "12월 20일"의 20을 월세로 읽지 않는다 (실측 회귀)
  ["12월 20일 만기인데 전세 3억5천에서 3억8천으로", { cur: 35000, next: 38000, rent: 0 }],

  // ── 아래는 전부 "읽지 않아야" 한다 ──
  ["3억8천으로 올려달래요. 지금은 3억5천입니다", null],   // 역순. 순서를 믿을 수 없다
  ["월세만 65로 올려달래요", null],                        // 보증금이 없다
  ["보증금 3억 유지하고 월세 60", null],                   // 보증금이 하나뿐 — 종전인지 제시인지 모른다
  ["작년에 3억이었는데 지금 3억5천에서 4억으로", null],     // 과거 계약이 섞였다
  ["관리비 포함 3억5천에서 3억8천", null],                 // 관리비가 섞였다
  ["구억육천만원에서 십억으로", null],                     // 한글 수사는 읽지 않는다
  ["만기가 2026년 12월 20일입니다", null],                 // 금액이 없다
  ["전세 3억5천에서 12억으로 올려달래요", null],           // +243% — 범위 밖
  ["500만원에서 600만원으로", null],                       // 보증금 하한 미만. 월세·관리비와 구분되지 않는다
  ["3억5천 3억8천", null],                                 // 방향 표시가 없다
  // 문법 밖 조각을 건너뛰면 조용히 틀린다 (2026-10-25 실측 회귀: 9억 → 9억, 9억7천2백 → 9억 7천)
  ["전세 9억인데 9억 7천2백으로 올려달래요", null],
  ["9억에서 9억7천2백으로", null],
  ["", null],
  [null, null],
];

t("붙여넣은 문장 — 정확히 읽거나, 읽지 않거나", () => {
  for (const [text, want] of PASTES) {
    const got = R.readAmounts(text);
    if (want === null) {
      assert.equal(got.ok, false, `읽지 않아야 하는데 읽었다: ${JSON.stringify(text)} → ${JSON.stringify(got)}`);
      assert.ok(["NO_AMOUNT", "AMBIGUOUS_ROLE", "UNSUPPORTED_SYNTAX", "OUT_OF_RANGE"].includes(got.reason),
        `사유가 목록에 없다: ${got.reason}`);
    } else {
      assert.deepEqual(got, { ok: true, ...want }, `잘못 읽었다: ${JSON.stringify(text)}`);
    }
  }
});

t("읽은 값은 판정 산술에 그대로 들어간다", () => {
  // 파서가 낸 값이 R1·R2 와 같은 단위·같은 정수여야 한다. 만원 정수 계약을 유지한다.
  const r = R.readAmounts("전세 6억인데 6억4800만원으로 올려달라고 하시네요");
  assert.deepEqual(r, { ok: true, cur: 60000, next: 64800, rent: 0 });
  assert.equal(R.r1Rate(r.cur, r.next).rate_pct, 8.0);
  assert.equal(R.r2Cap(r.cur, r.next).deposit, 63000);
  assert.equal(R.r2Cap(r.cur, r.next).excess, 1800);
  // 파서 출력도 intOf 와 같은 정수 계약 위에 있다
  for (const v of [r.cur, r.next, r.rent]) assert.ok(Number.isInteger(v));
});

/* ── 평가셋 라우팅 동결 (decisions/02-llm-model/criteria-v2.md §3 G6) ───────
 * readAmounts 가 한 줄 넓어지면 LLM 평가의 **분모가 조용히 바뀐다.** 골든셋 21건 중
 * 몇 건이 규칙으로 가는지를 여기에 못 박아, 문법을 바꾸면 평가 기준부터 깨지게 한다.
 * decisions/ 는 저장소 밖(gitignore)이라 없으면 건너뛴다 — 제품 검사가 리서치 자산에 묶이지 않는다. */
const goldenPath = new URL("../decisions/02-llm-model/golden.json", import.meta.url);
if (existsSync(goldenPath)) {
  tg("평가셋 라우팅이 동결값과 같다", () => {
    const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
    const vec = golden.map((c) => (R.readAmounts(c.text).ok ? "r" : "l")).join("");
    assert.equal(vec, "rllllrlrlllrrllllllrl",
      "규칙 문법이 바뀌어 평가셋 라우팅이 달라졌다 — criteria 버전을 올리고 전 후보를 다시 평가한다");
    for (const c of golden) {
      const got = R.readAmounts(c.text).ok ? "rule" : "llm";
      assert.equal(got, c.route, `${c.id}: route 가 ${c.route} 인데 실제로는 ${got}`);
      // 규칙 경로의 기대값은 규칙이 실제로 내는 값이어야 한다
      if (c.route === "rule") {
        const r = R.readAmounts(c.text);
        assert.equal(r.cur, c.want.cur_deposit_manwon, `${c.id}: 종전 보증금`);
        assert.equal(r.next, c.want.new_deposit_manwon, `${c.id}: 제시 보증금`);
        assert.equal(r.rent, c.want.new_monthly_manwon, `${c.id}: 제시 월세`);
        assert.equal(c.want.area_m2, null, `${c.id}: 규칙 경로는 면적을 읽지 않는다`);
      }
    }
  });

  tg("두 골든셋이 같은 문형에 다른 정답을 동결하지 않는다", () => {
    // 실측 사고: golden G06 은 월세 0, 이 파일의 PASTES 는 같은 문형에 null 을 기대했고
    // 둘 다 통과했다. 어느 쪽을 고쳐도 회귀 검사가 깨지지 않는 상태였다.
    const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
    const norm = (s) => String(s).replace(/[\s,·]/g, "");
    for (const c of golden.filter((x) => x.route === "rule")) {
      for (const [text, want] of PASTES) {
        if (want === null || !text) continue;
        if (norm(text) !== norm(c.text)) continue;
        assert.equal(want.rent, c.want.new_monthly_manwon,
          `같은 문장을 두 곳이 다르게 기대한다: ${c.id}`);
      }
    }
  });
}

t("면적 계약이 브라우저와 서버에서 같다", () => {
  // 같은 계약을 두 런타임에 따로 두었다(함수가 브라우저 판정 모듈을 import 할 이유가 없다).
  // 따로 둔 값은 언젠가 갈라진다 — 갈라지면 여기서 깨진다.
  const CASES = [10, 59.94, 84.9, 300, 0, 9.99, 300.01, -1, NaN, Infinity, null, undefined,
                 "84.9", "<img src=x onerror=BAD>", true, false, [84.9], { v: 84.9 }];
  for (const v of CASES)
    assert.equal(R.areaM2(v), serverAreaM2(v),
      `두 구현이 다르게 판단한다: ${JSON.stringify(v)} → 브라우저 ${R.areaM2(v)} / 서버 ${serverAreaM2(v)}`);
});

t("확인 줄의 면적 칸에 마크업이 들어갈 수 없다", () => {
  // 실측 결함(F-12): `${p.area_m2}㎡` 로 모델이 준 값을 그대로 innerHTML 에 넣고 있었다.
  // ① 화면 코드가 안전한 헬퍼를 지나는지 원문으로 확인한다.
  const app = readFileSync(new URL("../dist/assets/app.js", import.meta.url), "utf8");
  const cell = app.match(/\+ `, 전용면적 <b>\$\{([^}]*)\}<\/b>`/);
  assert.ok(cell, "확인 줄의 면적 칸을 찾지 못했다 — 표현이 바뀌었으면 이 검사도 같이 고친다");
  assert.ok(/R\.fmtArea\(p\.area_m2\)/.test(cell[1]),
    `면적 칸이 fmtArea 를 지나지 않는다: ${cell[1]}`);
  assert.ok(!/\bp\.area_m2\s*\}/.test(cell[1]), "면적 원값이 그대로 보간된다");

  // ② 그 헬퍼가 어떤 입력에도 마크업을 만들지 않는지 본다.
  for (const v of [84.9, 10, 300, null, undefined, 0, 3000, "84.9", true, [1],
                   "<img src=x onerror=BAD>", "</b><script>BAD</script><b>", { toString: () => "<b>x</b>" }]) {
    const out = R.fmtArea(v);
    assert.ok(out === null || /^[0-9]+(\.[0-9]+)?㎡$/.test(out),
      `면적 표시 문자열이 계약을 벗어난다: ${JSON.stringify(v)} → ${JSON.stringify(out)}`);
  }
  // ③ 값이 없을 때의 문구는 "그대로 둡니다" — 0 이나 지어낸 면적이 되지 않는다.
  assert.equal(R.fmtArea(null), null);
  assert.equal(R.areaM2(0), null, "0 이 면적으로 들어가면 band() 가 코호트를 바꾼다");
});

/* 문서가 이 건수를 적고 있다. 스스로 낡는 숫자는 검사로 묶거나 문서에서 뺀다. */
for (const f of ["docs/05-TEST.md", "README.md"])
  assert.ok(readFileSync(new URL(`../${f}`, import.meta.url), "utf8").includes(`${n}건`),
    `${f} 가 판정 산술 건수를 ${n}건으로 적고 있지 않다 — 검사를 늘렸으면 문서도 고친다`);

console.log(`rules ok — ${n}건` + (golden ? ` (+ 로컬 골든셋 ${golden}건)` : " (골든셋 없음: 동결 라우팅 검사 2건을 건너뜀)"));
