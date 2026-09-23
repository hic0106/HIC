"""Research Run orchestrator.

OHLCV -> quality/split (holdout sealed) -> regimes + patterns (TRAIN) -> LLM /
template hypotheses -> typed GP + MCTS search (budgeted, ledgered, TRAIN
fitness) -> close search -> multi-objective selection (validation opened) ->
novelty / known-strategy tagging -> walk-forward -> overfitting firewall
(DSR, PBO, sensitivity) -> stress / cross-asset / regime -> gate -> one-shot
final holdout -> candidates.
"""

from __future__ import annotations

import time
import traceback
from pathlib import Path

import numpy as np

from ..backtest.lookahead import truncation_test
from ..backtest.engine import run_backtest
from ..backtest.metrics import compute_metrics, moments
from ..config import hash_config
from ..data.quality import quality_report
from ..dsl.complexity import complexity
from ..dsl.typecheck import TypeChecker
from ..ledger.db import LedgerDB
from ..llm.client import make_client
from ..llm.explain import explain, llm_narrative, signal_forward_profile
from ..llm.hypothesis import HypothesisConfig, HypothesisEngine
from ..llm.reflection import summarize, summary_text
from ..memory.research_memory import MemoryConfig, ResearchMemory
from ..patterns.discovery import PatternConfig, discover_patterns
from ..patterns.mining import MiningConfig
from ..patterns.motifs import MotifConfig, ShapeletConfig
from ..regimes.detector import fit_regimes
from ..search import nsga2
from ..search.budget import EXPLOIT, SearchBudget
from ..search.evaluation import EvaluatorPool, SearchSpec, default_workers
from ..search.fingerprints import KNOWN_LIKE, NOVEL, classify, positions_for, reference_strategies
from ..search.generator import GenConfig, ThresholdSampler, TypedGenerator, Variation
from ..search.gp import GPConfig, GPEngine
from ..search.mcts import MCTS, MCTSConfig, MCTS_ACTIONS
from ..search.objectives import ConstraintConfig, objective_vector
from ..search.trials import EVALUATED, ManagerConfig, TrialManager, TrialRecord
from ..util import code_version, code_version_string, derive_rng, dumps, json_safe, ms_to_iso, utc_now_iso
from ..validation.cross import CrossAssetConfig, cross_asset_test, regime_breakdown
from ..validation.dsr import deflated_sharpe, effective_trials, probabilistic_sharpe, trial_sharpe_variance
from ..validation.gate import RESEARCH_WINNER, GateConfig, evaluate_gate, full_robustness_score
from ..validation.holdout import HoldoutConfig, HoldoutError, HoldoutVault
from ..validation.pbo import aggregate_returns, cscv_pbo
from ..validation.sensitivity import SensitivityConfig, parameter_sensitivity, selection_instability
from ..validation.stress import StressConfig, stress_test
from ..validation.walkforward import WFConfig, walk_forward
from .context import costs_for, exec_config, load_market_data, plan_split

DAY_MS = 86_400_000


def new_experiment_id(cfg_hash: str) -> str:
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    return f"exp-{stamp}-{cfg_hash[:6]}-{int(time.time() * 1000) % 100000:05d}"


class ResearchRun:
    def __init__(self, cfg: dict, root: str | Path = ".", experiment_id: str | None = None, log=None,
                 db: LedgerDB | None = None):
        self.cfg = cfg
        self.root = Path(root).resolve()
        self.ws = (self.root / cfg["experiment"]["workspace"]).resolve()
        self.ws.mkdir(parents=True, exist_ok=True)
        self.db = db or LedgerDB(self.ws / "ledger.sqlite")
        self.cfg_hash = hash_config(cfg)
        self.eid = experiment_id or new_experiment_id(self.cfg_hash)
        self.log = log or (lambda msg: None)
        self.seed = int(cfg["experiment"]["random_seed"])
        self.created = False
        self.pool: EvaluatorPool | None = None
        self._last_tick = 0.0
        self.progress_state: dict = {"stage": "INIT"}
        self.mcts: MCTS | None = None
        self.engine: HypothesisEngine | None = None
        self.gp: GPEngine | None = None
        self.manager: TrialManager | None = None

    # ------------------------------------------------------------- progress
    def progress(self, force: bool = True, **kw) -> None:
        self.progress_state.update(kw)
        m = self.manager
        if m is not None:
            self.progress_state.update(
                trials_used=m.budget.total_used, trial_budget=m.budget.max_trials,
                explore_used=m.budget.used["explore"], exploit_used=m.budget.used["exploit"],
                recorded=len(m.records) + 0, proposals=m.proposals_seen,
                best_robustness=float(max((r.robustness for r in m.records), default=0.0)),
                method_counts=dict(m.method_counts))
        if self.gp is not None:
            self.progress_state.update(generation=self.gp.generation, gp_population=len(self.gp.population))
        if self.mcts is not None:
            self.progress_state.update(mcts_nodes=self.mcts.nodes_created, mcts_llm_expansions=self.mcts.llm_expansions)
        if self.engine is not None:
            self.progress_state.update(llm_hypotheses=self.engine.generated, hypothesis_backend=self.engine.backend)
        self.progress_state["updated_at"] = utc_now_iso()
        now = time.time()
        if self.created and (force or now - self._last_tick > 1.0):
            self._last_tick = now
            self.db.update_experiment(self.eid, progress_json=json_safe(self.progress_state))

    def event(self, level: str, msg: str) -> None:
        self.log(f"[{level}] {msg}")
        if self.created:
            self.db.log_event(self.eid, level, msg)

    # ------------------------------------------------------------------ run
    def run(self) -> str:
        t0 = time.time()
        try:
            self._setup()
            self._discover()
            self._search()
            self._select()
            self._validate()
            self._holdout()
            self._finish(time.time() - t0)
        except Exception as exc:
            if self.created:
                self.db.update_experiment(self.eid, status="FAILED", error=traceback.format_exc()[-6000:],
                                          finished_at=utc_now_iso())
                self.db.log_event(self.eid, "ERROR", f"{type(exc).__name__}: {exc}")
            raise
        finally:
            if self.pool is not None:
                self.pool.close()
        return self.eid

    # --------------------------------------------------------------- stages
    def _setup(self) -> None:
        cfg = self.cfg
        md = load_market_data(cfg, self.root)
        self.quality = quality_report(md).to_dict()
        self.split, self.holdout_info = plan_split(md, cfg, self.db, self.eid)
        self.md = md.slice(0, self.split.holdout_start)  # holdout bars never leave this function
        del md
        self.costs = costs_for(cfg, self.md.asset_class)
        self.exec_cfg = exec_config(cfg)
        cv = code_version()
        self.db.create_experiment({
            "experiment_id": self.eid, "name": cfg["experiment"]["name"], "created_at": utc_now_iso(),
            "status": "RUNNING", "asset": self.md.asset, "timeframe": self.md.timeframe,
            "asset_class": self.md.asset_class, "data_source": self.md.source, "random_seed": self.seed,
            "data_version": self.md.version(), "holdout_data_version": self.holdout_info.get("data_hash"),
            "code_version": code_version_string(cv), "config_hash": self.cfg_hash, "config_json": dumps(cfg),
            "trial_budget": int(cfg["search"]["max_trials"]), "cost_model_json": dumps(self.costs.to_dict()),
            "split_json": dumps(self.split.to_dict()), "quality_json": dumps(self.quality),
        })
        self.created = True
        self.event("INFO", f"data {self.md.asset} {self.md.timeframe}: {len(self.md)} search bars, holdout "
                           f"{self.holdout_info['bars']} bars sealed ({self.holdout_info['status']})")
        self.progress(stage="DATA", holdout=self.holdout_info, split=self.split.to_dict()["boundaries_iso"])

    def _discover(self) -> None:
        cfg = self.cfg
        s, e = self.split.train
        self.md_train = self.md.slice(s, e)
        self.regime_model, self.regime_labels, self.regime_desc = None, None, []
        if cfg["regimes"]["enabled"]:
            self.progress(stage="REGIME_DETECTION")
            try:
                self.regime_model = fit_regimes(self.md_train, cfg["regimes"]["n_states"],
                                                int(cfg["regimes"]["window"]), self.seed)
                _, self.regime_labels = self.regime_model.filter(self.md)
                self.regime_desc = self.regime_model.descriptions
                self.db.save_regimes(self.eid, self.regime_model.to_dict(), self.regime_desc)
                self.event("INFO", "regimes: " + "; ".join(f"R{d['regime']} {d['label']} ({d['share']:.0%})"
                                                          for d in self.regime_desc))
            except ValueError as exc:
                self.event("WARN", f"regime detection skipped: {exc}")
        self.patterns, self.library = [], None
        if cfg["patterns"]["enabled"]:
            self.progress(stage="PATTERN_DISCOVERY")
            from ..dsl.registry import Registry

            pc = cfg["patterns"]
            pcfg = PatternConfig(horizons=tuple(pc["horizons"]), primary=int(pc["primary"]),
                                 norm_window=int(pc["norm_window"]), template_fdr=float(pc["template_fdr"]),
                                 mining=MiningConfig(fdr=float(pc["fdr"]), max_patterns=int(pc["max_patterns"]),
                                                     min_events=int(pc["min_events"])),
                                 motifs=MotifConfig(min_occ=int(pc["min_events"])),
                                 shapelets=ShapeletConfig(min_occ=int(pc["min_events"])),
                                 use_motifs=bool(pc["use_motifs"]), use_shapelets=bool(pc["use_shapelets"]))
            reg_p = Registry(columns=frozenset(self.md_train.available_columns()),
                             base_timeframe=self.md.timeframe, max_window=int(cfg["search"]["max_window"]))
            labels_train = self.regime_labels[s:e] if self.regime_labels is not None else None
            self.patterns, lib = discover_patterns(self.md_train, reg_p, pcfg, self.seed, labels_train)
            self.library = lib if lib.ids() else None
            self.db.save_patterns(self.eid, [{"pattern_id": p.pattern_id, "kind": p.kind, "summary": p.summary(),
                                              "template": p.template,
                                              "occurrences": {"idx": p.occurrences, "ts": p.occurrence_ts}}
                                             for p in self.patterns])
            self.event("INFO", f"patterns: {len(self.patterns)} significant on TRAIN "
                               f"({', '.join(p.pattern_id for p in self.patterns)})")

    def _search(self) -> None:
        cfg = self.cfg
        sc = cfg["search"]
        self.htf = tuple(cfg["data"].get("extra_timeframes", []))
        reg_kwargs = dict(columns=frozenset(self.md.available_columns()), htf=self.htf,
                          n_regimes=self.regime_model.n_states if self.regime_model else 0,
                          pattern_ids=self.library.ids() if self.library else (),
                          max_window=int(sc["max_window"]), base_timeframe=self.md.timeframe)
        spec = SearchSpec(md=self.md, split=self.split, costs=self.costs, exec_cfg=self.exec_cfg, htf=self.htf,
                          registry_kwargs=reg_kwargs, regime_model=self.regime_model,
                          pattern_library=self.library, n_blocks=int(cfg["backtest"]["n_blocks"]),
                          behavior_dim=int(sc["behavior_dim"]), max_nodes=int(sc["max_nodes"]) + 40,
                          max_depth=int(sc["max_depth"]) + 6)
        self.spec = spec
        self.pool = EvaluatorPool(spec, default_workers(sc.get("workers")))
        registry = spec.registry()
        self.registry = registry
        checker = TypeChecker(registry, int(sc["max_nodes"]) + 40, int(sc["max_depth"]) + 6)
        budget = SearchBudget(int(sc["max_trials"]), float(sc["explore_fraction"]))
        self.memory = None
        mfactor = None
        if cfg["memory"]["enabled"]:
            mc = cfg["memory"]
            self.memory = ResearchMemory(self.db, self.md.asset, self.md.timeframe,
                                         MemoryConfig(int(mc["min_trials"]), float(mc["penalty"]),
                                                      bool(mc["same_asset_only"])))
            mfactor = self.memory.family_factor
        self.manager = TrialManager(self.db, self.eid, budget, self.pool, checker, self.costs,
                                    ConstraintConfig(min_trades=int(sc["min_trades_train"])),
                                    ManagerConfig(near_duplicate=float(sc["near_duplicate"])),
                                    memory_factor=mfactor, behavior_dim=int(sc["behavior_dim"]),
                                    on_progress=lambda: self.progress(force=False))
        sampler = ThresholdSampler(self.pool.local.ctx, self.split.train, derive_rng(self.seed, "thresholds"))
        dirs = tuple(sc["directions"])
        dw = {"long": 0.5, "short": 0.25, "long_short": 0.25}
        gen = TypedGenerator(registry, sampler, derive_rng(self.seed, "generator"),
                             GenConfig(max_depth=int(sc["max_depth"]), max_nodes=int(sc["max_nodes"]), directions=dirs,
                                       direction_weights=tuple(dw.get(d, 0.2) for d in dirs)),
                             pattern_weights={p.pattern_id: 1.0 + abs(p.stats.get("t_stat", 0)) for p in self.patterns})
        var = Variation(gen, derive_rng(self.seed, "variation"))
        g = cfg["gp"]
        self.gp = GPEngine(GPConfig(population=int(g["population"]), p_crossover=float(g["p_crossover"]),
                                    p_immigrant=float(g["p_immigrant"]), objectives=tuple(g["objectives"])),
                           self.manager, gen, var, derive_rng(self.seed, "gp"))
        lc = cfg["llm"]
        self.llm = make_client(lc, self.db, self.eid)
        self.engine = HypothesisEngine(self.llm, registry.grammar_card(), self.md.timeframe, self.md.asset_class,
                                       derive_rng(self.seed, "hypotheses"),
                                       HypothesisConfig(max_per_call=int(lc["hypotheses_per_call"]),
                                                        vision=bool(lc["vision"]),
                                                        mcts_llm=bool(lc["mcts_expansion"])))
        mcfg = cfg["mcts"]
        self.mcts = MCTS(MCTSConfig(iterations=int(mcfg["iterations"]), c_uct=float(mcfg["c_uct"])), self.manager, var,
                         gen, derive_rng(self.seed, "mcts"),
                         expander=self.engine.mcts_expander(list(MCTS_ACTIONS)), phase=EXPLOIT)
        memory_notes = self.memory.llm_notes() if self.memory else []
        self.progress(stage="HYPOTHESIS_GENERATION")
        n_hyp = max(1, int(int(sc["max_trials"]) * float(sc["hypothesis_share"])))
        props = self.engine.from_patterns(self.patterns, self.regime_desc, memory_notes, n_hyp)
        props += self.engine.from_images(self.md_train, self.patterns, 6)
        for note in self.engine.notes:
            self.event("WARN", note)
        seeds = self.manager.submit(props)
        self.progress(stage="STRATEGY_SEARCH")
        self.gp.initialize([r for r in seeds if r is not None])
        stall = 0
        reflect_every = int(lc.get("reflection_every", 3))
        while not budget.exhausted and self.gp.generation < int(sc["max_generations"]):
            injected = []
            if reflect_every and self.gp.generation > 0 and self.gp.generation % reflect_every == 0:
                summ = summarize(self.manager.records)
                txt = summary_text(summ)
                injected = self.engine.from_reflection(txt, self.gp.elites(5), memory_notes, self.patterns, 6,
                                                       self.gp.generation + 1)
                self.db.save_generation(self.eid, self.gp.generation, summ, txt)
            before = budget.total_used
            self.gp.step(injected)
            if mcfg["enabled"] and self.gp.generation % max(1, int(mcfg["every"])) == 0 and budget.can_spend(EXPLOIT):
                for root in self.gp.elites(int(mcfg["roots"])):
                    found = self.mcts.search(root, int(mcfg["iterations"]))
                    self.gp.absorb(found)
            stall = stall + 1 if budget.total_used == before else 0
            self.progress(force=False)
            if stall >= 3:
                self.event("WARN", "search stalled (no new unique candidates); stopping before budget exhaustion")
                break
        summ = summarize(self.manager.records)
        self.db.save_generation(self.eid, self.gp.generation, summ, summary_text(summ))
        self.manager.close_search()
        self.pool = None
        self.event("INFO", f"search closed: {budget.total_used}/{budget.max_trials} trials evaluated, "
                           f"{len(self.manager.records)} unique records, {self.gp.generation} generations")
        if self.memory is not None:
            self.memory.update_from_trials(self.eid, self.manager.records)
        self.progress(stage="SEARCH_CLOSED")

    # ------------------------------------------------------------ selection
    def _select(self) -> None:
        cfg = self.cfg
        sel = cfg["selection"]
        self.progress(stage="MULTI_OBJECTIVE_SELECTION")
        self.ev = self.manager.pool.local
        recs = [r for r in self.manager.records if r.status == EVALUATED]
        feas = [r for r in recs if r.feasible] or recs
        feas.sort(key=lambda r: (-r.robustness, r.seq))
        pool_recs = []
        for r in feas:
            oos = self.manager.oos_metrics(r.trial_id) or {}
            if int(oos.get("trades", 0) or 0) >= int(sel["min_oos_trades"]):
                pool_recs.append(r)
            if len(pool_recs) >= int(sel["pool"]):
                break
        self.selection_pool = pool_recs
        if not pool_recs:
            self.candidates = []
            self.event("WARN", "no feasible trials with enough out-of-sample trades; no candidates")
            return
        sens = {r.trial_id: selection_instability(r.strategy, self.ev, int(sel["sensitivity_variants"]))
                for r in pool_recs}
        names = tuple(sel["objectives"])
        F = np.vstack([objective_vector(names, {"is": r.is_metrics, "oos": self.manager.oos_metrics(r.trial_id),
                                                "cx": r.complexity, "sens": sens[r.trial_id]}) for r in pool_recs])
        fronts = nsga2.fast_non_dominated_sort(F, None)
        # many objectives -> large fronts; order members by mean rank across objectives (Borda)
        ranks = np.argsort(np.argsort(F, axis=0, kind="mergesort"), axis=0, kind="mergesort").mean(axis=1)
        ordered = []
        for rank, front in enumerate(fronts):
            for i in sorted(front, key=lambda i: (ranks[i], -pool_recs[i].robustness, pool_recs[i].seq)):
                ordered.append((rank, pool_recs[i]))
        self.candidates = ordered[: int(sel["max_candidates"])]
        self.selection_sens = sens
        self.event("INFO", f"selection: {len(pool_recs)} trials in pool, {len(fronts[0])} on the Pareto front, "
                           f"{len(self.candidates)} candidates")

    # ----------------------------------------------------------- validation
    def _experiment_pbo(self) -> dict:
        k = int(self.cfg["pbo"]["top_k"])
        recs = sorted([r for r in self.manager.records if r.status == EVALUATED], key=lambda r: (-r.robustness, r.seq))
        recs = recs[:k]
        if len(recs) < 4:
            return {"pbo": None, "reason": "fewer than 4 evaluated trials"}
        s, e = self.split.segment("search")
        cols = []
        for r in recs:
            res, _ = self.ev.backtest(r.strategy, (s, e))
            cols.append(aggregate_returns(res.returns, self.md.ts[s:e], DAY_MS))
        M = np.column_stack(cols)
        out = cscv_pbo(M, int(self.cfg["pbo"]["n_blocks"]), rng=derive_rng(self.seed, "pbo"))
        out["configs"] = [r.trial_id for r in recs]
        out["scope"] = f"top {len(recs)} trials by train robustness, daily returns over train+validation+test"
        return out

    def _validate(self) -> None:
        cfg = self.cfg
        self.progress(stage="VALIDATION")
        self.pbo_experiment = self._experiment_pbo() if self.candidates else {"pbo": None}
        # DSR inputs. N = every evaluated trial (raw) or behaviourally distinct trials (effective);
        # V[SR] from the per-bar Sharpe of trials that traded, on the same segment as the candidate's SR.
        dcfg = cfg["dsr"]
        n_raw = self.manager.budget.total_used
        n_eff = max(2, effective_trials(self.manager.archive.return_matrix(), float(dcfg["cluster_threshold"])))
        sr_by_seg = {"train": [], "validation": []}
        for r in self.manager.records:
            if r.status != EVALUATED:
                continue
            if r.is_metrics and int(r.is_metrics.get("trades", 0) or 0) > 0:
                sr_by_seg["train"].append(float(r.is_metrics.get("sharpe_bar", 0.0)))
            o = self.manager.oos_metrics(r.trial_id) or {}
            if int(o.get("trades", 0) or 0) > 0 and o.get("sharpe_bar") is not None:
                sr_by_seg["validation"].append(float(o["sharpe_bar"]))
        var_cs = {k: trial_sharpe_variance(v) for k, v in sr_by_seg.items()}
        seg_bars = {k: max(2, self.split.segment(k)[1] - self.split.segment(k)[0]) for k in sr_by_seg}
        var_null = {k: 1.0 / (seg_bars[k] - 1) for k in sr_by_seg}   # sampling variance of SR under H0
        var_by_mode = {"sampling": var_null, "cross_sectional": var_cs,
                       "max": {k: max(var_cs[k], var_null[k]) for k in var_cs}}
        mode = dcfg.get("variance", "sampling")
        if mode not in var_by_mode:
            raise ValueError("dsr.variance must be sampling | cross_sectional | max")
        var_sr = var_by_mode[mode]
        self.dsr_inputs = {"n_raw": n_raw, "n_effective": n_eff, "var_sr": var_sr, "variance_mode": mode,
                           "var_cross_sectional": var_cs, "var_sampling": var_null,
                           "segment": dcfg["segment"], "n_basis": dcfg["n_trials"]}
        s_all, e_all = self.split.segment("search")
        known = reference_strategies(self.md)
        known_pos = {k.name: (k.family, positions_for(self.md, k, s_all, e_all)) for k in known}
        gate_cfg = GateConfig(**{k: v for k, v in cfg["gate"].items() if k in GateConfig.__dataclass_fields__})
        wf_cfg = WFConfig(**{k: v for k, v in cfg["walk_forward"].items() if k in WFConfig.__dataclass_fields__})
        sens_cfg = SensitivityConfig(**{k: v for k, v in cfg["sensitivity"].items()
                                        if k in SensitivityConfig.__dataclass_fields__})
        st_cfg = StressConfig(missed_trade_prob=float(cfg["stress"]["missed_trade_prob"]),
                              mc_runs=int(cfg["stress"]["mc_runs"]), mc_min_positive=float(cfg["stress"]["mc_min_positive"]),
                              required=tuple(cfg["stress"]["required"]))
        others = self._cross_asset_data()
        self.validated = []
        for rank_i, (pareto_rank, r) in enumerate(self.candidates):
            self.progress(stage="VALIDATION", validating=f"{rank_i + 1}/{len(self.candidates)}")
            st = r.strategy
            v: dict = {"trial_id": r.trial_id, "strategy_hash": st.hash, "pareto_rank": pareto_rank,
                       "selection_rank": rank_i + 1}
            sig = self.ev.signals(st)
            for seg in ("train", "validation", "test", "validation+test", "search"):
                _, m = self.ev.backtest(st, seg, sig)
                key = {"validation+test": "oos", "search": "full"}.get(seg, seg)
                v[key] = m
            v["lookahead"] = truncation_test(st, self.md, self.htf, self.regime_model, self.library, n_cuts=5,
                                             seed=self.seed).to_dict()
            v["walk_forward"] = walk_forward(st, self.ev, wf_cfg)
            sens = parameter_sensitivity(st, self.ev, sens_cfg, keep_returns=True)
            series = sens.pop("_series", {})
            v["sensitivity"] = sens
            if len(series) >= 3:
                M = np.column_stack([aggregate_returns(x, self.md.ts[s_all:e_all], DAY_MS) for x in series.values()])
                v["pbo_candidate"] = cscv_pbo(M, int(cfg["pbo"]["candidate_blocks"]),
                                              rng=derive_rng(self.seed, "pbo", st.hash))
            else:
                v["pbo_candidate"] = {"pbo": None, "reason": "too few parameter variants"}
            v["pbo_experiment"] = {k: self.pbo_experiment.get(k) for k in
                                   ("pbo", "n_configs", "n_combinations", "prob_oos_loss", "degradation_slope",
                                    "logit_mean", "scope")}
            detail = {}
            for seg in ("train", "validation"):
                res_s, m_s = self.ev.backtest(st, seg, sig)
                sk, ku = moments(res_s.returns)
                for basis, n in (("effective", n_eff), ("raw", n_raw)):
                    d = deflated_sharpe(float(m_s.get("sharpe_bar", 0.0)), int(m_s.get("bars", 0)), sk, ku, n,
                                        var_sr[seg])
                    d.update(segment=seg, n_basis=basis, variance=mode)
                    detail[f"{seg}/{basis}"] = d
                    if seg == dcfg["segment"] and basis == dcfg["n_trials"]:
                        # the same test under the other V[SR] estimators, reported for transparency
                        for alt, var in var_by_mode.items():
                            if alt != mode:
                                d2 = deflated_sharpe(float(m_s.get("sharpe_bar", 0.0)), int(m_s.get("bars", 0)),
                                                     sk, ku, n, var[seg])
                                d2.update(segment=seg, n_basis=basis, variance=alt)
                                detail[f"{seg}/{basis}/{alt}"] = d2
            test_res, test_m = self.ev.backtest(st, "test", sig)
            ts_, tk_ = moments(test_res.returns)
            primary = dict(detail[f"{dcfg['segment']}/{dcfg['n_trials']}"])
            primary["psr_test_vs_zero"] = probabilistic_sharpe(float(test_m.get("sharpe_bar", 0.0)), 0.0,
                                                               int(test_m.get("bars", 0)), ts_, tk_)
            v["dsr"] = primary
            v["dsr_detail"] = detail
            v["stress"] = stress_test(st, self.ev, st_cfg, self.seed)
            v["concentration"] = {
                "oos_best_trade_share": v["oos"].get("best_trade_share"),
                "oos_best_month_share": v["oos"].get("best_month_share"),
                "full_best_trade_share": v["full"].get("best_trade_share"),
                "full_best_month_share": v["full"].get("best_month_share"),
                "oos_best_week_share": v["oos"].get("best_week_share"),
            }
            v["regimes"] = regime_breakdown(st, self.ev, self.regime_labels, self.regime_desc, "search")
            v["cross_asset"] = cross_asset_test(
                st, others, int(self.split.boundaries_ms["holdout_start"]),
                {ac: costs_for(cfg, ac) for ac in ("crypto", "equity", "etf", "default")} | {"default": self.costs},
                self.exec_cfg, self.htf, self.regime_model, self.library,
                CrossAssetConfig()) if others else {"classification": "NOT_TESTED", "assets": []}
            full_res, _ = self.ev.backtest(st, (s_all, e_all), sig)
            kl = classify(st, full_res.position, known_pos, float(cfg["novelty"]["known_threshold"]),
                          float(cfg["novelty"]["hybrid_threshold"]))
            v["known_strategy"] = kl.to_dict()
            nov = r.novelty.to_dict() if r.novelty else None
            v["novelty"] = nov
            v["complexity"] = complexity(st).to_dict()
            v["cost_model"] = self.costs.to_dict()
            v["costless"] = self.costs.is_costless()
            v["trial_accounting"] = {"n_trials_evaluated": n_raw, "n_trials_effective": n_eff,
                                     "n_trials_recorded": len(self.manager.records),
                                     "budget": self.manager.budget.max_trials}
            gate = evaluate_gate(v, gate_cfg)
            v["robustness_full"] = full_robustness_score(v, gate)
            entry = sig.long_entry | sig.short_entry
            facts = {"forward_train": signal_forward_profile(entry, self.md.open, *self.split.train),
                     "forward_oos": signal_forward_profile(entry, self.md.open, *self.split.segment("validation+test")),
                     "trades": {"oos_trades": v["oos"].get("trades"), "oos_win_rate": v["oos"].get("win_rate"),
                                "oos_expectancy": v["oos"].get("expectancy")}}
            expl = explain(st, facts)
            if cfg["llm"].get("narratives") and self.llm is not None:
                nar = llm_narrative(self.llm, st, dumps(facts), self.registry.grammar_card(), self.md.timeframe,
                                    self.md.asset_class)
                if nar:
                    expl["llm_narrative"] = nar
            novelty_level = _novelty_level(kl.novelty_class, nov)
            v["novelty_level"] = novelty_level
            cid = self.db.upsert_candidate({
                "experiment_id": self.eid, "trial_id": r.trial_id, "strategy_hash": st.hash, "dsl": st.text,
                "selection_rank": rank_i + 1, "pareto_rank": pareto_rank, "robustness": v["robustness_full"],
                "novelty_class": kl.novelty_class, "status": gate["status"], "gate_json": gate,
                "validation_json": json_safe(v), "explanation_json": expl,
                "holdout_status": "LOCKED" if gate["status"] == RESEARCH_WINNER else "NOT_ELIGIBLE",
            })
            self.validated.append({"candidate_id": cid, "trial_id": r.trial_id, "strategy": st, "status": gate["status"],
                                   "family": r.family, "novelty_class": kl.novelty_class,
                                   "failed_checks": [c["name"] for c in gate["checks"] if not c["passed"]]})
            self.event("INFO", f"candidate {cid} (trial {r.trial_id}): {gate['status']} "
                               f"[{kl.novelty_class}] failed={[c['name'] for c in gate['checks'] if not c['passed']]}")
        if self.memory is not None:
            self.memory.add_validation_notes(self.eid, self.validated)

    def _cross_asset_data(self) -> list:
        out = []
        for a in self.cfg["cross_asset"].get("assets", []) or []:
            sub = {**self.cfg, "data": {**self.cfg["data"], **a, "timeframe": self.md.timeframe}}
            try:
                md = load_market_data(sub, self.root)
                md.asset_class = a.get("asset_class", md.asset_class)
                out.append(md)
            except Exception as exc:
                self.event("WARN", f"cross-asset {a.get('asset')}: {exc}")
        return out

    # --------------------------------------------------------------- holdout
    def _holdout(self) -> None:
        winners = [c for c in self.validated if c["status"] == RESEARCH_WINNER]
        hcfg = self.cfg["holdout"]
        self.holdout_results = []
        if not winners:
            self.event("INFO", "no RESEARCH_WINNER: final holdout stays LOCKED")
            return
        if not hcfg["auto_evaluate"]:
            self.event("INFO", "holdout.auto_evaluate = false: holdout stays LOCKED until `holdout unseal`")
            return
        if self.holdout_info["status"] == "AWAITING_DATA":
            self.event("INFO", "prospective holdout awaiting new data; evaluation deferred")
            for c in winners:
                self.db.upsert_candidate({"experiment_id": self.eid, "trial_id": c["trial_id"],
                                          "holdout_status": "AWAITING_DATA"})
            return
        self.progress(stage="FINAL_HOLDOUT")
        vault = HoldoutVault(self.db, self.holdout_info["dataset_key"])
        try:
            results = vault.unseal(self.eid, self.holdout_info["window_start_ms"], winners,
                                   lambda: load_market_data(self.cfg, self.root), self.htf, self.costs, self.exec_cfg,
                                   self.regime_model, self.library,
                                   HoldoutConfig(min_bars=int(hcfg["min_bars"]), min_trades=int(hcfg["min_trades"])))
        except HoldoutError as exc:
            self.event("WARN", f"holdout not evaluated: {exc}")
            return
        by_id = {c["candidate_id"]: c for c in winners}
        for res in results:
            c = by_id[res["candidate_id"]]
            self.db.upsert_candidate({"experiment_id": self.eid, "trial_id": c["trial_id"],
                                      "holdout_status": res["verdict"], "holdout_json": json_safe(res)})
            self.event("INFO", f"holdout candidate {res['candidate_id']}: {res['verdict']}")
        self.holdout_results = results
        self.holdout_info["status"] = "CONSUMED"  # the vault marked the window consumed in the same transaction

    def _finish(self, seconds: float) -> None:
        counts = self.db.trial_counts(self.eid)
        statuses: dict[str, int] = {}
        for c in self.validated:
            statuses[c["status"]] = statuses.get(c["status"], 0) + 1
        summary = {
            "seconds": round(seconds, 1),
            "trials": counts,
            "budget": self.manager.budget.to_dict(),
            "generations": self.gp.generation,
            "mcts_nodes": self.mcts.nodes_created if self.mcts else 0,
            "hypotheses": self.engine.generated if self.engine else 0,
            "hypothesis_backend": self.engine.backend if self.engine else None,
            "patterns": len(self.patterns),
            "candidates": len(self.validated),
            "candidate_status": statuses,
            "pbo_experiment": {k: self.pbo_experiment.get(k) for k in ("pbo", "n_configs", "prob_oos_loss")}
            if hasattr(self, "pbo_experiment") else None,
            "holdout": {"status": self.holdout_info["status"], "evaluated": len(self.holdout_results),
                        "verdicts": {v: sum(r["verdict"] == v for r in self.holdout_results)
                                     for v in sorted({r["verdict"] for r in self.holdout_results})},
                        "window_start": ms_to_iso(self.holdout_info["window_start_ms"])},
        }
        self.db.update_experiment(self.eid, status="COMPLETED", summary_json=json_safe(summary),
                                  finished_at=utc_now_iso())
        self.progress(stage="COMPLETED")
        self.event("INFO", f"completed in {seconds:.0f}s: {statuses}")


def _novelty_level(cls: str, nov: dict | None) -> str:
    score = (nov or {}).get("novelty", 1.0)
    if cls == KNOWN_LIKE:
        return "LOW"
    if cls == NOVEL and score >= 0.5:
        return "HIGH"
    return "MEDIUM"


def run_experiment(cfg: dict, root: str | Path = ".", experiment_id: str | None = None, log=print) -> str:
    return ResearchRun(cfg, root, experiment_id, log).run()


__all__ = ["ResearchRun", "run_experiment", "TrialRecord", "run_backtest", "compute_metrics"]
