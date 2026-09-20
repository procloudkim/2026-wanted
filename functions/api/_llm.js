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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ""; } };

export function allowedOrigin(request) {
  const o = request.headers.get("origin");
  if (!o) return null;
  let u;
  try { u = new URL(o); } catch { return null; }
  if (u.protocol === "https:" && (o === ORIGIN_EXACT || u.hostname.endsWith(ORIGIN_SUFFIX))) return o;

  // 로컬 개발 예외는 **요청 자체가 로컬에서 서비스될 때만** 연다.
  // 배포본이 localhost 오리진을 받으면 이용자 기기에서 도는 아무 페이지나 우리 키를 쓴다 —
  // 브라우저는 오리진을 못 속이지만 로컬 개발 서버의 페이지는 진짜로 그 오리진을 갖는다.
  // 실측(2026-09-18): 배포본이 http://localhost:3000 과 ftp://localhost 를 통과시켰다.
  if ((u.protocol === "http:" || u.protocol === "https:")
      && LOCAL_HOSTS.has(u.hostname) && LOCAL_HOSTS.has(hostOf(request.url))) return o;
  return null;
}

const cors = (origin) => (origin
  ? { "access-control-allow-origin": origin, "vary": "Origin" }
  : { "vary": "Origin" });

/** 성공·실패 모두 HTTP 200. 오류는 본문 code 로 전달한다(04-API §7.4).
 *  클라이언트 분기를 한 곳으로 모으기 위해서다 — 네트워크 실패와 ok:false 둘만 구분하면 된다. */
/* dist/_headers 는 **정적 자산에만** 적용된다 — 함수 응답에는 우리가 직접 붙여야 한다.
 * 실측(2026-09-18): /api/* 응답에 이 중 셋만 있었고 HSTS·CSP·프레임·COOP/CORP·권한 정책이 없었다.
 * README 보안 절은 여섯 종이 붙는다고 적고 있었으므로, 문서가 아니라 코드를 맞춘다. */
const SECURITY = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()",
};

export const json = (body, origin = null, extra = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...SECURITY,
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
      ? { ...SECURITY, ...cors(origin), "access-control-allow-methods": "POST",
          "access-control-allow-headers": "content-type", "access-control-max-age": "86400" }
      : { ...SECURITY, vary: "Origin" },
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

/* ── 운영 신호 ──────────────────────────────────────────────────────────────
 * 로그를 켜는 것이 아니라 **내용 없는 집계**를 켠다. 우리가 내보내는 줄은 {ev, code, ms} 뿐이고
 * 사용자 문장·금액·오리진은 거기 들어가지 않는다.
 *
 * 다만 정확히 적는다 — Pages 의 tail 봉투에는 **플랫폼이** 요청 URL·메서드·헤더를 함께 싣고
 * 그중에 cf-connecting-ip 가 있다. 우리가 넣는 것이 아니고 보관되지도 않지만 "아무것도 안 보인다"는
 * 아니다. 요청 **본문은 봉투에 없다**(2026-09-19 실측: 붙여넣은 문장이 tail 에 0건).
 *
 * 왜 필요한가: 오리진 차단도, 속도 제한 발동도, 업스트림 실패도 실제로 일어나는데
 * 흔적이 0이라 사후에 볼 것이 없었다(06-NIST-REVIEW §4-A). Pages 는 이 줄을
 * `wrangler pages deployment tail` 로 흘려보내고 **보관하지 않는다** — 보존하지 않으면서
 * 볼 수는 있는 상태가 이 제품의 약속과 맞는다.
 *
 * ponytail: 집계가 아니라 스트림이라 지표를 누적하지 못한다. 누적이 필요해지면
 * Analytics Engine 바인딩을 붙인다. 그 전까지는 이 한 줄이 0과 1의 차이다. */
export const emit = (ev, code, t0) => {
  try { console.log(JSON.stringify({ ev, code, ms: Date.now() - t0 })); } catch { /* 신호 때문에 요청이 죽지 않는다 */ }
};

/* 본문을 **바이트로 세면서** 읽고 상한을 넘으면 그 자리에서 끊는다.
 * 실측(2026-09-19): 예전 구현은 `raw.length`(UTF-16 코드 단위)를 셌다. 한글 16,000자는
 * length 16,000 이지만 실제로는 48,000 바이트다 — 적어 둔 16KB 의 3배가 통과했다.
 * 게다가 본문을 전부 버퍼에 담은 뒤에 재고 있었다. 이제 초과하는 순간 reader 를 취소한다.
 * 플랫폼 요청 상한이 앞에 하나 더 있지만, 그것은 우리 계약이 아니다. */
export async function readBody(request) {
  let raw;
  const stream = request.body;
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BODY) { await reader.cancel(); return { err: "E_INPUT_INVALID" }; }
        chunks.push(value);
      }
    } catch { return { err: "E_INPUT_INVALID" }; }
    const all = new Uint8Array(bytes);
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.byteLength; }
    raw = new TextDecoder().decode(all);
  } else {
    // 스트림이 없는 환경(일부 테스트 런타임)에서는 읽은 뒤 바이트로 잰다.
    raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY) return { err: "E_INPUT_INVALID" };
  }
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
    /* 기본값은 **평가로 채택한 모델**이어야 한다(04-API §5.9). 예전 기본값 gpt-4o-mini 는
     * 골든셋 6종 비교에 들어간 적이 없어, 시크릿이 지워지면 평가되지 않은 모델로 조용히
     * 바뀌었다 — 화면에도 로그에도 신호가 남지 않는다. Pages 시크릿이 기존 배포에 어떻게
     * 전파되는지가 문서화돼 있지 않으므로 가정에 기대 둘 자리가 아니다. */
    body: JSON.stringify({ model: env.OPENAI_MODEL || "gpt-5.4-mini", ...payload }),
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
 * "제7조"의 7은 통과하고 "7,000만원"의 7000은 걸린다.
 *
 * 면제는 **이 서비스가 실제로 인용하는 조문에만** 준다. 아무 "제N조"나 빼 주면 모델이
 * 조문 번호를 틀리게 써도 숫자 검사·금칙어 검사 어느 쪽에도 걸리지 않는다 —
 * 틀린 조문은 틀린 숫자보다 고치기 어렵다(사용자가 검산할 수 없다).
 * 목록 밖 조문은 숫자가 남아 hasDigits 에 걸리고 문안이 통째로 폐기된다. */
const STATUTE = /제\s?6\s?조의\s?3|제\s?7\s?조|제\s?1\s?항|제\s?8\s?호/g;

/* 모델이 쓴 문장에 숫자가 있는가. 숫자 문장은 전부 코드가 쓰므로, 있으면 그 문장을 버린다.
 * ASCII 만 보면 전각 "１２３" 이 그대로 통과한다 — \p{Nd} 로 십진 숫자 전부를 본다.
 * 한글 수사는 단위에 붙은 것만 본다. "이 글", "만나서" 의 이·만까지 잡으면 정상 문장이 남지 않는다. */
const DIGIT = /\p{Nd}/u;
const KO_MONEY = /[일이삼사오육칠팔구십백천만억][억만천]?\s?원/;
export const hasDigits = (s) => {
  const t = String(s).replace(STATUTE, " ");
  return DIGIT.test(t) || KO_MONEY.test(t);
};

/** 면적 계약 (02-SPEC §2, `#area` 의 min/max 와 같은 값).
 *  **숫자가 아니면 받지 않는다.** 스키마가 number 라고 선언했으므로 "84.9" 같은 숫자 문자열도
 *  계약 위반이다 — 관대한 강제 변환은 형 검사가 아니다.
 *  실측(2026-09-19): 이 검사가 없어서 모델이 돌려준 문자열이 그대로 확인 줄의 innerHTML 로 갔다.
 *  범위를 벗어난 숫자(3000)도 그대로 판정 입력 후보가 됐다. */
export const areaM2 = (v) =>
  (typeof v === "number" && Number.isFinite(v) && v >= 10 && v <= 300 ? v : null);

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
