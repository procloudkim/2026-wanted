/* 검증층 검증. 네트워크·키 없이 돈다.  실행: node scripts/test_verify.mjs */
import assert from "node:assert/strict";
import { hasDigits, hasForbidden, rangeCheck, allowedOrigin, gate } from "../functions/api/_llm.js";

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
  const req = (origin) => ({ headers: new Map(Object.entries(origin ? { origin } : {})) });
  // Map 은 get 만 쓰므로 Headers 대용으로 충분하다
  const ok = (o) => allowedOrigin({ headers: { get: (k) => (k === "origin" ? o : null) } });

  assert.equal(ok("https://gaengsin-baseline.pages.dev"), "https://gaengsin-baseline.pages.dev");
  assert.equal(ok("https://4a5e40c6.gaengsin-baseline.pages.dev"), "https://4a5e40c6.gaengsin-baseline.pages.dev");
  assert.equal(ok("http://localhost:8788"), "http://localhost:8788");
  assert.equal(ok("http://127.0.0.1:8788"), "http://127.0.0.1:8788");

  // 이 넷을 막지 못하면 남의 사이트가 우리 OpenAI 키를 쓴다
  assert.equal(ok("https://evil.example"), null);
  assert.equal(ok(null), null);                                        // curl 처럼 오리진 없는 요청
  assert.equal(ok("https://gaengsin-baseline.pages.dev.evil.com"), null);  // 접두어 흉내
  assert.equal(ok("http://gaengsin-baseline.pages.dev"), null);        // https 가 아니다
  assert.equal(ok("not a url"), null);
  void req;
});

t("gate 는 오리진을 먼저 보고, 통과해야 속도 제한을 센다", () => {
  const mk = (o, ip) => ({ headers: { get: (k) => (k === "origin" ? o : k === "cf-connecting-ip" ? ip : null) } });
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
  // 그 밖의 숫자는 전부 걸린다
  assert.equal(hasDigits("보증금 7,000만원을 제안합니다."), true);
  assert.equal(hasDigits("2026년 10월까지 회신드리겠습니다."), true);
  assert.equal(hasDigits("중앙값은 5%였습니다."), true);
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

console.log(`verify ok — ${n}건`);
