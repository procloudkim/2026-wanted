/* 검증층 검증. 네트워크·키 없이 돈다.  실행: node scripts/test_verify.mjs */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { hasDigits, hasForbidden, rangeCheck, allowedOrigin, gate, json } from "../functions/api/_llm.js";

let n = 0; const t = (name, fn) => { fn(); n++; };

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

/* 문서가 이 건수를 적고 있다. test_rules.mjs 와 같은 이유로 묶어 둔다.
 * **모든 t() 뒤에 두어야 한다** — 중간에 두면 그 시점의 건수만 세고 뒤에 붙은 검사를 놓친다. */
const testDoc = readFileSync(new URL("../docs/05-TEST.md", import.meta.url), "utf8");
assert.ok(testDoc.includes(`오리진 경계 ${n}건`),
  `docs/05-TEST.md 가 검증층 건수를 ${n}건으로 적고 있지 않다`);

console.log(`verify ok — ${n}건`);
