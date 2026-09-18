/* 판정 산술 7종 — docs/02-SPEC.md §3. 전부 순수 함수이고 외부 의존이 없다.
 *
 * 이 파일에 LLM 이 끼어들 자리는 없다. 같은 입력이면 항상 같은 출력이 나와야
 * 사용자가 화면의 숫자를 종이에 옮겨 검산할 수 있다.
 * 검증: node scripts/test_rules.mjs
 */

export const CAP_PCT = 5;
export const CAP_NUM = 21, CAP_DEN = 20;   // ×1.05 를 유리수로 다룬다
export const MIN_N_RATE = 3;               // 백분위 최소 표본 (02-SPEC §3.6)
export const MIN_N_MARKET = 5;             // 신규 시세 중앙값 최소 표본

/* ── 반올림 ────────────────────────────────────────────────────────────────
 * 사사오입으로 못 박는다. 파이썬 round 는 은행원 반올림이라 빌드와 브라우저가
 * 같은 데이터에서 다른 숫자를 낼 수 있다(scripts/build_assets.py pctile 과 한 쌍). */
const halfUp = (x, d) => {
  const m = 10 ** d, v = x * m;
  return (v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5)) / m;
};
export const round0 = (x) => halfUp(x, 0);
export const round1 = (x) => halfUp(x, 1);
export const round2 = (x) => halfUp(x, 2);

/** 최근접 순위법. vec 는 오름차순 정렬되어 있어야 한다. */
export function nearestRank(vec, p) {
  if (!vec.length) return null;
  const k = Math.floor(((vec.length - 1) * p) / 100 + 0.5);
  return vec[Math.min(k, vec.length - 1)];
}

/* ── 표시 포맷 (02-SPEC DR6) ─────────────────────────────────────────────── */

/** 만원 단위 정수를 사람이 읽는 금액으로. 1억 이상은 "N억 M,MMM만원". */
export function fmtMoney(manwon) {
  if (manwon == null || !isFinite(manwon)) return "—";
  const sign = manwon < 0 ? "-" : "";
  const v = Math.abs(round0(manwon));
  if (v >= 10000) {
    const eok = Math.floor(v / 10000), rest = v % 10000;
    return sign + eok.toLocaleString("ko-KR") + (rest ? `억 ${rest.toLocaleString("ko-KR")}만원` : "억원");
  }
  return sign + v.toLocaleString("ko-KR") + "만원";
}
export const fmtPct = (x, d = 2) => (x == null ? "—" : `${halfUp(x, d).toFixed(d)}%`);
export const fmtN = (n) => (n == null ? "—" : n.toLocaleString("ko-KR"));
export const fmtDate = (d) => `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;

/* ── 코호트 키 ─────────────────────────────────────────────────────────────
 * scripts/build_assets.py 의 band()/keys_for() 와 문자열까지 같아야 한다. */

export function band(area) {
  if (!area || area <= 0) return null;
  const lo = Math.floor(area / 10) * 10;
  return `${lo}-${lo + 10}`;
}

export const LEVELS = {
  1: "단지·면적대", 2: "단지 전체 면적", 3: "법정동·면적대",
  4: "법정동 전체", 5: "자치구 전체",
};
/** 단지 단위 표본이 성립하는 유형(02-SPEC §5.3-1). 나머지는 3단계부터 시작한다. */
const HAS_BUILDING_COHORT = new Set(["아파트", "오피스텔"]);

export function keysFor({ kind, sgg, umd, seq, area }) {
  const b = band(area), ks = [];
  if (HAS_BUILDING_COHORT.has(kind) && seq) {
    if (b) ks.push([1, `${kind}|${sgg}|${umd}|${seq}|${b}`]);
    ks.push([2, `${kind}|${sgg}|${umd}|${seq}|`]);
  }
  if (b) ks.push([3, `${kind}|${sgg}|${umd}||${b}`]);
  ks.push([4, `${kind}|${sgg}|${umd}||`]);
  ks.push([5, `${kind}|${sgg}|||`]);
  return ks;
}

/** 병합된 인상률 벡터(0.01%p 단위 정수, 오름차순). */
export const ratesOf = (rec) => [...(rec.rr || []), ...(rec.nr || [])].sort((a, b) => a - b);

/**
 * 폴백 사다리. 위 단계부터 내려가며 표본이 minN 이상인 첫 레코드를 쓴다.
 * 어느 단계에서 몇 건이 나왔는지 전부 남긴다 — 단계를 숨기면 데이터가 실제보다 정밀해 보인다.
 */
export function widen(cohorts, key, minN, count) {
  const trail = [];
  for (const [lv, k] of keysFor(key)) {
    const rec = cohorts[k];
    const n = rec ? count(rec) : 0;
    trail.push({ level: lv, label: LEVELS[lv], n });
    if (rec && n >= minN) return { rec, level: lv, widened: lv !== keysFor(key)[0][0], trail };
  }
  return { rec: null, level: null, widened: true, trail };
}

/* ── R1. 인상률 ────────────────────────────────────────────────────────────
 * 5% 동치·초과는 정수 비교로만 판정한다. 실수로 rate > 0.05 를 쓰면
 * 정확히 +5.00% 인 계약 일부가 초과로 잘못 분류되는데, 전세→전세 갱신의
 * 43% 가 정확히 +5.00% 라 그 오분류의 영향이 크다. */
export function r1Rate(prev, now, prevRent = 0, nowRent = 0) {
  if (prevRent > 0 || nowRent > 0) return { error: "E_RENT_TYPE_MIXED" };
  if (!(prev > 0)) return { error: "E-RATE-DIV0" };
  return {
    rate_pct: round2(((now - prev) / prev) * 100),
    is_exact_cap: CAP_DEN * (now - prev) === prev,
    is_over_cap: CAP_DEN * (now - prev) > prev,
  };
}

/* ── R2. 5% 상한 대비 초과 차액 ────────────────────────────────────────────
 * 상한액은 버림한다 — 사용자가 "더 내야 할 근거"로 쓰이지 않게.
 * 초과 차액은 버림값이 아니라 정확한 상한값 기준으로 계산한 뒤 반올림한다. */
export function r2Cap(prev, now) {
  const capExact = (prev * CAP_NUM) / CAP_DEN;
  const over = CAP_DEN * (now - prev) > prev;
  return {
    rate_pct: CAP_PCT,
    deposit: Math.floor((prev * CAP_NUM) / CAP_DEN),
    excess: over ? round0(now - capExact) : 0,
    over,
  };
}

/* ── R3. 코호트 백분위 ─────────────────────────────────────────────────────
 * "상위 X%" 는 나보다 크거나 같은 계약의 비율(동률 포함)이다.
 * 비교는 교차 곱으로 한다 — 벡터가 0.01%p 정수라 부동소수를 섞으면 동률이 깨진다.
 *
 * 5% 초과·동률 건수는 벡터에서 세지 않고 레코드의 ro/no/rt/nt 를 그대로 쓴다.
 * 벡터는 0.01%p 로 접혀 있어서 5.0026% 같은 계약이 정확히 5.00% 로 내려앉는다
 * (실측: 행사 기록 있는 갱신의 초과가 0.37% → 0.01% 로 바뀐다).
 * 빌드가 정수 비교로 센 값을 실어 보내야 R1 의 판정과 코호트가 같은 말을 한다. */
export function r3Percentile(rec, prev, now) {
  const vec = ratesOf(rec), n = vec.length;
  if (n < MIN_N_RATE) return { need_widen: true, n };
  const above = vec.filter((r) => r * prev >= (now - prev) * 10000).length;
  return {
    n,
    median_pct: nearestRank(vec, 50) / 100,
    p90_pct: nearestRank(vec, 90) / 100,
    top_share_pct: round1((above / n) * 100),
    tie_at_cap_n: (rec.rt || 0) + (rec.nt || 0),
    over_cap_n: (rec.ro || 0) + (rec.no || 0),
    recorded: rec.rr ? { n: rec.rr.length, over_cap_n: rec.ro || 0 } : null,
    unrecorded: rec.nr ? { n: rec.nr.length, over_cap_n: rec.no || 0 } : null,
  };
}

/* ── R4. 행사 기록 유무별 분포 비교 ────────────────────────────────────────
 * 코호트 표본과 무관하게 서울 전체 앵커 상수를 쓴다. */
export function r4Groups(anchors, isOverCap) {
  const a = anchors;
  return {
    scope: a.scope,
    total_n: a.total_n,
    recorded: { n: a.recorded.n, over_cap_share_pct: a.recorded.over5 },
    unrecorded: {
      n: a.unrecorded.n,
      over_cap_share_pct: a.unrecorded.over5,
      excess_median: a.excess_median,
    },
    mine_over_cap: isOverCap,
  };
}

/* ── R5. 신규 시세 대비 차액 ───────────────────────────────────────────────
 * gap 이 양수면 내가 시세보다 싸다. 이 차액에는 이사비·중개보수·대출 조건이
 * 들어 있지 않고, 그 값에 실제 매물이 있는지도 이 데이터는 답하지 않는다. */
export function r5Market(newMedian, newN, myDeposit) {
  if (!newMedian || newN < MIN_N_MARKET) return null;
  const gap = round0(newMedian - myDeposit);
  return { n: newN, new_median: newMedian, gap, gap_pct: round1((gap / newMedian) * 100) };
}

/* ── R6. 법정 기한 타임라인 ────────────────────────────────────────────────
 * 개월 단위 계산이 정답이고 D-180/D-60 표기는 보조다. 말일은 그 달의 마지막 날로 맞춘다. */
export const daysInMonth = (y, m) => new Date(y, m, 0).getDate();   // m 은 1-12

export function minusMonths(d, m) {
  let y = d.getFullYear(), mo = d.getMonth() + 1 - m;
  while (mo <= 0) { mo += 12; y -= 1; }
  return new Date(y, mo - 1, Math.min(d.getDate(), daysInMonth(y, mo)));
}

const DAY = 86400000;
const dayDiff = (a, b) =>
  Math.round((Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()) -
              Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())) / DAY);

export function r6Window(expiry, today, signed = null) {
  const start = minusMonths(expiry, 6);
  let deadline = minusMonths(expiry, 2), note = null;
  if (signed && signed < new Date(2020, 11, 10)) {
    const alt = minusMonths(expiry, 1);          // 2020-12-10 이전 체결분의 옛 기준
    note = { alt_deadline: alt, text: "기준이 다를 수 있어 두 날짜를 모두 표시합니다" };
    if (alt < deadline) deadline = alt;           // 보수적으로 이른 날짜를 마감으로 안내한다
  }
  const d_day = dayDiff(deadline, today);
  const stage = d_day < 0 ? "PASSED" : d_day === 0 ? "TODAY"
    : d_day <= 1 ? "D1" : d_day <= 3 ? "D3"
    : d_day <= 7 ? "D7" : d_day <= 14 ? "D14" : "OPEN";
  return { start, deadline, d_day, stage, basis: "months", note };
}

/* ── R7. 환산 (월세가 섞이는 조건) ─────────────────────────────────────────
 * 감액분이 0이면 전환이 아니라 순증이다. 분모 0으로 전환율을 만들지 않는다.
 * 법정 전월세전환율 비교는 구현하지 않는다 — 기준금리 데이터가 없다. */
export function r7Convert(prevDeposit, offerDeposit, offerRent) {
  if (!offerRent) return null;                       // 월세 없음 → R1 경로
  const cut = prevDeposit - offerDeposit, annual = offerRent * 12;
  if (cut === 0)
    return { kind: "NET_ADD", annual_rate_pct: round2((annual / prevDeposit) * 100),
             compare_to_distribution: false };
  if (cut < 0)
    return { kind: "BOTH_UP", annual_rate_pct: null, compare_to_distribution: false };
  return { kind: "CONVERT", annual_rate_pct: round2((annual / cut) * 100),
           compare_to_distribution: true, cut };
}

/** 서울 전세→월세 갱신 역산 분포 (n=600). 세 분포 중 표본이 가장 얇다. */
export const CONVERT_DIST = { n: 600, p25: 5.17, p50: 6.27, p75: 9.44 };
