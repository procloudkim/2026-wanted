/* 판정 산술 검증. 네트워크·키 없이 돈다.  실행: node scripts/test_rules.mjs
 * 기대값은 docs/02-SPEC.md §3 의 검증 표를 그대로 옮긴 것이다. 표가 바뀌면 여기가 먼저 깨져야 한다. */
import assert from "node:assert/strict";
import * as R from "../dist/assets/rules.js";

const D = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
let n = 0;
const t = (name, fn) => { fn(); n++; };

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
  for (const prev of [10000, 33333, 61368, 7]) {
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
t("R3 — 상위 X%는 동률을 포함한다", () => {
  const rec = { rr: [0, 500, 500], nr: [500, 800, 2000], rt: 2, nt: 1, ro: 0, no: 2 };
  const r = R.r3Percentile(rec, 10000, 10500);          // 내 인상률 = 정확히 5.00%
  assert.equal(r.n, 6);
  // 나보다 크거나 같은 것: 500×3 + 800 + 2000 = 5건 → 83.3%
  assert.equal(r.top_share_pct, 83.3);
  assert.equal(r.median_pct, 5.0);
  assert.equal(r.p90_pct, 20.0);
});

t("R3 — 5% 초과·동률은 벡터가 아니라 레코드의 정수 비교 결과를 쓴다", () => {
  // 벡터에는 500 이 3건 있지만 그중 1건은 실제로 5.0026% 다(빌드가 정수 비교로 세어 no=1).
  // 벡터에서 세면 초과 0건이 되어, R1 이 "초과"라고 판정한 계약이 분포에서 사라진다.
  const rec = { rr: [500, 500], nr: [500, 900], rt: 2, nt: 0, ro: 0, no: 2 };
  const r = R.r3Percentile(rec, 10000, 10500);
  assert.equal(r.tie_at_cap_n, 2);                      // 벡터의 500 은 3건이지만 동률은 2건
  assert.equal(r.over_cap_n, 2);
  assert.deepEqual(r.recorded, { n: 2, over_cap_n: 0 });
  assert.deepEqual(r.unrecorded, { n: 2, over_cap_n: 2 });
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
  const r = R.r3Percentile({ rr: [500], nr: [600] }, 10000, 10500);
  assert.equal(r.need_widen, true);
  assert.equal(r.n, 2);
});

/* ── R5 이탈 차액 ──────────────────────────────────────────────────────────── */
t("R5 — 표본 5건 미만이면 카드를 만들지 않는다", () => {
  assert.equal(R.r5Market(71000, 4, 64800), null);
  assert.equal(R.r5Market(null, 12, 64800), null);
  const m = R.r5Market(71000, 12, 64800);
  assert.equal(m.gap, 6200);
  assert.equal(m.gap_pct, 8.7);
});

/* ── R6 법정 기한 (02-SPEC §3.7 검증 표 그대로) ────────────────────────────── */
t("R6 — 개월 계산과 말일 보정", () => {
  const cases = [
    ["2026-12-20", "2026-06-20", "2026-10-20"],   // D-60 표기(10-21)와 하루 어긋난다
    ["2027-01-15", "2026-07-15", "2026-11-15"],
    ["2026-11-30", "2026-05-30", "2026-09-30"],
    ["2026-12-31", "2026-06-30", "2026-10-31"],   // 6월은 31일이 없다
    ["2026-04-30", "2025-10-30", "2026-02-28"],   // 2월 말일 보정
  ];
  for (const [exp, start, dl] of cases) {
    const w = R.r6Window(D(exp), D("2026-09-18"));
    assert.equal(iso(w.start), start, exp);
    assert.equal(iso(w.deadline), dl, exp);
  }
});

t("R6 — 남은 일수와 경고 단계", () => {
  const w = R.r6Window(D("2026-12-20"), D("2026-09-18"));
  assert.equal(w.d_day, 32);
  assert.equal(w.stage, "OPEN");
  assert.equal(R.r6Window(D("2026-12-20"), D("2026-10-20")).stage, "TODAY");
  assert.equal(R.r6Window(D("2026-12-20"), D("2026-10-19")).stage, "D1");
  assert.equal(R.r6Window(D("2026-12-20"), D("2026-10-17")).stage, "D3");
  assert.equal(R.r6Window(D("2026-12-20"), D("2026-10-21")).stage, "PASSED");
  assert.equal(R.r6Window(D("2026-12-20"), D("2026-10-21")).d_day, -1);
});

t("R6 — 2020-12-10 이전 체결분은 이른 날짜를 마감으로 안내한다", () => {
  const w = R.r6Window(D("2026-12-20"), D("2026-09-18"), D("2020-06-01"));
  assert.equal(iso(w.deadline), "2026-10-20");           // 2개월 기준이 더 이르다
  assert.equal(iso(w.note.alt_deadline), "2026-11-20");
  assert.equal(R.r6Window(D("2026-12-20"), D("2026-09-18"), D("2021-01-01")).note, null);
});

/* ── R7 환산 ───────────────────────────────────────────────────────────────── */
t("R7 — 세린의 두 조건", () => {
  const a = R.r7Convert(24000, 24000, 60);               // 보증금 유지 + 월 60
  assert.equal(a.kind, "NET_ADD");
  assert.equal(a.annual_rate_pct, 3.0);
  assert.equal(a.compare_to_distribution, false);        // 분포와 비교하지 않는다

  const b = R.r7Convert(24000, 14000, 60);               // 감액 1억 + 월 60
  assert.equal(b.kind, "CONVERT");
  assert.equal(b.annual_rate_pct, 7.2);
  assert.equal(b.compare_to_distribution, true);
  assert.ok(b.annual_rate_pct > R.CONVERT_DIST.p50 && b.annual_rate_pct < R.CONVERT_DIST.p75);
});

t("R7 — 보증금과 월세가 둘 다 오르면 전환율을 내지 않는다", () => {
  assert.equal(R.r7Convert(24000, 26000, 60).kind, "BOTH_UP");
  assert.equal(R.r7Convert(24000, 26000, 60).annual_rate_pct, null);
  assert.equal(R.r7Convert(24000, 14000, 0), null);
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
    "아파트|11440|성산동|11440-2118|50-60": { rr: [500], nr: [600] },       // 2건, 미달
    "아파트|11440|성산동|11440-2118|": { rr: [500, 500], nr: [600, 700] },  // 4건, 통과
  };
  const w = R.widen(cohorts, key, 3, (r) => R.ratesOf(r).length);
  assert.equal(w.level, 2);
  assert.equal(w.widened, true);
  assert.deepEqual(w.trail.map((s) => s.n), [2, 4]);
  assert.equal(w.trail[0].label, "단지·면적대");

  const none = R.widen({}, key, 3, (r) => R.ratesOf(r).length);
  assert.equal(none.rec, null);
  assert.equal(none.trail.length, 5);                    // 끝까지 내려가고 판정 불가로 끝낸다
});

t("인상률 벡터 병합은 정렬을 유지한다", () => {
  assert.deepEqual(R.ratesOf({ rr: [500, 900], nr: [-100, 700] }), [-100, 500, 700, 900]);
  assert.deepEqual(R.ratesOf({ rr: null, nr: [500] }), [500]);
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
  assert.equal(R.fmtPct(34.47), "34.47%");
  assert.equal(R.fmtPct(2.0, 1), "2.0%");
  assert.equal(R.fmtN(61368), "61,368");
});

console.log(`rules ok — ${n}건`);
