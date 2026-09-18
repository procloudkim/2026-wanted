/* 함수 두 개가 공유하는 것 — 비밀값 취급, 공통 규약, 검증층.
 * 파일명이 _ 로 시작하면 Pages Functions 가 라우트로 올리지 않는다.
 *
 * 이 파일이 지키는 것: 판정을 하지 않는다. 저장하지 않는다. 사용자 입력 문장을 로그에 남기지 않는다.
 */

export const MAX_BODY = 16 * 1024;

/* ── 오리진 경계 ────────────────────────────────────────────────────────────
 * 이 두 함수는 우리 페이지 말고는 부를 이유가 없다. 그런데 Pages 는 정적 자산에
 * Access-Control-Allow-Origin: * 를 기본으로 붙이고, 오리진 검사가 없으면
 * 아무 사이트나 제 페이지에서 우리 엔드포인트를 불러 **우리 OpenAI 키를 쓸 수 있다.**
 *
 * ponytail: 오리진 헤더는 브라우저만 못 속인다. curl 로 위조하는 것은 막지 못한다.
 * 그 경로의 최종 방어선은 제공자 쪽 지출 한도다(README 보안 절 참조). */
const ORIGIN_SUFFIX = ".gaengsin-baseline.pages.dev";
const ORIGIN_EXACT = "https://gaengsin-baseline.pages.dev";

export function allowedOrigin(request) {
  const o = request.headers.get("origin");
  if (!o) return null;
  let u;
  try { u = new URL(o); } catch { return null; }
  if (u.protocol === "https:" && (o === ORIGIN_EXACT || u.hostname.endsWith(ORIGIN_SUFFIX))) return o;
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return o;   // 로컬 개발
  return null;
}

const cors = (origin) => (origin
  ? { "access-control-allow-origin": origin, "vary": "Origin" }
  : { "vary": "Origin" });

/** 성공·실패 모두 HTTP 200. 오류는 본문 code 로 전달한다(04-API §7.4).
 *  클라이언트 분기를 한 곳으로 모으기 위해서다 — 네트워크 실패와 ok:false 둘만 구분하면 된다. */
export const json = (body, origin = null, extra = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...cors(origin), ...extra,
    },
  });

export const fail = (code, message, retryable = false, extra = {}, origin = null) =>
  json({ ok: false, code, message, retryable, ...extra }, origin);

/** 프리플라이트. 허용된 오리진에만 답한다. */
export const preflight = (request) => {
  const origin = allowedOrigin(request);
  return new Response(null, {
    status: origin ? 204 : 403,
    headers: origin
      ? { ...cors(origin), "access-control-allow-methods": "POST",
          "access-control-allow-headers": "content-type", "access-control-max-age": "86400" }
      : { vary: "Origin" },
  });
};

/** 모든 함수가 가장 먼저 부른다. 통과하면 오리진 문자열, 막히면 Response. */
export function gate(request, perMinute) {
  const origin = allowedOrigin(request);
  if (!origin)
    return { blocked: fail("E_FORBIDDEN", "이 요청은 허용되지 않습니다.", false, {}, null) };
  if (rateLimited(request, perMinute))
    return { blocked: fail("E_RATE_LIMITED", "요청이 많습니다. 잠시 후 다시 시도해 주세요.", true, {}, origin) };
  return { origin };
}

export async function readBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return { err: "E_INPUT_INVALID" };
  try { return { body: JSON.parse(raw) }; } catch { return { err: "E_INPUT_INVALID" }; }
}

/* 아이솔레이트 메모리 속도 제한. IP 단위와 아이솔레이트 전체 단위를 함께 본다.
 * ponytail: 아이솔레이트 단위라 전역 정확도가 없다 — 콜로가 여러 개면 그만큼 곱해진다.
 * 정확한 전역 제한이 필요해지면 KV 나 Durable Object 로 올린다. 그 전의 실질 상한은
 * 제공자 쪽 지출 한도다. */
const hits = new Map();
let burst = [];
const WINDOW = 60_000;
const ISOLATE_PER_MINUTE = 60;   // 한 아이솔레이트가 1분에 넘기지 않는 총량

export function rateLimited(request, perMinute) {
  const ip = request.headers.get("cf-connecting-ip") || "?";
  const now = Date.now();

  burst = burst.filter((t) => now - t < WINDOW);
  if (burst.length >= ISOLATE_PER_MINUTE) return true;

  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW);
  if (list.length >= perMinute) { hits.set(ip, list); return true; }

  list.push(now);
  hits.set(ip, list);
  burst.push(now);
  if (hits.size > 5000) hits.clear();   // 메모리 상한. 아이솔레이트는 어차피 오래 살지 않는다
  return false;
}

export async function callOpenAI(env, payload, timeoutMs) {
  if (!env.OPENAI_API_KEY) throw new Error("no key");
  const base = env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: env.OPENAI_MODEL || "gpt-4o-mini", ...payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`upstream ${r.status}`);   // 본문은 읽지 않는다. 로그에 남기지 않는다
  const d = await r.json();
  return d.choices?.[0]?.message?.content ?? "";
}

/* ── 검증층 ────────────────────────────────────────────────────────────────
 * LLM 출력은 검증층을 통과하기 전까지 데이터가 아니라 주장이다. */

/** 법 결론 금칙어. 이 서비스가 쓰면 그 순간 법률 자문이 된다. */
const FORBIDDEN = [
  "무효", "위법", "불법", "승소", "패소", "위반입니다", "위반이며", "청구할 수 있습니다",
  "손해배상을 받을", "고소", "고발", "소송을 제기하면", "법적으로 가능합니다", "법적 효력이 있습니다",
  "권리가 있습니다", "의무가 있습니다", "확정적으로", "반드시 이깁니다",
  // 표기 규칙: "미사용" 이 아니라 "행사 기록 없음" 이다 (02-SPEC DR2)
  "미사용", "미행사",
];

export const hasForbidden = (text) => FORBIDDEN.find((w) => text.includes(w)) || null;

/* 조문 표기. 숫자를 허용 목록에 넣어 검사를 느슨하게 만드는 대신, 조문 자리의 숫자만 스캔에서 뺀다.
 * "제7조"의 7은 통과하고 "7,000만원"의 7000은 걸린다. */
const STATUTE = /제\s?\d+\s?조(?:의\s?\d+)?|제\s?\d+\s?항|제\s?\d+\s?호/g;

/* 모델이 쓴 문장에 숫자가 있는가. 숫자 문장은 전부 코드가 쓰므로, 있으면 그 문장을 버린다.
 * ASCII 만 보면 전각 "１２３" 이 그대로 통과한다 — \p{Nd} 로 십진 숫자 전부를 본다.
 * 한글 수사는 단위에 붙은 것만 본다. "이 글", "만나서" 의 이·만까지 잡으면 정상 문장이 남지 않는다. */
const DIGIT = /\p{Nd}/u;
const KO_MONEY = /[일이삼사오육칠팔구십백천만억][억만천]?\s?원/;
export const hasDigits = (s) => {
  const t = String(s).replace(STATUTE, " ");
  return DIGIT.test(t) || KO_MONEY.test(t);
};

/** 자릿수 사고 탐지 (04-API §5.4.2). confidence 는 통과 근거로 쓰지 않는다 —
 *  실측에서 "구억육천만원"을 9,600 으로 읽고도 0.98 을 냈다. 탈락시킬 때만 쓴다. */
export function rangeCheck(parsed) {
  const cur = parsed.cur_deposit_manwon, nw = parsed.new_deposit_manwon;
  const bad = (v) => v != null && !(v >= 1 && v <= 500000);
  if (bad(cur) || bad(nw)) return "E_VALUE_OUT_OF_RANGE";
  if (cur > 0 && nw > 0) {
    const rate = ((nw - cur) / cur) * 100;
    if (rate < -50 || rate > 200) return "E_VALUE_OUT_OF_RANGE";
  }
  if (parsed.new_monthly_manwon != null && !(parsed.new_monthly_manwon >= 0 && parsed.new_monthly_manwon <= 1000))
    return "E_VALUE_OUT_OF_RANGE";
  return null;
}
