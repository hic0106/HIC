"""Human-readable strategy explanation.

The deterministic explanation is assembled from the rule's syntax tree plus
statistics computed by the backtester. An optional LLM narrative may be added,
but it is stored separately, labelled as such, and never scored.
"""

from __future__ import annotations

import numpy as np

from ..dsl.nodes import Node, Strategy, fmt_number
from ..patterns.stats import forward_returns
from .client import LLMRequest, LLMUnavailable
from .prompts import EXPLANATION_SCHEMA, explanation_prompt, system_prompt

KO_SERIES = {
    "return": "최근 {0}봉 수익률", "log_return": "최근 {0}봉 로그수익률",
    "body_size": "캔들 몸통 크기(시가 대비)", "body_ratio": "캔들 몸통/전체 범위 비율",
    "upper_wick": "윗꼬리 비율", "lower_wick": "아랫꼬리 비율", "wick_to_body": "꼬리/몸통 비율",
    "close_location_in_range": "종가의 캔들 범위 내 위치", "high_low_range": "캔들 고저폭(종가 대비)",
    "gap": "시가 갭(전일 종가 대비)", "true_range": "True Range(전 종가 대비)",
    "range_expansion": "현재 캔들 범위/직전 {0}봉 평균 범위", "range_contraction": "최근 {0}봉 평균 범위/최근 4배 기간 평균 범위",
    "range_position": "종가의 최근 {0}봉 가격 범위 내 위치",
    "volume_return": "거래량 변화율({0}봉)", "volume_ratio": "거래량/직전 {0}봉 평균",
    "volume_zscore": "거래량 z-score(직전 {0}봉 기준)", "rolling_volume_mean": "{0}봉 평균 거래량",
    "rolling_volume_std": "{0}봉 거래량 표준편차", "price_volume_correlation": "가격-거래량 변화 상관({0}봉)",
    "volume_acceleration": "거래량 추세 가속도({0}봉)", "relative_volume": "같은 시간대 대비 상대 거래량({0}일)",
    "realized_volatility": "{0}봉 실현변동성", "range_volatility": "{0}봉 고저 기반 변동성",
    "volatility_ratio": "변동성 비율({0}봉/{1}봉)", "volatility_change": "{0}봉 변동성 변화율",
    "distance_from_recent_high": "최근 {0}봉 고점 대비 거리", "distance_from_recent_low": "최근 {0}봉 저점 대비 거리",
    "higher_high_count": "최근 {0}봉 중 고점 갱신 횟수", "lower_low_count": "최근 {0}봉 중 저점 갱신 횟수",
    "trend_slope": "{0}봉 추세 기울기/변동성", "compression_score": "{0}봉 범위 압축도",
    "breakout_distance": "직전 {0}봉 고점 돌파 거리(ATR 단위)", "taker_buy_ratio": "{0}봉 테이커 매수 비중",
    "funding_sum": "{0}봉 펀딩비 합", "oi_change": "{0}봉 미결제약정 변화율",
    "close": "종가", "open": "시가", "high": "고가", "low": "저가", "volume": "거래량",
    "pattern_distance": "발견 패턴 {0}와의 거리", "regime_prob": "레짐 {0} 확률",
}
KO_TRANSFORM = {
    "lag": "{1}봉 전 {0}", "rolling_mean": "{0}의 {1}봉 평균", "rolling_max": "{0}의 {1}봉 최고값",
    "rolling_min": "{0}의 {1}봉 최저값", "rolling_std": "{0}의 {1}봉 표준편차", "zscore": "{0}의 {1}봉 z-score",
    "rank": "{0}의 {1}봉 내 백분위", "slope": "{0}의 {1}봉 기울기", "log": "{0}(로그)", "abs": "{0}의 절댓값",
    "ratio": "{0}/{1} 비율", "difference": "{0}-{1} 차이", "correlation": "{0}와 {1}의 {2}봉 상관계수",
    "rolling_quantile": "{0}의 {1}봉 {2} 분위수", "count_true": "최근 {1}봉 중 [{0}]인 봉 수",
    "bars_since": "[{0}] 이후 경과 봉 수", "tf": "{0} 봉 기준 {1}",
}


def describe_series(n: Node) -> str:
    if n.is_literal:
        return fmt_number(n.value) if n.op not in ("#tf", "#pattern") else str(n.value)
    args = [describe_series(a) if not a.is_literal or a.op in ("#tf", "#pattern") else fmt_number(a.value)
            for a in n.args]
    if n.op in ("count_true", "bars_since"):
        args = [describe_condition(n.args[0])] + args[1:]
    tpl = KO_TRANSFORM.get(n.op) or KO_SERIES.get(n.op)
    if tpl is None:
        return n.text
    try:
        return tpl.format(*args)
    except (IndexError, KeyError):
        return n.text


def describe_condition(n: Node) -> str:
    if n.op == "WHEN":
        return describe_condition(n.args[0])
    if n.op == "ONSET":
        return f"({describe_condition(n.args[0])}) 이/가 새로 성립"
    if n.op == "AND":
        return " 그리고 ".join(describe_condition(a) for a in n.args)
    if n.op == "OR":
        return " 또는 ".join(describe_condition(a) for a in n.args)
    if n.op == "NOT":
        return f"NOT ({describe_condition(n.args[0])})"
    if n.op in ("GT", "LT", "CROSS_ABOVE", "CROSS_BELOW"):
        a, b = describe_series(n.args[0]), describe_series(n.args[1])
        sym = {"GT": ">", "LT": "<", "CROSS_ABOVE": "상향 돌파 ↗", "CROSS_BELOW": "하향 돌파 ↘"}[n.op]
        return f"{a} {sym} {b}"
    if n.op == "was":
        return f"최근 {n.args[1].value}봉 안에 한 번 이상 [{describe_condition(n.args[0])}]"
    if n.op == "held":
        return f"최근 {n.args[1].value}봉 연속 [{describe_condition(n.args[0])}]"
    if n.op == "regime_is":
        return f"HMM 레짐 = {n.args[0].value}"
    if n.op == "tf":
        return f"{n.args[0].value} 봉 기준 [{describe_condition(n.args[1])}]"
    return n.text


def condition_bullets(root: Node) -> tuple[str, list[str]]:
    """(header, bullet lines) for one slot."""
    trigger = "조건이 새로 성립하는 봉" if root.op == "ONSET" else "조건이 성립하는 봉"
    body = root.args[0] if root.op in ("WHEN", "ONSET") else root
    if body.op == "AND":
        return f"아래 조건을 모두 충족 ({trigger})", [describe_condition(a) for a in body.args]
    if body.op == "OR":
        return f"아래 조건 중 하나 이상 충족 ({trigger})", [describe_condition(a) for a in body.args]
    return f"아래 조건 충족 ({trigger})", [describe_condition(body)]


def signal_forward_profile(entry: np.ndarray, open_: np.ndarray, s: int, e: int,
                           horizons=(1, 3, 5, 7, 10)) -> dict:
    fwd = forward_returns(open_[s:e], tuple(horizons))
    idx = np.flatnonzero(entry[s:e])
    out = {}
    for h, f in fwd.items():
        v = f[idx]
        v = v[np.isfinite(v)]
        out[str(h)] = {"n": int(v.size), "mean": float(v.mean()) if v.size else None,
                       "hit_rate": float((v > 0).mean()) if v.size else None}
    return out


def explain(st: Strategy, facts: dict) -> dict:
    """Deterministic Korean explanation. ``facts`` holds computed statistics (train/oos forward profiles etc.)."""
    lines = []
    side_word = {"long": "매수(롱)", "short": "매도(숏)", "long_short": "롱/숏 양방향"}[st.direction]
    lines.append(f"이 전략은 {side_word} 규칙입니다.")
    lines.append("조건은 봉 마감 시 판단하고, 체결은 다음 봉 시가입니다.")
    for slot, node in st.slot_items():
        label = {"long_entry": "롱 진입", "long_exit": "롱 청산", "short_entry": "숏 진입",
                 "short_exit": "숏 청산"}[slot]
        head, bullets = condition_bullets(node)
        lines.append(f"[{label}] {head}:")
        lines.extend(f"  · {b}" for b in bullets)
    if st.max_hold:
        lines.append(f"최대 보유 기간: {st.max_hold}봉.")
    if st.stop_loss:
        lines.append(f"종가 기준 손실이 {st.stop_loss:.1%}에 도달하면 다음 봉 시가에 청산합니다.")
    prof_tr = facts.get("forward_train") or {}
    prof_oos = facts.get("forward_oos") or {}

    def fmt(p, h):
        x = p.get(h, {})
        return None if x.get("mean") is None else x["mean"]

    obs = []
    for h in ("3", "5", "7"):
        a, b = fmt(prof_tr, h), fmt(prof_oos, h)
        if a is not None and b is not None:
            obs.append((h, a, b))
    sign = 1 if st.direction != "short" else -1
    if obs:
        pos = [o for o in obs if sign * o[1] > 0 and sign * o[2] > 0]
        desc = ", ".join(f"+{h}봉 TRAIN {a:+.2%} / OOS {b:+.2%}" for h, a, b in obs)
        if len(pos) == len(obs):
            lines.append(f"진입 신호 이후 평균 가격 변화는 {desc}로, TRAIN과 OOS 모두 전략 방향과 같은 부호로 관찰되었습니다.")
        else:
            lines.append(f"진입 신호 이후 평균 가격 변화: {desc}. 구간 간 부호가 일관되지 않습니다.")
    t = facts.get("trades")
    if t:
        lines.append(f"검증 구간(validation+test) 거래 {t.get('oos_trades')}회, 승률 {t.get('oos_win_rate', 0):.0%}, "
                     f"평균 거래 수익 {t.get('oos_expectancy', 0):+.2%} (비용 차감 후).")
    return {"text": "\n".join(lines), "source": "template", "dsl": st.to_text(pretty_print=True)}


def llm_narrative(llm, st: Strategy, facts_text: str, grammar: str, timeframe: str, asset_class: str) -> dict | None:
    if llm is None:
        return None
    req = LLMRequest(purpose="explain", system=system_prompt("explain", grammar, timeframe, asset_class),
                     user=explanation_prompt(st.text, facts_text), schema=EXPLANATION_SCHEMA)
    try:
        resp = llm.complete_json(req)
    except LLMUnavailable:
        return None
    if not resp.data:
        return None
    return {"text": resp.data.get("explanation", ""), "source": f"llm:{resp.model}",
            "note": "LLM narrative - informational only, not used in any score"}
