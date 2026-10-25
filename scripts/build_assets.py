#!/usr/bin/env python3
"""국토부 전월세 실거래가 4종을 서울 25개 자치구 × 12개월 수집해 집계 자산을 만든다.

출력: dist/data/index.json, dist/data/anchors.json, dist/data/cohort/<자치구코드>.json
명세: docs/04-API.md §6 (코호트 스키마·폴백 사다리·자산 검증), docs/02-SPEC.md §5.3-1 (유형별 코호트 키)

키: .env 의 DATA_GO_KR_SERVICE_KEY (Decoding 키. 코드에서 URL 인코딩한다)
실행: python3 scripts/build_assets.py            (수집 → 집계 → 검증 → 출력)
      python3 scripts/build_assets.py --selftest (네트워크 없이 돈다)

가정(scripts/molit_rent.py 와 동일하게 유지한다):
  - 인상률은 전세→전세 갱신만 센다. 월세가 섞이면 보증금 단독 비교가 성립하지 않는다.
  - 갱신 행의 useRRRight 공란은 '행사 기록 없음'으로 본다(근거 등급 B).
  - 신규 계약 행은 이 필드가 100% 공란이므로 갱신 행과 절대 합산하지 않는다.
  - 면적 구간은 10㎡ 고정 하한 구간이다(floor(area/10)*10). 겹치는 구간을 쓰면 같은 계약이 두 번 세어진다.
"""
import gzip
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date

CAP = 5.0  # 주택임대차보호법 제7조 상한 5%
RATE_MIN, RATE_MAX = -90.0, 300.0  # 이 밖은 자릿수 사고로 보고 버린다(종전 보증금 4만원 신고 실측)
MIN_N = 5  # 백분위가 20% 단위 이상 의미를 갖는 최소 표본 (04-API §6.4)

# 유형: (서비스명, 단지명 태그, 면적 태그, 코호트 최상위 단계)
# 최상위 단계 1(단지)은 aptSeq 가 오는 유형에만 성립한다. 실측(596,178행)에서 aptSeq 는
# 아파트만 100% 오고 오피스텔·연립다세대·단독다가구는 100% 비어 있다. 단지명이 와도
# 일련번호가 없으면 같은 이름을 같은 건물로 묶을 근거가 없어 3단계(법정동·면적대)부터 쓴다.
SVC = {
    "아파트": ("RTMSDataSvcAptRent", "aptNm", "excluUseAr", 1),
    "오피스텔": ("RTMSDataSvcOffiRent", "offiNm", "excluUseAr", 3),
    "연립다세대": ("RTMSDataSvcRHRent", "mhouseNm", "excluUseAr", 3),
    # 단독다가구의 totalFloorAr 는 건물 전체가 아니라 계약한 부분의 면적이다(실측 중앙값 30㎡, 2026-10-25)
    "단독다가구": ("RTMSDataSvcSHRent", None, "totalFloorAr", 3),
}

SEOUL = {
    "11110": "종로구", "11140": "중구", "11170": "용산구", "11200": "성동구", "11215": "광진구",
    "11230": "동대문구", "11260": "중랑구", "11290": "성북구", "11305": "강북구", "11320": "도봉구",
    "11350": "노원구", "11380": "은평구", "11410": "서대문구", "11440": "마포구", "11470": "양천구",
    "11500": "강서구", "11530": "구로구", "11545": "금천구", "11560": "영등포구", "11590": "동작구",
    "11620": "관악구", "11650": "서초구", "11680": "강남구", "11710": "송파구", "11740": "강동구",
}


def num(s):
    s = (s or "").replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def field(item, tag):
    m = re.search(rf"<{tag}>(.*?)</{tag}>", item, re.S)
    return (m.group(1) if m else "").strip()


def band(area):
    """10㎡ 고정 하한 구간. None 이면 면적 미상."""
    if not area or area <= 0:
        return None
    lo = int(area // 10) * 10
    return f"{lo}-{lo + 10}"


def parse(kind, xml):
    _, name_tag, area_tag, _ = SVC[kind]
    out = []
    for it in re.findall(r"<item>(.*?)</item>", xml, re.S):
        out.append({
            "kind": kind,
            "sgg": field(it, "sggCd"),
            "umd": field(it, "umdNm"),
            "seq": field(it, "aptSeq"),
            "nm": field(it, name_tag) if name_tag else "",
            "area": num(field(it, area_tag)),
            "deposit": num(field(it, "deposit")),
            "rent": num(field(it, "monthlyRent")),
            "prev_deposit": num(field(it, "preDeposit")),
            "prev_rent": num(field(it, "preMonthlyRent")),
            "ctype": field(it, "contractType"),   # 신규 / 갱신 / 공란
            "rr": field(it, "useRRRight"),        # 사용 / 공란
        })
    return out


# ── 수집 ────────────────────────────────────────────────────────────────────

def fetch(kind, lawd, ymd, key, page=1, rows=1000):
    svc = SVC[kind][0]
    q = urllib.parse.urlencode({
        "serviceKey": key, "LAWD_CD": lawd, "DEAL_YMD": ymd,
        "numOfRows": rows, "pageNo": page,
    })
    url = f"https://apis.data.go.kr/1613000/{svc}/get{svc}?{q}"
    with urllib.request.urlopen(url, timeout=40) as r:
        return r.read().decode("utf-8", "replace")


def total_count(xml):
    m = re.search(r"<totalCount>(\d+)</totalCount>", xml)
    return int(m.group(1)) if m else 0


def result_code(xml):
    m = re.search(r"<resultCode>(\w+)</resultCode>", xml)
    return m.group(1) if m else "?"


def one(job, key, tries=3):
    """(kind, lawd, ymd) 한 조합. 200 이어도 본문이 오류일 수 있어 resultCode 를 함께 본다."""
    kind, lawd, ymd = job
    for attempt in range(tries):
        try:
            xml = fetch(kind, lawd, ymd, key)
            code = result_code(xml)
            if code not in ("000", "00"):
                if "SERVICE_KEY" in xml or code in ("30", "31"):
                    raise SystemExit(f"B_AUTH_FAILED: {code} {xml[:200]}")
                raise RuntimeError(code)
            rows = parse(kind, xml)
            total = total_count(xml)
            page = 1
            while len(rows) < total and page < 20:
                page += 1
                rows += parse(kind, fetch(kind, lawd, ymd, key, page=page))
            return rows, total, None
        except SystemExit:
            raise
        except Exception as e:  # noqa: BLE001 — 재시도 후 상위에서 집계한다
            if attempt == tries - 1:
                return [], 0, f"{kind}/{lawd}/{ymd}: {e}"
            time.sleep(1.5 * (attempt + 1))
    return [], 0, None


def collect(key, lawds, ymds, workers=8, log=print, jobs=None):
    jobs = jobs or [(k, l, y) for k in SVC for l in lawds for y in ymds]
    rows, errs, zeros, done = [], [], [], 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for job, (rs, total, err) in zip(jobs, ex.map(lambda j: one(j, key), jobs)):
            done += 1
            rows += rs
            if err:
                errs.append(err)
            elif total == 0:
                zeros.append("/".join(job))
            if done % 100 == 0:
                log(f"  {done}/{len(jobs)} 조합, {len(rows):,}행, 실패 {len(errs)}")
    return rows, errs, zeros, len(jobs)


# ── 집계 ────────────────────────────────────────────────────────────────────

def pctile(vals, p):
    """최근접 순위법. 반올림은 사사오입으로 못 박는다 —
    파이썬 round 는 은행원 반올림이고 자바스크립트 Math.round 는 사사오입이라,
    그대로 두면 빌드와 브라우저가 같은 데이터에서 다른 분위수를 낸다."""
    if not vals:
        return None
    s = sorted(vals)
    k = int((len(s) - 1) * p / 100 + 0.5)   # floor(x + 0.5) = 사사오입
    return round(s[min(k, len(s) - 1)], 2)


def jeonse_renewals(rows):
    """전세→전세 갱신만. 종전 월세가 공백이면 종전이 전세라는 뜻이다(숫자 0이 아니다)."""
    out, dropped = [], 0
    for r in rows:
        if r["ctype"] != "갱신" or not r["prev_deposit"] or r["prev_rent"] or r["rent"]:
            continue
        rate = (r["deposit"] - r["prev_deposit"]) / r["prev_deposit"] * 100
        if not (RATE_MIN <= rate <= RATE_MAX):
            dropped += 1
            continue
        out.append({**r, "rate": rate})
    return out, dropped


LEVELS = {1: "단지·면적대", 2: "단지 전체 면적", 3: "법정동·면적대",
          4: "법정동 전체", 5: "자치구 전체"}


def keys_for(r):
    """폴백 사다리 각 단계의 코호트 키. 위에서부터 좁은 순서(02-SPEC §3.6).

    유형을 키에 넣는 이유: 아파트와 단독다가구를 같은 법정동 코호트에 섞으면 분포가 뒤섞인다.
    아파트 말고는 원천에 단지 일련번호가 없어 1·2단계를 만들지 않는다(02-SPEC §5.3-1).
    """
    b = band(r["area"])
    ks = []
    if SVC[r["kind"]][3] == 1 and r["seq"]:
        if b:
            ks.append((1, f"{r['kind']}|{r['sgg']}|{r['umd']}|{r['seq']}|{b}"))
        ks.append((2, f"{r['kind']}|{r['sgg']}|{r['umd']}|{r['seq']}|"))
    if b:
        ks.append((3, f"{r['kind']}|{r['sgg']}|{r['umd']}||{b}"))
    ks.append((4, f"{r['kind']}|{r['sgg']}|{r['umd']}||"))
    ks.append((5, f"{r['kind']}|{r['sgg']}|||"))
    return ks


def dist(rates):
    """분위수만 담으면 백분위를 정확히 낼 수 없다(상위 몇 %인가는 전체 순위가 필요하다).
    정렬된 인상률 벡터를 그대로 싣는다 — 0.01%p 단위 정수라 gzip 이 잘 접고,
    5.00% 동률 수를 화면에 적으려면 어차피 벡터가 필요하다."""
    return sorted(int(round(x * 100)) for x in rates)


def is_over_cap(r):
    """5% 초과 판정은 정수 비교로만 한다(02-SPEC §3.1). 20×증감액 > 종전 보증금."""
    return 20 * (r["deposit"] - r["prev_deposit"]) > r["prev_deposit"]


def is_at_cap(r):
    return 20 * (r["deposit"] - r["prev_deposit"]) == r["prev_deposit"]


def summary(rows):
    """분위수는 벡터에서, 5% 초과·동률 건수는 원본 행의 정수 비교에서 뽑는다.

    두 경로를 나누는 이유: 인상률을 0.01%p 정수로 접으면 5.0026% 처럼 상한을 아슬하게
    넘긴 계약이 정확히 5.00% 로 내려앉는다. 실측에서 행사 기록 있는 갱신의 5% 초과가
    0.37%(153건)에서 0.01%(4건)로 바뀌었다. 판정(R1)은 정확한 정수 비교를 쓰므로,
    코호트 쪽도 같은 비교를 쓰지 않으면 같은 계약이 화면에서 초과이면서 분포에는 없게 된다."""
    if not rows:
        return None
    v = dist([r["rate"] for r in rows])
    n = len(rows)
    return {"n": n, "p50": pctile(v, 50) / 100, "p75": pctile(v, 75) / 100,
            "p90": pctile(v, 90) / 100,
            "over5": round(sum(1 for r in rows if is_over_cap(r)) / n * 100, 2),
            "at5": round(sum(1 for r in rows if is_at_cap(r)) / n * 100, 2)}


def aggregate(rows, asof):
    renew, dropped = jeonse_renewals(rows)
    buckets, names, new_deposits = {}, {}, {}

    for r in renew:
        for lv, k in keys_for(r):
            b = buckets.setdefault(k, {"lv": lv, "rr": [], "nr": []})
            b["rr" if r["rr"] else "nr"].append(r)
        if r["seq"] and r["nm"]:
            names[r["seq"]] = (r["nm"], r["umd"], r["kind"])

    # 신규 전세 보증금 중앙값 — 같은 키 공간에 쌓아 이탈 차액(R5)에 쓴다
    for r in rows:
        if r["ctype"] != "신규" or r["rent"] or not r["deposit"]:
            continue
        for _, k in keys_for(r):
            new_deposits.setdefault(k, []).append(r["deposit"])
        if r["seq"] and r["nm"]:
            names.setdefault(r["seq"], (r["nm"], r["umd"], r["kind"]))

    records = {}
    for k, b in buckets.items():
        if len(b["rr"]) + len(b["nr"]) < 3:  # 3건 미만은 자산에 싣지 않는다
            continue
        nd = new_deposits.get(k, [])
        records[k] = {
            "lv": b["lv"],
            # 인상률 벡터(0.01%p 정수, 오름차순). 백분위·중앙값용.
            "rr": dist(r["rate"] for r in b["rr"]) or None,   # 행사 기록 있음
            "nr": dist(r["rate"] for r in b["nr"]) or None,   # 행사 기록 없음. 없음과 0건을 구분한다
            # 5% 초과·동률은 벡터가 아니라 정수 비교 결과를 그대로 싣는다(summary 주석 참조)
            "ro": sum(1 for r in b["rr"] if is_over_cap(r)),
            "no": sum(1 for r in b["nr"] if is_over_cap(r)),
            "rt": sum(1 for r in b["rr"] if is_at_cap(r)),
            "nt": sum(1 for r in b["nr"] if is_at_cap(r)),
            "nd": pctile(nd, 50) if len(nd) >= MIN_N else None,  # 신규 전세 보증금 중앙값
            "nn": len(nd) if len(nd) >= MIN_N else 0,
        }

    return records, names, renew, dropped


def shard(records, names, asof, meta):
    """자치구별 파일. 코호트와 건물 색인을 한 파일에 담아 요청을 1회로 줄인다."""
    out = {}
    for sgg, gu in SEOUL.items():
        recs = {k: v for k, v in records.items() if f"|{sgg}|" in k}
        blds = sorted(
            ({"seq": s, "nm": n, "umd": u, "kind": kd}
             for s, (n, u, kd) in names.items() if s.startswith(sgg + "-")),
            key=lambda x: x["nm"],
        )
        umds = sorted({b["umd"] for b in blds} | {k.split("|")[2] for k in recs if k.split("|")[2]})
        out[sgg] = {"asof": asof, "sgg": sgg, "gu": gu, "meta": meta,
                    "umds": umds, "buildings": blds, "cohorts": recs}
    return out


def ym_ko(ym):
    return f"{str(ym)[:4]}년 {int(str(ym)[4:6])}월"


def anchors(renew, rows, asof, months, dropped, errs, zeros):
    """서울 전체 상수. 모수를 값과 같은 자리에 적어 화면이 분모를 섞지 못하게 한다(02-SPEC DR4)."""
    by_kind = {}
    for kind in SVC:
        g = [r for r in renew if r["kind"] == kind]
        by_kind[kind] = {"n": len(g),
                         "rr": summary([r for r in g if r["rr"]]),
                         "nr": summary([r for r in g if not r["rr"]]),
                         "ladder": ladder(g)}   # 키에 유형이 들어 있어 유형별로 따로 세도 같다
    rr = [r for r in renew if r["rr"]]
    nr = [r for r in renew if not r["rr"]]
    return {
        "asof": asof,
        # 두 문자열은 화면·공유 문구에 그대로 나간다 — 연월 코드(202511)나 API 같은 개발 용어를 쓰지 않는다
        "source": "국토교통부 전월세 실거래가 공개 자료(아파트·오피스텔·연립다세대·단독다가구)",
        "scope": f"서울 25개 자치구, {ym_ko(months[0])}~{ym_ko(months[-1])} 계약, 전세를 전세로 갱신한 계약",
        "note": "월세가 섞인 계약은 보증금만으로 비교할 수 없어 뺐습니다.",   # 화면에 그대로 나간다 — 존댓말로 쓴다
        "total_n": len(renew),
        "all": summary(renew),
        "recorded": summary(rr),       # 갱신요구권 행사 기록 있음
        "unrecorded": summary(nr),     # 행사 기록 없음
        "excess_median": excess_median(renew),
        "over": over_stats(renew),
        "market_gap": market_gap(renew, rows),
        "blank_ctype": blank_ctype(rows),
        "ladder": ladder(renew),
        "convert": convert_dist(rows),
        "fill": fill_rates(rows),
        "exactly5_pct": round(sum(1 for r in renew if is_at_cap(r)) / len(renew) * 100, 2) if renew else None,
        "by_kind": by_kind,
        "build": {"rows": len(rows), "dropped_outliers": dropped,
                  "failed_jobs": len(errs), "zero_jobs": len(zeros)},
    }


def ladder(renew):
    """갱신 계약이 폴백 사다리의 몇 단계에서 비교 표본 3건을 만나는가(02-SPEC §3.6).

    비교 표본은 **행사 기록이 없는 갱신**만이다(R3). 화면이 그 건수로 사다리를 타므로 여기서도 같이 센다.
    "표본 3건 이상인 코호트 비율"은 모수를 코호트로 잡느냐 계약으로 잡느냐에 따라 값이 달라진다.
    화면이 답하는 질문은 "내 계약이 어느 단계에서 판정되나"이므로 계약을 모수로 센다."""
    buckets = {}
    for r in renew:
        if r["rr"]:
            continue
        for _lv, k in keys_for(r):
            buckets[k] = buckets.get(k, 0) + 1
    hit = {}
    for r in renew:
        for lv, k in keys_for(r):
            if buckets.get(k, 0) >= 3:
                hit[lv] = hit.get(lv, 0) + 1
                break
        else:
            hit["none"] = hit.get("none", 0) + 1
    n = len(renew) or 1
    return {str(lv): round(hit.get(lv, 0) / n * 100, 2) for lv in (1, 2, 3, 4, 5, "none")}


def convert_dist(rows):
    """전세→월세 갱신에서 역산한 전환율(연 %) 분포. 보증금 감액이 있는 갱신만 센다.

    R7 이 사용자의 조건을 이 분포에 견준다. 세 분포 중 표본이 가장 얇고, 단지 단위가 아니라
    서울 전체다. 법정 전월세전환율 한도 판정이 아니라 시장에서 역산한 참고값이다."""
    v = []
    for r in rows:
        if r["ctype"] != "갱신" or r["prev_rent"] or not r["prev_deposit"] or not r["rent"]:
            continue
        cut = r["prev_deposit"] - r["deposit"]
        if cut > 0:
            v.append(r["rent"] * 12 / cut * 100)
    if not v:
        return None
    return {"n": len(v), "p25": pctile(v, 25), "p50": pctile(v, 50), "p75": pctile(v, 75)}


def fill_rates(rows):
    """갱신 행의 채움률. "행사 기록 없음"이라는 표기는 이 칸이 계속 채워져야 성립한다.
    한 유형에서 양성 토큰이 무너지면 그 유형의 분포 해석이 통째로 바뀐다(05-TEST Q2·Q3)."""
    ren = [r for r in rows if r["ctype"] == "갱신"]
    n = len(ren) or 1
    by_kind = {}
    for kind in SVC:
        g = [r for r in ren if r["kind"] == kind]
        a = [r for r in rows if r["kind"] == kind]
        by_kind[kind] = {
            "n": len(g),
            "rr_token_pct": round(sum(1 for r in g if r["rr"]) / (len(g) or 1) * 100, 2),
            "seq_missing_pct": round(sum(1 for r in a if not r["seq"]) / (len(a) or 1) * 100, 2),
        }
    return {
        "renewal_rows": len(ren),
        "prev_deposit_missing_pct": round(sum(1 for r in ren if not r["prev_deposit"]) / n * 100, 2),
        "rr_token_pct": round(sum(1 for r in ren if r["rr"]) / n * 100, 2),
        "by_kind": by_kind,
    }


def over_stats(renew):
    """5% 초과 갱신의 수와 상한 대비 초과 차액 합계(만원, PRD D5). 행사 기록 유무를 가리지 않는다.
    '위법 금액'이 아니라 '갱신요구권을 행사했을 때의 상한과 실제 계약의 차이'다."""
    ex = [r["deposit"] - r["prev_deposit"] * 21 / 20 for r in renew if is_over_cap(r)]
    return {"n": len(ex), "excess_sum": round(sum(ex))}


def market_gap(renew, rows):
    """갱신 보증금과 같은 단지·면적대(1단계) 신규 전세 중앙값의 차이(PRD D6, 02-SPEC R5 참조 앵커).
    신규 전세가 MIN_N 건 이상인 1단계 코호트를 만난 갱신만 센다. 차이가 양수면 갱신이 시세보다 싸다.
    below_pct 는 **시세보다 낮은**(차이 > 0) 비율이다 — 2026-09-18 문서의 "시세 이하 81.08%"가 이 정의다."""
    new = {}
    for r in rows:
        if r["ctype"] != "신규" or r["rent"] or not r["deposit"]:
            continue
        lv, k = keys_for(r)[0]
        if lv == 1:
            new.setdefault(k, []).append(r["deposit"])
    gaps = []
    for r in renew:
        lv, k = keys_for(r)[0]
        if lv == 1 and len(new.get(k, [])) >= MIN_N:
            gaps.append(pctile(new[k], 50) - r["deposit"])
    if not gaps:
        return None
    return {"n": len(gaps), "share_pct": round(len(gaps) / len(renew) * 100, 2),
            "gap_median": round(pctile(gaps, 50)),
            "below_pct": round(sum(1 for g in gaps if g > 0) / len(gaps) * 100, 2)}


def blank_ctype(rows):
    """계약구분이 신규도 갱신도 아닌 행. 판정에서 빠지므로 화면 각주가 이 값을 그대로 쓴다."""
    nb = sum(1 for r in rows if r["ctype"] not in ("신규", "갱신"))
    return {"n": nb, "pct": round(nb / (len(rows) or 1) * 100, 2)}


def excess_median(renew):
    """5% 상한 대비 초과 차액의 건당 중앙값(만원). 행사 기록 없는 초과 건만 센다.
    '위법 금액'이 아니라 '갱신요구권을 행사했을 때의 상한과 실제 계약의 차이'다."""
    ex = [r["deposit"] - r["prev_deposit"] * 21 / 20
          for r in renew if not r["rr"] and is_over_cap(r)]
    return round(pctile(ex, 50)) if ex else None


def validate(records, anc, prev=None):
    """배포 전 게이트(04-API §6.8). 조용한 실패를 여기서 잡는다.
    prev 는 직전 스냅샷의 유형별 양성 토큰 비율. 생략하면 배포본에서 읽는다."""
    bad = []
    for k, r in records.items():
        v = (r["rr"] or []) + (r["nr"] or [])
        if len(v) < 3:
            bad.append(f"{k}: n<3")
        if any(x != y for x, y in zip(r["rr"] or [], sorted(r["rr"] or []))):
            bad.append(f"{k}: rr 미정렬")
        if r["ro"] > len(r["rr"] or []) or r["no"] > len(r["nr"] or []):
            bad.append(f"{k}: 초과 건수가 표본 수를 넘는다")
        if v and not (RATE_MIN * 100 <= pctile(sorted(v), 50) <= RATE_MAX * 100):
            bad.append(f"{k}: p50 범위 밖")
    if not records:
        bad.append("레코드 0건")
    if anc["total_n"] < 1000:
        bad.append(f"전세→전세 갱신 표본 급감 {anc['total_n']}")

    # 갱신 행의 채움률. 이 둘이 무너지면 "행사 기록 없음"이라는 표기 자체가 성립하지 않는다.
    f = anc.get("fill")
    if f:
        if f["prev_deposit_missing_pct"] > 0.5:
            bad.append(f"갱신 행 종전 보증금 결측 {f['prev_deposit_missing_pct']}% > 0.5%")
        prev = previous_anchors() if prev is None else prev
        for kind, d in f["by_kind"].items():
            if d["rr_token_pct"] < 15:   # 실측 최저는 단독다가구 22.41%. 그 아래는 붕괴로 본다
                bad.append(f"{kind} 갱신요구권 양성 토큰 {d['rr_token_pct']}% < 15%")
            p = prev.get(kind)
            if p is not None and d["rr_token_pct"] < p - 5:
                bad.append(f"{kind} 양성 토큰 직전 스냅샷 {p}% → {d['rr_token_pct']}% ({p - d['rr_token_pct']:.2f}%p 하락)")
    return bad


def previous_anchors():
    """직전 배포본의 유형별 양성 토큰 비율. 없으면 빈 dict — 첫 빌드에서는 비교하지 않는다."""
    path = os.path.join(os.path.dirname(__file__), "..", "dist", "data", "anchors.json")
    try:
        with open(path, encoding="utf-8") as f:
            by_kind = json.load(f)["fill"]["by_kind"]
        return {k: v["rr_token_pct"] for k, v in by_kind.items()}
    except (OSError, KeyError, ValueError):
        return {}


# ── 자체 검증 (네트워크 0) ──────────────────────────────────────────────────

FIXTURE = """<response><header><resultCode>000</resultCode></header><body><items>
<item><sggCd>11440</sggCd><umdNm>성산동</umdNm><aptSeq>11440-2118</aptSeq><aptNm>성산시영</aptNm>
<excluUseAr>50.6</excluUseAr><deposit>21,000</deposit><monthlyRent>0</monthlyRent>
<preDeposit>20,000</preDeposit><preMonthlyRent> </preMonthlyRent>
<contractType>갱신</contractType><useRRRight>사용</useRRRight></item>
<item><sggCd>11440</sggCd><umdNm>성산동</umdNm><aptSeq>11440-2118</aptSeq><aptNm>성산시영</aptNm>
<excluUseAr>50.6</excluUseAr><deposit>24,000</deposit><monthlyRent>0</monthlyRent>
<preDeposit>20,000</preDeposit><preMonthlyRent> </preMonthlyRent>
<contractType>갱신</contractType><useRRRight> </useRRRight></item>
<item><sggCd>11440</sggCd><umdNm>성산동</umdNm><aptSeq>11440-2118</aptSeq><aptNm>성산시영</aptNm>
<excluUseAr>50.6</excluUseAr><deposit>22,000</deposit><monthlyRent>0</monthlyRent>
<preDeposit>20,000</preDeposit><preMonthlyRent> </preMonthlyRent>
<contractType>갱신</contractType><useRRRight> </useRRRight></item>
<item><sggCd>11440</sggCd><umdNm>성산동</umdNm><aptSeq>11440-2118</aptSeq><aptNm>성산시영</aptNm>
<excluUseAr>50.6</excluUseAr><deposit>30,000</deposit><monthlyRent>0</monthlyRent>
<preDeposit> </preDeposit><preMonthlyRent> </preMonthlyRent>
<contractType>신규</contractType><useRRRight> </useRRRight></item>
<item><sggCd>11440</sggCd><umdNm>성산동</umdNm><aptSeq>11440-2118</aptSeq><aptNm>성산시영</aptNm>
<excluUseAr>50.6</excluUseAr><deposit>5,000</deposit><monthlyRent>60</monthlyRent>
<preDeposit>5,000</preDeposit><preMonthlyRent>50</preMonthlyRent>
<contractType>갱신</contractType><useRRRight> </useRRRight></item>
<item><sggCd>11440</sggCd><umdNm>성산동</umdNm><aptSeq>11440-2118</aptSeq><aptNm>성산시영</aptNm>
<excluUseAr>50.6</excluUseAr><deposit>50,000</deposit><monthlyRent>0</monthlyRent>
<preDeposit>4</preDeposit><preMonthlyRent> </preMonthlyRent>
<contractType>갱신</contractType><useRRRight> </useRRRight></item>
</items></body></response>"""


def selftest():
    rows = parse("아파트", FIXTURE)
    assert len(rows) == 6

    # 종전이 전세면 종전 월세는 0 이 아니라 공백으로 온다. 숫자로 읽으면 표본이 통째로 사라진다.
    assert rows[0]["prev_rent"] is None and rows[0]["prev_deposit"] == 20000.0

    renew, dropped = jeonse_renewals(rows)
    assert len(renew) == 3, renew           # 월세 갱신 1건·신규 1건·자릿수 이상 1건 제외
    assert dropped == 1                     # 종전 4만원 → +124,900% 는 버린다
    assert sorted(round(r["rate"], 2) for r in renew) == [5.0, 10.0, 20.0]

    # 면적 구간은 겹치지 않는 10㎡ 하한 구간
    assert band(50.6) == "50-60" and band(59.99) == "50-60" and band(60.0) == "60-70"
    assert band(None) is None and band(0) is None

    # 유형별 최상위 단계: 아파트는 단지, 단독다가구는 법정동·면적대부터
    assert [lv for lv, _ in keys_for(renew[0])] == [1, 2, 3, 4, 5]
    sh = dict(renew[0], kind="단독다가구", seq="")
    assert [lv for lv, _ in keys_for(sh)] == [3, 4, 5]
    # 면적이 없으면 면적대 단계를 건너뛰고 단지 전체로 간다
    assert [lv for lv, _ in keys_for(dict(renew[0], area=None))] == [2, 4, 5]

    recs, names, _, _ = aggregate(rows, "2026-09-18")
    k = "아파트|11440|성산동|11440-2118|50-60"
    assert k in recs and recs[k]["rr"] == [500] and recs[k]["nr"] == [1000, 2000]
    assert (recs[k]["ro"], recs[k]["no"]) == (0, 2)   # 초과는 행사 기록 없는 2건뿐
    assert (recs[k]["rt"], recs[k]["nt"]) == (1, 0)   # 정확히 5.00% 는 행사 기록 있는 1건
    assert summary(renew)["p50"] == 10.0
    assert recs[k]["nd"] is None and recs[k]["nn"] == 0   # 신규 1건 < MIN_N
    assert names["11440-2118"][0] == "성산시영"
    assert set(r["lv"] for r in recs.values()) == {1, 2, 3, 4, 5}
    assert len(recs["아파트|11440|성산동|11440-2118|"]["nr"]) == 2   # 단지 전체 면적

    anc = anchors(renew, rows, "2026-09-18", ["202510", "202609"], dropped, [], [])
    assert anc["total_n"] == 3 and anc["recorded"]["n"] == 1 and anc["unrecorded"]["n"] == 2
    assert anc["unrecorded"]["over5"] == 100.0 and anc["recorded"]["over5"] == 0.0
    assert anc["recorded"]["at5"] == 100.0

    # 0.01%p 벡터로 접으면 사라지는 초과 계약을 정수 비교가 잡는다 (실측 회귀)
    edge = {"deposit": 14000, "prev_deposit": 13333, "rate": (14000 - 13333) / 13333 * 100,
            "rr": "사용", "kind": "아파트", "sgg": "11440", "umd": "성산동",
            "seq": "x", "area": 50.6, "ctype": "갱신"}
    assert is_over_cap(edge) and dist([edge["rate"]]) == [500]   # 5.0026% → 벡터는 500
    assert abs(anc["exactly5_pct"] - 33.33) < 0.01
    # 초과 2건(3,000 / 1,000)의 최근접 순위 중앙값은 사사오입으로 위쪽인 3,000이다
    assert anc["excess_median"] == 3000
    assert anc["over"] == {"n": 2, "excess_sum": 4000}           # 3,000 + 1,000 만원
    assert anc["blank_ctype"] == {"n": 0, "pct": 0.0}
    # 시세 비교: 픽스처의 신규 전세는 1건뿐이라 MIN_N 미만 — 지어내지 않고 None 이다
    assert anc["market_gap"] is None
    new5 = [dict(rows[3]) for _ in range(5)]                     # 같은 단지·면적대 신규 전세 30,000 × 5
    mg = market_gap(renew, rows + new5)
    # 차이 9,000 / 6,000 / 8,000 의 최근접 순위 중앙값은 8,000 이다
    assert mg == {"n": 3, "share_pct": 100.0, "gap_median": 8000, "below_pct": 100.0}, mg

    # 사다리: 픽스처의 갱신 3건 중 행사 기록 없는 것은 2건뿐이라 어느 단계에서도 표본 3건을 못 만난다.
    # 행사 기록 있는 1건까지 세면 1단계 100% 가 된다 — 그것이 R3 표본을 정정하기 전의 값이었다.
    assert anc["ladder"]["1"] == 0.0 and anc["ladder"]["none"] == 100.0
    assert anc["by_kind"]["아파트"]["ladder"] == anc["ladder"]
    # 환산: 보증금 감액이 없는 월세 갱신(5,000 → 5,000)은 전환이 아니라 순증이라 표본이 아니다
    assert anc["convert"] is None
    conv = convert_dist([{"ctype": "갱신", "prev_rent": None, "prev_deposit": 50000,
                          "deposit": 20000, "rent": 100, "kind": "아파트"}])
    assert conv == {"n": 1, "p25": 4.0, "p50": 4.0, "p75": 4.0}   # 100×12 ÷ 30,000 = 연 4%
    # 채움률: 갱신 5건(월세 갱신·자릿수 이상 포함) 중 양성 토큰 1건, 종전 보증금 결측 0건
    assert anc["fill"]["renewal_rows"] == 5 and anc["fill"]["rr_token_pct"] == 20.0
    assert anc["fill"]["prev_deposit_missing_pct"] == 0.0
    assert anc["fill"]["by_kind"]["아파트"]["seq_missing_pct"] == 0.0
    # 채움률 게이트가 실제로 막는가 — 결측 0.9% 와 양성 토큰 10% 둘 다 걸려야 한다
    low = {"total_n": 5000, "fill": {"prev_deposit_missing_pct": 0.9,
                                     "by_kind": {"아파트": {"rr_token_pct": 10.0}}}}
    assert len(validate(recs, low, prev={})) == 2, validate(recs, low, prev={})
    # 직전 스냅샷 대비 급락도 막는다 — 절대 하한을 넘겨도 걸려야 한다
    ok_abs = {"total_n": 5000, "fill": {"prev_deposit_missing_pct": 0.0,
                                        "by_kind": {"아파트": {"rr_token_pct": 30.0}}}}
    assert validate(recs, ok_abs, prev={"아파트": 44.13}) == [
        "아파트 양성 토큰 직전 스냅샷 44.13% → 30.0% (14.13%p 하락)"]
    assert validate(recs, ok_abs, prev={"아파트": 33.0}) == []
    assert validate(recs, {"total_n": 5000}) == []
    assert validate({}, {"total_n": 5000}) == ["레코드 0건"]

    sh = shard(recs, names, "2026-09-18", {})
    assert sh["11440"]["buildings"][0]["nm"] == "성산시영"
    assert sh["11440"]["cohorts"] and not sh["11680"]["cohorts"]
    print("selftest ok")


def months_back(n=12, today=None):
    t = today or date.today()
    y, m = t.year, t.month
    out = []
    for _ in range(n):
        out.append(f"{y}{m:02d}")
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return sorted(out)


CACHE = os.path.join(os.path.dirname(__file__), "..", "data", "raw-rows.json.gz")


def main(from_cache=False, retry=False):
    key = os.environ.get("DATA_GO_KR_SERVICE_KEY")
    asof = date.today().isoformat()
    ymds = months_back(12)
    t0 = time.time()

    if from_cache or retry:
        with gzip.open(CACHE, "rt", encoding="utf-8") as f:
            c = json.load(f)
        rows, errs, zeros, ymds = c["rows"], c["errs"], c["zeros"], c["ymds"]
        asof = c["collected"]   # 기준일은 재집계한 날이 아니라 수집한 날이다
        print(f"# 캐시 {len(rows):,}행 (수집일 {c['collected']}), 실패 {len(errs)}")

    if retry and errs:
        # 429 는 동시성 때문에 난다. 워커를 줄여 실패분만 다시 받고 캐시를 갱신한다.
        jobs = [tuple(e.split(": ", 1)[0].split("/")) for e in errs]
        print(f"# 실패 {len(jobs)}조합 재시도 (워커 3)")
        more, errs, z2, _ = collect(key, None, None, workers=3, jobs=jobs)
        rows += more
        zeros += z2
        print(f"# 재시도 +{len(more):,}행, 남은 실패 {len(errs)}")
        with gzip.open(CACHE, "wt", encoding="utf-8") as f:
            json.dump({"collected": c["collected"], "ymds": ymds, "errs": errs,
                       "zeros": zeros, "rows": rows}, f, ensure_ascii=False,
                      separators=(",", ":"))
    elif not (from_cache or retry):   # 캐시 경로에서는 절대 재수집하지 않는다
        if not key:
            sys.exit("DATA_GO_KR_SERVICE_KEY 가 없다. set -a; . ./.env; set +a")
        print(f"# 수집 시작 {asof} — 자치구 {len(SEOUL)} × 월 {len(ymds)} × 유형 {len(SVC)}")
        rows, errs, zeros, njobs = collect(key, list(SEOUL), ymds)
        print(f"# 수집 완료 {len(rows):,}행, 호출조합 {njobs}, 실패 {len(errs)}, "
              f"0건 {len(zeros)}, {time.time()-t0:.0f}s")
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        with gzip.open(CACHE, "wt", encoding="utf-8") as f:
            json.dump({"collected": asof, "ymds": ymds, "errs": errs,
                       "zeros": zeros, "rows": rows}, f, ensure_ascii=False,
                      separators=(",", ":"))
        print(f"# 원본 캐시 {CACHE} — 재집계는 --from-cache")

    apt_zero = [z for z in zeros if z.startswith("아파트")]
    if apt_zero:
        print(f"! B_SILENT_ZERO 아파트 0건 조합 {len(apt_zero)}건: {apt_zero[:5]}")
    for e in errs[:10]:
        print(f"! {e}")
    if errs:
        # 실패 조합이 남은 채로 자산을 만들면 표본이 조용히 빠진다. 2026-10-25 실측: 1,200조합 중
        # 429개가 HTTP 429 로 빠졌는데 validate 는 통과했고 자산이 그대로 만들어졌다(행 수 30% 감소).
        # 캐시는 위에서 이미 썼으므로 --retry 가 빠진 조합만 다시 받는다.
        sys.exit(f"! B_PARTIAL_COLLECTION 실패 {len(errs)}조합이 남았다 — 자산을 쓰지 않는다. "
                 "python3 scripts/build_assets.py --retry 로 채운다")

    records, names, renew, dropped = aggregate(rows, asof)
    meta = {"months": [ymds[0], ymds[-1]], "rows": len(rows), "renewals": len(renew)}
    anc = anchors(renew, rows, asof, ymds, dropped, errs, zeros)

    bad = validate(records, anc)
    if bad:
        print(f"! B_ASSET_INVALID {len(bad)}건:")
        for b in bad[:10]:
            print(f"  {b}")
        sys.exit(1)

    out = os.path.join(os.path.dirname(__file__), "..", "dist", "data")
    os.makedirs(os.path.join(out, "cohort"), exist_ok=True)
    sh = shard(records, names, asof, meta)
    for sgg, payload in sh.items():
        with open(os.path.join(out, "cohort", f"{sgg}.json"), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    index = {
        "asof": asof, "meta": meta,
        "gu": [{"sgg": s, "nm": n,
                "cohorts": len(sh[s]["cohorts"]), "buildings": len(sh[s]["buildings"])}
               for s, n in SEOUL.items()],
    }
    for name, payload in (("index.json", index), ("anchors.json", anc)):
        with open(os.path.join(out, name), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    total = sum(os.path.getsize(os.path.join(out, "cohort", f"{s}.json")) for s in SEOUL)
    print(f"# 자산 출력: 코호트 {len(records):,}개, 샤드 25개 {total/1e6:.2f}MB, 갱신표본 {len(renew):,}건")
    print(f"# 앵커: 행사기록 있음 {anc['recorded']['n']:,}건 5%초과 {anc['recorded']['over5']}% / "
          f"없음 {anc['unrecorded']['n']:,}건 5%초과 {anc['unrecorded']['over5']}% / "
          f"정확히5% {anc['exactly5_pct']}% / "
          f"초과차액 중앙 {anc['excess_median']:,}만원")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        selftest()
    else:
        main(from_cache="--from-cache" in sys.argv, retry="--retry" in sys.argv)
