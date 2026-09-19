/* 검증층 검증. 네트워크·키 없이 돈다.  실행: node scripts/test_verify.mjs */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { hasDigits, hasForbidden, rangeCheck, areaM2, allowedOrigin, gate, json, readBody, MAX_BODY } from "../functions/api/_llm.js";
import { onRequestPost as parsePost } from "../functions/api/parse.js";

/* 검사를 **순차로** 돌린다. 비동기 검사가 globalThis.fetch 를 바꾸므로 동시에 돌면 서로 덮는다
 * (실측: 세 검사가 겹쳐 힌트 검사가 남의 스텁을 받았다). 실패는 검사 이름과 함께 던진다. */
/* 검사 요청마다 다른 cf-connecting-ip 를 준다. 같은 키를 쓰면 **제품의 속도 제한**(분당 10회)에
 * 검사가 걸려서 뒤쪽 검사가 조용히 E_GATE 를 받는다(실측으로 한 번 당했다). */
let ip = 0;
let n = 0; let chain = Promise.resolve();
const t = (name, fn) => { n++; chain = chain.then(async () => {
  try { await fn(); } catch (e) { throw new Error(`${name}: ${e.message}`); } }); };

const FACTS = {
  asof: "2026-09-18", deadline: "2026-10-20", d_day: 32,
  cur_deposit_manwon: 60000, new_deposit_manwon: 64800,
  cap_deposit_manwon: 63000, excess_manwon: 1800, rate_pct: 8.0,
  cohort: { label: "마포구 성산동 성산시영 전용 50-60㎡", n: 312, median_pct: 5.0, p90_pct: 11.9, top_share_pct: 2.0 },
  groups: { total_n: 85691, recorded: { n: 40814, over_cap_share_pct: 0.37 },
            unrecorded: { n: 44877, over_cap_share_pct: 31.95, excess_median: 2400 } },
};

t("오리진 경계 — 우리 페이지 말고는 이 함수를 부를 수 없다", () => {
  const PROD = "https://gaengsin-baseline.pages.dev/api/draft";
  const LOCAL = "http://localhost:8788/api/draft";
  const ok = (o, url = PROD) =>
    allowedOrigin({ url, headers: { get: (k) => (k === "origin" ? o : null) } });

  assert.equal(ok("https://gaengsin-baseline.pages.dev"), "https://gaengsin-baseline.pages.dev");
  assert.equal(ok("https://4a5e40c6.gaengsin-baseline.pages.dev"), "https://4a5e40c6.gaengsin-baseline.pages.dev");

  // 이 넷을 막지 못하면 남의 사이트가 우리 OpenAI 키를 쓴다
  assert.equal(ok("https://evil.example"), null);
  assert.equal(ok(null), null);                                        // curl 처럼 오리진 없는 요청
  assert.equal(ok("https://gaengsin-baseline.pages.dev.evil.com"), null);  // 접두어 흉내
  assert.equal(ok("http://gaengsin-baseline.pages.dev"), null);        // https 가 아니다
  assert.equal(ok("not a url"), null);

  // 로컬 개발 예외는 **요청 자체가 로컬로 들어올 때만** 열린다.
  // 실측(2026-09-18): 배포본이 http://localhost:3000 과 ftp://localhost 를 통과시켰다.
  // 브라우저는 오리진을 못 속이지만, 이용자 기기의 로컬 개발 서버 페이지는 진짜 그 오리진이다.
  assert.equal(ok("http://localhost:8788", LOCAL), "http://localhost:8788");
  assert.equal(ok("http://127.0.0.1:8788", LOCAL), "http://127.0.0.1:8788");
  assert.equal(ok("http://localhost:3000", PROD), null, "배포본이 localhost 오리진을 받으면 안 된다");
  assert.equal(ok("http://localhost", PROD), null);
  assert.equal(ok("https://127.0.0.1", PROD), null);
  assert.equal(ok("ftp://localhost", LOCAL), null, "http(s) 가 아닌 스킴은 로컬에서도 막는다");
});

t("함수 응답에도 정적 자산과 같은 보안 헤더가 붙는다", () => {
  // dist/_headers 는 정적 자산에만 적용된다. 실측(2026-09-18)에서 /api/* 응답에는 셋뿐이었다.
  const h = json({ ok: true }, "https://gaengsin-baseline.pages.dev").headers;
  for (const k of ["strict-transport-security", "x-frame-options", "content-security-policy",
                   "cross-origin-opener-policy", "cross-origin-resource-policy",
                   "permissions-policy", "x-content-type-options", "referrer-policy"])
    assert.ok(h.get(k), `${k} 가 함수 응답에 없다`);
  assert.equal(h.get("cache-control"), "no-store");
  assert.match(h.get("content-security-policy"), /frame-ancestors 'none'/);
});

t("gate 는 오리진을 먼저 보고, 통과해야 속도 제한을 센다", () => {
  const mk = (o, ip) => ({ url: "https://gaengsin-baseline.pages.dev/api/draft",
                           headers: { get: (k) => (k === "origin" ? o : k === "cf-connecting-ip" ? ip : null) } });
  const bad = gate(mk("https://evil.example", "1.1.1.1"), 5);
  assert.ok(bad.blocked);
  assert.equal(bad.origin, undefined);

  const good = gate(mk("https://gaengsin-baseline.pages.dev", "2.2.2.2"), 5);
  assert.equal(good.origin, "https://gaengsin-baseline.pages.dev");
  assert.equal(good.blocked, undefined);

  // 같은 IP 로 한도를 넘기면 막힌다
  let hit = null;
  for (let i = 0; i < 10 && !hit; i++) {
    const r = gate(mk("https://gaengsin-baseline.pages.dev", "3.3.3.3"), 5);
    if (r.blocked) hit = i;
  }
  assert.equal(hit, 5, "6번째 요청에서 막혀야 한다");
});

t("모델이 쓴 문장에 숫자가 있으면 버린다", () => {
  // 숫자 문장은 전부 코드가 쓴다. 모델은 인사말·맺음말만 쓰고 거기에 숫자가 있으면 폐기한다.
  assert.equal(hasDigits("안녕하세요. 계약 갱신 조건에 관해 회신드립니다."), false);
  // 조문 이름은 예외다 — 그 자리의 숫자만 스캔에서 뺀다
  assert.equal(hasDigits("주택임대차보호법 제6조의3, 제7조에 따라 회신드립니다."), false);
  assert.equal(hasDigits("같은 법 제6조의3 제1항 제8호를 참고했습니다."), false);
  // '제' 없는 호수는 예외로 두지 않는다 — 동·호수는 애초에 받지 않는 값이라 문안에 나올 이유가 없다
  assert.equal(hasDigits("단서 8호를 참고했습니다."), true);
  // 면제는 이 서비스가 인용하는 조문에만. 아무 조문이나 빼 주면 틀린 조문이 그대로 나간다.
  assert.equal(hasDigits("주택임대차보호법 제9조에 따라 회신드립니다."), true);
  assert.equal(hasDigits("민법 제618조를 참고했습니다."), true);
  // 그 밖의 숫자는 전부 걸린다
  assert.equal(hasDigits("보증금 7,000만원을 제안합니다."), true);
  assert.equal(hasDigits("2026년 10월까지 회신드리겠습니다."), true);
  assert.equal(hasDigits("중앙값은 5%였습니다."), true);

  // ASCII 만 보면 이 둘이 그대로 통과한다 — 화면은 "숫자가 있으면 버린다"고 약속한다
  assert.equal(hasDigits("보증금 ７，０００만원을 제안합니다."), true);   // 전각 숫자
  assert.equal(hasDigits("삼억원으로 올려 주시면 합니다."), true);        // 한글 금액 표현
  assert.equal(hasDigits("만원만 조정해 주시면 합니다."), true);

  // 정상 문장의 '이·만·일'까지 잡으면 인사말이 한 줄도 남지 않는다
  assert.equal(hasDigits("이 글을 보내는 이유를 먼저 말씀드립니다."), false);
  assert.equal(hasDigits("만나 뵙고 말씀드리면 좋겠습니다. 감사합니다."), false);
});

t("법 결론 금칙어", () => {
  assert.equal(hasForbidden("제시하신 조건은 위법입니다."), "위법");
  assert.equal(hasForbidden("증액분 청구할 수 있습니다."), "청구할 수 있습니다");
  assert.equal(hasForbidden("계약갱신요구권을 미사용한 계약"), "미사용");  // DR2: "행사 기록 없음"으로 쓴다
  assert.equal(hasForbidden("행사 기록이 없는 갱신 계약에서는"), null);
  assert.equal(hasForbidden("주택임대차보호법 제6조의3에 따라 회신드립니다."), null);
});

t("자릿수 사고를 범위 검사가 잡는다 (04-API §5.4.2 실측)", () => {
  // "구억육천만원" = 96,000만원인데 모델이 9,600 으로 읽고 confidence 0.98 을 냈던 사례.
  // 종전 96,000 · 제시 9,600 이면 -90% 라 범위 밖이다.
  assert.equal(rangeCheck({ cur_deposit_manwon: 96000, new_deposit_manwon: 9600 }), "E_VALUE_OUT_OF_RANGE");
  assert.equal(rangeCheck({ cur_deposit_manwon: 0, new_deposit_manwon: 38000 }), "E_VALUE_OUT_OF_RANGE");
  assert.equal(rangeCheck({ cur_deposit_manwon: 35000, new_deposit_manwon: 900000 }), "E_VALUE_OUT_OF_RANGE");
  assert.equal(rangeCheck({ cur_deposit_manwon: 35000, new_deposit_manwon: 38000, new_monthly_manwon: 5000 }), "E_VALUE_OUT_OF_RANGE");
  // 감액 갱신은 이상치가 아니다 — 전세→전세 갱신의 10.41%가 0% 이하다
  assert.equal(rangeCheck({ cur_deposit_manwon: 50000, new_deposit_manwon: 45000 }), null);
  assert.equal(rangeCheck({ cur_deposit_manwon: 35000, new_deposit_manwon: 38000, new_monthly_manwon: 0 }), null);
});

/* ── 프롬프트·검증층 상수 동결 (criteria-v2 §3 G6) ──────────────────────────
 * 이것들이 바뀌면 저장된 모델 평가 결과가 **무효**가 된다. 조용히 바뀌지 않게 해시로 묶는다.
 * 값을 고치는 것은 자유다 — 다만 고치는 순간 이 검사가 깨져서 "평가를 다시 해야 한다"를 알린다. */
t("모델 평가의 전제(프롬프트·검증층 상수)가 동결값과 같다", () => {
  const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
  const strip = (s) => s.replace(/\/\/[^\n]*/g, "");
  const parseSrc = readFileSync(new URL("../functions/api/parse.js", import.meta.url), "utf8");
  const llmSrc = readFileSync(new URL("../functions/api/_llm.js", import.meta.url), "utf8");

  const SYSTEM = parseSrc.match(/const SYSTEM = `(.*?)`;/s)[1];
  assert.equal(sha(SYSTEM), "24d3e13a7641e7c4", "parse 의 SYSTEM 프롬프트가 바뀌었다 — 모델 평가를 다시 해야 한다");

  const required = [...parseSrc.match(/required: \[(.*?)\]/s)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(required.length, 12);
  assert.equal(sha(required.join("|")), "e1f67371ab30be6d", "parse 의 응답 스키마가 바뀌었다");

  const forbidden = [...strip(llmSrc.match(/const FORBIDDEN = \[(.*?)\];/s)[1]).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(forbidden.length, 20);
  assert.equal(sha(forbidden.join("|")), "0fc847fc8ccd9879", "금칙어 목록이 바뀌었다");

  assert.equal(sha(llmSrc.match(/const STATUTE = (\/.*?\/g);/)[1]), "bb52aa80b78bb72f", "조문 면제 패턴이 바뀌었다");
});

t("숫자 검사가 무엇을 통과시키는지 — 천장을 적어 둔다", () => {
  // 모델이 숫자를 못 쓰게 막는 것이 목적인데, 이 검사는 아라비아·전각 숫자와 한글 금액 표현만 본다.
  // 아래는 **통과한다**. 화면이 약속하지 않는 범위를 여기 고정해 두어, 나중에 넓힐 때 무엇이 남았는지 보이게 한다.
  for (const s of ["일억 정도로 알고 있습니다", "보증금을 두 배로", "다음 달 말일까지", "③억 수준으로"])
    assert.equal(hasDigits(s), false, `천장이 바뀌었다(이제 걸린다): ${s}`);
  for (const s of ["삼억오천만원", "１２３만원", "제10조", "35,000만원"])
    assert.equal(hasDigits(s), true, `막아야 하는데 통과한다: ${s}`);
  // draft 모델은 숫자도 판정 딕셔너리도 받지 않으므로(draft.js), 통과한 수량 표현은 전부 지어낸 것이다.
});

t("면적 계약 — 숫자가 아니면 받지 않는다", () => {
  // 실측 결함(F-12): 이 검사가 없어서 모델이 돌려준 값이 형·범위 검사 없이
  // 확인 줄의 innerHTML 과 판정 입력 후보로 갔다.
  for (const v of [10, 59.94, 84.9, 300]) assert.equal(areaM2(v), v, `정상 면적을 버린다: ${v}`);
  for (const v of [null, undefined, 0, 9.99, 300.01, -50, NaN, Infinity,
                   "84.9", "<img src=x onerror=BAD>", true, false, [84.9], { v: 84.9 }])
    assert.equal(areaM2(v), null, `계약 밖인데 통과한다: ${JSON.stringify(v)}`);
  // 숫자 문자열도 계약 위반이다. 스키마가 number 라고 선언했고, 관대한 강제 변환은 형 검사가 아니다.
});

t("parse 응답의 면적은 계약을 지난 값만 나간다 — 실제 핸들러", async () => {
  // 실제 onRequestPost 를 부른다. 네트워크·키 0: 전송만 합성 응답으로 바꾼다.
  const REQ = ["sgg_nm","umd_nm","bldg_nm","area_m2","rent_type","cur_deposit_manwon",
    "cur_monthly_manwon","new_deposit_manwon","new_monthly_manwon","rr_right_used_before","confidence","missing"];
  const ORIGIN = "https://gaengsin-baseline.pages.dev";
  const real = globalThis.fetch;
  const ask = async (area) => {
    const out = Object.fromEntries(REQ.map((k) => [k, null]));
    Object.assign(out, { cur_deposit_manwon: 35000, new_deposit_manwon: 38000,
      new_monthly_manwon: 0, confidence: 0.95, missing: [], area_m2: area });
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(out) } }] }), { status: 200 });
    const request = new Request(`${ORIGIN}/api/parse`, { method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": `t${ip++}` },
      body: JSON.stringify({ text: "전세 3억5천인데 3억8천으로 올려달라고 하시네요" }) });
    return (await parsePost({ request, env: { OPENAI_API_KEY: "sk-dummy" } })).json();
  };
  try {
    const ok = await ask(84.9);
    assert.equal(ok.parsed.area_m2, 84.9, "정상 면적을 버린다");
    assert.ok(!ok.warnings.includes("area_m2"), "정상인데 버렸다고 적는다");
    for (const bad of ["<img src=x onerror=BAD>", "84.9", 3000, true, { a: 1 }]) {
      const r = await ask(bad);
      assert.equal(r.ok, true, "면적 하나 때문에 맞는 금액까지 버린다");
      assert.equal(r.parsed.area_m2, null, `계약 밖 면적이 그대로 나간다: ${JSON.stringify(bad)}`);
      assert.equal(r.parsed.new_deposit_manwon, 38000, "금액이 함께 망가졌다");
      assert.ok(r.warnings.includes("area_m2"), "버린 사실을 조용히 숨긴다");
    }
    const none = await ask(null);
    assert.equal(none.parsed.area_m2, null);
    assert.ok(!none.warnings.includes("area_m2"), "원래 null 인 것을 버렸다고 적는다");
  } finally { globalThis.fetch = real; }
});

t("본문 상한은 문자 수가 아니라 바이트로 센다", async () => {
  // 실측 결함: 예전 구현은 raw.length(UTF-16 코드 단위)를 셌다. 한글 16,000자는 length 16,000
  // 이지만 48,000 바이트다 — 적어 둔 16KB 의 3배가 통과했다.
  const enc = new TextEncoder();
  const mk = (body, headers = {}) => new Request("https://x/api/parse",
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  const pad = (bytes, ch) => {
    const shell = enc.encode(JSON.stringify({ text: "" })).byteLength;
    return JSON.stringify({ text: ch.repeat(Math.max(0, Math.floor((bytes - shell) / enc.encode(ch).byteLength))) });
  };
  const at = pad(MAX_BODY, "a");
  assert.equal(enc.encode(at).byteLength, MAX_BODY, "경계 본문을 정확히 만들지 못했다");
  assert.ok(!(await readBody(mk(at))).err, "상한과 같은 크기를 막는다");
  assert.equal((await readBody(mk(at.replace('"}', 'a"}')))).err, "E_INPUT_INVALID", "상한 + 1바이트를 통과시킨다");

  const ko = pad(MAX_BODY + 600, "전");                       // 문자 수는 적고 바이트는 크다
  assert.ok(ko.length < MAX_BODY, "이 케이스는 문자 수로는 상한 아래여야 의미가 있다");
  for (const h of [{}, { "content-length": "10" }])           // 헤더가 없거나 거짓이어도 같아야 한다
    assert.equal((await readBody(mk(ko, h))).err, "E_INPUT_INVALID",
      `바이트 초과를 통과시킨다(headers=${JSON.stringify(h)})`);
  assert.equal((await readBody(mk("{not json"))).err, "E_INPUT_INVALID");
});

t("자치구 힌트는 값이 있을 때만 프롬프트에 붙는다", async () => {
  // 실측 결함(8교시): 미선택 시 옵션 문구 "선택하세요" 가 그대로 힌트로 나갔다.
  const ORIGIN = "https://gaengsin-baseline.pages.dev";
  const REQ = ["sgg_nm","umd_nm","bldg_nm","area_m2","rent_type","cur_deposit_manwon",
    "cur_monthly_manwon","new_deposit_manwon","new_monthly_manwon","rr_right_used_before","confidence","missing"];
  const real = globalThis.fetch;
  let sent = null;
  const ask = async (hint) => {
    const out = Object.fromEntries(REQ.map((k) => [k, null]));
    Object.assign(out, { cur_deposit_manwon: 35000, new_deposit_manwon: 38000, confidence: 0.95, missing: [] });
    globalThis.fetch = async (_u, init) => {
      sent = JSON.parse(init.body).messages.find((m) => m.role === "user").content;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }), { status: 200 });
    };
    const request = new Request(`${ORIGIN}/api/parse`, { method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": `t${ip++}` },
      body: JSON.stringify({ text: "전세 3억5천인데 3억8천으로", hint: hint === undefined ? undefined : { sgg_nm: hint } }) });
    await parsePost({ request, env: { OPENAI_API_KEY: "sk-dummy" } });
    return sent;
  };
  try {
    assert.equal(await ask("마포구"), "[자치구: 마포구]\n전세 3억5천인데 3억8천으로", "정상 힌트가 붙지 않는다");
    for (const none of [null, undefined, 123, { a: 1 }, ["마포구"]])
      assert.equal(await ask(none), "전세 3억5천인데 3억8천으로",
        `문자열이 아닌 힌트가 프롬프트에 들어간다: ${JSON.stringify(none)}`);
    const longHint = await ask("가".repeat(50));
    assert.ok(longHint.startsWith("[자치구: " + "가".repeat(20) + "]"), `힌트 길이 상한이 없다: ${JSON.stringify(longHint.slice(0, 60))}`);
    // 화면 쪽 — 미선택·서울밖에서는 힌트를 아예 만들지 않는다(원문으로 확인).
    const app = readFileSync(new URL("../dist/assets/app.js", import.meta.url), "utf8");
    const line = app.match(/hint:\s*\{[^}]*\}/);
    assert.ok(line && /\$\("#gu"\)\.value\s*&&/.test(line[0]) && /!==\s*"OUT"/.test(line[0]),
      `화면이 미선택·서울밖을 거르지 않는다: ${line && line[0]}`);
  } finally { globalThis.fetch = real; }
  // 주의: 이것은 **프롬프트 구성**의 결정론 검사다. 힌트가 모델 정확도에 주는 영향은
  // 골든셋의 hint 가 전부 null 이라 여전히 측정되지 않았다(05-TEST §10-4).
});

t("업스트림이 죽으면 수동 입력으로 내려간다 — 판정은 그대로다", async () => {
  const ORIGIN = "https://gaengsin-baseline.pages.dev";
  const real = globalThis.fetch;
  const ask = async (f) => {
    globalThis.fetch = f;
    const request = new Request(`${ORIGIN}/api/parse`, { method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": `t${ip++}` },
      body: JSON.stringify({ text: "전세 3억5천인데 3억8천으로" }) });
    return (await parsePost({ request, env: { OPENAI_API_KEY: "sk-dummy" } })).json();
  };
  try {
    for (const [what, f] of [
      ["전송 실패", async () => { throw new Error("network"); }],
      ["상류 500", async () => new Response("", { status: 500 })],
      ["본문이 JSON 이 아님", async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 })],
    ]) {
      const r = await ask(f);
      assert.equal(r.ok, false, `${what}: 실패를 성공으로 낸다`);
      assert.equal(r.code, "E_UPSTREAM", `${what}: 오류 코드가 다르다`);
      assert.equal(r.retryable, true, `${what}: 재시도 가능 표시가 없다`);
      assert.ok(r.parsed && r.parsed.new_deposit_manwon === null, `${what}: 빈 후보를 주지 않는다`);
      assert.ok(!JSON.stringify(r).includes("network") && !JSON.stringify(r).includes("500"),
        `${what}: 업스트림 내용이 응답에 샌다`);
    }
    // 키가 아예 없을 때도 같은 자리로 내려간다(제공자 차단의 로컬 대응 경로).
    const nokey = await (async () => {
      globalThis.fetch = async () => { throw new Error("불려서는 안 된다"); };
      const request = new Request(`${ORIGIN}/api/parse`, { method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": `t${ip++}` },
        body: JSON.stringify({ text: "전세 3억5천인데 3억8천으로" }) });
      return (await parsePost({ request, env: {} })).json();
    })();
    assert.equal(nokey.code, "E_UPSTREAM", "키가 없을 때 다른 경로로 샌다");
  } finally { globalThis.fetch = real; }
  // 이 검사가 보증하는 것은 **애플리케이션 폴백**뿐이다. 제공자 쪽 차단·호스팅 반영·복구는
  // 여기서 확인되지 않는다(07-FINAL-REVIEW U-05).
});

/* 문서가 이 건수를 적고 있다. test_rules.mjs 와 같은 이유로 묶어 둔다.
 * **모든 t() 뒤에 두어야 한다** — 중간에 두면 그 시점의 건수만 세고 뒤에 붙은 검사를 놓친다. */
await chain;   // 비동기 검사의 실패가 조용히 사라지지 않게 한다
const testDoc = readFileSync(new URL("../docs/05-TEST.md", import.meta.url), "utf8");
assert.ok(testDoc.includes(`오리진 경계 ${n}건`),
  `docs/05-TEST.md 가 검증층 건수를 ${n}건으로 적고 있지 않다`);

console.log(`verify ok — ${n}건`);
