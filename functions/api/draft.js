/* POST /api/draft — 회신 문안의 인사말과 맺음말만 만든다.
 *
 * 왜 이것만 맡기는가: 모델에게 숫자 문장을 재서술시키면 숫자가 맞아도 라벨이 바뀐다.
 * 실측에서 코호트 전체 316건을 "행사 기록이 있는 316건"으로, 5% 상한액 9억 4,500만원을
 * "제시된 보증금"으로 바꿔 썼다. 숫자 화이트리스트는 이런 오류를 잡지 못한다.
 * 그래서 숫자가 들어간 문장은 전부 브라우저의 코드가 쓰고, 이 함수는 그 앞뒤만 쓴다.
 * 검증은 그래서 단순해진다 — 모델이 쓴 문장에 숫자가 하나라도 있으면 버린다.
 */
import { json, fail, readBody, gate, preflight, callOpenAI, hasForbidden, hasDigits, emit } from "./_llm.js";

const SYSTEM = `너는 한국 세입자가 집주인에게 보낼 회신의 **인사말과 맺음말**을 쓴다.
본문(숫자와 근거)은 이미 만들어져 있고 너는 보지 않는다.

절대 규칙:
- **숫자를 쓰지 않는다.** 금액·비율·건수·날짜·기간을 한 글자도 쓰지 않는다.
  조문 이름(주택임대차보호법 제6조의3, 제7조)만 예외로 쓸 수 있다.
- 법 결론을 쓰지 않는다: "무효", "위법", "승소", "권리가 있습니다", "청구할 수 있습니다" 금지.
- "미사용"·"미행사"라고 쓰지 않는다.
- 정중하고 사무적인 존댓말. 감정적 표현·비난·협박을 쓰지 않는다.
- opening 은 1~2문장. 인사와 이 글을 보내는 이유만.
- closing 은 1~2문장. 회신 요청과 맺음 인사만.`;

const SCHEMA = {
  name: "draft_frame",
  strict: true,
  schema: {
    type: "object", additionalProperties: false,
    properties: { opening: { type: "string" }, closing: { type: "string" } },
    required: ["opening", "closing"],
  },
};

const CHOICES = { 행사: "계약갱신요구권을 행사하려 한다", 합의: "제시하신 조건으로 합의 갱신을 검토하고 있다",
                  무행동: "조건을 확인하는 중이다" };

export async function onRequestPost({ request, env }) {
  const t0 = Date.now();
  const done = (code, res) => { emit("draft", code, t0); return res; };

  const { origin, blocked } = gate(request, 5, "draft");
  if (blocked) return done("E_GATE", blocked);

  const { body, err } = await readBody(request);
  if (err) return done(err, fail(err, "입력이 너무 길거나 형식이 맞지 않습니다.", false, {}, origin));

  const tone = body?.tone === "soft" ? "soft" : "neutral";
  // "constructor"·"__proto__" 같은 상속 키가 입장이 되지 않게 자기 키만 본다
  const stance = Object.hasOwn(CHOICES, body?.choice) ? CHOICES[body.choice] : CHOICES["무행동"];

  try {
    const content = await callOpenAI(env, {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `어조: ${tone === "soft" ? "부드럽게" : "사무적으로"}\n보내는 사람의 입장: ${stance}` },
      ],
      response_format: { type: "json_schema", json_schema: SCHEMA },
      max_completion_tokens: 1000,   // 실측 출력 356토큰(04-API §5.8)의 약 3배
    }, 15_000);
    const f = JSON.parse(content);
    const text = `${f.opening}\n${f.closing}`;

    const reject = (reason) =>
      done(reason, json({ ok: true, frame: null, verified: false, source: "template", reason }, origin));
    if (hasDigits(text)) return reject("numbers");
    if (hasForbidden(text)) return reject("forbidden");
    if (!f.opening.trim() || !f.closing.trim() || text.length > 600) return reject("shape");

    return done("ok", json({ ok: true, frame: f, verified: true, source: "llm" }, origin));
  } catch {
    return done("upstream", json({ ok: true, frame: null, verified: false, source: "template", reason: "upstream" }, origin));
  }
}

export const onRequestOptions = ({ request }) => preflight(request);
export const onRequest = () => fail("E_INPUT_INVALID", "POST 로 보내 주세요.");
