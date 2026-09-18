#!/usr/bin/env python3
"""국토교통부 전월세 실거래가 4종 API(아파트·오피스텔·연립다세대·단독다가구)를 받아
유형별 채움률과 갱신 인상률 분포를 잰다.

키: .env 의 DATA_GO_KR_SERVICE_KEY (Decoding 키. 코드에서 URL 인코딩한다)
실행: python3 molit_rent.py <LAWD_CD,...> <YYYYMM,...>
검증: python3 molit_rent.py --selftest   (네트워크 없이 돈다)

가정(quantify_renewal.py 와 동일하게 유지):
  - 인상률은 전세→전세 갱신만 센다. 월세가 섞이면 보증금 단독 비교가 성립하지 않는다.
  - 갱신 행의 useRRRight 공란은 '행사 기록 없음'으로 본다(근거 등급 B).
  - 신규 계약 행은 이 필드가 100% 공란이므로 갱신 행만 센다.
"""
import os
import re
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

CAP = 0.05
SVC = {  # 유형: (서비스, 단지명 필드)
    "아파트": ("RTMSDataSvcAptRent", "aptNm"),
    "오피스텔": ("RTMSDataSvcOffiRent", "offiNm"),
    "연립다세대": ("RTMSDataSvcRHRent", "mhouseNm"),
    "단독다가구": ("RTMSDataSvcSHRent", None),  # 건물명·지번 없음 → 읍면동 단위가 최선
}


def num(s):
    s = (s or "").replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def items(xml):
    return re.findall(r"<item>(.*?)</item>", xml, re.S)


def field(item, tag):
    m = re.search(rf"<{tag}>(.*?)</{tag}>", item, re.S)
    return (m.group(1) if m else "").strip()


def fetch(kind, lawd, ymd, key, rows=1000):
    svc, _ = SVC[kind]
    q = urllib.parse.urlencode(
        {"serviceKey": key, "LAWD_CD": lawd, "DEAL_YMD": ymd, "numOfRows": rows, "pageNo": 1}
    )
    url = f"https://apis.data.go.kr/1613000/{svc}/get{svc}?{q}"
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def parse(kind, xml):
    _, name_tag = SVC[kind]
    out = []
    for it in items(xml):
        out.append(
            {
                "kind": kind,
                "sgg": field(it, "sggCd"),
                "umd": field(it, "umdNm"),
                "name": field(it, name_tag) if name_tag else "",
                "area": num(field(it, "excluUseAr") or field(it, "totalFloorAr")),
                "deposit": num(field(it, "deposit")),
                "rent": num(field(it, "monthlyRent")),
                "prev_deposit": num(field(it, "preDeposit")),
                "prev_rent": num(field(it, "preMonthlyRent")),
                "ctype": field(it, "contractType"),  # 신규/갱신
                "rr": field(it, "useRRRight"),  # 사용/공란
            }
        )
    return out


def pct(vals, p):
    if not vals:
        return None
    s = sorted(vals)
    return s[min(len(s) - 1, int(round((len(s) - 1) * p / 100)))]


def stats(rows):
    """유형별 채움률과 전세→전세 갱신 인상률 분포."""
    out = {}
    for kind in SVC:
        rs = [r for r in rows if r["kind"] == kind]
        renew = [r for r in rs if r["ctype"] == "갱신"]
        new = [r for r in rs if r["ctype"] == "신규"]
        jeonse = [
            r
            for r in renew
            if r["prev_deposit"] and not (r["prev_rent"] or 0) and not (r["rent"] or 0)
        ]
        rates = [(r["deposit"] - r["prev_deposit"]) / r["prev_deposit"] for r in jeonse]
        used = [r for r in jeonse if r["rr"]]
        unused = [r for r in jeonse if not r["rr"]]

        def over(g):
            rr = [(r["deposit"] - r["prev_deposit"]) / r["prev_deposit"] for r in g]
            return (sum(1 for x in rr if x > CAP) / len(rr)) if rr else None

        cohort = {}
        for r in jeonse:
            k = (r["sgg"], r["umd"], r["name"], round((r["area"] or 0) / 10))
            cohort[k] = cohort.get(k, 0) + 1
        out[kind] = {
            "행": len(rs),
            "갱신": len(renew),
            "신규": len(new),
            "계약구분_공란": sum(1 for r in rs if not r["ctype"]),
            "갱신중_권리기재": (sum(1 for r in renew if r["rr"]) / len(renew)) if renew else None,
            "갱신중_종전보증금_채움": (
                sum(1 for r in renew if r["prev_deposit"]) / len(renew)
            )
            if renew
            else None,
            "신규중_권리기재": (sum(1 for r in new if r["rr"]) / len(new)) if new else None,
            "전세갱신n": len(jeonse),
            "행사n": len(used),
            "미기재n": len(unused),
            "행사_5%초과": over(used),
            "미기재_5%초과": over(unused),
            "정확히5%": (sum(1 for x in rates if abs(x - CAP) < 1e-9) / len(rates)) if rates else None,
            "중앙인상률": pct(rates, 50),
            "p90인상률": pct(rates, 90),
            "코호트3건이상": (
                sum(v for v in cohort.values() if v >= 3) / len(jeonse)
            )
            if jeonse
            else None,
        }
    return out


def collect(lawds, ymds, key, workers=8):
    jobs = [(k, l, y) for k in SVC for l in lawds for y in ymds]
    rows, errs = [], 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for res in ex.map(lambda j: _one(j, key), jobs):
            if res is None:
                errs += 1
            else:
                rows += res
    return rows, errs, len(jobs)


def _one(job, key):
    kind, lawd, ymd = job
    try:
        return parse(kind, fetch(kind, lawd, ymd, key))
    except Exception:
        return None


FIXTURE = """<response><body><items>
<item><sggCd>11680</sggCd><umdNm>역삼동</umdNm><aptNm>가상아파트</aptNm><excluUseAr>59.4</excluUseAr>
<deposit>10,500</deposit><monthlyRent>0</monthlyRent><preDeposit>10,000</preDeposit><preMonthlyRent>0</preMonthlyRent>
<contractType>갱신</contractType><useRRRight>사용</useRRRight></item>
<item><sggCd>11680</sggCd><umdNm>역삼동</umdNm><aptNm>가상아파트</aptNm><excluUseAr>59.4</excluUseAr>
<deposit>12,000</deposit><monthlyRent>0</monthlyRent><preDeposit>10,000</preDeposit><preMonthlyRent>0</preMonthlyRent>
<contractType>갱신</contractType><useRRRight> </useRRRight></item>
<item><sggCd>11680</sggCd><umdNm>역삼동</umdNm><aptNm>가상아파트</aptNm><excluUseAr>59.4</excluUseAr>
<deposit>20,000</deposit><monthlyRent>0</monthlyRent><preDeposit> </preDeposit><preMonthlyRent> </preMonthlyRent>
<contractType>신규</contractType><useRRRight> </useRRRight></item>
<item><sggCd>11680</sggCd><umdNm>역삼동</umdNm><aptNm>가상아파트</aptNm><excluUseAr>59.4</excluUseAr>
<deposit>5,000</deposit><monthlyRent>30</monthlyRent><preDeposit>5,000</preDeposit><preMonthlyRent>25</preMonthlyRent>
<contractType>갱신</contractType><useRRRight> </useRRRight></item>
</items></body></response>"""


def selftest():
    rows = parse("아파트", FIXTURE)
    assert len(rows) == 4
    s = stats(rows)["아파트"]
    assert s["갱신"] == 3 and s["신규"] == 1
    assert s["전세갱신n"] == 2, s["전세갱신n"]  # 월세 갱신 1건 제외
    assert s["행사n"] == 1 and s["미기재n"] == 1
    assert s["행사_5%초과"] == 0.0 and s["미기재_5%초과"] == 1.0  # 20% 인상 1건
    assert s["신규중_권리기재"] == 0.0  # 신규는 항상 공란
    assert abs(s["중앙인상률"] - 0.05) < 1e-9 or abs(s["중앙인상률"] - 0.20) < 1e-9
    assert num("10,500") == 10500.0 and num(" ") is None
    print("selftest ok")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        selftest()
    elif len(sys.argv) > 2:
        key = os.environ["DATA_GO_KR_SERVICE_KEY"]
        rows, errs, n = collect(sys.argv[1].split(","), sys.argv[2].split(","), key)
        print(f"# 호출 {n}건, 실패 {errs}건, 수집 {len(rows)}행")
        for kind, s in stats(rows).items():
            print(kind, {k: (round(v, 4) if isinstance(v, float) else v) for k, v in s.items()})
    else:
        print(__doc__)
