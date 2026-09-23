"""Command-line interface: ``python -m strategy_explorer <command>``."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import RESEARCH_ONLY_NOTICE, __version__
from .util import dumps


def _db(args):
    from .ledger.db import LedgerDB

    return LedgerDB(Path(args.workspace) / "ledger.sqlite")


def cmd_run(args) -> int:
    from .config import load_config
    from .pipeline.run import ResearchRun

    overrides = list(args.set or [])
    if args.workspace:
        overrides.append(f'experiment.workspace="{Path(args.workspace).resolve()}"')
    cfg = load_config(args.config, overrides)
    run = ResearchRun(cfg, root=args.root, experiment_id=args.experiment_id, log=lambda m: print(m, flush=True))
    eid = run.run()
    exp = run.db.experiment(eid)
    print(dumps({"experiment_id": eid, "summary": exp.get("summary")}, indent=2))
    return 0


def cmd_ui(args) -> int:
    from .ui.server import serve

    serve(host=args.host, port=args.port, workspace=Path(args.workspace), root=Path(args.root),
          data_dir=Path(args.data_dir), configs_dir=Path(args.configs))
    return 0


def cmd_export(args) -> int:
    from .export.recipe import export_candidate

    # same location as exports made from the UI: <workspace>/exports/<name>_<hash>/
    out = export_candidate(_db(args), int(args.candidate), root=args.root,
                           out_dir=args.out or Path(args.workspace) / "exports")
    print(dumps(out, indent=2))
    return 0


def cmd_list(args) -> int:
    db = _db(args)
    if args.what == "experiments":
        rows = db.experiments()
        for r in rows:
            prog = r.get("progress") or {}
            print(f"{r['experiment_id']}  {r['status']:<10} {r['asset']} {r['timeframe']}  trials "
                  f"{prog.get('trials_used', 0)}/{r['trial_budget']}  seed={r['random_seed']} cfg={r['config_hash']}")
    elif args.what == "candidates":
        for c in db.candidates(args.experiment):
            print(f"#{c['candidate_id']:<4} {c['status']:<16} {c['holdout_status']:<22} {c['novelty_class']:<10} "
                  f"rob={c['robustness']:.3f}  {c['dsl'].splitlines()[1][:90]}")
    elif args.what == "trials":
        counts = db.trial_counts(args.experiment)
        print(json.dumps(counts, indent=2))
        for t in db.trials(args.experiment, status=args.status, limit=args.limit):
            print(f"{t['trial_id']:>6} {t['creation_method']:<10} {t['status']:<18} rob={t['robustness'] or 0:.3f} "
                  f"is={t['is_return'] or 0:+.3f}  {t['dsl'].splitlines()[1][:80] if t['dsl'] else ''}")
    return 0


def cmd_compile(args) -> int:
    from .dsl.registry import Registry
    from .dsl.typecheck import compile_strategy

    text = Path(args.file).read_text(encoding="utf-8") if args.file else args.dsl
    reg = Registry(columns=frozenset({"open", "high", "low", "close", "volume", "quote_volume", "number_of_trades",
                                      "taker_buy_volume", "funding_rate", "open_interest", "long_short_ratio"}),
                   htf=tuple(args.htf or ()), n_regimes=args.regimes, pattern_ids=tuple(args.patterns or ()))
    st = compile_strategy(text, reg)
    print(st.to_text(pretty_print=True))
    print(f"# hash {st.hash}")
    return 0


def cmd_grammar(args) -> int:
    from .dsl.registry import Registry

    print(Registry(htf=("4h", "1d"), n_regimes=4, pattern_ids=("M1",)).grammar_card())
    return 0


def cmd_make_synthetic(args) -> int:
    from .data.synthetic import generate_synthetic

    md = generate_synthetic(args.bars, args.timeframe, args.asset, args.seed, args.start, args.plant or None,
                            args.strength)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{args.asset}_{args.timeframe}.csv"
    md.to_frame().to_csv(path, index=False)
    path.with_name(path.name + ".meta.json").write_text(json.dumps({"asset_class": "crypto", "synthetic": True,
                                                                    "plant": args.plant, "seed": args.seed}))
    print(f"wrote {path} ({len(md)} bars, SYNTHETIC)")
    return 0


def cmd_fetch_binance(args) -> int:
    from .data.binance import BinanceDataProvider
    from .util import parse_date_ms

    prov = BinanceDataProvider(market=args.market, cache_dir=args.out)
    md = prov.load(args.symbol, args.timeframe, parse_date_ms(args.start), parse_date_ms(args.end) if args.end else None)
    print(f"saved {len(md)} bars of {args.symbol} {args.timeframe} (public market data) to {args.out}")
    return 0


def cmd_data_report(args) -> int:
    from .data.catalog import describe

    print(dumps(describe(args.data_dir), indent=2))
    return 0


def cmd_holdout(args) -> int:
    db = _db(args)
    if args.action == "status":
        print(dumps(db.query("SELECT * FROM holdout_registry ORDER BY window_start"), indent=2))
        print(dumps(db.query("SELECT dataset_key, window_start, experiment_id, candidate_id, strategy_hash, passed, "
                             "evaluated_at FROM holdout_evaluations ORDER BY id"), indent=2))
        return 0
    from .pipeline.context import load_market_data, rebuild_context
    from .dsl.registry import Registry
    from .dsl.typecheck import compile_strategy
    from .validation.gate import RESEARCH_WINNER
    from .validation.holdout import HoldoutConfig, HoldoutVault

    exp = db.experiment(args.experiment)
    ctx = rebuild_context(db, args.experiment, Path(args.root))
    reg = Registry(**ctx.registry_kwargs)
    winners = [{"candidate_id": c["candidate_id"], "trial_id": c["trial_id"], "status": c["status"],
                "strategy": compile_strategy(c["dsl"], reg, 400, 60)}
               for c in db.candidates(args.experiment) if c["status"] == RESEARCH_WINNER]
    split = exp["split"]
    key_row = db.query_one("SELECT * FROM holdout_registry WHERE window_start = ? AND registered_by = ?",
                           [int(split["boundaries_ms"]["holdout_start"]), args.experiment]) or \
        db.query_one("SELECT * FROM holdout_registry WHERE window_start = ?", [int(split["boundaries_ms"]["holdout_start"])])
    vault = HoldoutVault(db, key_row["dataset_key"])
    hc = ctx.cfg["holdout"]
    res = vault.unseal(args.experiment, int(key_row["window_start"]), winners,
                       lambda: load_market_data(ctx.cfg, Path(args.root)), ctx.htf, ctx.costs, ctx.exec_cfg,
                       ctx.regime_model, ctx.pattern_library, HoldoutConfig(min_bars=int(hc["min_bars"]),
                                                                           min_trades=int(hc["min_trades"])))
    for r in res:
        c = next(w for w in winners if w["candidate_id"] == r["candidate_id"])
        db.upsert_candidate({"experiment_id": args.experiment, "trial_id": c["trial_id"],
                             "holdout_status": r["verdict"], "holdout_json": r})
    print(dumps(res, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="strategy-explorer",
                                description=f"AI Strategy Explorer {__version__}. {RESEARCH_ONLY_NOTICE}")
    p.add_argument("--workspace", default="workspace", help="workspace directory (ledger, exports)")
    p.add_argument("--root", default=".", help="project root for relative data paths")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="run a research experiment")
    r.add_argument("--config", help="TOML config file")
    r.add_argument("--set", action="append", help="override, e.g. search.max_trials=5000")
    r.add_argument("--experiment-id")
    r.set_defaults(fn=cmd_run)
    u = sub.add_parser("ui", help="start the research laboratory UI (localhost only by default)")
    u.add_argument("--host", default="127.0.0.1")
    u.add_argument("--port", type=int, default=8765)
    u.add_argument("--data-dir", default="data")
    u.add_argument("--configs", default="configs")
    u.set_defaults(fn=cmd_ui)
    e = sub.add_parser("export", help="export a candidate's strategy recipe")
    e.add_argument("--candidate", required=True)
    e.add_argument("--out")
    e.set_defaults(fn=cmd_export)
    ls = sub.add_parser("list", help="list experiments / candidates / trials")
    ls.add_argument("what", choices=["experiments", "candidates", "trials"])
    ls.add_argument("--experiment")
    ls.add_argument("--status")
    ls.add_argument("--limit", type=int, default=30)
    ls.set_defaults(fn=cmd_list)
    c = sub.add_parser("compile", help="type-check a DSL strategy")
    c.add_argument("--dsl")
    c.add_argument("--file")
    c.add_argument("--htf", nargs="*")
    c.add_argument("--regimes", type=int, default=0)
    c.add_argument("--patterns", nargs="*")
    c.set_defaults(fn=cmd_compile)
    g = sub.add_parser("grammar", help="print the DSL reference")
    g.set_defaults(fn=cmd_grammar)
    m = sub.add_parser("make-synthetic", help="write a synthetic OHLCV CSV (labelled synthetic)")
    m.add_argument("--asset", default="SYNTH")
    m.add_argument("--timeframe", default="4h")
    m.add_argument("--bars", type=int, default=8000)
    m.add_argument("--seed", type=int, default=7)
    m.add_argument("--start", default="2018-01-01")
    m.add_argument("--plant", default="")
    m.add_argument("--strength", type=float, default=1.0)
    m.add_argument("--out", default="data")
    m.set_defaults(fn=cmd_make_synthetic)
    f = sub.add_parser("fetch-binance", help="download PUBLIC Binance klines (+funding) to CSV; no API key")
    f.add_argument("--symbol", required=True)
    f.add_argument("--timeframe", default="4h")
    f.add_argument("--start", default="2020-01-01")
    f.add_argument("--end")
    f.add_argument("--market", default="usdm", choices=["usdm", "spot"])
    f.add_argument("--out", default="data")
    f.set_defaults(fn=cmd_fetch_binance)
    dr = sub.add_parser("data-report", help="quality report for every dataset in a directory")
    dr.add_argument("--data-dir", default="data")
    dr.set_defaults(fn=cmd_data_report)
    h = sub.add_parser("holdout", help="final holdout status / one-time unseal")
    h.add_argument("action", choices=["status", "unseal"])
    h.add_argument("--experiment")
    h.set_defaults(fn=cmd_holdout)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.fn(args) or 0)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
