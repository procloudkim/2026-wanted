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
/** 면적 계약. `functions/api/_llm.js` 의 areaM2 와 **같은 값이어야 한다**
 *  — `scripts/test_rules.mjs` 가 두 구현이 어긋나지 않는지 대조한다.
 *  숫자가 아니면 null 이다. 이 값을 거치지 않은 면적은 화면에도 입력 칸에도 넣지 않는다. */
export const areaM2 = (v) =>
  (typeof v === "number" && Number.isFinite(v) && v >= 10 && v <= 300 ? v : null);
/** 확인 줄에 넣을 면적 문자열. 계약을 통과한 **숫자만** 문자열이 되므로 마크업이 생길 수 없다. */
export const fmtArea = (v) => { const a = areaM2(v); return a == null ? null : `${a}㎡`; };
export const fmtPct = (x, d = 2) => (x == null ? "—" : `${halfUp(x, d).toFixed(d)}%`);
export const fmtN = (n) => (n == null || !isFinite(n) ? "—" : Number(n).toLocaleString("ko-KR"));
export const fmtDate = (d) => `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;

/* ── 금액 입력 읽기 ────────────────────────────────────────────────────────
 * 금액 칸은 만원 단위 정수다. 표기를 좁히지 않으면 두 가지가 샌다.
 *  1) 소수(60000.4) — 정확히 +5.00% 인 계약이 정수 교차 곱 비교에서 초과로 뒤집힌다.
 *  2) 1e5 · 0x10 — Number() 는 받아들이지만 사용자가 친 금액이 아니다. */
export const intOf = (v) => {
  const s = String(v ?? "").replace(/[,\s]/g, "");
  return /^-?\d+$/.test(s) ? Number(s) : NaN;
};

/* ── 문장에서 금액 읽기 ────────────────────────────────────────────────────
 * Why: "전세 3억5천인데 3억8천으로" 같은 정형 문장은 산술로 읽힌다. 이런 문장까지
 * 언어 모델에 보내면 네트워크·키·비결정성이 붙고 **원문이 브라우저 밖으로 나간다.**
 * 읽을 수 있으면 여기서 읽고, 애매하면 읽지 않는다 — 읽지 않는 것은 언어 모델로
 * 넘어갈 뿐이지만, 틀린 값을 조용히 채우는 것은 되돌릴 수 없다.
 *
 * 그래서 이 파서의 성공 기준은 처리율이 아니라 **조용한 오수락 0건**이다.
 * 문법을 일부러 좁게 둔다 — 보증금 두 개와 전세/월세 표시가 전부다.
 *
 * ponytail: 한글 수사("구억육천")는 읽지 않는다. 언어 모델이 자릿수를 틀렸던 바로 그
 * 표기라 결정론으로 읽을 값어치가 있지만, 문법이 두 배가 된다. 넓히려면 AMOUNT 에
 * 토큰을 더하고 golden 에 기대값을 먼저 적는다. */

/** 보증금 후보의 하한(만원). 이보다 작으면 월세·관리비와 구분되지 않아 읽지 않는다. */
const DEPOSIT_FLOOR = 1000;

/* 읽지 않는 문장. 이 낱말이 있으면 금액이 어느 계약의 것인지 문장만으로 정해지지 않는다. */
const NOT_OURS = /관리비|주차|중개|복비|작년|재작년/;

/* "3억5천" "3억 5000" "6억" "5천만" "35000만" — 단위가 붙은 것만 금액으로 본다.
 * 단위 없는 맨숫자를 금액으로 읽으면 "2026년"이 2026만원이 된다. */
const AMOUNT = /(\d+)억(?:(\d+)(천|백|십)?만?)?|(\d+)천만|(\d+)만/g;
const SCALE = { 천: 1000, 백: 100, 십: 10 };

/* 월세는 "월세 60"처럼 단위 없이 오는 것이 흔하다. 다만 맨 "월"에 붙은 숫자까지 월세로 읽으면
 * "12월 20일"의 20이 월세가 된다 — 실제로 그렇게 읽혔다. "월"은 만 단위가 붙은 것만 본다. */
const RENT = /월세\s*(\d+)\s*만?\s*원?|월\s*(\d+)\s*만\s*원?/;

/* 두 금액 사이에 "어디서 어디로"를 말하는 표시가 있어야 종전→제시로 읽는다.
 * 없으면 순서를 믿을 수 없다 — "3억8천으로 올려달래요. 지금은 3억5천입니다"가 뒤집힌다. */
const DIRECTION = /에서|인데|이었는데|이고|부터|→|->/;

const amountsIn = (t) => {
  const out = [];
  AMOUNT.lastIndex = 0;
  for (let m; (m = AMOUNT.exec(t));) {
    const [, eok, rest, unit, cheonman, man] = m;
    const v = eok ? Number(eok) * 10000 + (rest ? Number(rest) * (SCALE[unit] || 1) : 0)
      : cheonman ? Number(cheonman) * 1000 : Number(man);
    out.push({ v, start: m.index, end: m.index + m[0].length });
  }
  return out;
};

/**
 * 문장 → 금액. 확실할 때만 값을 낸다.
 * @returns {{ok: true, cur: number, next: number, rent: number|null}
 *          | {ok: false, reason: "NO_AMOUNT"|"AMBIGUOUS_ROLE"|"UNSUPPORTED_SYNTAX"|"OUT_OF_RANGE"}}
 */
export function readAmounts(text) {
  const t = String(text ?? "").replace(/(\d),(?=\d{3})/g, "$1");
  if (NOT_OURS.test(t)) return { ok: false, reason: "UNSUPPORTED_SYNTAX" };

  // 월세를 먼저 떼어 낸다. 떼지 않으면 보증금 후보로 다시 세어진다.
  const rm = t.match(RENT);
  const rent = rm ? Number(rm[1] ?? rm[2]) : (/전세/.test(t) ? 0 : null);
  const body = rm ? t.slice(0, rm.index) + " " + t.slice(rm.index + rm[0].length) : t;

  const found = amountsIn(body);
  if (!found.length) return { ok: false, reason: "NO_AMOUNT" };
  // 읽은 금액 말고 금액 조각이 남아 있으면 읽지 않는다. "9억 7천2백"의 "7천2백"처럼 문법 밖 표기를
  // 건너뛰면 9억으로 조용히 틀린다(2026-10-25 실측, 붙여 쓴 "9억7천2백"은 9억 7천이 됐다).
  if (/\d\s*(?:억|천|백|십|만)/.test(body.replace(AMOUNT, " "))) return { ok: false, reason: "UNSUPPORTED_SYNTAX" };
  if (found.some((a) => a.v < DEPOSIT_FLOOR)) return { ok: false, reason: "UNSUPPORTED_SYNTAX" };

  // 보증금이 정확히 둘일 때만 "종전 → 제시"로 읽는다. 하나뿐이면 어느 쪽인지 문장이 말하지 않는다.
  if (found.length !== 2) return { ok: false, reason: found.length === 1 ? "AMBIGUOUS_ROLE" : "UNSUPPORTED_SYNTAX" };
  if (!DIRECTION.test(body.slice(found[0].end, found[1].start)))
    return { ok: false, reason: "AMBIGUOUS_ROLE" };

  const cur = found[0].v, next = found[1].v;
  // 서버 검증층(rangeCheck)과 같은 경계다. 규칙 경로라고 방어선을 건너뛰지 않는다.
  const bad = (v) => !(v >= 1 && v <= 500000);
  if (bad(cur) || bad(next)) return { ok: false, reason: "OUT_OF_RANGE" };
  if (rent != null && !(rent >= 0 && rent <= 1000)) return { ok: false, reason: "OUT_OF_RANGE" };
  const rate = ((next - cur) / cur) * 100;
  if (rate < -50 || rate > 200) return { ok: false, reason: "OUT_OF_RANGE" };

  return { ok: true, cur, next, rent };
}

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
/* 단지 단위 표본이 성립하는 유형(02-SPEC §5.3-1). 나머지는 3단계부터 시작한다.
 * 아파트만인 이유는 원천이다 — 실측 596,178행에서 단지 일련번호(aptSeq)는 아파트만 100% 오고
 * 오피스텔·연립다세대·단독다가구는 100% 비어 있다. 단지명이 와도 일련번호가 없으면
 * 같은 이름을 같은 건물로 묶을 근거가 없다(dist/data/anchors.json 의 fill.by_kind.seq_missing_pct). */
const HAS_BUILDING_COHORT = new Set(["아파트"]);

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

/** R3 의 표본 수 — 행사 기록이 없는 갱신만 센다. 폴백 사다리도 이 건수로 탄다(r3Percentile 과 한 쌍). */
export const rateN = (rec) => (rec.nr || []).length;

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
 * * 정확히 +5.00% 인 계약 일부가 초과로 잘못 분류되는데, 전세→전세 갱신의
 * 26.51% 가 정확히 +5.00% 라 그 오분류의 영향이 크다(anchors.exactly5_pct). */
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
 * "상위 X%" 는 **행사 기록이 없는 갱신**(rec.nr) 안에서 나보다 크거나 같은 계약의 비율(동률 포함)이다.
 * 행사 기록이 있는 갱신(rec.rr)은 섞지 않는다. 5% 상한이 걸린 계약이라 섞으면 제시안이 실제보다
 * 드물어 보인다 — 대치동 전용 80-90㎡ 의 +8% 가 합치면 316건 중 상위 16.8%, 행사 기록 없는 111건
 * 안에서는 47.7% 였다(2026-10-25 검토). 권리를 쓸 수 있는 사람에게는 상한 5% 가 답이고,
 * 쓸 수 없는 사람이 견줄 대상은 행사 기록이 없는 쪽이다.
 * 비교는 교차 곱으로 한다 — 벡터가 0.01%p 정수라 부동소수를 섞으면 동률이 깨진다.
 *
 * 5% 초과·동률 건수는 벡터에서 세지 않고 레코드의 ro/no/rt/nt 를 그대로 쓴다.
 * 벡터는 0.01%p 로 접혀 있어서 5.0026% 같은 계약이 정확히 5.00% 로 내려앉는다
 * (실측: 행사 기록 있는 갱신의 초과가 0.37% → 0.01% 로 바뀐다).
 * 빌드가 정수 비교로 센 값을 실어 보내야 R1 의 판정과 코호트가 같은 말을 한다. */
export function r3Percentile(rec, prev, now) {
  const vec = rec.nr || [], n = rateN(rec);
  if (n < MIN_N_RATE) return { need_widen: true, n };
  const above = vec.filter((r) => r * prev >= (now - prev) * 10000).length;
  const rr = (rec.rr || []).length;
  return {
    n,
    median_pct: nearestRank(vec, 50) / 100,
    p90_pct: nearestRank(vec, 90) / 100,
    top_share_pct: round1((above / n) * 100),
    tie_at_cap_n: rec.nt || 0,
    over_cap_n: rec.no || 0,
    // 비교에서 뺀 쪽. 왜 뺐는지 화면에 적으려고 같은 범위의 건수와 5% 이하 비율만 싣는다.
    recorded: rr ? { n: rr, within_cap_pct: round1(((rr - (rec.ro || 0)) / rr) * 100) } : null,
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

/* ── R2-1. 자릿수 사고 탐지 ────────────────────────────────────────────────
 * Why: 금액이 10배 틀려도 종전과 제시가 같은 배율이면 인상률이 정상이라 어떤 비율 검사도
 * 통과한다(실측: 어떤 모델은 "2억4천"을 24억으로 읽으면서 confidence 1.0 을 냈다).
 * 잡으려면 **바깥 기준**이 필요하고, 그 기준이 코호트의 신규 전세 보증금 중앙값이다.
 *
 * 이것은 LLM 방어가 아니라 판정 경로의 가드다. 사용자가 0을 하나 더 치는 것도 같은 오류다.
 * 이상치를 버리는 것이 아니라 되묻는 것이다 — 진짜로 분포 밖인 계약이 존재한다. */
export const DEPOSIT_FACTOR = 3;   // 중앙값의 1/3 ~ 3배 밖이면 되묻는다

export function depositLooksOff(deposit, cohortMedian) {
  if (!(deposit > 0) || !(cohortMedian > 0)) return null;   // 기준이 없으면 판정하지 않는다
  const ratio = deposit / cohortMedian;
  if (ratio > DEPOSIT_FACTOR) return { kind: "HIGH", ratio: round1(ratio), median: cohortMedian };
  if (ratio < 1 / DEPOSIT_FACTOR) return { kind: "LOW", ratio: round1(ratio), median: cohortMedian };
  return null;
}

/* ── R6. 법정 기한 타임라인 ────────────────────────────────────────────────
 * 개월 단위 계산이 정답이고 D-180/D-60 표기는 보조다. 말일은 그 달의 마지막 날로 맞춘다.
 *
 * 마감은 대응일이 아니라 **그 전날**이다. "2개월 전까지"는 대응일 0시 전까지라서 대응일 당일에
 * 도달하면 이미 늦다. 기대값은 바깥 해석에서 가져왔다(확인 2026-10-25, scripts/test_rules.mjs R6):
 * 서울시 마을변호사 "만료일 9월 30일 → 1개월 전인 8월 29일까지 도달", 국토부 인용 보도
 * "만기 1월 9일 → 12월 9일 0시 전까지". 판례는 찾지 못했다. 되돌릴 수 없는 기한이라 이른 쪽으로 안내한다.
 * 예전 구현은 대응일을 마감으로 냈고, 검증 표도 같은 사람이 써서 하루 늦은 마감이 통과했다. */
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

const dayBefore = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);

export function r6Window(expiry, today, signed = null) {
  const start = minusMonths(expiry, 6);           // 창은 대응일 0시에 열린다
  let deadline = dayBefore(minusMonths(expiry, 2)), note = null;
  if (signed && signed < new Date(2020, 11, 10)) {
    const alt = dayBefore(minusMonths(expiry, 1));   // 2020-12-10 이전 체결분의 옛 기준
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

/* 전세→월세 갱신 역산 분포는 상수로 두지 않는다. 다른 두 분포와 같은 빌드에서 나와야
 * 기준일·모수가 어긋나지 않는다 — dist/data/anchors.json 의 convert 를 그대로 읽는다. */
