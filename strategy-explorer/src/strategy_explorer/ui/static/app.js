/* AI Strategy Explorer - Quant Research Laboratory UI */
(function () {
  "use strict";
  const { CandleChart, LineChart, barChart } = window.LabCharts;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fin = (x) => x !== null && x !== undefined && isFinite(x);
  const pct = (x, d = 2) => (fin(x) ? (x * 100).toFixed(d) + "%" : "—");
  const num = (x, d = 2) => (fin(x) ? Number(x).toFixed(d) : "—");
  const sgn = (x) => (fin(x) ? (x > 0 ? "pos" : x < 0 ? "neg" : "") : "");
  const chip = (t, c) => `<span class="chip ${esc(c ?? t)}">${esc(t)}</span>`;
  const jround = (v) => JSON.stringify(v, (k, x) => (typeof x === "number" && !Number.isInteger(x) ? Number(x.toPrecision(4)) : x));
  const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "—");

  async function api(path, opts) {
    const r = await fetch(path, opts);
    const j = await r.json().catch(() => ({ error: "invalid response" }));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

  const S = { exps: [], eid: null, exp: null, cid: null, tab: "data", poll: null, charts: {}, ledger: { status: "", method: "", offset: 0 }, lbSort: "robustness" };

  function chart(id, Kind, opts) {
    const el = document.getElementById(id);
    if (!el) return null;
    const key = id;
    if (!S.charts[key] || S.charts[key].canvas !== el) S.charts[key] = new Kind(el, opts);
    return S.charts[key];
  }

  // ------------------------------------------------------------------ nav
  $$("#tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  function showTab(name) {
    S.tab = name;
    $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
    render(name);
  }
  function render(name) {
    const f = { data: renderData, patterns: renderPatterns, discovery: renderDiscovery, experiments: renderExperiments,
      candidates: renderCandidates, validation: renderValidation, memory: renderMemory }[name];
    f && f().catch((e) => { $("#tab-" + name).innerHTML = `<div class="panel"><div class="empty">${esc(e.message)}</div></div>`; });
  }

  // ----------------------------------------------------------- experiments
  async function loadExperiments(keep = true) {
    const j = await api("/api/experiments");
    S.exps = j.experiments;
    const sel = $("#exp-select");
    const cur = keep ? S.eid : null;
    sel.innerHTML = S.exps.length ? S.exps.map((e) => `<option value="${esc(e.experiment_id)}">${esc(e.name || "")} · ${esc(e.experiment_id)} · ${esc(e.status)}</option>`).join("")
      : `<option value="">(no experiments yet)</option>`;
    if (cur && S.exps.some((e) => e.experiment_id === cur)) sel.value = cur;
    else if (S.exps.length) sel.value = S.exps[0].experiment_id;
    S.eid = sel.value || null;
    await refreshExperiment();
  }
  $("#exp-select").addEventListener("change", async (e) => { S.eid = e.target.value; S.cid = null; await refreshExperiment(); render(S.tab); });

  async function refreshExperiment() {
    if (!S.eid) { S.exp = null; $("#exp-status").innerHTML = ""; return; }
    try { S.exp = await api(`/api/experiments/${S.eid}`); } catch (e) { S.exp = null; }
    const st = S.exp ? S.exp.status : "?";
    const p = (S.exp && S.exp.progress) || {};
    $("#exp-status").innerHTML = chip(st) + (p.trial_budget ? ` <span class="mono muted">trials ${p.trials_used ?? 0}/${p.trial_budget}</span>` : "");
    const live = ["RUNNING", "STARTING"].includes(st);
    if (live && !S.poll) S.poll = setInterval(async () => { await refreshExperiment(); if (["discovery", "experiments"].includes(S.tab)) render(S.tab); }, 2500);
    if (!live && S.poll) { clearInterval(S.poll); S.poll = null; loadExperiments(true); }
  }

  // ------------------------------------------------------------------- DATA
  async function renderData() {
    const el = $("#tab-data");
    const j = await api("/api/datasets");
    const rows = j.datasets.map((d, i) => {
      const q = d.quality || {};
      return `<tr class="clickable" data-path="${esc(d.path)}"><td>${esc(d.asset)}</td><td>${esc(d.timeframe)}</td>
        <td>${esc((q.start || "").slice(0, 10))} → ${esc((q.end || "").slice(0, 10))}</td><td class="num">${q.rows ?? "—"}</td>
        <td class="num">${q.missing_bars ?? (q.calendar === "exchange" ? "exch." : "—")} ${q.missing_pct != null ? `(${num(q.missing_pct, 2)}%)` : ""}</td>
        <td>${q.volume_available ? chip("yes", "ok") : chip("no", "bad")}</td><td>${q.funding_available ? chip("yes", "ok") : chip("no")}</td>
        <td>${esc(d.asset_class)}</td><td class="muted">${esc((q.extra_columns || []).join(", "))}</td>
        <td class="neg">${esc(d.error || "")}</td></tr>`;
    }).join("");
    let split = "";
    if (S.exp && S.exp.split) {
      const b = S.exp.split.boundaries_iso || {};
      const sp = S.exp.split, n = sp.n || 1;
      const w = (seg) => ((seg[1] - seg[0]) / n * 100).toFixed(2) + "%";
      split = `<div class="panel"><h3>Selected experiment · data split <span class="sp">${chip("FINAL HOLDOUT " + ((S.exp.progress || {}).holdout || {}).status, "LOCKED")}</span></h3>
        <div class="split-bar"><div style="width:${w(sp.train)};background:#2dd4bf">TRAIN</div><div style="width:${w(sp.validation)};background:#60a5fa">VALIDATION</div>
        <div style="width:${w(sp.test)};background:#a78bfa">TEST</div><div style="width:${w(sp.holdout)};background:#3b2a52;color:#c4b5fd">HOLDOUT (sealed)</div></div>
        <div class="mono muted">train ${esc(b.train_start)} · validation ${esc(b.validation_start)} · test ${esc(b.test_start)} · holdout ${esc(b.holdout_start)} · end ${esc(b.data_end)}</div>
        <div class="note">The search, the LLM and every validator except the holdout vault see only bars before the holdout start.</div>
        ${qualityBlock(S.exp.quality)}</div>`;
    }
    el.innerHTML = `<div class="grid">
      <div class="panel"><h3>Datasets <span class="muted">${esc(j.data_dir)}</span></h3>
        ${rows ? `<table><thead><tr><th>Asset</th><th>Timeframe</th><th>Date range</th><th class="num">Rows</th><th class="num">Missing</th><th>Volume</th><th>Funding</th><th>Class</th><th>Extra columns</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
          : `<div class="empty">No CSV/Parquet files named ASSET_TF.csv in the data directory.<br>Try <code>strategy-explorer make-synthetic</code> or <code>strategy-explorer fetch-binance --symbol BTCUSDT --timeframe 4h</code> (public data).</div>`}
        <div class="row" style="margin-top:8px"><button class="small" id="prev-synth">Preview synthetic sample</button><span class="note">Click a dataset row for a chart preview (wheel = zoom, drag = pan).</span></div>
      </div>
      <div class="panel"><h3 id="prev-title">Chart preview</h3><canvas class="chart" id="data-chart"></canvas></div>
      ${split}</div>`;
    $$("#tab-data tr.clickable").forEach((tr) => tr.addEventListener("click", () => preview(tr.dataset.path)));
    $("#prev-synth").addEventListener("click", () => preview("synthetic"));
    if (j.datasets.length) preview(j.datasets[0].path);
  }
  function qualityBlock(q) {
    if (!q) return "";
    return `<div class="kpis" style="margin-top:10px">${[["asset", q.asset], ["timeframe", q.timeframe], ["rows", q.rows], ["missing bars", q.missing_bars ?? "n/a"],
      ["largest gap", q.largest_gap_bars], ["duplicates dropped", q.duplicates_dropped], ["invalid rows", q.invalid_rows_dropped],
      ["ohlc repaired", q.ohlc_repaired], ["volume", q.volume_available ? "yes" : "no"], ["funding", q.funding_available ? "yes" : "no"]]
      .map(([k, v]) => `<div class="kpi"><div class="k">${esc(k)}</div><div class="v" style="font-size:15px">${esc(v)}</div></div>`).join("")}</div>`;
  }
  async function preview(path) {
    const j = await api(`/api/data/preview?path=${encodeURIComponent(path)}&limit=2000`);
    $("#prev-title").innerHTML = `Chart preview · ${esc(j.asset)} ${esc(j.timeframe)} <span class="muted">last ${j.bars.length} of ${j.rows} bars</span>`;
    chart("data-chart", CandleChart).setData(j.bars, { initialSpan: 300 });
  }

  // ------------------------------------------------------------ PATTERN LAB
  async function renderPatterns() {
    const el = $("#tab-patterns");
    if (!S.eid) { el.innerHTML = `<div class="panel"><div class="empty">Select or start an experiment.</div></div>`; return; }
    const j = await api(`/api/experiments/${S.eid}/patterns`);
    const reg = await api(`/api/experiments/${S.eid}/regimes`).catch(() => ({}));
    const rows = j.patterns.map((p) => {
      const st = p.stats || {}, hz = st.horizons || {};
      const f = (k) => hz[k] && fin(hz[k].mean) ? `<span class="${sgn(hz[k].mean)}">${pct(hz[k].mean)}</span>` : "—";
      const prim = hz[String(st.primary_horizon)] || {};
      return `<tr class="clickable" data-pid="${esc(p.pattern_id)}"><td><b>${esc(p.pattern_id)}</b></td><td>${esc(p.kind)}</td><td class="num">${st.n_events ?? ""}</td>
        <td class="num">${p.length}</td><td class="num">${f("1")}</td><td class="num">${f("3")}</td><td class="num">${f("5")}</td><td class="num">${f("10")}</td>
        <td class="num">${pct(prim.hit_rate, 0)}</td><td class="num">${num(st.t_stat)}</td><td class="num">${num(p.q_value, 3)}</td>
        <td>${chip(p.direction, p.direction === "long" ? "ok" : "bad")}</td>
        <td class="muted">${Object.entries(p.regimes || {}).map(([k, v]) => `R${k} ${(v * 100).toFixed(0)}%`).join(" ")}</td></tr>`;
    }).join("");
    const regRows = (reg.description || []).map((d) => `<tr><td>R${d.regime}</td><td>${esc(d.label)}</td><td class="num">${pct(d.share, 0)}</td>
      <td class="num">${pct(d.ann_return, 1)}</td><td class="num">${pct(d.ann_volatility, 1)}</td><td class="num">${num(d.mean_trend_slope, 3)}</td>
      <td class="num">${num(d.return_autocorr, 3)}</td><td class="num">${num(d.expected_duration_bars, 0)}</td></tr>`).join("");
    el.innerHTML = `<div class="grid">
      <div class="panel"><h3>Discovered patterns <span class="muted">TRAIN segment only · forward returns from next-open entry · BH-FDR q-values</span></h3>
        ${rows ? `<table><thead><tr><th>ID</th><th>Kind</th><th class="num">Occurrences</th><th class="num">Length</th><th class="num">+1</th><th class="num">+3</th><th class="num">+5</th><th class="num">+10</th><th class="num">Hit rate</th><th class="num">t</th><th class="num">q</th><th>Dir</th><th>Regimes</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">No significant patterns in this experiment.</div>`}
      </div>
      <div class="grid g-side"><div class="panel" id="pat-detail"><div class="empty">Select a pattern.</div></div>
        <div class="panel"><h3 id="pat-chart-title">Occurrence</h3><canvas class="chart" id="pat-chart"></canvas>
        <div class="note">Amber band = pattern window, dashed line = end of forward horizon. Click an occurrence on the left to jump.</div></div></div>
      <div class="panel"><h3>Latent regimes (Gaussian HMM, fitted on TRAIN, causal filtering)</h3>
        ${regRows ? `<table><thead><tr><th>ID</th><th>Post-hoc label</th><th class="num">Share</th><th class="num">Ann. return</th><th class="num">Ann. vol</th><th class="num">Trend slope</th><th class="num">Autocorr</th><th class="num">Duration</th></tr></thead><tbody>${regRows}</tbody></table>` : `<div class="empty">Regime detection disabled or unavailable.</div>`}
      </div></div>`;
    $$("#tab-patterns tr[data-pid]").forEach((tr) => tr.addEventListener("click", () => patternDetail(tr.dataset.pid, 0)));
    if (j.patterns.length) patternDetail(j.patterns[0].pattern_id, 0);
  }
  async function patternDetail(pid, occ) {
    $$("#tab-patterns tr[data-pid]").forEach((tr) => tr.classList.toggle("selected", tr.dataset.pid === pid));
    const p = await api(`/api/experiments/${S.eid}/patterns/${pid}?occurrence=${occ}`);
    const prof = (p.profile || []).map((r) => `<li>${esc(r.phrase)} <span class="muted">${r.z > 0 ? "high" : "low"} · median at ${(r.median_percentile * 100).toFixed(0)}th pct${r.lag ? ` · ${r.lag} bars before` : ""}</span></li>`).join("");
    $("#pat-detail").innerHTML = `<h3>${esc(p.pattern_id)} · ${esc(p.kind)} <span class="sp">${chip(p.direction, p.direction === "long" ? "ok" : "bad")}</span></h3>
      <div class="dsl">${esc(p.dsl)}</div>
      <pre class="note" style="margin-top:8px">${esc(p.summary_text || "")}</pre>
      ${prof ? `<h3 style="margin-top:10px">Feature profile at occurrence</h3><ul class="note">${prof}</ul>` : ""}
      ${(p.shape || []).length ? `<h3>Shape</h3><ul class="note">${p.shape.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
      <h3>Occurrences (${p.occurrence_count})</h3><div class="log" style="max-height:180px">${(p.occurrences || []).map((o) =>
        `<div><a href="#" data-occ="${o.i}">${esc(o.time)}</a> <span class="faint">bar ${o.index}</span></div>`).join("")}</div>`;
    $$("#pat-detail a[data-occ]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); patternDetail(pid, Number(a.dataset.occ)); }));
    if (p.chart) {
      const off = p.chart.offset;
      $("#pat-chart-title").innerHTML = `Occurrence #${p.chart.occurrence + 1} · ${esc(pid)}`;
      chart("pat-chart", CandleChart).setData(p.chart.bars, { highlight: [p.chart.highlight[0] - off, p.chart.highlight[1] - off],
        vline: p.chart.forward_end - off });
    }
  }

  // ------------------------------------------------------ STRATEGY DISCOVERY
  async function renderDiscovery() {
    const el = $("#tab-discovery");
    if (!$("#run-form")) {
      const cfgs = await api("/api/configs").catch(() => ({ configs: [] }));
      el.innerHTML = `<div class="grid">
        <div class="panel" id="run-form"><h3>Start research run</h3>
          <div class="row"><select id="cfg-path">${cfgs.configs.map((c) => `<option value="${esc(c.path)}">${esc(c.name)} · ${esc(c.experiment || "")} · ${esc((c.data || {}).asset || "")} ${esc((c.data || {}).timeframe || "")} · ${c.max_trials ?? "?"} trials · LLM ${esc(c.llm || "")}${c.error ? " · ERROR" : ""}</option>`).join("")}<option value="">(defaults only)</option></select>
          <button class="primary" id="start-run">START RESEARCH RUN</button></div>
          <div class="note" style="margin:6px 0">Overrides, one per line (TOML values), e.g. <code>search.max_trials=5000</code>, <code>data.path="data/BTCUSDT_4h.csv"</code>. The trial budget is fixed before the run and cannot be extended.</div>
          <textarea id="cfg-over" placeholder="search.max_trials=2000"></textarea><div id="run-msg" class="note"></div></div>
        <div class="panel"><h3>Current research run <span class="sp" id="run-stage"></span></h3><div id="run-kpis"></div></div>
        <div class="panel"><h3>Leaderboard <span class="muted">default sort: Robustness Score (TRAIN-only, net of costs, novelty/memory adjusted)</span>
          <span class="sp"><select id="lb-sort"><option value="robustness">Robustness Score</option><option value="is_return">In-sample return</option><option value="oos_return">Validation return</option><option value="complexity">Complexity</option><option value="seq">Trial order</option></select></span></h3>
          <div id="leaderboard"></div></div>
        <div class="panel"><h3>AI reflection loop <span class="muted">generation summaries sent to the hypothesis generator (TRAIN metrics only)</span></h3><div id="reflections"></div></div></div>`;
      $("#start-run").addEventListener("click", startRun);
      $("#lb-sort").addEventListener("change", (e) => { S.lbSort = e.target.value; renderDiscovery(); });
    }
    $("#lb-sort").value = S.lbSort;
    if (!S.eid || !S.exp) { $("#run-kpis").innerHTML = `<div class="empty">No experiment selected.</div>`; return; }
    const p = S.exp.progress || {};
    $("#run-stage").innerHTML = chip(S.exp.status) + " " + chip(p.stage || "—", "warn");
    const used = p.trials_used ?? 0, budget = p.trial_budget ?? S.exp.trial_budget;
    const mc = p.method_counts || {};
    const kp = [
      ["Trial", `${used.toLocaleString()} / ${(budget || 0).toLocaleString()}`, `explore ${p.explore_used ?? 0} · exploit ${p.exploit_used ?? 0}`, budget ? used / budget : 0],
      ["Generation", p.generation ?? 0, "typed GP · NSGA-II"],
      ["GP population", p.gp_population ?? 0, ""],
      ["MCTS nodes", p.mcts_nodes ?? 0, `LLM expansions ${p.mcts_llm_expansions ?? 0}`],
      ["LLM / pattern hypotheses", p.llm_hypotheses ?? 0, esc(p.hypothesis_backend || "")],
      ["Recorded trials", p.recorded ?? 0, `proposals ${p.proposals ?? 0}`],
      ["Best robustness", num(p.best_robustness, 3), "train only"],
      ["By method", Object.entries(mc).map(([k, v]) => `${k} ${v}`).join(" · ") || "—", ""],
    ];
    $("#run-kpis").innerHTML = `<div class="kpis">${kp.map(([k, v, s, f]) => `<div class="kpi"><div class="k">${esc(k)}</div><div class="v" style="${String(v).length > 14 ? "font-size:12px" : ""}">${v}</div><div class="s">${s || ""}</div>${f != null ? `<div class="bar"><div style="width:${Math.min(100, f * 100).toFixed(1)}%"></div></div>` : ""}</div>`).join("")}</div>
      ${S.exp.log_tail ? `<h3 style="margin-top:10px">Process log</h3><div class="log">${esc(S.exp.log_tail)}</div>` : ""}
      ${S.exp.error ? `<h3 style="margin-top:10px" class="neg">Error</h3><div class="log">${esc(S.exp.error)}</div>` : ""}`;
    if (S.exp.status === "STARTING" || !S.exp.counts) return;
    const lb = await api(`/api/experiments/${S.eid}/trials?order=${S.lbSort}&status=EVALUATED&limit=40`);
    $("#leaderboard").innerHTML = trialTable(lb.trials, true);
    bindTrialRows("#leaderboard");
    const g = await api(`/api/experiments/${S.eid}/generations`);
    $("#reflections").innerHTML = g.generations.length ? g.generations.slice(-6).reverse().map((x) => `<div class="ex"><div class="meta">generation ${x.generation} · ${esc(x.created_at)}</div><pre class="note">${esc(x.reflection_text || "")}</pre></div>`).join("") : `<div class="empty">No reflection yet.</div>`;
  }
  async function startRun() {
    $("#run-msg").textContent = "starting…";
    try {
      const r = await post("/api/experiments", { config_path: $("#cfg-path").value, overrides: $("#cfg-over").value });
      $("#run-msg").innerHTML = `started <b>${esc(r.experiment_id)}</b> (pid ${r.pid}) · log ${esc(r.log)}`;
      S.eid = r.experiment_id;
      setTimeout(async () => { await loadExperiments(true); render("discovery"); }, 1200);
    } catch (e) { $("#run-msg").innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
  }
  function trialTable(trials, compact) {
    if (!trials.length) return `<div class="empty">No trials.</div>`;
    return `<table><thead><tr><th class="num">#</th><th>Method</th><th>Status</th><th class="num">Robust.</th><th class="num">IS return</th><th class="num">IS trades</th><th class="num">Val return</th><th class="num">Cmplx</th><th>Tags</th><th>DSL</th></tr></thead><tbody>
      ${trials.map((t) => `<tr class="clickable" data-tid="${t.trial_id}"><td class="num">${t.trial_id}</td><td>${esc(t.creation_method)}<div class="faint">${esc(t.operator || "")}</div></td><td>${chip(t.status)}</td>
      <td class="num">${num(t.robustness, 3)}</td><td class="num ${sgn(t.is_return)}">${pct(t.is_return, 1)}</td><td class="num">${t.is_trades ?? "—"}</td>
      <td class="num ${sgn(t.oos_return)}">${pct(t.oos_return, 1)}</td><td class="num">${num(t.complexity_score, 1)}</td>
      <td>${(t.tags || []).map((x) => chip(x, "warn")).join(" ")}</td><td class="dsl-inline" title="${esc(t.dsl)}">${esc((t.dsl || "").replace(/\n/g, " | "))}</td></tr>`).join("")}</tbody></table>`;
  }
  function bindTrialRows(root) {
    $$(`${root} tr[data-tid]`).forEach((tr) => tr.addEventListener("click", () => showTrial(tr.dataset.tid)));
  }
  async function showTrial(tid) {
    const t = await api(`/api/trials/${tid}`);
    const lin = (t.lineage || []).map((a) => `<tr><td class="num">${a.trial_id}</td><td>${esc(a.creation_method)} ${esc(a.operator || "")}</td><td class="num">${a.generation}</td><td>${chip(a.status)}</td><td class="num">${num(a.robustness, 3)}</td><td class="dsl-inline">${esc((a.dsl || "").replace(/\n/g, " | "))}</td></tr>`).join("");
    const is = t.is_result || {};
    openModal(`<h2>TRIAL #${t.trial_id} <span class="muted">&nbsp;${esc(t.creation_method)} · gen ${t.generation} · ${esc(t.phase || "")}</span><span class="sp"><button class="small" id="mclose">CLOSE</button></span></h2>
      <div class="grid g2"><div><div class="dsl"><pre>${esc(t.dsl)}</pre></div>${t.error ? `<div class="neg mono">${esc(t.error)}</div>` : ""}
      <div class="note" style="margin-top:6px">${esc((t.meta || {}).rationale || "")}</div></div>
      <div><table><tbody>${[["status", t.status], ["family", t.family], ["train return", pct(is.total_return)], ["train trades", is.trades], ["train sortino", num(is.sortino)],
        ["train max DD", pct(is.max_drawdown)], ["gross (pre-cost) return", pct(is.gross_return)], ["sub-period consistency", num(is.consistency)],
        ["robustness", num(t.robustness, 3)], ["validation return (sealed from search)", pct((t.oos_result || {}).total_return)]]
        .map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td class="num">${esc(v ?? "—")}</td></tr>`).join("")}</tbody></table></div></div>
      <h3 style="margin-top:12px">Lineage</h3><table><thead><tr><th class="num">trial</th><th>method</th><th class="num">gen</th><th>status</th><th class="num">robust.</th><th>DSL</th></tr></thead><tbody>${lin}</tbody></table>`);
  }

  // ------------------------------------------------------------ EXPERIMENTS
  async function renderExperiments() {
    const el = $("#tab-experiments");
    const j = await api("/api/experiments");
    const rows = j.experiments.map((e) => {
      const p = e.progress || {}, s = e.summary || {};
      return `<tr class="clickable ${e.experiment_id === S.eid ? "selected" : ""}" data-eid="${esc(e.experiment_id)}"><td>${esc(e.experiment_id)}<div class="faint">${esc(e.name || "")}</div></td><td>${chip(e.status)}</td>
      <td>${esc((e.created_at || "").slice(0, 19))}</td><td>${esc(e.asset || "")} ${esc(e.timeframe || "")}</td><td class="num">${p.trials_used ?? "—"} / ${e.trial_budget ?? "—"}</td>
      <td class="num">${e.random_seed ?? ""}</td><td class="mono faint">${esc(e.config_hash || "")}</td><td class="mono faint">${esc((e.data_version || "").slice(0, 12))}</td>
      <td class="mono faint">${esc(e.code_version || "")}</td><td>${esc(JSON.stringify(s.candidate_status || {}))}</td></tr>`;
    }).join("");
    let ledger = "";
    if (S.eid && S.exp && S.exp.counts) {
      const c = S.exp.counts;
      const t = await api(`/api/experiments/${S.eid}/trials?order=seq&limit=100&offset=${S.ledger.offset}&status=${S.ledger.status}&method=${S.ledger.method}`);
      const st = Object.entries(c.by_status).map(([k, v]) => `<option value="${esc(k)}" ${S.ledger.status === k ? "selected" : ""}>${esc(k)} (${v})</option>`).join("");
      const me = Object.entries(c.by_method).map(([k, v]) => `<option value="${esc(k)}" ${S.ledger.method === k ? "selected" : ""}>${esc(k)} (${v})</option>`).join("");
      const e = S.exp;
      ledger = `<div class="panel"><h3>Reproducibility · ${esc(e.experiment_id)}</h3><div class="kpis">${[["random_seed", e.random_seed], ["data_version", (e.data_version || "").slice(0, 16)], ["holdout data hash", (e.holdout_data_version || "").slice(0, 16)],
        ["code_version", e.code_version], ["config_hash", e.config_hash], ["trial_budget", e.trial_budget], ["cost model", `${(e.cost_model || {}).fee_bps}bp fee · ${(e.cost_model || {}).slippage_bps}bp slip · funding ${(e.cost_model || {}).funding_mode}`]]
        .map(([k, v]) => `<div class="kpi"><div class="k">${esc(k)}</div><div class="v" style="font-size:12px;word-break:break-all">${esc(v)}</div></div>`).join("")}</div></div>
        <div class="panel"><h3>Trial Ledger <span class="muted">append-only · every candidate is recorded, including failures, invalid DSL and duplicates · ${c.total_recorded} recorded · ${c.budget_used} counted against the budget</span></h3>
        <div class="row"><select id="lf-status"><option value="">all statuses</option>${st}</select><select id="lf-method"><option value="">all methods</option>${me}</select>
        <button class="small" id="lf-prev">◀</button><span class="mono muted">offset ${S.ledger.offset}</span><button class="small" id="lf-next">▶</button></div>
        <div style="margin-top:8px">${trialTable(t.trials)}</div></div>
        <div class="panel"><h3>Events</h3><div class="log">${(e.events || []).map((x) => `<div><span class="faint">${esc(x.created_at)}</span> ${chip(x.level, x.level === "ERROR" ? "bad" : x.level === "WARN" ? "warn" : "")} ${esc(x.message)}</div>`).join("")}</div></div>`;
    }
    el.innerHTML = `<div class="grid"><div class="panel"><h3>Experiments</h3><table><thead><tr><th>ID</th><th>Status</th><th>Created</th><th>Data</th><th class="num">Trials</th><th class="num">Seed</th><th>Config hash</th><th>Data version</th><th>Code version</th><th>Candidates</th></tr></thead><tbody>${rows}</tbody></table></div>${ledger}</div>`;
    $$("#tab-experiments tr[data-eid]").forEach((tr) => tr.addEventListener("click", async () => { S.eid = tr.dataset.eid; $("#exp-select").value = S.eid; S.ledger.offset = 0; await refreshExperiment(); renderExperiments(); }));
    bindTrialRows("#tab-experiments");
    const f = (id, key) => { const x = $(id); if (x) x.addEventListener("change", (ev) => { S.ledger[key] = ev.target.value; S.ledger.offset = 0; renderExperiments(); }); };
    f("#lf-status", "status"); f("#lf-method", "method");
    const pv = $("#lf-prev"), nx = $("#lf-next");
    if (pv) pv.addEventListener("click", () => { S.ledger.offset = Math.max(0, S.ledger.offset - 100); renderExperiments(); });
    if (nx) nx.addEventListener("click", () => { S.ledger.offset += 100; renderExperiments(); });
  }

  // ------------------------------------------------------------- CANDIDATES
  async function renderCandidates() {
    const el = $("#tab-candidates");
    if (!S.eid) { el.innerHTML = `<div class="panel"><div class="empty">Select an experiment.</div></div>`; return; }
    const j = await api(`/api/experiments/${S.eid}/candidates`);
    if (!j.candidates.length) { el.innerHTML = `<div class="panel"><div class="empty">No candidates yet (they are created after the search budget is exhausted and validation runs).</div></div>`; return; }
    const cards = j.candidates.sort((a, b) => (b.robustness ?? 0) - (a.robustness ?? 0)).map((c) => `<div class="card ${c.candidate_id === S.cid ? "sel" : ""}">
      <div class="title">STRATEGY #${c.trial_id} <span class="faint">cand ${c.candidate_id}</span><span class="sp">${chip(c.status)}</span></div>
      <dl><dt>Novelty</dt><dd>${chip(c.novelty || "—")} ${chip(c.novelty_class || "")}</dd>
      <dt>Complexity</dt><dd>${c.complexity_nodes ?? "—"} nodes</dd><dt>Trades (OOS)</dt><dd>${c.trades ?? "—"}</dd>
      <dt>OOS CAGR</dt><dd class="${sgn(c.oos_cagr)}">${pct(c.oos_cagr, 1)}</dd><dt>MDD</dt><dd class="neg">${pct(c.mdd, 1)}</dd>
      <dt>Sortino</dt><dd>${num(c.sortino)}</dd><dt>Deflated Sharpe</dt><dd>${num(c.deflated_sharpe)}</dd><dt>PBO</dt><dd>${num(c.pbo)}</dd>
      <dt>Cost Stress</dt><dd>${chip(c.cost_stress)}</dd><dt>Parameter Stability</dt><dd>${chip(c.parameter_stability)}</dd>
      <dt>Walk-forward</dt><dd>${chip(c.walk_forward)}</dd><dt>Regime</dt><dd>${esc(c.regime)}</dd>
      <dt>Final holdout</dt><dd>${chip(c.holdout_status)}</dd><dt>Robustness (full)</dt><dd>${num(c.robustness, 3)}</dd></dl>
      ${c.failed_checks.length ? `<div class="note">failed: ${c.failed_checks.map((x) => esc(x)).join(", ")}</div>` : ""}
      ${(c.warnings || []).map((w) => `<div class="mono" style="color:var(--warn);font-size:11px">${esc(w)}</div>`).join("")}
      <div class="dsl" style="margin-top:8px"><pre>${esc(c.dsl)}</pre></div>
      <details style="margin-top:6px"><summary class="note">설명 (Strategy explanation)</summary><pre class="note">${esc(c.explanation || "")}</pre></details>
      <div class="actions"><button class="small" data-act="val" data-cid="${c.candidate_id}">VALIDATION</button><button class="small" data-act="ex" data-cid="${c.candidate_id}">SHOW EXAMPLES</button>
      <button class="small primary" data-act="exp" data-cid="${c.candidate_id}">EXPORT STRATEGY RECIPE</button></div><div class="note" id="exp-${c.candidate_id}"></div></div>`).join("");
    el.innerHTML = `<div class="panel" style="margin-bottom:12px"><div class="note">Cards are sorted by the post-validation Robustness Score. The LLM's opinion never enters any number shown here; every value comes from deterministic, cost-inclusive backtests.</div></div><div class="cards">${cards}</div>`;
    $$("#tab-candidates button[data-act]").forEach((b) => b.addEventListener("click", () => {
      const cid = Number(b.dataset.cid);
      if (b.dataset.act === "val") { S.cid = cid; showTab("validation"); }
      if (b.dataset.act === "ex") showExamples(cid);
      if (b.dataset.act === "exp") exportRecipe(cid);
    }));
  }
  async function exportRecipe(cid) {
    const box = $(`#exp-${cid}`);
    box.textContent = "exporting…";
    try {
      const r = await post(`/api/candidates/${cid}/export`, {});
      box.innerHTML = `exported <b>${esc(r.strategy_name)}</b> → <span class="mono">${esc(r.folder)}</span><br>` +
        r.files.map((f) => `<a href="/api/candidates/${cid}/export/${encodeURIComponent(f)}">${esc(f)}</a>`).join(" · ");
    } catch (e) { box.innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
  }
  async function showExamples(cid) {
    openModal(`<h2>SHOW EXAMPLES · candidate ${cid}<span class="sp"><button class="small" id="mclose">CLOSE</button></span></h2><div class="empty">loading…</div>`);
    const j = await api(`/api/candidates/${cid}/examples`);
    const col = (title, list, key) => `<div><h3>${title} <span class="muted">${list.length}</span></h3>${list.map((t, i) => `<div class="ex"><div class="meta">${esc(t.side)} · ${esc(t.entry_time)} → ${esc(t.exit_time)} · <span class="${sgn(t.return)}">${pct(t.return)}</span> · MFE ${pct(t.mfe)} · ${esc(t.reason)} · ${esc(t.segment)}</div><canvas class="chart small" id="exc-${key}-${i}"></canvas></div>`).join("") || `<div class="empty">none</div>`}</div>`;
    $("#modal-body").innerHTML = `<h2>SHOW EXAMPLES · candidate ${cid} <span class="muted">&nbsp;${j.trades_total} trades (train+validation+test)</span><span class="sp"><button class="small" id="mclose">CLOSE</button></span></h2>
      <div class="note" style="margin-bottom:8px">▲ entry fill (next open after the signal) · ▼ exit · violet = signal bar. False signal = ${esc(j.false_signal_rule || "")}.</div>
      <div class="ex-cols">${col("GOOD TRADES", j.good, "g")}${col("BAD TRADES", j.bad, "b")}${col("FALSE SIGNALS", j.false, "f")}</div>`;
    $("#mclose").addEventListener("click", closeModal);
    for (const [key, list] of [["g", j.good], ["b", j.bad], ["f", j.false]]) {
      list.forEach((t, i) => {
        const c = new CandleChart(document.getElementById(`exc-${key}-${i}`), { interactive: false });
        const off = t.offset;
        c.setData(t.bars, { highlight: [t.entry - off, t.exit - off], markers: [{ i: t.signal - off, type: "signal" }, { i: t.entry - off, type: "entry", side: t.side }, { i: t.exit - off, type: "exit" }] });
      });
    }
  }

  // ------------------------------------------------------------- VALIDATION
  async function renderValidation() {
    const el = $("#tab-validation");
    if (!S.eid) { el.innerHTML = `<div class="panel"><div class="empty">Select an experiment.</div></div>`; return; }
    const list = await api(`/api/experiments/${S.eid}/candidates`);
    if (!list.candidates.length) { el.innerHTML = `<div class="panel"><div class="empty">No candidates in this experiment.</div></div>`; return; }
    if (!S.cid || !list.candidates.some((c) => c.candidate_id === S.cid)) S.cid = list.candidates[0].candidate_id;
    const c = await api(`/api/candidates/${S.cid}`);
    const v = c.validation || {}, g = c.gate || {};
    const opts = list.candidates.map((x) => `<option value="${x.candidate_id}" ${x.candidate_id === S.cid ? "selected" : ""}>#${x.trial_id} · ${esc(x.status)} · rob ${num(x.robustness, 3)}</option>`).join("");
    const checks = (g.checks || []).map((k) => `<div class="check">${chip(k.passed ? "PASS" : "FAIL")}<div><b>${esc(k.name)}</b><div class="val">${esc(jround(k.value)).slice(0, 240)}</div><div class="val">threshold ${esc(jround(k.threshold))} ${esc(k.detail || "")}</div></div></div>`).join("");
    const perf = ["train", "validation", "test", "oos", "full"].map((s) => { const m = v[s] || {}; return `<tr><td>${s === "oos" ? "validation+test" : s === "full" ? "train+val+test" : s}</td><td class="num ${sgn(m.total_return)}">${pct(m.total_return, 1)}</td><td class="num">${pct(m.cagr, 1)}</td><td class="num">${num(m.sharpe)}</td><td class="num">${num(m.sortino)}</td><td class="num neg">${pct(m.max_drawdown, 1)}</td><td class="num">${num(m.profit_factor)}</td><td class="num">${pct(m.win_rate, 0)}</td><td class="num">${m.trades ?? "—"}</td><td class="num">${pct(m.exposure, 0)}</td><td class="num">${num(m.turnover, 1)}</td><td class="num">${pct(m.gross_return, 1)}</td></tr>`; }).join("");
    const wf = v.walk_forward || {};
    const wfRows = (wf.folds || []).map((f) => `<tr><td class="num">${f.fold}</td><td>${iso(f.test_start_ts)} → ${iso(f.test_end_ts)}</td><td>${f.clean ? chip("clean", "ok") : chip("sel.", "warn")}</td><td class="num ${sgn(f.fixed.total_return)}">${pct(f.fixed.total_return, 1)}</td><td class="num">${f.fixed.trades}</td><td class="num ${sgn((f.refit || {}).total_return)}">${pct((f.refit || {}).total_return, 1)}</td><td class="dsl-inline">${esc((f.refit_dsl || "same parameters").replace(/\n/g, " | "))}</td></tr>`).join("");
    const st = v.stress || {};
    const stRows = Object.entries(st.scenarios || {}).map(([k, s]) => `<tr><td>${esc(k)}</td><td class="num ${sgn(s.total_return)}">${pct(s.total_return, 1)}</td><td class="num">${s.trades}</td><td class="num">${num(s.sharpe)}</td><td class="num">${(st.required || {})[k] === undefined ? "" : chip((st.required || {})[k] ? "PASS" : "FAIL")}</td></tr>`).join("");
    const mt = st.missed_trades || {};
    const sens = v.sensitivity || {};
    const sensRows = (sens.variants || []).map((x) => `<tr><td>${esc(x.parameter)}</td><td class="num">${esc(x.base_value)}</td><td class="num">${esc(x.value)}</td><td class="num ${sgn((x["train+validation"] || {}).total_return)}">${pct((x["train+validation"] || {}).total_return, 1)}</td><td class="num ${sgn((x.test || {}).total_return)}">${pct((x.test || {}).total_return, 1)}</td></tr>`).join("");
    const rg = v.regimes || {};
    const rgRows = (rg.regimes || []).map((r) => `<tr><td>R${r.regime}</td><td>${esc(r.label)}</td><td class="num ${sgn(r.return)}">${pct(r.return, 1)}</td><td class="num">${r.trades_entered}</td><td class="num">${pct(r.win_rate, 0)}</td><td class="num">${r.bars_in_position}</td></tr>`).join("");
    const ca = v.cross_asset || {};
    const caRows = (ca.assets || []).map((a) => `<tr><td>${esc(a.asset)}</td><td>${esc(a.asset_class)}</td><td>${esc(a.status)}</td><td class="num ${sgn(a.total_return)}">${pct(a.total_return, 1)}</td><td class="num">${a.trades ?? ""}</td><td class="num">${num(a.profit_factor)}</td></tr>`).join("");
    const ks = v.known_strategy || {};
    const ksRows = (ks.top || []).map((k) => `<tr><td>${esc(k.name)}</td><td>${esc(k.family)}</td><td class="num">${num(k.similarity, 3)}</td><td class="num">${num(k.trade_overlap, 3)}</td><td class="num">${num(k.position_correlation, 3)}</td></tr>`).join("");
    const d = v.dsr || {}, pe = v.pbo_experiment || {}, pc = v.pbo_candidate || {};
    const dd = Object.entries(v.dsr_detail || {}).map(([k, x]) => `<tr><td>${esc(k)}</td><td class="num">${num(x.sharpe_per_bar, 4)}</td><td class="num">${x.bars}</td><td class="num">${x.n_trials}</td><td class="num">${num(x.expected_max_sharpe, 4)}</td><td class="num">${num(x.dsr, 3)}</td></tr>`).join("");
    const ho = c.holdout;
    el.innerHTML = `<div class="grid">
      <div class="panel"><h3>Candidate <select id="val-cand">${opts}</select><span class="sp">${chip(c.status)} ${chip(c.holdout_status)} ${chip(c.novelty_class || "")}</span></h3>
        <div class="grid g2"><div class="dsl"><pre>${esc(c.dsl)}</pre></div><pre class="note">${esc((c.explanation || {}).text || "")}</pre></div>
        ${((c.explanation || {}).llm_narrative) ? `<div class="note" style="margin-top:6px"><b>LLM narrative (informational, not scored):</b> ${esc(c.explanation.llm_narrative.text)}</div>` : ""}
        ${(g.warnings || []).map((w) => `<div class="mono" style="color:var(--warn)">${esc(w)}</div>`).join("")}
        <div class="note" style="margin-top:6px">Selected from <b>${(v.trial_accounting || {}).n_trials_evaluated}</b> evaluated trials (${(v.trial_accounting || {}).n_trials_effective} behaviourally distinct, ${(v.trial_accounting || {}).n_trials_recorded} recorded incl. duplicates/invalid).</div></div>
      <div class="panel"><h3>Strategy Robustness Gate <span class="sp">${chip(g.status)} pass ${pct(g.pass_fraction, 0)}</span></h3><div class="checks">${checks}</div></div>
      <div class="panel"><h3>Equity curve (net of costs) <span class="muted">shaded: train / validation / test · holdout not shown until evaluated</span></h3><canvas class="chart" id="eq-chart"></canvas></div>
      <div class="panel"><h3>Performance by segment</h3><table><thead><tr><th>Segment</th><th class="num">Return</th><th class="num">CAGR</th><th class="num">Sharpe</th><th class="num">Sortino</th><th class="num">Max DD</th><th class="num">PF</th><th class="num">Win</th><th class="num">Trades</th><th class="num">Exposure</th><th class="num">Turnover/yr</th><th class="num">Gross (pre-cost)</th></tr></thead><tbody>${perf}</tbody></table></div>
      <div class="grid g2">
        <div class="panel"><h3>Walk-forward <span class="sp">${chip(wf.passed ? "PASS" : "FAIL")} ${esc(wf.mode || "")} · refit ${wf.refit}</span></h3><div class="note">positive folds ${pct(wf.positive_fraction, 0)} · compounded OOS ${pct(wf.compounded_oos_return, 1)} · clean folds (TEST segment) ${wf.clean_folds} → ${pct(wf.clean_compounded_return, 1)}</div>
          <table><thead><tr><th class="num">Fold</th><th>Test window</th><th></th><th class="num">Fixed</th><th class="num">Trades</th><th class="num">Refit</th><th>Refit parameters</th></tr></thead><tbody>${wfRows}</tbody></table></div>
        <div class="panel"><h3>Overfitting firewall</h3>
          <div class="kpis"><div class="kpi"><div class="k">Deflated Sharpe</div><div class="v">${num(d.dsr, 3)}</div><div class="s">${esc(d.segment)} · N ${d.n_trials} (${esc(d.n_basis)})</div></div>
          <div class="kpi"><div class="k">PSR test vs 0</div><div class="v">${num(d.psr_test_vs_zero, 3)}</div><div class="s">no selection on test</div></div>
          <div class="kpi"><div class="k">PBO (experiment)</div><div class="v">${num(pe.pbo, 3)}</div><div class="s">${pe.n_configs ?? "?"} configs · ${pe.n_combinations ?? "?"} CSCV splits</div></div>
          <div class="kpi"><div class="k">PBO (param. neighbourhood)</div><div class="v">${num(pc.pbo, 3)}</div><div class="s">diagnostic</div></div>
          <div class="kpi"><div class="k">Look-ahead</div><div class="v">${(v.lookahead || {}).valid ? "clean" : "INVALID"}</div><div class="s">truncation test · ${((v.lookahead || {}).cuts || []).length} cuts</div></div></div>
          <table style="margin-top:8px"><thead><tr><th>DSR variant</th><th class="num">SR/bar</th><th class="num">T</th><th class="num">N</th><th class="num">E[max SR]</th><th class="num">DSR</th></tr></thead><tbody>${dd}</tbody></table>
          <h3 style="margin-top:10px">CSCV logit distribution (experiment)</h3><canvas class="chart tiny" id="pbo-hist"></canvas></div>
      </div>
      <div class="grid g2">
        <div class="panel"><h3>Stress tests <span class="sp">${chip(st.passed ? "PASS" : "FAIL")}</span></h3><table><thead><tr><th>Scenario</th><th class="num">Return</th><th class="num">Trades</th><th class="num">Sharpe</th><th class="num">Required</th></tr></thead><tbody>${stRows}
          <tr><td>random missed trades p=${mt.prob} (${mt.runs} runs)</td><td class="num">median ${pct(mt.median_return, 1)}</td><td class="num"></td><td class="num">p05 ${pct(mt.p05_return, 1)}</td><td class="num">${pct(mt.positive_fraction, 0)} positive</td></tr></tbody></table></div>
        <div class="panel"><h3>Parameter sensitivity <span class="sp">${chip(sens.passed ? "PASS" : "FAIL")}</span></h3><div class="note">selection region positive ${pct((sens["train+validation"] || {}).positive_fraction, 0)} · median Sortino ratio ${num((sens["train+validation"] || {}).median_sortino_ratio)} · test positive ${pct((sens.test || {}).positive_fraction, 0)}</div>
          <div style="max-height:320px;overflow:auto"><table><thead><tr><th>Parameter</th><th class="num">Base</th><th class="num">Value</th><th class="num">Train+Val</th><th class="num">Test</th></tr></thead><tbody>${sensRows}</tbody></table></div></div>
      </div>
      <div class="grid g3">
        <div class="panel"><h3>Regime robustness</h3>${rgRows ? `<table><thead><tr><th>ID</th><th>Label</th><th class="num">Return</th><th class="num">Trades</th><th class="num">Win</th><th class="num">Bars in pos.</th></tr></thead><tbody>${rgRows}</tbody></table>` : `<div class="empty">n/a</div>`}</div>
        <div class="panel"><h3>Cross-asset · ${esc(ca.classification || "")}</h3>${caRows ? `<table><thead><tr><th>Asset</th><th>Class</th><th>Status</th><th class="num">Return</th><th class="num">Trades</th><th class="num">PF</th></tr></thead><tbody>${caRows}</tbody></table>` : `<div class="empty">No other assets configured (cross_asset.assets).</div>`}</div>
        <div class="panel"><h3>Known-strategy fingerprint · ${esc(ks.novelty_class || "")}</h3><div class="note">structural matches: ${esc((ks.structural || []).join(", ") || "none")}</div><table><thead><tr><th>Closest known</th><th>Family</th><th class="num">Sim.</th><th class="num">Overlap</th><th class="num">Corr.</th></tr></thead><tbody>${ksRows}</tbody></table></div>
      </div>
      <div class="panel"><h3>Final holdout vault <span class="sp">${chip(c.holdout_status)}</span></h3>
        ${ho ? `<div class="kpis"><div class="kpi"><div class="k">verdict</div><div class="v" style="font-size:14px">${esc(ho.verdict)}</div></div><div class="kpi"><div class="k">window</div><div class="v" style="font-size:12px">${esc(ho.window.start)} → ${esc(ho.window.end)}</div><div class="s">${ho.window.bars} bars</div></div>
          <div class="kpi"><div class="k">return</div><div class="v ${sgn(ho.metrics.total_return)}">${pct(ho.metrics.total_return, 1)}</div></div><div class="kpi"><div class="k">trades</div><div class="v">${ho.metrics.trades}</div></div><div class="kpi"><div class="k">max DD</div><div class="v">${pct(ho.metrics.max_drawdown, 1)}</div></div></div>
          <div class="note">Evaluated once. The window is now CONSUMED; a modified strategy needs a new prospective window.</div>`
          : `<div class="note">The holdout is evaluated exactly once, only for candidates that pass every gate, all together. Status: ${esc(c.holdout_status)}.</div>`}</div>
    </div>`;
    $("#val-cand").addEventListener("change", (e) => { S.cid = Number(e.target.value); renderValidation(); });
    const eq = await api(`/api/candidates/${S.cid}/equity`);
    const colors = { train: "rgba(45,212,191,0.06)", validation: "rgba(96,165,250,0.07)", test: "rgba(167,139,250,0.08)" };
    chart("eq-chart", LineChart, { log: true }).setData([
      { points: eq.equity, color: "#2dd4bf", label: "strategy (net)", width: 1.8 },
      { points: eq.benchmark, color: "#4b5868", label: "buy & hold", dashed: true }],
      eq.segments.map((s) => ({ from: s.from, to: s.to, color: colors[s.name], label: s.name.toUpperCase() })));
    barChart(document.getElementById("pbo-hist"), pe.logit_histogram || [], []);
  }

  // --------------------------------------------------------- RESEARCH MEMORY
  async function renderMemory() {
    const el = $("#tab-memory");
    const scope = S.memScope || "";
    const j = await api(`/api/memory${scope ? `?scope=${scope}` : ""}`);
    const rows = j.memory.map((m) => `<tr><td>${esc(m.created_at.slice(0, 19))}</td><td>${chip(m.scope === "llm_visible" ? "LLM-visible" : "researcher only", m.scope === "llm_visible" ? "ok" : "LOCKED")}</td>
      <td>${esc(m.asset || "")} ${esc(m.timeframe || "")}</td><td class="dsl-inline" title="${esc(m.family)}">${esc(m.family)}</td><td class="num">${m.n_trials}</td>
      <td>${chip(m.conclusion, ["fails_after_cost", "no_edge", "REJECTED"].includes(m.conclusion) ? "bad" : m.conclusion === "promising" ? "ok" : "warn")}</td>
      <td class="muted">${esc(Object.entries(m.stats || {}).map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(2) : JSON.stringify(v)}`).join(" · ")).slice(0, 180)}</td><td class="muted">${esc(m.note || "")}</td></tr>`).join("");
    let calls = "";
    if (S.eid) {
      const c = await api(`/api/experiments/${S.eid}/llm`).catch(() => ({ calls: [] }));
      calls = c.calls.length ? `<table><thead><tr><th>Time</th><th>Purpose</th><th>Backend</th><th>Model</th><th>Prompt hash</th><th>Meta</th></tr></thead><tbody>${c.calls.map((x) => `<tr><td>${esc(x.created_at)}</td><td>${esc(x.purpose)}</td><td>${esc(x.backend)}</td><td>${esc(x.model || "")}</td><td class="mono faint">${esc(x.prompt_hash.slice(0, 16))}</td><td class="muted">${esc(JSON.stringify(x.meta || {})).slice(0, 160)}</td></tr>`).join("")}</tbody></table>`
        : `<div class="empty">No LLM calls in this experiment (offline template backend or LLM disabled).</div>`;
    }
    el.innerHTML = `<div class="grid"><div class="panel"><h3>Research memory <span class="sp"><select id="mem-scope"><option value="">all</option><option value="llm_visible">LLM-visible (TRAIN-derived)</option><option value="researcher_only">researcher only (validation-derived)</option></select></span></h3>
      <div class="note">Families that repeatedly fail on TRAIN are penalised in later searches and reported to the LLM as "do not regenerate without a material structural change". Validation-derived notes are never shown to the LLM.</div>
      ${rows ? `<table style="margin-top:8px"><thead><tr><th>Time</th><th>Scope</th><th>Data</th><th>Family</th><th class="num">Trials</th><th>Conclusion</th><th>Stats</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">Memory is empty.</div>`}</div>
      <div class="panel"><h3>LLM call log · selected experiment</h3>${calls}</div></div>`;
    $("#mem-scope").value = scope;
    $("#mem-scope").addEventListener("change", (e) => { S.memScope = e.target.value; renderMemory(); });
  }

  // ------------------------------------------------------------------ modal
  function openModal(html) {
    $("#modal-body").innerHTML = html;
    $("#modal").classList.add("open");
    const b = $("#mclose"); if (b) b.addEventListener("click", closeModal);
  }
  function closeModal() { $("#modal").classList.remove("open"); }
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  loadExperiments(false).then(() => render(S.tab)).catch((e) => console.error(e));
})();
