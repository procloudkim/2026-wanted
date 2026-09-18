/* POST /api/parse — 조건 문장을 계산 입력 JSON 으로 바꾼다.
 *
 * 이 함수는 판정하지 않는다. 응답 스키마에 백분위·인상률·판정이 들어갈 자리가 없다.
 * 출력은 조회 키와 사용자 입력값으로만 쓰이고, 판정은 브라우저가 집계 자산으로 한다.
 */
import { json, fail, readBody, rateLimited, callOpenAI, rangeCheck } from "./_llm.js";

const SYSTEM = `너는 한국 전월세 계약 문장에서 값을 뽑아내는 추출기다. 판정하지 않는다.

규칙:
- 문장에 적힌 값만 뽑는다. 없는 값은 null 로 둔다. 추정하지 않는다.
- 금액 단위는 만원 정수다. "3억5천" = 35000, "6억" = 60000, "구억육천만원" = 96000.
  한글 수사는 자릿수를 특히 조심한다. 억 = 10000만원이다.
- "전세"면 월세는 0 이다. 월세가 언급되면 그 값을 넣는다.
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

export async function onRequestPost({ request, env }) {
  if (rateLimited(request, 10))
    return fail("E_RATE_LIMITED", "요청이 많습니다. 잠시 후 다시 시도해 주세요.", true);

  const { body, err } = await readBody(request);
  if (err) return fail(err, "입력이 너무 길거나 형식이 맞지 않습니다.");

  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text || text.length > 2000)
    return fail("E_INPUT_INVALID", "문장은 1자에서 2,000자 사이로 넣어 주세요.", false, { parsed: EMPTY });

  const hint = typeof body?.hint?.sgg_nm === "string" ? body.hint.sgg_nm.slice(0, 20) : null;

  let parsed;
  try {
    const content = await callOpenAI(env, {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: hint ? `[자치구: ${hint}]\n${text}` : text },
      ],
      response_format: { type: "json_schema", json_schema: SCHEMA },
    }, 10_000);
    parsed = { ...EMPTY, ...JSON.parse(content) };
  } catch {
    // 제공자 장애·타임아웃. 핵심 기능은 그대로 동작하므로 수동 입력 폼으로 보낸다.
    return fail("E_UPSTREAM", "문장을 자동으로 읽지 못했습니다. 직접 넣어 주세요.", true, { parsed: EMPTY });
  }

  // 방어선 2 — 자릿수 사고 탐지. confidence 는 통과 근거로 쓰지 않는다.
  const range = rangeCheck(parsed);
  if (range)
    return fail(range, "읽어 낸 금액이 범위를 벗어납니다. 값을 직접 확인해 주세요.", false, { parsed });

  // 방어선 3 — 신뢰도 게이트. 탈락시킬 때만 쓴다.
  if (!(parsed.confidence >= 0.7) || parsed.new_deposit_manwon == null)
    return fail("E_PARSE_LOW_CONFIDENCE", "일부 조건을 읽지 못했습니다. 아래에 직접 넣어 주세요.", false, { parsed });

  return json({ ok: true, parsed, warnings: parsed.missing || [] });
}

export const onRequest = () => fail("E_INPUT_INVALID", "POST 로 보내 주세요.");
