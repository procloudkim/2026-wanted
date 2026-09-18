#!/usr/bin/env python3
"""갱신 계약에서 '갱신요구권을 썼을 때의 상한(5%)과의 차액'을 계량한다.

입력: 서울 열린데이터광장 전월세가 CSV (키 없이 내려받은 파일).
     열: 신규갱신여부 / 계약갱신권사용여부 / 종전 보증금 / 종전 임대료 / 보증금(만원) / 임대료(만원) ...
출력: 코호트별 인상률 분포와 5% 초과 차액 합계.

주의: 합의 갱신(갱신요구권 미사용)에는 법정 5% 상한이 적용되지 않는다.
     여기서 계산하는 '초과 차액'은 위법 금액이 아니라
     "갱신요구권을 행사했을 때의 상한과 실제 계약의 차이"다.

가정(수치를 인용할 때 반드시 함께 쓴다. CLAUDE.md 규칙 10):
  - 모수: 서울, 전세→전세 갱신만. 월세가 섞인 계약은 제외한다(보증금 단독 비교 불가).
    월세를 환산해 넣으면 5% 초과 비율이 8%p 이상 움직인다(09-field-semantics.md §5).
  - 빈 칸 해석: 갱신 행의 `계약갱신권사용여부` 공란은 '미행사'로 본다.
    근거는 법정 신고서 서식의 2지 택일 작성방법과 국토부 자체 통계의 분모(09-field-semantics.md, 등급 B).
    화면 표기는 '미사용'이 아니라 '행사 기록이 없는 갱신 계약'으로 쓴다.
  - 신규 계약 행은 이 필드가 100% 비어 있으므로 절대 합산하지 않는다(이 코드는 갱신 행만 센다).

실행: python3 quantify_renewal.py <rent_csv_utf8>
검증: python3 quantify_renewal.py --selftest
"""
import csv
import sys

CAP = 0.05  # 주택임대차보호법 제7조: 약정 차임·보증금의 20분의 1


def num(s):
    s = (s or "").replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def rows(path):
    with open(path, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            yield r


def renewals(path):
    """전세→전세 갱신만 남긴다. 보증금만으로 인상률이 정의되는 유일한 구간이다."""
    for r in rows(path):
        if (r.get("신규갱신여부") or "").strip() != "갱신":
            continue
        prev_dep, prev_rent = num(r.get("종전 보증금")), num(r.get("종전 임대료"))
        dep, rent = num(r.get("보증금(만원)")), num(r.get("임대료(만원)"))
        if None in (prev_dep, dep) or not prev_dep:
            continue
        if (prev_rent or 0) > 0 or (rent or 0) > 0:
            continue  # 월세 포함 계약은 보증금 단독 비교가 성립하지 않는다
        used = bool((r.get("계약갱신권사용여부") or "").strip())
        yield {
            "used": used,
            "prev": prev_dep,
            "now": dep,
            "rate": (dep - prev_dep) / prev_dep,
            "gu": (r.get("자치구명") or "").strip(),
            "dong": (r.get("법정동명") or "").strip(),
            "bldg": (r.get("건물명") or "").strip(),
        }


def pct(vals, p):
    if not vals:
        return None
    s = sorted(vals)
    return s[min(len(s) - 1, int(round((len(s) - 1) * p / 100)))]


def report(path):
    data = list(renewals(path))
    out = {"total": len(data)}
    for used in (True, False):
        g = [d for d in data if d["used"] == used]
        rates = [d["rate"] for d in g]
        over = [d for d in g if d["rate"] > CAP]
        # 초과 차액: 상한을 적용했다면 올랐을 보증금과 실제 보증금의 차
        excess = [d["now"] - d["prev"] * (1 + CAP) for d in over]
        key = "used" if used else "not_used"
        out[key] = {
            "n": len(g),
            "over_cap_n": len(over),
            "over_cap_share": len(over) / len(g) if g else None,
            "exact_5pct": sum(1 for r in rates if abs(r - CAP) < 1e-9),
            "median_rate": pct(rates, 50),
            "p90_rate": pct(rates, 90),
            "excess_sum_manwon": sum(excess),
            "excess_median_manwon": pct(excess, 50),
        }
    # 코호트 표본: 같은 자치구·법정동·건물명에 비교 가능한 갱신 계약이 몇 건이나 있는가
    cohort = {}
    for d in data:
        cohort.setdefault((d["gu"], d["dong"], d["bldg"]), 0)
        cohort[(d["gu"], d["dong"], d["bldg"])] += 1
    out["cohort_ge3_share"] = sum(v for v in cohort.values() if v >= 3) / len(data) if data else None
    return out


FIXTURE = '''"자치구명","법정동명","보증금(만원)","임대료(만원)","건물명","전월세 구분","신규갱신여부","계약갱신권사용여부","종전 보증금","종전 임대료"
"강동구","길동","10,500","0","가상아파트","전세","갱신","사용","10,000","0"
"강동구","길동","12,000","0","가상아파트","전세","갱신","","10,000","0"
"강동구","길동","10,300","0","가상아파트","전세","갱신","","10,000","0"
"강동구","길동","20,000","0","가상아파트","전세","신규","","0","0"
"강동구","길동","5,000","30","가상아파트","월세","갱신","","5,000","25"
'''


def selftest():
    """상한 차액 계산과 파싱·필터가 틀리면 즉시 실패한다. 원본 파일 없이 돈다(CLAUDE.md 규칙 7·10)."""
    assert pct([1, 2, 3, 4, 5], 50) == 3 and pct([1, 2, 3, 4, 5], 90) == 5
    assert num("100,000") == num("100000") == 100000.0 and num("") is None
    import os
    import tempfile
    fd, path = tempfile.mkstemp(suffix=".csv")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(FIXTURE)
    try:
        r = report(path)
        assert r["total"] == 3, r["total"]  # 신규 1건·월세 갱신 1건은 제외된다
        assert r["used"]["n"] == 1 and r["used"]["over_cap_n"] == 0
        assert r["not_used"]["n"] == 2 and r["not_used"]["over_cap_n"] == 1
        assert abs(r["not_used"]["excess_sum_manwon"] - 1500.0) < 1e-9  # 12,000 - 10,000*1.05
        assert abs(r["used"]["median_rate"] - 0.05) < 1e-9
        assert r["cohort_ge3_share"] == 1.0  # 같은 자치구·법정동·건물명 3건
    finally:
        os.unlink(path)
    print("selftest ok")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        selftest()
    elif len(sys.argv) > 1:
        r = report(sys.argv[1])
        for k, v in r.items():
            print(k, v)
    else:
        print(__doc__)
