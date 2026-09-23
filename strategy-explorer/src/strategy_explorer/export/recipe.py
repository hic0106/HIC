"""Strategy Recipe export.

Writes, for one candidate, the files a human reviews before porting a rule to
another (trading) project by hand:

    strategy_recipe.json     machine-readable recipe (DSL, features, parameters, execution semantics,
                             costs, validation, reproducibility, trial accounting)
    strategy_description.md  plain-language explanation + exact DSL
    strategy_report.md       validation report (gate checks, walk-forward, DSR, PBO, stress, ...)
    validation_report.json   full validation bundle
    equity_curve.csv         per-bar equity on TRAIN+VALIDATION+TEST (net of costs)
    trades.csv               every trade with costs
    trial_lineage.json       ancestry of the trial in the ledger
    signal_check.csv         per-bar signals, so a port can be verified bar by bar

Nothing is deployed anywhere; the export only writes files.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

import numpy as np

from .. import RESEARCH_ONLY_NOTICE, __version__
from ..dsl.complexity import parameters
from ..dsl.nodes import Strategy, iter_nodes
from ..dsl.registry import SIG_BY_KEY, Registry
from ..dsl.typecheck import compile_strategy
from ..ledger.db import LedgerDB
from ..pipeline.context import rebuild_context
from ..util import dumps, ms_to_iso, utc_now_iso

EXPORT_FILES = ("strategy_recipe.json", "strategy_description.md", "strategy_report.md", "validation_report.json",
                "equity_curve.csv", "trades.csv", "trial_lineage.json", "signal_check.csv")
EXECUTION = {
    "signal_time": "evaluated at the close of each bar",
    "fill": "market order at the OPEN of the next bar (slippage applied to the fill price)",
    "entry_when_flat": "long entry opens a long, short entry opens a short; both on the same bar = no trade",
    "while_in_position": "only the exit rules of that side are evaluated, starting at the close of the fill bar; "
                         "opposite entries are ignored unless they fire on the exit bar (then the position reverses "
                         "at the same open)",
    "same_side_reentry": "not on the bar of the exit signal",
    "max_hold": "exit at the open after MAX_HOLD bars in the trade",
    "stop_loss_take_profit": "checked on bar closes, executed at the next open",
    "level_vs_onset": "WHEN (plain condition) = level trigger; ONSET(...) = only the bar the condition turns true",
    "warmup": "conditions are unknown (never true) until every look-back window is filled",
    "higher_timeframes": "tf(\"X\", expr) uses only fully closed X candles, aligned on candle close time",
}


def _direction_list(st: Strategy) -> list[str]:
    return {"long": ["long"], "short": ["short"], "long_short": ["long", "short"]}[st.direction]


def required_features(st: Strategy) -> tuple[list[dict], list[str]]:
    feats: dict[str, dict] = {}
    cols: set[str] = set()
    for slot, root in st.slot_items():
        for _, n in iter_nodes(root):
            if n.is_literal or n.op in ("WHEN",):
                continue
            sig = SIG_BY_KEY.get(n.sig) if n.sig else None
            if sig is None:
                continue
            cols |= set(sig.requires)
            if sig.category in ("logic", "compare", "signal"):
                continue
            key = n.text
            if key not in feats:
                feats[key] = {"expression": key, "function": sig.name, "category": sig.category,
                              "returns": str(sig.ret), "definition": sig.doc, "used_in": [slot]}
            elif slot not in feats[key]["used_in"]:
                feats[key]["used_in"].append(slot)
    return list(feats.values()), sorted(cols)


def _csv(path: Path, header: list[str], rows) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        for r in rows:
            w.writerow(r)


def _segment_labels(ctx, start: int, stop: int) -> np.ndarray:
    lab = np.empty(stop - start, dtype=object)
    for name in ("train", "validation", "test"):
        s, e = ctx.split.segment(name)
        lab[max(0, s - start):max(0, e - start)] = name
    return lab


def _perf(m: dict) -> dict:
    keys = ("total_return", "cagr", "sharpe", "sortino", "max_drawdown", "profit_factor", "win_rate", "expectancy",
            "trades", "exposure", "turnover", "gross_return", "cost_fees", "cost_slippage", "cost_funding")
    return {k: m.get(k) for k in keys}


def _fmt(x, pct=False, nd=3):
    if x is None:
        return "n/a"
    try:
        x = float(x)
    except (TypeError, ValueError):
        return str(x)
    return f"{100 * x:.2f}%" if pct else f"{x:.{nd}f}"


def build_report_md(name: str, cand: dict, v: dict, gate: dict, recipe: dict) -> str:
    L = [f"# {name} - validation report", "", f"> {RESEARCH_ONLY_NOTICE}", "",
         f"Status: **{cand['status']}** | Holdout: **{cand['holdout_status']}** | Novelty: "
         f"**{cand.get('novelty_class')}** | Selected from **{v['trial_accounting']['n_trials_evaluated']}** evaluated "
         f"trials (effective {v['trial_accounting'].get('n_trials_effective')}), "
         f"{v['trial_accounting']['n_trials_recorded']} recorded", "", "## Rule", "", "```", recipe["dsl"], "```", "",
         "## Robustness gate", "", "| check | result | value | threshold |", "|---|---|---|---|"]
    for c in gate["checks"]:
        L.append(f"| {c['name']} | {'PASS' if c['passed'] else 'FAIL'} | `{json.dumps(c['value'], default=str)[:80]}` | "
                 f"`{json.dumps(c['threshold'], default=str)[:40]}` |")
    for w in gate.get("warnings", []):
        L.append(f"\n**{w}**")
    L += ["", "## Performance (net of costs)", "", "| segment | return | sharpe | sortino | max DD | PF | trades |",
          "|---|---|---|---|---|---|---|"]
    for seg in ("train", "validation", "test", "oos"):
        m = v.get(seg, {})
        L.append(f"| {seg} | {_fmt(m.get('total_return'), True)} | {_fmt(m.get('sharpe'), nd=2)} | "
                 f"{_fmt(m.get('sortino'), nd=2)} | {_fmt(m.get('max_drawdown'), True)} | "
                 f"{_fmt(m.get('profit_factor'), nd=2)} | {m.get('trades')} |")
    wf = v.get("walk_forward", {})
    L += ["", f"## Walk-forward ({wf.get('mode')}, refit={wf.get('refit')})", "",
          f"positive folds {_fmt(wf.get('positive_fraction'), True)}, compounded OOS "
          f"{_fmt(wf.get('compounded_oos_return'), True)}, passed={wf.get('passed')}", "",
          "| fold | test window | clean | fixed return | refit return |", "|---|---|---|---|---|"]
    for f in wf.get("folds", []):
        L.append(f"| {f['fold']} | {ms_to_iso(f['test_start_ts'])} .. {ms_to_iso(f['test_end_ts'])} | {f['clean']} | "
                 f"{_fmt(f['fixed']['total_return'], True)} | {_fmt((f.get('refit') or {}).get('total_return'), True)} |")
    d = v.get("dsr", {})
    L += ["", "## Overfitting firewall", "",
          f"- Deflated Sharpe Ratio ({d.get('segment')}, N={d.get('n_trials')} {d.get('n_basis')}): "
          f"**{_fmt(d.get('dsr'))}** (SR/bar {_fmt(d.get('sharpe_per_bar'), nd=4)}, expected max under null "
          f"{_fmt(d.get('expected_max_sharpe'), nd=4)}); PSR on test vs 0: {_fmt(d.get('psr_test_vs_zero'))}",
          f"- PBO (experiment, CSCV): **{_fmt(v.get('pbo_experiment', {}).get('pbo'))}**; parameter-neighbourhood PBO "
          f"(diagnostic): {_fmt(v.get('pbo_candidate', {}).get('pbo'))}",
          f"- Parameter sensitivity: passed={v.get('sensitivity', {}).get('passed')}, selection-region positive "
          f"fraction {_fmt(v.get('sensitivity', {}).get('train+validation', {}).get('positive_fraction'), True)}, "
          f"test positive fraction {_fmt(v.get('sensitivity', {}).get('test', {}).get('positive_fraction'), True)}",
          f"- Look-ahead truncation test: valid={v.get('lookahead', {}).get('valid')}"]
    st = v.get("stress", {})
    L += ["", "## Stress tests (validation+test)", "", "| scenario | return | trades |", "|---|---|---|"]
    for k, s in st.get("scenarios", {}).items():
        L.append(f"| {k} | {_fmt(s.get('total_return'), True)} | {s.get('trades')} |")
    mt = st.get("missed_trades", {})
    L.append(f"| missed trades p={mt.get('prob')} ({mt.get('runs')} runs) | median {_fmt(mt.get('median_return'), True)}"
             f", positive {_fmt(mt.get('positive_fraction'), True)} | |")
    rg = v.get("regimes", {})
    if rg.get("available"):
        L += ["", "## Regime breakdown", "", "| regime | label | return | trades | bars in position |",
              "|---|---|---|---|---|"]
        for r in rg["regimes"]:
            L.append(f"| {r['regime']} | {r['label']} | {_fmt(r['return'], True)} | {r['trades_entered']} | "
                     f"{r['bars_in_position']} |")
    ca = v.get("cross_asset", {})
    L += ["", f"## Cross-asset: {ca.get('classification')}", ""]
    for a in ca.get("assets", []):
        L.append(f"- {a['asset']} ({a['asset_class']}): {a.get('status')} return {_fmt(a.get('total_return'), True)}"
                 f" trades {a.get('trades')}")
    ks = v.get("known_strategy", {})
    L += ["", f"## Known-strategy check: {ks.get('novelty_class')}", "",
          f"closest: {ks.get('closest')} ({ks.get('closest_family')}), similarity {_fmt(ks.get('max_similarity'))}; "
          f"structural matches: {ks.get('structural') or 'none'}"]
    if cand.get("holdout"):
        h = cand["holdout"]
        L += ["", "## Final holdout (single evaluation)", "", f"verdict **{h.get('verdict')}** on {h['window']['start']} "
              f".. {h['window']['end']} ({h['window']['bars']} bars): return {_fmt(h['metrics'].get('total_return'), True)}, "
              f"trades {h['metrics'].get('trades')}"]
    return "\n".join(L) + "\n"


def export_candidate(db: LedgerDB, candidate_id: int, root: str | Path = ".", out_dir: str | Path | None = None) -> dict:
    cand = db.candidate(candidate_id)
    if cand is None:
        raise KeyError(f"unknown candidate {candidate_id}")
    eid = cand["experiment_id"]
    ctx = rebuild_context(db, eid, Path(root))
    reg = Registry(**ctx.registry_kwargs)
    st = compile_strategy(cand["dsl"], reg, 400, 60)
    if st.hash != cand["strategy_hash"]:
        raise RuntimeError("recompiled strategy hash differs from the stored candidate")
    ev = ctx.evaluator
    sig = ev.signals(st)
    v = cand["validation"]
    gate = cand["gate"]
    trial = db.trial(cand["trial_id"])
    name = f"AI_DISCOVERED_{int(cand['trial_id']):05d}"
    base = Path(out_dir) if out_dir else (Path(root) / ctx.cfg["export"]["dir"])
    folder = (base / f"{name}_{st.hash[:8]}").resolve()
    folder.mkdir(parents=True, exist_ok=True)

    s, e = ctx.split.segment("search")
    res, full_m = ev.backtest(st, (s, e), sig)
    feats, cols = required_features(st)
    uses_regime = any(n.op in ("regime_is", "regime_prob") for _, r in st.slot_items() for _, n in iter_nodes(r))
    pats = sorted({n.value for _, r in st.slot_items() for _, n in iter_nodes(r) if n.op == "#pattern"})
    rec = ctx.record
    recipe = {
        "recipe_format": "ai-strategy-explorer/recipe@1",
        "strategy_name": name,
        "version": 1,
        "research_only": True,
        "notice": RESEARCH_ONLY_NOTICE,
        "status": cand["status"],
        "gate_passed": bool(gate.get("passed_all")),
        "holdout_status": cand["holdout_status"],
        "asset": ctx.md_search.asset,
        "asset_class": ctx.md_search.asset_class,
        "timeframe": ctx.md_search.timeframe,
        "extra_timeframes": list(ctx.htf),
        "direction": _direction_list(st),
        "entry_expression": {side: st.slot(f"{side}_entry").text for side in _direction_list(st)},
        "exit_expression": {side: (st.slot(f"{side}_exit").text if st.slot(f"{side}_exit") is not None else None)
                            for side in _direction_list(st)},
        "risk": {"max_hold_bars": st.max_hold, "stop_loss": st.stop_loss, "take_profit": st.take_profit},
        "dsl": st.to_text(pretty_print=True),
        "dsl_canonical": st.text,
        "dsl_version": "1",
        "required_features": feats,
        "required_columns": cols,
        "parameters": {p.name: p.value for p in parameters(st)},
        "parameters_detail": [p.to_dict() for p in parameters(st)],
        "execution": EXECUTION,
        "position_sizing": ctx.exec_cfg.to_dict(),
        "cost_model": ctx.costs.to_dict(),
        "pattern_templates": ctx.pattern_library.subset(pats).to_dict() if pats and ctx.pattern_library else None,
        "regime_model": ctx.regime_model.to_dict() if uses_regime and ctx.regime_model else None,
        "validation": {
            "walk_forward": bool(v.get("walk_forward", {}).get("passed")),
            "walk_forward_positive_fraction": v.get("walk_forward", {}).get("positive_fraction"),
            "deflated_sharpe": v.get("dsr", {}).get("dsr"),
            "deflated_sharpe_basis": {k: v.get("dsr", {}).get(k) for k in ("segment", "n_basis", "n_trials")},
            "psr_test_vs_zero": v.get("dsr", {}).get("psr_test_vs_zero"),
            "pbo": v.get("pbo_experiment", {}).get("pbo"),
            "pbo_parameter_neighbourhood": v.get("pbo_candidate", {}).get("pbo"),
            "parameter_stability": bool(v.get("sensitivity", {}).get("passed")),
            "stress_passed": bool(v.get("stress", {}).get("passed")),
            "cost_survival": bool(v.get("stress", {}).get("cost_survival")),
            "lookahead_valid": bool(v.get("lookahead", {}).get("valid")),
            "novelty_class": cand.get("novelty_class"),
            "closest_known_strategy": v.get("known_strategy", {}).get("closest"),
            "cross_asset": v.get("cross_asset", {}).get("classification"),
            "works_in_regimes": v.get("regimes", {}).get("works_in"),
            "warnings": gate.get("warnings", []),
            "gate_checks": [{k: c[k] for k in ("name", "passed")} for c in gate["checks"]],
        },
        "performance": {seg: _perf(v.get(seg, {})) for seg in ("train", "validation", "test", "oos")},
        "holdout": cand.get("holdout"),
        "trial_accounting": v.get("trial_accounting"),
        "reproducibility": {
            "experiment_id": eid, "trial_id": cand["trial_id"], "candidate_id": candidate_id,
            "strategy_hash": st.hash, "random_seed": rec["random_seed"], "data_version": rec["data_version"],
            "code_version": rec["code_version"], "config_hash": rec["config_hash"], "trial_budget": rec["trial_budget"],
            "cost_model": rec["cost_model"], "generator": f"ai-strategy-explorer {__version__}",
        },
        "data_split": ctx.split.to_dict()["boundaries_iso"],
        "created_at": utc_now_iso(),
    }
    files = {}

    def write(fname: str, text: str) -> None:
        p = folder / fname
        p.write_text(text, encoding="utf-8")
        files[fname] = str(p)

    write("strategy_recipe.json", dumps(recipe, indent=2))
    expl = cand.get("explanation") or {}
    desc = [f"# {name}", "", f"> {RESEARCH_ONLY_NOTICE}", "", "## 설명 (자동 생성, 계산된 수치만 사용)", "",
            expl.get("text", ""), ""]
    if expl.get("llm_narrative"):
        desc += ["## LLM narrative (informational, not scored)", "", expl["llm_narrative"].get("text", ""), ""]
    desc += ["## DSL", "", "```", recipe["dsl"], "```", "", "## Card", "",
             f"- Status: {cand['status']} / Holdout: {cand['holdout_status']}",
             f"- Novelty: {v.get('novelty_level')} ({cand.get('novelty_class')})",
             f"- Complexity: {v.get('complexity', {}).get('nodes')} nodes, {v.get('complexity', {}).get('parameters')} "
             f"parameters",
             f"- OOS (validation+test): return {_fmt(v['oos'].get('total_return'), True)}, trades {v['oos'].get('trades')}"
             f", MDD {_fmt(v['oos'].get('max_drawdown'), True)}, Sortino {_fmt(v['oos'].get('sortino'), nd=2)}",
             f"- Deflated Sharpe {_fmt(v.get('dsr', {}).get('dsr'))}, PBO {_fmt(v.get('pbo_experiment', {}).get('pbo'))}",
             f"- Selected from {v['trial_accounting']['n_trials_evaluated']} evaluated trials", ""]
    write("strategy_description.md", "\n".join(desc))
    write("strategy_report.md", build_report_md(name, cand, v, gate, recipe))
    write("validation_report.json", dumps({"candidate": {k: cand[k] for k in ("candidate_id", "trial_id", "status",
                                                                              "holdout_status", "novelty_class")},
                                           "gate": gate, "validation": v, "holdout": cand.get("holdout")}, indent=2))
    ts = ctx.md_search.ts[s:e]
    seg = _segment_labels(ctx, s, e)
    curve = np.r_[res.initial_equity, res.equity]
    dd = curve[1:] / np.maximum.accumulate(curve)[1:] - 1.0
    _csv(folder / "equity_curve.csv", ["timestamp", "ts_ms", "segment", "equity", "drawdown", "position", "bar_return"],
         ((ms_to_iso(int(t)), int(t), sg, f"{eq:.6f}", f"{d:.6f}", int(p), f"{r:.8f}")
          for t, sg, eq, d, p, r in zip(ts, seg, res.equity, dd, res.position, res.returns)))
    files["equity_curve.csv"] = str(folder / "equity_curve.csv")
    md = ctx.md_search
    _csv(folder / "trades.csv", ["side", "signal_time", "entry_time", "entry_price", "exit_time", "exit_price", "reason",
                                 "bars_held", "qty", "gross_pnl", "fees", "slippage_cost", "funding", "net_pnl",
                                 "return", "mfe", "mae", "segment"],
         (("long" if t.side == 1 else "short", ms_to_iso(int(md.ts[t.signal_idx] + md.bar_ms)),
           ms_to_iso(int(md.ts[t.entry_idx])), f"{t.entry_price:.8g}",
           ms_to_iso(int(md.ts[t.exit_idx] + (md.bar_ms if t.exit_at_close else 0))), f"{t.exit_price:.8g}", t.reason,
           t.bars_held, f"{t.qty:.8g}", f"{t.gross_pnl:.4f}", f"{t.fees:.4f}", f"{t.slippage_cost:.4f}",
           f"{t.funding:.4f}", f"{t.net_pnl:.4f}", f"{t.ret:.6f}", f"{t.mfe:.6f}", f"{t.mae:.6f}",
           seg[t.entry_idx - s]) for t in res.trades))
    files["trades.csv"] = str(folder / "trades.csv")
    write("trial_lineage.json", dumps({"trial": {k: trial.get(k) for k in ("trial_id", "seq", "generation",
                                                                         "creation_method", "operator", "phase",
                                                                         "parent_trial", "parents", "family",
                                                                         "strategy_hash", "status")},
                                       "ancestors": db.lineage(cand["trial_id"]),
                                       "experiment_trial_counts": db.trial_counts(eid)}, indent=2))
    _csv(folder / "signal_check.csv", ["timestamp_close", "ts_open_ms", "long_entry", "long_exit", "short_entry",
                                       "short_exit", "position_during_bar"],
         ((ms_to_iso(int(md.ts[i] + md.bar_ms)), int(md.ts[i]), int(sig.long_entry[i]), int(sig.long_exit[i]),
           int(sig.short_entry[i]), int(sig.short_exit[i]), int(res.position[i - s])) for i in range(s, e)))
    files["signal_check.csv"] = str(folder / "signal_check.csv")
    db.add_export(eid, candidate_id, str(folder), sorted(files))
    return {"folder": str(folder), "files": files, "strategy_name": name}
