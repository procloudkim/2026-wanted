/* POST /api/parse — 조건 문장을 계산 입력 JSON 으로 바꾼다.
 *
 * 이 함수는 판정하지 않는다. 응답 스키마에 백분위·인상률·판정이 들어갈 자리가 없다.
 * 출력은 조회 키와 사용자 입력값으로만 쓰이고, 판정은 브라우저가 집계 자산으로 한다.
 */
import { json, fail, readBody, gate, preflight, callOpenAI, rangeCheck, areaM2, emit } from "./_llm.js";

const SYSTEM = `너는 한국 전월세 계약 문장에서 값을 뽑아내는 추출기다. 판정하지 않는다.

규칙:
- 문장에 적힌 값만 뽑는다. 없는 값은 null 로 둔다. 추정하지 않는다.
- 금액 단위는 만원 정수다. "3억5천" = 35000, "6억" = 60000, "구억육천만원" = 96000.
  한글 수사는 자릿수를 특히 조심한다. 억 = 10000만원이다.
- "전세"면 월세는 0 이다. 월세가 언급되면 그 값을 넣는다.
- 한쪽만 바뀐다고 말하면 나머지는 **현재 값과 같게 둔다.** "월세만 65로" → 제시 보증금 = 현재 보증금.
  "보증금은 그대로 두고 월세 60" → 제시 보증금 = 현재 보증금. 이것은 추정이 아니라 문장이 말한 내용이다.
- 여러 금액이 나오면 **현재 계약의 값과 제시받은 값**만 고른다. 과거 계약 금액·관리비·주차비는 넣지 않는다.
- 면적이 평으로 적혀 있으면 ㎡ 로 바꾼다(1평 = 3.3058㎡).
- 판정·해석·조언을 쓰지 않는다. 필드 값에 문장을 넣지 않는다.`;

const SCHEMA = {
  name: "rent_conditions",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sgg_nm: { type: ["string", "null"], description: "자치구명. 예: 마포구" },
      umd_nm: { type: ["string", "null"], description: "법정동명. 예: 성산동" },
      bldg_nm: { type: ["string", "null"], description: "건물·단지명" },
      area_m2: { type: ["number", "null"], description: "전용면적 ㎡" },
      rent_type: { type: ["string", "null"], enum: ["전세", "월세", null] },
      cur_deposit_manwon: { type: ["integer", "null"], description: "현재 보증금(만원)" },
      cur_monthly_manwon: { type: ["integer", "null"], description: "현재 월세(만원)" },
      new_deposit_manwon: { type: ["integer", "null"], description: "제시받은 보증금(만원)" },
      new_monthly_manwon: { type: ["integer", "null"], description: "제시받은 월세(만원)" },
      rr_right_used_before: { type: ["boolean", "null"] },
      confidence: { type: "number" },
      missing: { type: "array", items: { type: "string" } },
    },
    required: ["sgg_nm", "umd_nm", "bldg_nm", "area_m2", "rent_type",
      "cur_deposit_manwon", "cur_monthly_manwon", "new_deposit_manwon",
      "new_monthly_manwon", "rr_right_used_before", "confidence", "missing"],
  },
};

const EMPTY = Object.fromEntries(SCHEMA.schema.required.map((k) =>
  [k, k === "confidence" ? 0 : k === "missing" ? [] : null]));

/* 응답에는 화면이 쓰는 네 칸만 싣는다. 스키마의 나머지(자치구·건물명 같은 자유 문자열, missing)는
 * 모델 평가의 전제라 그대로 두되 밖으로 내보내지 않는다. 내보내면 이 함수가 우리 비용으로 도는 범용
 * 문장 생성기가 된다 — 모델이 bldg_nm 에 쓴 2만 6천 자가 그대로 돌아왔다(2026-10-25 감사, 로컬 시험). */
const FIELDS = new Set(SCHEMA.schema.required);
const int = (v) => (Number.isInteger(v) ? v : null);
const pick = (p) => ({ cur_deposit_manwon: int(p.cur_deposit_manwon), new_deposit_manwon: int(p.new_deposit_manwon),
                       new_monthly_manwon: int(p.new_monthly_manwon), area_m2: areaM2(p.area_m2) });
const warn = (p) => (Array.isArray(p.missing) ? p.missing : []).filter((k) => FIELDS.has(k));   // 아는 필드 이름만

export async function onRequestPost({ request, env }) {
  const t0 = Date.now();
  const done = (code, res) => { emit("parse", code, t0); return res; };

  const { origin, blocked } = gate(request, 10, "parse");
  if (blocked) return done("E_GATE", blocked);

  const { body, err } = await readBody(request);
  if (err) return done(err, fail(err, "입력이 너무 길거나 형식이 맞지 않습니다.", false, {}, origin));

  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text || text.length > 2000)
    return done("E_INPUT_INVALID", fail("E_INPUT_INVALID", "문장은 1자에서 2,000자 사이로 넣어 주세요.", false, { parsed: pick(EMPTY) }, origin));

  const hint = typeof body?.hint?.sgg_nm === "string" ? body.hint.sgg_nm.slice(0, 20) : null;

  let parsed;
  try {
    const content = await callOpenAI(env, {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: hint ? `[자치구: ${hint}]\n${text}` : text },
      ],
      response_format: { type: "json_schema", json_schema: SCHEMA },
      // 출력이 프롬프트 길이에 묶이지 않는다. 실측 출력 97~133토큰(04-API §5.8)의 약 3배에서 끊는다
      max_completion_tokens: 400,
    }, 10_000);
    parsed = { ...EMPTY, ...JSON.parse(content) };
  } catch {
    // 제공자 장애·타임아웃. 핵심 기능은 그대로 동작하므로 수동 입력 폼으로 보낸다.
    return done("E_UPSTREAM", fail("E_UPSTREAM", "문장을 자동으로 읽지 못했습니다. 직접 넣어 주세요.", true, { parsed: pick(EMPTY) }, origin));
  }

  // 방어선 2 — 면적 형·범위 계약. 금액과 달리 응답 전체를 버리지 않는다.
  // 면적은 사용자가 직접 넣을 수 있는 보조 값이고, 하나 때문에 맞는 금액까지 수동 입력으로
  // 보내면 손해가 더 크다. 대신 **지어내지 않는다** — 계약 밖이면 null 로 내려 "그대로 둡니다"가
  // 되고, 무엇을 버렸는지 missing 에 남긴다(조용히 0이 되지 않는다).
  if (parsed.area_m2 != null && areaM2(parsed.area_m2) == null) {
    // 모델이 missing 에 이미 적어 두고 값도 함께 보내는 경우가 있다 — 중복을 만들지 않는다.
    parsed.missing = [...new Set([...(Array.isArray(parsed.missing) ? parsed.missing : []), "area_m2"])];
    parsed.area_m2 = null;
  } else {
    parsed.area_m2 = areaM2(parsed.area_m2);
  }

  // 방어선 3 — 자릿수 사고 탐지. confidence 는 통과 근거로 쓰지 않는다.
  const range = rangeCheck(parsed);
  if (range)
    return done(range, fail(range, "읽어 낸 금액이 범위를 벗어납니다. 값을 직접 확인해 주세요.", false, { parsed: pick(parsed) }, origin));

  // 방어선 4 — 신뢰도 게이트. 탈락시킬 때만 쓴다.
  if (!(parsed.confidence >= 0.7) || parsed.new_deposit_manwon == null)
    return done("E_PARSE_LOW_CONFIDENCE", fail("E_PARSE_LOW_CONFIDENCE", "일부 조건을 읽지 못했습니다. 아래에 직접 넣어 주세요.", false, { parsed: pick(parsed) }, origin));

  return done("ok", json({ ok: true, parsed: pick(parsed), warnings: warn(parsed) }, origin));
}

export const onRequestOptions = ({ request }) => preflight(request);
export const onRequest = () => fail("E_INPUT_INVALID", "POST 로 보내 주세요.");
