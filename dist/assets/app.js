/* 갱신 기준선 — 화면. 판정 산술은 rules.js 가 하고 여기서는 읽고 그린다.
 * 판정 경로에 네트워크가 없다. 정적 자산을 받은 뒤로는 전부 브라우저 안에서 끝난다. */
import * as R from "./rules.js?v=2";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const parseDate = (s) => { if (!s) return null; const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const intOf = (v) => { const n = Number(String(v ?? "").replace(/[,\s]/g, "")); return Number.isFinite(n) ? n : NaN; };

const STORE = "gaengsin-input-v1";
const S = { index: null, anchors: null, shard: null, v: null, choice: null,
            snapshotFailed: false, amountConfirmed: false };

/* ── 부팅 ──────────────────────────────────────────────────────────────── */
async function boot() {
  try {
    const [index, anchors] = await Promise.all([
      fetch("data/index.json").then((r) => r.json()),
      fetch("data/anchors.json").then((r) => r.json()),
    ]);
    S.index = index; S.anchors = anchors;
    $("#asof").textContent = anchors.asof;
    $("#f-asof").textContent = anchors.asof;
    $("#a-rec-over").textContent = R.fmtPct(anchors.recorded.over5);
    $("#a-rec-n").textContent = `${R.fmtN(anchors.recorded.n)}건 중 5% 초과`;
    $("#a-unrec-over").textContent = R.fmtPct(anchors.unrecorded.over5);
    $("#a-unrec-n").textContent = `${R.fmtN(anchors.unrecorded.n)}건 중 5% 초과`;
    $("#a-excess").textContent = R.fmtMoney(anchors.excess_median);
    $("#anchor-scope").textContent =
      `모수 — ${anchors.scope}, ${R.fmtN(anchors.total_n)}건. 출처 ${anchors.source}. ${anchors.note}`;
    const gu = $("#gu");
    for (const g of index.gu) gu.add(new Option(g.nm, g.sgg), gu.options.length - 1);
  } catch (e) {
    // M-03: 스냅샷을 읽지 못해도 입력만으로 되는 산술은 계속 동작해야 한다
    S.snapshotFailed = true;
    $("#asof-bar").textContent = "데이터를 읽지 못했습니다 — 산술 전용 모드";
  }
  restore();
  wire();
}

/* ── 자치구 샤드 ───────────────────────────────────────────────────────── */
async function loadShard(sgg) {
  if (!sgg || sgg === "OUT") { S.shard = null; return; }
  if (S.shard?.sgg === sgg) return;
  try {
    S.shard = await fetch(`data/cohort/${sgg}.json`).then((r) => r.json());
  } catch { S.shard = null; S.snapshotFailed = true; }
  fillDong();
}

function fillDong() {
  const dong = $("#dong"), kind = $("#kind").value;
  dong.innerHTML = "";
  if (!S.shard) { dong.disabled = true; dong.add(new Option("자치구를 먼저 고르세요", "")); return; }
  dong.disabled = false;
  dong.add(new Option("선택하세요", ""));
  for (const u of S.shard.umds) dong.add(new Option(u, u));
  fillBuildings();
  $("#kind-help").textContent = R.keysFor({ kind, sgg: "x", umd: "x", seq: "x", area: 60 })[0][0] === 1
    ? "같은 단지·같은 면적대끼리 비교합니다."
    : "이 유형은 원천에 단지 표본이 얇아 같은 동네·비슷한 면적 기준으로 비교합니다.";
}

function fillBuildings() {
  const list = $("#bldg-list"), umd = $("#dong").value, kind = $("#kind").value;
  list.innerHTML = "";
  const usesBuilding = kind === "아파트" || kind === "오피스텔";
  $("#bldg-field").hidden = !usesBuilding;
  if (!S.shard || !usesBuilding) return;
  // datalist 는 select 가 아니라서 .add() 가 없다. 법정동을 고르기 전에는 목록이 길어 상한을 둔다.
  const pool = S.shard.buildings.filter((b) => b.kind === kind && (!umd || b.umd === umd));
  for (const b of pool.slice(0, umd ? pool.length : 500)) list.append(new Option(b.umd, b.nm));
}

const normName = (s) => String(s || "").replace(/\s|아파트|\(.*?\)/g, "").toLowerCase();

function findBuilding(name, umd, kind) {
  if (!S.shard) return { seq: null, candidates: [] };
  const pool = S.shard.buildings.filter((b) => b.kind === kind && (!umd || b.umd === umd));
  const n = normName(name);
  const exact = pool.find((b) => normName(b.nm) === n);
  if (exact) return { seq: exact.seq, nm: exact.nm, candidates: [] };
  const near = pool.filter((b) => normName(b.nm).includes(n) || n.includes(normName(b.nm))).slice(0, 3);
  return { seq: null, candidates: near };
}

/* ── 입력 읽기와 검증 (02-SPEC §2) ─────────────────────────────────────── */
function showErr(id, msg) {
  const e = $(`#${id}-err`), f = $(`#${id}`);
  if (!e) return;
  e.hidden = !msg; e.textContent = msg || "";
  if (f) f.setAttribute("aria-invalid", msg ? "true" : "false");
}

function readInput() {
  const errs = [];
  const kind = $("#kind").value, gu = $("#gu").value, umd = $("#dong").value;
  const area = Number($("#area").value);
  const expiry = parseDate($("#expiry").value);
  const dep = intOf($("#dep").value), rent = intOf($("#rent").value || 0);
  const tab = $(".tabs button[aria-selected=true]").dataset.tab;

  for (const id of ["gu", "dong", "area", "expiry", "dep", "rent", "bldg", "offer"]) showErr(id, "");

  if (!gu) errs.push(["gu", "자치구를 선택해 주세요. 목록에 없는 지역이면 '서울 밖'을 고르세요 — 분포 숫자 없이 기한 계산과 문안 기능만 제공합니다."]);
  if (gu && gu !== "OUT" && !umd) errs.push(["dong", "법정동을 선택해 주세요."]);
  if (!(area >= 10 && area <= 300))
    errs.push(["area", area > 0 && area < 10
      ? "전용면적을 ㎡로 넣어 주세요(예: 59.94). 평으로 넣으신 것 같습니다 — 1평은 약 3.3㎡입니다."
      : "전용면적을 10㎡에서 300㎡ 사이로 넣어 주세요."]);
  if (!expiry) errs.push(["expiry", "계약 만기일을 넣어 주세요."]);
  else {
    const diff = (expiry - today()) / 86400000;
    if (diff < -365 || diff > 1095)
      errs.push(["expiry", "만기일을 다시 확인해 주세요. 오늘 기준 1년 전부터 3년 뒤까지만 계산합니다."]);
  }
  if (!(dep >= 1 && dep <= 500000))
    errs.push(["dep", "현재 보증금을 만원 단위로 넣어 주세요(예: 6억원 → 60000). 보증금이 0이면 인상률을 계산할 수 없습니다."]);
  if (!(rent >= 0 && rent <= 1000)) errs.push(["rent", "월세를 만원 단위로 넣어 주세요(전세면 0)."]);

  // 제시 조건 — 세 경로 모두 {제시 보증금, 제시 월세} 한 쌍으로 귀결된다
  let odep = NaN, orent = 0;
  if (tab === "rate") {
    const p = Number($("#orate").value);
    if (!(p >= -50 && p <= 100)) errs.push(["offer", "인상률은 −50%에서 100% 사이로 넣어 주세요."]);
    else { odep = R.round0(dep * (1 + p / 100)); orent = intOf($("#orent").value || 0) || 0; }
  } else {
    odep = intOf($("#odep").value); orent = intOf($("#orent").value || 0);
  }
  if (!(odep >= 0 && odep <= 500000) || !(orent >= 0 && orent <= 1000) || (!odep && !orent))
    errs.push(["offer", "제시받은 보증금과 월세를 넣어 주세요. 둘 다 0일 수는 없습니다."]);

  let seq = null, candidates = [], bldgName = $("#bldg").value.trim();
  if (gu !== "OUT" && (kind === "아파트" || kind === "오피스텔") && bldgName) {
    const f = findBuilding(bldgName, umd, kind);
    seq = f.seq; candidates = f.candidates;
    if (!seq) errs.push(["bldg", "입력하신 건물명을 데이터에서 찾지 못했습니다. 아래 후보 중에서 고르시거나 건물명을 비우고 동네 기준으로 보세요. 직접 고르지 않으면 판정하지 않습니다."]);
  }

  for (const [id, m] of errs) showErr(id, m);
  if (errs.length) {
    if (candidates.length) {
      const e = $("#bldg-err");
      e.append(el("span", null, " 후보: " + candidates.map((c) => `<button type="button" class="btn ghost cand" data-nm="${esc(c.nm)}">${esc(c.nm)}</button>`).join(" ")));
    }
    $(errs[0][0] === "offer" ? "#odep" : `#${errs[0][0]}`)?.focus();
    return null;
  }
  return {
    kind, gu, umd, seq, bldgName, area, expiry, dep, rent, odep, orent,
    signed: parseDate($("#signed").value), used: $("#used").value, notice: $("#notice").value,
  };
}

/* ── 모드 판정 (02-SPEC §5.3, 우선순위 순서로 정확히 하나) ──────────────── */
function decide(i) {
  const w = R.r6Window(i.expiry, today(), i.signed);
  const v = { asof: S.anchors?.asof, window: w, input: i, flags: [], mode: "M-10" };

  if (i.gu === "OUT") v.mode = "M-01";
  else if (w.d_day < 0) v.mode = "M-02";
  else if (S.snapshotFailed || !S.shard) v.mode = "M-03";
  else if (i.rent > 0 || i.orent > 0) v.mode = "M-04";

  // 산술은 모드와 무관하게 입력만으로 되는 것부터 낸다
  if (i.rent === 0 && i.orent === 0) {
    v.rate = R.r1Rate(i.dep, i.odep);
    v.cap = R.r2Cap(i.dep, i.odep);
  } else {
    v.convert = R.r7Convert(i.dep, i.odep, i.orent);
  }
  if (["M-01", "M-02", "M-03", "M-04"].includes(v.mode)) return finish(v);

  if (i.kind === "단독다가구") v.flags.push("M-05");

  const key = { kind: i.kind, sgg: i.gu, umd: i.umd, seq: i.seq, area: i.area };
  const wr = R.widen(S.shard.cohorts, key, R.MIN_N_RATE, (r) => R.ratesOf(r).length);
  v.trail = wr.trail;
  if (!wr.rec) { v.mode = wr.trail.every((t) => t.n === 0) ? "M-08" : "M-09"; return finish(v); }

  v.cohort = R.r3Percentile(wr.rec, i.dep, i.odep);
  v.cohort.level = wr.level; v.cohort.widened = wr.widened;
  v.groups = R.r4Groups(S.anchors, v.rate.is_over_cap);

  const mw = R.widen(S.shard.cohorts, key, R.MIN_N_MARKET, (r) => r.nn || 0);

  // 자릿수 사고 탐지. 비율 검사로는 못 잡으므로 코호트의 신규 전세 중앙값을 바깥 기준으로 쓴다.
  // 되묻기이지 버리기가 아니다 — 사용자가 "맞다"고 하면 그대로 판정한다.
  const off = mw.rec ? R.depositLooksOff(i.dep, mw.rec.nd) : null;
  if (off && !S.amountConfirmed) {
    v.mode = "M-11";
    v.amountCheck = { ...off, level: mw.level, n: mw.rec.nn };
    return finish(v);
  }

  v.market = mw.rec ? R.r5Market(mw.rec.nd, mw.rec.nn, i.odep) : null;
  if (v.market) { v.market.level = mw.level; v.market.widened = mw.widened; }
  return finish(v);
}

function finish(v) {
  const i = v.input;
  if (i.used === "예") v.flags.push("O-01");
  if (i.notice === "실거주") v.flags.push("O-02");
  if (S.anchors && (today() - new Date(S.anchors.asof)) / 86400000 >= 7) v.flags.push("O-03");
  if (v.convert?.kind === "NET_ADD") v.flags.push("O-06");
  return v;
}

/* ── 모드 결말 문장 — 모든 상태가 사용자가 읽는 문장으로 끝난다 ─────────── */
const MODE_TEXT = {
  "M-01": ["계산 범위는 서울입니다", "우리가 계산한 범위는 <strong>서울</strong>입니다. 해당 지역의 갱신 분포는 계산하지 않았습니다. 법정 기한 계산·통지 문안·3관문 알림은 그대로 쓸 수 있고, <strong>분포 숫자는 표시하지 않습니다.</strong> 서울 숫자를 다른 지역에 적용하지 않습니다."],
  "M-02": ["마감일이 지났습니다", "갱신요구권은 이번 만기에 행사할 수 없습니다. 남은 경로는 ① 합의 갱신(5% 상한 미적용) ② 묵시적 갱신(전 임대차와 동일 조건, 인상 없음 — 다만 임대인이 이미 만료 통보를 보냈다면 성립하지 않습니다)입니다."],
  "M-03": ["데이터를 읽지 못했습니다", "원천 데이터를 읽지 못해 <strong>분포 판정을 중단</strong>합니다. 만기 계산·5% 상한 금액·환산처럼 <strong>입력만으로 되는 산술은 그대로 동작</strong>합니다. 추정치를 만들지 않습니다."],
  "M-04": ["월세가 섞이면 보증금만으로는 비교가 성립하지 않습니다", "월세를 환산해 넣으면 5% 초과 비율이 <strong>35~46%</strong>까지 흔들립니다. 인상률 백분위·신규 시세 차액 화면을 <strong>잠그고</strong> 환산 판정으로 이동합니다. 잠근 이유를 이 자리에 적어 둡니다."],
  "M-08": ["조건을 만족하는 갱신 계약이 0건입니다", "각 단계 건수를 그대로 보여 드리고 <strong>판정 불가로 끝냅니다. 추정치를 만들지 않습니다.</strong> 5% 상한 금액과 법정 기한은 입력값만으로 계산되므로 그대로 제공합니다."],
  "M-09": ["표본이 부족해 백분위를 내지 않습니다", "표본 없이 만든 백분위는 숫자처럼 보여도 판정이 아닙니다. 각 단계에서 몇 건이 나왔는지 그대로 보여 드립니다."],
};

const OVERLAY_TEXT = {
  "M-05": "단독·다가구는 원천에 <strong>건물명·지번이 없어</strong> 같은 건물끼리 비교할 수 없습니다. <strong>같은 읍면동, 비슷한 연면적</strong> 기준으로 보여 드립니다.",
  "O-01": "갱신요구권은 같은 주택에서 <strong>1회 한정</strong>입니다. 이미 행사하셨다면 이번 갱신은 합의 갱신이고 <strong>5% 상한이 적용되지 않습니다.</strong> 이 데이터에는 임차인의 갱신권 소진 이력이 <strong>없어서</strong> 입력하신 값을 그대로 신뢰합니다 — 입력이 틀리면 판정도 틀립니다.",
  "O-02": "실거주는 갱신거절 사유입니다(주택임대차보호법 제6조의3 제1항 단서 8호). <strong>이 서비스는 실거주 주장의 진위를 판정하지 않습니다.</strong> 지금 할 일은 통보 내용을 <strong>일시·수단·발화자와 함께 기록</strong>하는 것입니다.",
  "O-03": "이 판정의 데이터 기준일이 오래됐습니다. <strong>최근 30일 계약은 표본에서 빠질 수 있습니다.</strong>",
  "O-06": "전환율을 계산할 수 없습니다(분모 0). 이것은 전환이 아니라 <strong>순증</strong>입니다. 연 부담률만 표시하고 <strong>전환율 분포와 비교하지 않습니다</strong> — 비교 대상이 다른 종류의 숫자입니다.",
};

/* ── 렌더 ──────────────────────────────────────────────────────────────── */
function render(v) {
  S.v = v;
  const i = v.input, blocked = ["M-01", "M-02", "M-03", "M-04", "M-08", "M-09", "M-11"].includes(v.mode);
  $("#result").hidden = false;

  const mc = $("#mode-card");
  const overlays = v.flags.filter((f) => OVERLAY_TEXT[f]).map((f) => `<p>${OVERLAY_TEXT[f]}</p>`).join("");
  const amount = v.amountCheck ? amountQuestion(v) : "";
  if (MODE_TEXT[v.mode] || overlays || amount) {
    const [t, b] = MODE_TEXT[v.mode] || ["", ""];
    mc.hidden = false;
    mc.classList.toggle("stop", blocked);
    $("#mode-title").textContent = v.amountCheck ? "보증금 금액을 한 번만 확인해 주세요" : (t || "함께 보셔야 할 것");
    $("#mode-text").innerHTML = amount + (b ? `<p>${b}</p>` : "") + overlays;
  } else mc.hidden = true;

  renderTimeline(v);   // 만기일만 쓰므로 금액 확인과 무관하게 항상 낸다

  // 금액을 되묻는 중이면 그 금액에서 나온 숫자를 보여 주지 않는다.
  // 확인 전에 틀릴 수 있는 값을 화면에 띄우면 되묻는 의미가 없다.
  const holdMoney = v.mode === "M-11";

  $("#s3").hidden = holdMoney || (!v.cohort && !v.rate?.rate_pct && v.mode !== "M-08" && v.mode !== "M-09");
  if (!$("#s3").hidden) renderVerdict(v);
  $("#s4").hidden = holdMoney || !v.market;
  if (!$("#s4").hidden) renderMarket(v);
  $("#s7").hidden = holdMoney || !v.convert;
  if (!$("#s7").hidden) renderConvert(v);
  renderChoices(v);
  $("#s5").hidden = holdMoney;   // 문안에도 그 금액이 들어간다
  renderGates(v);
  // O-02(실거주 통보)면 연다. 그 밖에도 기록이 있으면 계속 보여 준다.
  $("#s-notice").hidden = !(v.flags.includes("O-02") || loadNotices().length);
  renderNotices();

  $("#limit-5").hidden = !v.groups;
  $("#limit-6").hidden = !v.convert && i.rent === 0 && i.orent === 0;
  $("#result").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderTimeline(v) {
  const w = v.window, i = v.input, t = today();
  $("#s2").hidden = false;
  const rows = [
    [w.start, "갱신 요구 기간이 열립니다", "만기 6개월 전"],
    [w.deadline, "갱신 요구 마감", "만기 2개월 전 — 이 날짜가 지나면 이번 만기에는 권리를 쓸 수 없습니다"],
    [i.expiry, "계약 만기", ""],
  ];
  const tl = el("ul", "tl");
  for (const [d, label, sub] of rows) {
    const li = el("li", d < t ? "past" : "");
    if (d.getTime() === w.deadline.getTime() && w.d_day >= 0) li.className = "now";
    li.innerHTML = `<span class="d">${R.fmtDate(d)}</span><span>${label}${sub ? `<br><small class="help">${sub}</small>` : ""}</span>`;
    tl.append(li);
  }
  const box = $("#timeline"); box.innerHTML = ""; box.append(tl);
  if (w.note)
    box.append(el("p", "tie", `계약 체결일이 2020년 12월 10일 이전입니다. 갱신요구 마감 기준이 다를 수 있어 두 날짜를 모두 보여 드립니다 — <b>${R.fmtDate(w.deadline)}</b> 와 <b>${R.fmtDate(w.note.alt_deadline)}</b>. 이른 쪽을 마감으로 안내합니다.`));

  const bar = $("#deadline-bar");
  bar.hidden = false;
  bar.innerHTML = w.d_day < 0
    ? `<div class="dl urgent"><span class="dd">마감 경과</span><span>갱신 요구 마감 ${R.fmtDate(w.deadline)}이 ${-w.d_day}일 지났습니다.</span></div>`
    : `<div class="dl${w.d_day <= 14 ? " urgent" : ""}"><span class="dd">${w.d_day === 0 ? "오늘이 마지막입니다" : `D-${w.d_day}`}</span><span>갱신 요구 마감 <b>${R.fmtDate(w.deadline)}</b>${w.d_day === 0 ? "" : ` — 남은 기간 ${w.d_day}일`}</span></div>`;

  const paths = [
    ["갱신요구권을 행사한다", `마감까지 의사표시가 도달하면 기록이 남습니다. 서울 집계에서 행사 기록이 있는 ${R.fmtN(S.anchors?.recorded.n)}건 중 5% 초과는 ${R.fmtPct(S.anchors?.recorded.over5)}입니다.`],
    ["합의로 갱신한다", `5% 상한이 적용되지 않습니다. 행사 기록이 없는 ${R.fmtN(S.anchors?.unrecorded.n)}건 중 ${R.fmtPct(S.anchors?.unrecorded.over5)}가 5%를 넘겼습니다.`],
    ["아무것도 하지 않는다", "마감이 지나면 이번 만기에는 권리를 쓸 수 없습니다. 되돌릴 수 없는 유일한 칸입니다."],
  ];
  $("#paths").innerHTML = paths.map(([h, p]) => `<div class="p"><h3>${h}</h3><p>${p}</p></div>`).join("");
}

function renderVerdict(v) {
  const i = v.input, c = v.cohort, head = $("#verdict");
  head.innerHTML = "";
  if (v.rate?.error) { head.innerHTML = `<p class="headline">인상률을 계산할 수 없습니다.</p>`; }
  else if (v.rate) {
    const over = v.rate.is_over_cap;
    head.append(el("p", "headline", c
      ? `제시받은 <span class="big${over ? " over" : ""}">${R.fmtPct(v.rate.rate_pct)}</span>는 ${esc(cohortLabel(v))}에서 갱신된 <b>${R.fmtN(c.n)}건</b> 중 <b>상위 ${R.fmtPct(c.top_share_pct, 1)}</b>입니다. 이 코호트의 중앙값은 <b>${R.fmtPct(c.median_pct)}</b>입니다.`
      : `제시받은 인상률은 <span class="big${over ? " over" : ""}">${R.fmtPct(v.rate.rate_pct)}</span>입니다.`));
    const f = el("ul", "facts");
    f.innerHTML = `
      <li><span class="k">현재 보증금</span><span class="v">${R.fmtMoney(i.dep)}</span></li>
      <li><span class="k">제시 보증금</span><span class="v">${R.fmtMoney(i.odep)}</span></li>
      <li><span class="k">5% 상한이면</span><span class="v">${R.fmtMoney(v.cap.deposit)}</span></li>
      <li><span class="k">${v.cap.over ? "상한 대비 차액" : "상한 이내"}</span><span class="v ${v.cap.over ? "over" : "ok"}">${v.cap.over ? R.fmtMoney(v.cap.excess) : "초과 없음"}</span></li>`;
    head.append(f);
    if (v.cap.over && S.anchors)
      head.append(el("p", "mine", `서울 집계에서 행사 기록 없는 초과 건의 차액은 건당 중앙값 <b>${R.fmtMoney(S.anchors.excess_median)}</b>입니다.`));
  }

  const co = $("#cohort"); co.innerHTML = "";
  if (c) {
    if (c.widened)
      co.append(el("p", "trail", "표본이 모자라 범위를 넓혔습니다 — " +
        v.trail.map((t) => `${t.label} <b>${R.fmtN(t.n)}건</b>`).join(" → ") +
        `. <b>이 숫자는 ${R.LEVELS[c.level]} 기준입니다.</b>`));
    co.append(el("ul", "facts", `
      <li><span class="k">표본 수</span><span class="v">${R.fmtN(c.n)}건</span></li>
      <li><span class="k">중앙값</span><span class="v">${R.fmtPct(c.median_pct)}</span></li>
      <li><span class="k">상위 10% 인상률</span><span class="v">${R.fmtPct(c.p90_pct)}</span></li>
      <li><span class="k">이 코호트의 5% 초과</span><span class="v">${R.fmtN(c.over_cap_n)}건</span></li>`));
    if (c.tie_at_cap_n / c.n >= 0.2)
      co.append(el("p", "tie", `이 코호트의 <b>${R.fmtN(c.n)}건 중 ${R.fmtN(c.tie_at_cap_n)}건이 정확히 +5.00%</b>입니다. 5.00% 부근에서는 백분위가 한 계단씩 크게 움직입니다.`));
  } else if (v.trail) {
    co.append(el("p", "trail", "각 단계 건수 — " + v.trail.map((t) => `${t.label} <b>${R.fmtN(t.n)}건</b>`).join(" → ")));
  }

  const g = $("#groups"); g.innerHTML = "";
  if (v.groups) {
    const a = v.groups, max = Math.max(a.recorded.over_cap_share_pct, a.unrecorded.over_cap_share_pct, 1);
    g.append(el("h3", null, "권리를 쓴 계약과 그렇지 않은 계약은 숫자가 다릅니다"));
    const bars = el("div", "bars");
    for (const [name, d, warn] of [
      ["갱신요구권 행사 기록 있음", a.recorded, false],
      ["행사 기록 없음", a.unrecorded, true],
    ]) {
      const row = el("div", "bar-row");
      row.innerHTML = `<span class="lab"><span>${name} <b>${R.fmtN(d.n)}건</b></span><span><b>${R.fmtPct(d.over_cap_share_pct)}</b>가 5% 초과</span></span>
        <span class="bar-track"><span class="bar-fill${warn ? " warn" : ""}"></span></span>`;
      // 폭은 style 속성이 아니라 CSSOM 으로 준다 — CSP 에서 unsafe-inline 을 빼기 위해서다
      row.querySelector(".bar-fill").style.width = `${Math.max(1, (d.over_cap_share_pct / max) * 100)}%`;
      bars.append(row);
    }
    g.append(bars);
    g.append(el("p", "mine", `모수 — ${esc(a.scope)}, ${R.fmtN(a.total_n)}건. 제시받은 조건은 <b>${a.mine_over_cap ? "5%를 넘는 쪽" : "5% 이내 쪽"}</b>에 있습니다.`));
  }
}

/** M-11 — 자릿수 사고로 보일 때 되묻는 문장. 판정을 멈추고 사용자에게 확인받는다. */
function amountQuestion(v) {
  const a = v.amountCheck, i = v.input;
  return `<p>입력하신 현재 보증금은 <b>${R.fmtMoney(i.dep)}</b>입니다.
    그런데 같은 조건(${esc(R.LEVELS[a.level])})의 <b>신규 전세 보증금 중앙값은 ${R.fmtMoney(a.median)}</b>(표본 ${R.fmtN(a.n)}건)이라,
    입력값이 <b>${a.ratio}배</b>${a.kind === "HIGH" ? " 높습니다" : "로 낮습니다"}.</p>
    <p><strong>0을 하나 더 치거나 덜 친 것이 아닌지만 확인해 주세요.</strong>
    금액이 10배 틀려도 종전과 제시가 같은 배율이면 인상률은 정상으로 보여서, 비율만으로는 잡히지 않습니다.
    실제로 분포 밖인 계약도 있으므로 <strong>맞다고 하시면 그대로 판정합니다.</strong></p>
    <div class="rowbtns">
      <button type="button" class="btn primary" id="amount-ok">네, ${esc(R.fmtMoney(i.dep))} 맞습니다</button>
      <button type="button" class="btn ghost" id="amount-fix">보증금 다시 입력</button>
    </div>`;
}

const cohortLabel = (v) => {
  const i = v.input, lv = v.cohort.level;
  const where = `${S.shard?.gu ?? ""} ${i.umd}`.trim();
  if (lv === 1) return `${where} ${i.bldgName} 전용 ${R.band(i.area)}㎡`;
  if (lv === 2) return `${where} ${i.bldgName} 전체 면적`;
  if (lv === 3) return `${where} 전용 ${R.band(i.area)}㎡`;
  if (lv === 4) return `${where} 전체`;
  return `${S.shard?.gu ?? ""} 전체`;
};

function renderMarket(v) {
  const m = v.market, box = $("#market"); box.innerHTML = "";
  box.append(el("p", "headline", m.gap > 0
    ? `같은 조건 <b>신규 전세</b> 보증금 중앙값은 <b>${R.fmtMoney(m.new_median)}</b>입니다. 제시받은 조건보다 <span class="big">${R.fmtMoney(m.gap)}</span> 높습니다 — 나가면 이 차액을 시장에서 다시 지불해야 합니다.`
    : `같은 조건 <b>신규 전세</b> 보증금 중앙값은 <b>${R.fmtMoney(m.new_median)}</b>이고, 제시받은 조건이 <b>${R.fmtMoney(-m.gap)}</b> 더 높습니다.`));
  box.append(el("ul", "facts", `
    <li><span class="k">신규 전세 중앙값</span><span class="v">${R.fmtMoney(m.new_median)}</span></li>
    <li><span class="k">신규 표본</span><span class="v">${R.fmtN(m.n)}건</span></li>
    <li><span class="k">차액</span><span class="v ${m.gap > 0 ? "ok" : "over"}">${R.fmtMoney(Math.abs(m.gap))}</span></li>
    <li><span class="k">차액 비율</span><span class="v">${R.fmtPct(Math.abs(m.gap_pct), 1)}</span></li>`));
  if (m.widened) box.append(el("p", "trail", `신규 표본이 모자라 범위를 넓혔습니다 — <b>이 숫자는 ${R.LEVELS[m.level]} 기준입니다.</b>`));
}

function renderConvert(v) {
  const c = v.convert, i = v.input, box = $("#convert"); box.innerHTML = "";
  if (c.kind === "NET_ADD") {
    box.append(el("p", "headline", `이 조건은 <b>전환이 아니라 순증</b>입니다. 보증금 감액이 <b>0원</b>이라 전환율을 계산할 수 없습니다(분모 0). 월 ${R.fmtMoney(i.orent)} = 연 <b>${R.fmtMoney(i.orent * 12)}</b>, 종전 보증금 ${R.fmtMoney(i.dep)} 대비 연 <span class="big">${R.fmtPct(c.annual_rate_pct)}</span>의 추가 부담입니다.`));
  } else if (c.kind === "BOTH_UP") {
    box.append(el("p", "headline", `보증금과 월세가 <b>둘 다 올랐습니다.</b> 전환이 아니므로 전환율을 내지 않습니다. 보증금은 보증금끼리, 월세는 월세끼리 비교하세요.`));
  } else {
    const d = R.CONVERT_DIST, pos = c.annual_rate_pct > d.p75 ? "p75(9.44%)보다 높습니다"
      : c.annual_rate_pct > d.p50 ? "중앙값(6.27%)보다 높고 p75(9.44%)보다 낮습니다"
      : c.annual_rate_pct > d.p25 ? "p25(5.17%)와 중앙값(6.27%) 사이입니다" : "p25(5.17%)보다 낮습니다";
    box.append(el("p", "headline", `이 조건의 <b>환산 전환율은 연 <span class="big">${R.fmtPct(c.annual_rate_pct)}</span></b>입니다 (연 월세 ${R.fmtMoney(i.orent * 12)} ÷ 보증금 감액 ${R.fmtMoney(c.cut)}). 서울 전세→월세 갱신 역산 분포(n=${d.n})에서 ${pos}.`));
    box.append(el("p", "mine", "이 값은 시장 데이터에서 역산한 참고값이며 <strong>법정 전월세전환율 한도 판정이 아닙니다.</strong> 세 분포 중 <strong>표본이 가장 얇고</strong>, 단지 단위가 아니라 서울 전체 분포를 씁니다."));
  }
}

function renderChoices(v) {
  $("#s5").hidden = false;   // render() 가 금액 확인 중이면 다시 숨긴다
  $("#chosen").hidden = true;
  $("#draft-out").hidden = true;
  $("#copy-btn").hidden = true;
  S.choice = null;
  $$(".choice").forEach((b) => b.setAttribute("aria-pressed", "false"));
}

function renderGates(v) {
  $("#s6").hidden = false;
  const exp = v.input.expiry;
  const after = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const gates = [
    [exp, "확정일자", "갱신 계약서에 확정일자를 다시 받습니다. 증액분은 새로 받아야 순위가 생깁니다."],
    [after(exp, 30), "전세대출 연장", "대출 만기와 임대차 만기는 같은 날이 아닙니다. 따로 확인하세요."],
    [after(exp, 30), "보증 갱신", "전세보증금반환보증은 자동 연장되지 않습니다."],
  ];
  $("#gates").innerHTML = gates.map(([d, t, s]) =>
    `<li><span class="d">${R.fmtDate(d)}</span><span>${t}<small>${s}</small></span></li>`).join("");
}

/* ── 문안 ──────────────────────────────────────────────────────────────── */
function factsOf(v) {
  const i = v.input;
  return {
    asof: v.asof, choice: S.choice,
    deadline: isoDate(v.window.deadline), deadline_ko: R.fmtDate(v.window.deadline), d_day: v.window.d_day,
    cur_deposit_manwon: i.dep, new_deposit_manwon: i.odep, monthly_manwon: i.orent,
    rate_pct: v.rate?.rate_pct ?? null,
    cap_deposit_manwon: v.cap?.deposit ?? null, excess_manwon: v.cap?.excess ?? null,
    cohort: v.cohort ? { label: cohortLabel(v), n: v.cohort.n, median_pct: v.cohort.median_pct,
                         p90_pct: v.cohort.p90_pct, top_share_pct: v.cohort.top_share_pct } : null,
    groups: v.groups ? { total_n: v.groups.total_n,
                         recorded: v.groups.recorded, unrecorded: v.groups.unrecorded } : null,
    market: v.market ? { n: v.market.n, new_median_manwon: v.market.new_median, gap_manwon: v.market.gap } : null,
  };
}

/* 숫자가 들어간 문장은 전부 여기서 만든다. 언어 모델은 이 문장들을 보지도, 고치지도 못한다.
 * 모델에게 재서술을 맡겼더니 숫자가 맞는데 라벨이 바뀌었다 — 5% 상한액을 "제시된 보증금"으로,
 * 코호트 전체 건수를 "행사 기록이 있는 건수"로 썼다. 숫자 검증으로는 잡히지 않는 오류다. */
function bodyLines(f) {
  const L = [];
  if (f.rate_pct != null) {
    L.push(`제시하신 조건은 현재 보증금 ${R.fmtMoney(f.cur_deposit_manwon)}에서 ${R.fmtMoney(f.new_deposit_manwon)}으로 ${R.fmtPct(f.rate_pct)} 인상입니다.`);
    L.push(`주택임대차보호법 제7조의 20분의 1 기준을 적용하면 ${R.fmtMoney(f.cap_deposit_manwon)}입니다.`
      + (f.excess_manwon > 0 ? ` 제시하신 금액과의 차이는 ${R.fmtMoney(f.excess_manwon)}입니다.` : ""));
  }
  if (f.cohort)
    L.push(`국토교통부 전월세 실거래가 공개자료(기준일 ${f.asof})에서 ${f.cohort.label}의 갱신 계약 ${R.fmtN(f.cohort.n)}건을 보면, 인상률 중앙값은 ${R.fmtPct(f.cohort.median_pct)}이고 상위 10%는 ${R.fmtPct(f.cohort.p90_pct)}입니다. 제시하신 조건은 이 가운데 상위 ${R.fmtPct(f.cohort.top_share_pct, 1)}에 해당합니다.`);
  if (f.market)
    L.push(`같은 조건의 신규 전세 보증금 중앙값은 ${R.fmtMoney(f.market.new_median_manwon)}입니다(신규 표본 ${R.fmtN(f.market.n)}건).`);
  L.push(`주택임대차보호법 제6조의3에 따른 갱신 요구 기간은 ${f.deadline_ko}까지입니다.`);
  return L;
}

const FRAME = {
  행사: ["안녕하세요. 계약 갱신 조건에 관해 회신드립니다. 이 계약에 대해 계약갱신요구권을 행사하고자 합니다.",
        "아래 자료를 참고해 조건을 협의할 수 있으면 합니다. 회신 부탁드립니다. 감사합니다."],
  합의: ["안녕하세요. 제시해 주신 갱신 조건에 관해 회신드립니다. 합의 갱신을 검토하고 있습니다.",
        "아래 자료를 확인한 뒤 다시 말씀드리겠습니다. 회신 부탁드립니다. 감사합니다."],
  무행동: ["안녕하세요. 제시해 주신 갱신 조건을 확인하고 있어 먼저 회신드립니다.",
          "정리되는 대로 다시 말씀드리겠습니다. 감사합니다."],
};
const CAVEAT = "이 문안은 법률 문서가 아닙니다. 보내기 전에 내용을 직접 확인하시고, 도달 증거가 남는 방법(내용증명·문자 등)으로 보내세요.";

async function makeDraft() {
  const btn = $("#draft-btn"), out = $("#draft-out");
  const f = factsOf(S.v);
  const lines = bodyLines(f);
  let [opening, closing] = FRAME[S.choice] || FRAME["무행동"];
  let source = "template";

  btn.disabled = true; btn.textContent = "만드는 중…";
  try {
    const r = await fetch("/api/draft", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice: S.choice, tone: "neutral" }),
      signal: AbortSignal.timeout(15000),
    }).then((x) => x.json());
    if (r.ok && r.frame) { opening = r.frame.opening; closing = r.frame.closing; source = "llm"; }
  } catch { /* 폴백. 숫자 문장은 애초에 바뀌지 않는다 */ }

  const text = [opening, ...lines, closing].join("\n\n");
  out.hidden = false;
  out.innerHTML = `<div class="box">${esc(text)}</div>
    <p class="src">${source === "llm"
      ? "인사말과 맺음말만 언어 모델이 썼고, <b>숫자가 들어간 문장은 전부 코드가 계산해 그대로 넣었습니다.</b> 모델이 쓴 부분에 숫자가 있으면 폐기합니다."
      : "문장 생성이 동작하지 않아 <b>고정 인사말</b>로 대신합니다. 숫자는 동일합니다."}
    ${esc(CAVEAT)}</p>`;
  btn.disabled = false; btn.textContent = "이 숫자로 회신 문안 만들기";
  $("#copy-btn").hidden = false;
  $("#copy-btn").dataset.text = text;
}

/* ── 공유 — 사용자의 금액은 내보내지 않는다. 서비스와 서울 전체 집계만 나간다 ── */
async function share() {
  const a = S.anchors;
  const text = a
    ? `전월세 갱신, 같은 법인데 결과가 갈립니다. 갱신요구권 행사 기록이 있는 갱신 ${R.fmtN(a.recorded.n)}건 중 5% 초과는 ${R.fmtPct(a.recorded.over5)}, 기록이 없는 ${R.fmtN(a.unrecorded.n)}건은 ${R.fmtPct(a.unrecorded.over5)}입니다. (${a.scope}, 기준일 ${a.asof})`
    : "전월세 갱신 조건이 실제 갱신 계약들 사이에서 어디쯤인지 확인하세요.";
  const url = location.origin + "/";
  try {
    if (navigator.share) { await navigator.share({ title: "갱신 기준선", text, url }); return "shared"; }
    await navigator.clipboard.writeText(`${text}\n${url}`);
    return "copied";
  } catch { return "failed"; }   // 사용자가 취소한 경우도 여기로 온다
}

function wireShare(id) {
  const b = $(`#${id}`);
  if (!b) return;
  b.addEventListener("click", async () => {
    const r = await share();
    if (r === "failed") return;
    const label = b.lastChild;
    const before = label.textContent;
    label.textContent = r === "copied" ? " 링크를 복사했습니다" : " 공유했습니다";
    setTimeout(() => { label.textContent = before; }, 2500);
  });
}

/* ── 데모 — 빈 폼 앞에서는 이 서비스가 무엇을 하는지 보이지 않는다 ─────── */
const DEMO = { kind: "아파트", gu: "11680", dong: "대치동", bldg: "", area: "84.9",
               expiry: null, dep: "90000", rent: "0", odep: "97200", orent: "0" };

async function runDemo() {
  const btn = $("#demo-btn");
  btn.disabled = true;
  const exp = new Date();
  exp.setMonth(exp.getMonth() + 3);           // 마감이 아직 열려 있는 만기일
  for (const [k, val] of Object.entries({ ...DEMO, expiry: isoDate(exp) })) {
    const e = $(`#${k}`);
    if (!e || val == null) continue;
    if (k === "gu") { e.value = val; await loadShard(val); }
    else if (k === "dong") { e.value = val; fillBuildings(); }
    else e.value = val;
  }
  S.amountConfirmed = false;
  save();
  $("#form").requestSubmit();
  btn.disabled = false;
}

/* ── 통보 기록 (O-02) — 브라우저에만 남는다 ─────────────────────────────── */
const NOTICES = "gaengsin-notices-v1";
const loadNotices = () => { try { return JSON.parse(localStorage.getItem(NOTICES) || "[]"); } catch { return []; } };
const saveNotices = (xs) => { try { localStorage.setItem(NOTICES, JSON.stringify(xs)); } catch { /* 저장 못해도 화면은 남는다 */ } };

function renderNotices() {
  const xs = loadNotices().sort((a, b) => (a.when || "").localeCompare(b.when || ""));
  $("#nt-export").hidden = !xs.length;
  $("#nt-list").innerHTML = xs.map((x, idx) => `<li>
      <span class="d">${esc(x.when ? x.when.replace("T", " ") : "일시 미기재")}</span>
      <span><b>${esc(x.how)}</b> · ${esc(x.who || "발화자 미기재")}<small>${esc(x.what || "")}</small></span>
      <button type="button" class="btn ghost nt-del" data-i="${idx}" aria-label="이 기록 삭제">삭제</button>
    </li>`).join("");
}

function addNotice() {
  const x = { when: $("#nt-when").value, how: $("#nt-how").value,
              who: $("#nt-who").value.trim(), what: $("#nt-what").value.trim() };
  if (!x.when && !x.what) { $("#nt-what").focus(); return; }
  saveNotices([...loadNotices(), x]);
  $("#nt-what").value = "";
  renderNotices();
}

function exportNotices() {
  const xs = loadNotices().sort((a, b) => (a.when || "").localeCompare(b.when || ""));
  const body = xs.map((x, i) =>
    `${i + 1}. ${x.when ? x.when.replace("T", " ") : "(일시 미기재)"} / ${x.how} / ${x.who || "(발화자 미기재)"}\n   ${x.what || ""}`
  ).join("\n\n");
  const text = `임대인 통보 기록\n작성 ${new Date().toLocaleString("ko-KR")}\n`
    + `${"-".repeat(40)}\n\n${body}\n\n${"-".repeat(40)}\n`
    + `이 기록은 사용자가 직접 작성한 것이며 법률 문서가 아닙니다.\n`
    + `이 서비스는 통보의 도달 여부나 효력을 판정하지 않습니다.\n`;
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  a.download = "임대인-통보기록.txt";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── 캘린더 내보내기 — 계정도 연락처도 쓰지 않는 유일한 알림 수단 ───────── */
function downloadICS(v) {
  const d = v.window.deadline;
  const stamp = (x) => `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, "0")}${String(x.getDate()).padStart(2, "0")}`;
  const end = new Date(d); end.setDate(end.getDate() + 1);
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//갱신 기준선//KO", "BEGIN:VEVENT",
    `UID:${stamp(d)}-gaengsin@local`, `DTSTAMP:${stamp(today())}T000000Z`,
    `DTSTART;VALUE=DATE:${stamp(d)}`, `DTEND;VALUE=DATE:${stamp(end)}`,
    "SUMMARY:갱신요구권 행사 마감일",
    "DESCRIPTION:이 날짜가 지나면 이번 만기에는 갱신요구권을 행사할 수 없습니다.",
    "BEGIN:VALARM", "TRIGGER:-P7D", "ACTION:DISPLAY", "DESCRIPTION:갱신 요구 마감 7일 전", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = "갱신요구-마감일.ics";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── 로컬 보관 (브라우저에만, 서버로 가지 않는다) ──────────────────────── */
const FIELDS = ["kind", "gu", "dong", "bldg", "area", "expiry", "dep", "rent", "odep", "orent", "orate", "signed", "used", "notice"];
const save = () => {
  try {
    localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(FIELDS.map((f) => [f, $(`#${f}`)?.value ?? ""]))));
  } catch { /* 저장 불가여도 판정은 동작한다 */ }
};
async function restore() {
  let d; try { d = JSON.parse(localStorage.getItem(STORE) || "null"); } catch { d = null; }
  if (!d) return;
  for (const f of FIELDS) if ($(`#${f}`) && d[f] != null && f !== "dong" && f !== "bldg") $(`#${f}`).value = d[f];
  if (d.gu) { await loadShard(d.gu); if (d.dong) { $("#dong").value = d.dong; fillBuildings(); } }
  if (d.bldg) $("#bldg").value = d.bldg;
}

/* ── 배선 ──────────────────────────────────────────────────────────────── */
function wire() {
  $("#gu").addEventListener("change", async (e) => { await loadShard(e.target.value); save(); });
  $("#dong").addEventListener("change", () => { fillBuildings(); save(); });
  $("#kind").addEventListener("change", () => { fillDong(); save(); });
  $("#form").addEventListener("input", save);
  $("#dep").addEventListener("input", () => { S.amountConfirmed = false; });

  $$(".tabs button").forEach((b) => b.addEventListener("click", () => {
    $$(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    $$(".tabpane").forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
  }));

  $("#orate").addEventListener("input", (e) => {
    const p = Number(e.target.value), dep = intOf($("#dep").value);
    const c = $("#rate-confirm");
    if (Number.isFinite(p) && dep > 0 && e.target.value !== "") {
      c.hidden = false;
      c.innerHTML = `${R.fmtPct(p)}면 보증금 <b>${R.fmtMoney(R.round0(dep * (1 + p / 100)))}</b>입니다. 맞습니까?`;
    } else c.hidden = true;
  });

  $("#bldg-err").addEventListener("click", (e) => {
    const b = e.target.closest(".cand");
    if (!b) return;
    $("#bldg").value = b.dataset.nm;
    showErr("bldg", "");
    $("#form").requestSubmit();
  });

  $("#parse-btn").addEventListener("click", parseText);

  $("#form").addEventListener("submit", (e) => {
    e.preventDefault();
    const i = readInput();
    if (!i) return;
    render(decide(i));
  });

  $("#clear-btn").addEventListener("click", () => {
    // 통보 기록(NOTICES)은 지우지 않는다. 계약 입력과 성격이 다르고 되살릴 수 없다.
    try { localStorage.removeItem(STORE); } catch {}
    $("#form").reset();
    $("#result").hidden = true;
    $("#deadline-bar").hidden = true;
    FIELDS.forEach((f) => showErr(f, ""));
  });

  $("#mode-text").addEventListener("click", (e) => {
    if (e.target.id === "amount-ok") {
      S.amountConfirmed = true;          // 사용자가 확인했으므로 그대로 판정한다
      $("#form").requestSubmit();
    } else if (e.target.id === "amount-fix") {
      $("#result").hidden = true;
      $("#dep").focus();
      $("#dep").select();
    }
  });

  $("#demo-btn").addEventListener("click", runDemo);
  wireShare("share-btn");
  wireShare("share-verdict");
  $("#start-btn").addEventListener("click", () => {
    $("#s1").scrollIntoView({ behavior: "smooth", block: "start" });
    $("#kind").focus();
  });

  $("#nt-add").addEventListener("click", addNotice);
  $("#nt-export").addEventListener("click", exportNotices);
  $("#nt-list").addEventListener("click", (e) => {
    const b = e.target.closest(".nt-del");
    if (!b) return;
    const xs = loadNotices();
    xs.splice(Number(b.dataset.i), 1);
    saveNotices(xs);
    renderNotices();
  });

  $("#ics-btn").addEventListener("click", () => S.v && downloadICS(S.v));
  $("#draft-btn").addEventListener("click", makeDraft);
  $("#copy-btn").addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(e.currentTarget.dataset.text || "");
      e.currentTarget.lastChild.textContent = " 복사했습니다";
    } catch { /* 클립보드 권한이 없으면 사용자가 직접 선택해 복사한다 */ }
  });

  $$(".choice").forEach((b) => b.addEventListener("click", () => {
    S.choice = b.dataset.choice;
    $$(".choice").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    const c = $("#chosen"); c.hidden = false;
    c.innerHTML = `<b>${esc(S.choice)}</b>를 선택하셨습니다 — ${new Date().toLocaleString("ko-KR")}. 이 기록은 <strong>이 브라우저에만</strong> 남습니다.`;
    try { localStorage.setItem("gaengsin-choice", JSON.stringify({ choice: S.choice, at: Date.now() })); } catch {}
  }));
}

async function parseText() {
  const btn = $("#parse-btn"), out = $("#parse-out"), text = $("#otext").value.trim();
  if (!text) return;
  btn.disabled = true; btn.textContent = "읽는 중…";
  try {
    const r = await fetch("/api/parse", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, hint: { sgg_nm: $("#gu").selectedOptions[0]?.text || null } }),
      signal: AbortSignal.timeout(10000),
    }).then((x) => x.json());
    const p = r.parsed || {};
    if (p.cur_deposit_manwon) $("#dep").value = p.cur_deposit_manwon;
    if (p.new_deposit_manwon) $("#odep").value = p.new_deposit_manwon;
    if (p.new_monthly_manwon != null) $("#orent").value = p.new_monthly_manwon;
    if (p.area_m2) $("#area").value = p.area_m2;
    out.hidden = false;
    out.innerHTML = r.ok
      ? `읽은 값 — 현재 보증금 <b>${R.fmtMoney(p.cur_deposit_manwon)}</b>, 제시 보증금 <b>${R.fmtMoney(p.new_deposit_manwon)}</b>${p.new_monthly_manwon ? `, 제시 월세 <b>${R.fmtMoney(p.new_monthly_manwon)}</b>` : ""}. <strong>맞는지 확인하고 '금액으로' 탭에서 고치실 수 있습니다.</strong> 원문은 저장하지 않았습니다.`
      : `문장에서 조건을 충분히 읽지 못했습니다. <strong>'금액으로' 탭에 직접 넣어 주세요.</strong>`;
  } catch {
    out.hidden = false;
    out.innerHTML = `문장을 자동으로 읽지 못했습니다. <strong>'금액으로' 탭에 직접 넣어 주세요.</strong> 판정 기능은 그대로 동작합니다.`;
  }
  btn.disabled = false; btn.textContent = "문장에서 금액 읽기";
}

boot();
