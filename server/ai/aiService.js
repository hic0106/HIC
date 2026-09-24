// AI features (Claude API):
//   1) analyze   : explain why strategies lost money in the last backtest (causes + evidence)
//   2) improve   : self-improvement loop - Claude proposes setting changes, each candidate is backtested,
//                  results go back to Claude for the next round. Claude only sees the IN-SAMPLE period (first 70%);
//                  the OUT-OF-SAMPLE period (last 30%) is kept hidden and used to accept / reject (overfitting guard).
//                  Nothing is applied automatically - the user applies a candidate with one click (validated like a manual save).
//   3) generate  : Claude designs a new strategy in the declarative rule format (dsl.js), backtested and refined.
// Only aggregated backtest data is sent to Claude (no keys, no account data).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../store.js';
import { ALL_STRATEGIES, META, STRATEGY_CLASS, symbolsForStrategy } from '../strategyRegistry.js';
import { timeframeOf } from '../scheduler/timeframes.js';
import { validateStrategySettings } from '../strategyConfig.js';
import { ClaudeClient, AI_MODEL } from './claudeClient.js';
import { STRATEGY_SCHEMA, validateDsl, compileDsl, describeRules } from './dsl.js';

const FILE = path.join(DATA_DIR, 'ai-state.json');
const SAVED = path.join(DATA_DIR, 'ai-strategies.json');
const DAY = 86_400_000;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { fs.writeFileSync(`${f}.tmp`, JSON.stringify(v)); fs.renameSync(`${f}.tmp`, f); } catch { /* disk issue */ } };
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const ymd = (t) => new Date(t).toISOString().slice(0, 10);

// ---------- prompts (stable -> cached)
const SYSTEM = `당신은 암호화폐 선물 자동매매 시스템의 퀀트 리서처입니다. 사용자는 한국어를 쓰며, 모든 설명 문자열은 한국어로, 짧고 구체적으로 작성합니다.

시스템 규칙 (백테스트와 실거래 동일):
- 거래소: Binance USDT-M 무기한 선물, 레버리지 1배, 전략·종목당 포지션 1개. 헤지 모드(롱·숏 동시 보유 가능).
- 신호는 마감된 캔들에서만 확인하고, 주문은 다음 캔들 시가에 체결(슬리피지 적용). 수수료(시장가)·펀딩비 반영.
- 손절(ATR_DYNAMIC): 진입 시 손절폭 = clamp(ATR×배수/진입가, 최소%, 최대%)로 고정되고 캔들 고가/저가로 체결 확인(갭은 시가 체결). FIXED_PERCENT는 고정 %.
- resetAfterStop=true 이면 손절 후 진입 조건이 한 번 false가 된 뒤에만 재진입.
- 자금: 전략별 별도 계좌, 각 종목 슬롯은 진입 시 계좌 평가액/종목 수(복리).
- 기존 전략: TURTLE(N봉 최고가 돌파 롱 / N봉 최저가 이탈 + SMA200 아래 숏, M봉 채널 청산), ADX(ADX>기준 & DI 방향, 숏은 SMA200 아래), TSMOM(N일 로그수익률>0 롱, 아니면 현금), QQQ 전략(미국 정규장 일봉, 롱/현금).

분석과 제안 원칙:
- 숫자 근거(거래 수, 청산 사유별 손익, 월별 수익, 롱/숏 분리, 수수료·펀딩 비중, 단순 보유 대비)를 인용하세요.
- 과최적화 금지: 적은 수의 변경, 넓게 안정적인 값, 거래 수가 너무 적어지는 조건은 피하세요. 주어진 데이터는 학습 구간뿐이며 검증 구간은 따로 평가됩니다.
- 수수료·슬리피지가 큰 잦은 매매, 추세 없는 구간의 반복 손절, 숏의 상승장 손실 같은 구조적 원인을 우선 찾으세요.
- 수익을 보장하는 표현은 쓰지 마세요.`;

const ANALYSIS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['overall', 'strategies', 'portfolioRisks', 'nextSteps'],
  properties: {
    overall: { type: 'string' },
    strategies: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['strategy', 'verdict', 'summary', 'lossCauses', 'suggestions'], properties: {
      strategy: { type: 'string' }, verdict: { type: 'string', enum: ['GOOD', 'MIXED', 'BAD', 'NO_DATA'] }, summary: { type: 'string' },
      lossCauses: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cause', 'evidence', 'severity'], properties: { cause: { type: 'string' }, evidence: { type: 'string' }, severity: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] } } } },
      suggestions: { type: 'array', items: { type: 'string' } },
    } } },
    portfolioRisks: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
  },
};

const IMPROVE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['analysis', 'candidates'],
  properties: {
    analysis: { type: 'string' },
    candidates: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'hypothesis', 'changes'], properties: {
      label: { type: 'string' }, hypothesis: { type: 'string' },
      changes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'value'], properties: {
        path: { type: 'string', description: 'e.g. params.entryPeriod, stop.atrMult, stop.mode, timeframe, shortEnabled, takeProfit.enabled' },
        value: { type: 'string', description: 'new value as text: number, true/false, 4h/1d, ATR_DYNAMIC/FIXED_PERCENT/OFF' },
      } } },
    } } },
  },
};

const GENERATE_SCHEMA = { type: 'object', additionalProperties: false, required: ['notes', 'strategy'], properties: { notes: { type: 'string' }, strategy: STRATEGY_SCHEMA } };

// ---------- diagnostics sent to Claude (compact numbers only)
export function diagnose(result, { maxWorst = 8 } = {}) {
  const tr = result.trades || [];
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const group = (key) => {
    const g = {};
    for (const t of tr) { const k = key(t); const x = (g[k] ||= { n: 0, net: 0, wins: 0 }); x.n++; x.net += t.net; if (t.net > 0) x.wins++; }
    for (const x of Object.values(g)) { x.net = Math.round(x.net); x.winRate = r2(x.wins / x.n * 100); delete x.wins; }
    return g;
  };
  const monthly = {};
  let prev = result.capital;
  const byMonth = new Map();
  for (const p of result.equity || []) byMonth.set(new Date(p.t).toISOString().slice(0, 7), p.equity);
  for (const [m, v] of byMonth) { monthly[m] = r2((v / prev - 1) * 100); prev = v; }
  let streak = 0, maxStreak = 0;
  for (const t of [...tr].sort((a, b) => a.exitTime - b.exitTime)) { streak = t.net <= 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); }
  const bh = result.benchmark?.length ? r2((result.benchmark.at(-1).equity / result.capital - 1) * 100) : null;
  const m = result.metrics;
  return {
    strategy: result.strategy, timeframe: result.timeframe, symbols: result.symbols, settings: { params: result.params, stop: result.stop, takeProfit: result.takeProfit, shortEnabled: result.shortEnabled },
    metrics: { returnPct: r2(m.returnPct), maxDrawdownPct: r2(m.maxDrawdownPct), trades: m.trades, winRatePct: r2(m.winRatePct), profitFactor: r2(m.profitFactor), sharpe: r2(m.sharpe), avgHoldDays: r2(m.avgHoldDays), longestDrawdownDays: r2(m.longestDrawdownDays), maxLosingStreak: maxStreak },
    costs: { gross: Math.round(sum(tr, (t) => t.gross)), fees: Math.round(result.fees), funding: Math.round(result.funding) },
    buyHoldReturnPct: bh, bySymbol: group((t) => t.symbol), bySide: group((t) => t.side), byExitReason: group((t) => t.reason), monthlyReturnPct: monthly,
    worstTrades: [...tr].sort((a, b) => a.returnPct - b.returnPct).slice(0, maxWorst).map((t) => ({ symbol: t.symbol, side: t.side, entry: ymd(t.entryTime), exit: ymd(t.exitTime), returnPct: r2(t.returnPct), reason: t.reason, holdDays: r2((t.exitTime - t.entryTime) / DAY) })),
    openAtEnd: (result.openPositions || []).map((p) => ({ symbol: p.symbol, side: p.side, unrealized: Math.round(p.unrealized) })),
    notes: result.notes,
  };
}

const score = (m) => m.returnPct / Math.max(m.maxDrawdownPct, 2); // return per unit of drawdown
const brief = (r) => ({ returnPct: r2(r.metrics.returnPct), maxDrawdownPct: r2(r.metrics.maxDrawdownPct), trades: r.metrics.trades, winRatePct: r2(r.metrics.winRatePct), profitFactor: r2(r.metrics.profitFactor), sharpe: r2(r.metrics.sharpe), fees: Math.round(r.fees) });

// parameter bounds shown to Claude (validateStrategySettings enforces the real limits)
const EDITABLE = {
  TURTLE: 'params.entryPeriod(5-100), params.exitPeriod(3-60), params.smaFilter(50-300), timeframe(4h|1d), shortEnabled',
  ADX: 'params.adxPeriod(7-30), params.threshold(15-40), params.smaFilter(50-300), timeframe(4h|1d), shortEnabled',
  TSMOM: 'params.lookback(10-120), timeframe(4h|1d)',
  QQQ_EMA_TREND: 'params.fastEma, params.slowEma, params.sma200Filter', QQQ_TSMOM: 'params.lookback(63|126|189|252), params.sma200Filter',
  QQQ_SMA200: 'params.smaPeriod', QQQ_TURTLE_50_20: 'params.entryPeriod, params.exitPeriod',
};
const COMMON_EDIT = 'stop.mode(ATR_DYNAMIC|FIXED_PERCENT|OFF), stop.atrPeriod(5-50), stop.atrMult(1-6), stop.minPct(1-30), stop.maxPct(3-40), stop.fixedPct(1-30), takeProfit.enabled, takeProfit.pct(5-200)';
const ALLOWED_PATH = /^(timeframe|shortEnabled|params\.[A-Za-z0-9]+|stop\.(mode|atrPeriod|atrMult|minPct|maxPct|fixedPct)|takeProfit\.(enabled|pct))$/;

function applyChanges(cur, changes) {
  const next = structuredClone(cur);
  const applied = [];
  for (const { path: p, value } of changes || []) {
    if (!ALLOWED_PATH.test(p)) throw new Error(`허용되지 않는 항목: ${p}`);
    const keys = p.split('.');
    const parent = keys.length === 1 ? next : next[keys[0]];
    if (!parent || (keys.length === 2 && !(keys[1] in parent))) throw new Error(`없는 항목: ${p}`);
    const k = keys.at(-1);
    const old = parent[k];
    const v = String(value).trim();
    parent[k] = typeof old === 'boolean' ? /^(true|1|yes|on)$/i.test(v) : typeof old === 'number' ? Number(v) : v;
    applied.push({ path: p, from: old, to: parent[k] });
  }
  return { next, applied };
}

export class AiService {
  constructor({ store, backtest, controller, engine, log }) {
    this.store = store;
    this.backtest = backtest;
    this.controller = controller;
    this.engine = engine;
    this.log = log;
    this.claude = new ClaudeClient({ getKey: () => store.secrets.anthropicApiKey });
    this.job = { state: 'IDLE' };
    this.state = readJson(FILE, { analysis: null, improvements: {}, generated: [] });
    this.saved = readJson(SAVED, []);
  }

  status() {
    return { hasKey: this.claude.hasKey(), model: AI_MODEL, job: this.job, usage: this.claude.usage, analysis: this.state.analysis, improvements: this.state.improvements, generated: this.state.generated, saved: this.saved };
  }

  persist() { writeJson(FILE, this.state); }

  startJob(kind, fn) {
    if (this.job.state === 'RUNNING') return { ok: false, msg: `AI 작업 실행 중 (${this.job.kind})` };
    if (!this.claude.hasKey()) return { ok: false, msg: 'Claude API 키를 먼저 입력하세요' };
    this.job = { state: 'RUNNING', kind, progress: 0, msg: '시작', startedAt: Date.now() };
    const step = (msg, progress) => { this.job.msg = msg; if (progress != null) this.job.progress = progress; };
    fn(step).then(() => { this.job = { ...this.job, state: 'DONE', progress: 100, msg: '완료', finishedAt: Date.now() }; this.persist(); })
      .catch((e) => { this.job = { ...this.job, state: 'ERROR', msg: e.message, finishedAt: Date.now() }; this.log.error(`AI ${kind} failed: ${e.message}`, 'AI'); });
    return { ok: true };
  }

  async context(days, strategies = ALL_STRATEGIES.filter((s) => STRATEGY_CLASS[s] === 'CRYPTO')) {
    const config = structuredClone(this.store.config);
    const ctx = await this.backtest.loadData(config, days, this.backtest.needFor(config, strategies));
    return { config, ctx };
  }

  // ---------- 1) loss analysis of the last backtest
  analyze() {
    const bt = this.backtest.last;
    if (!bt?.results) return { ok: false, msg: '먼저 백테스트를 실행하세요' };
    return this.startJob('analyze', async (step) => {
      step('Claude가 백테스트 결과를 분석하는 중', 20);
      const payload = { period: `${ymd(bt.start)} ~ ${ymd(bt.end)}`, capitalPerStrategyKRW: bt.capital, compound: bt.compound, costs: bt.settings.general, strategies: bt.results.map((r) => diagnose(r)) };
      const r = await this.claude.json({
        system: SYSTEM, schema: ANALYSIS_SCHEMA, effort: 'high',
        messages: [{ role: 'user', content: `다음은 전략별 백테스트 결과 요약(JSON)입니다. 손실이 난 이유를 전략별로 분석하고, 근거 숫자를 들어 원인과 개선 방향을 제시하세요. 데이터가 부족한 전략은 NO_DATA로 표시하세요.\n\n${JSON.stringify(payload)}` }],
      });
      this.state.analysis = { at: Date.now(), backtestRanAt: bt.ranAt, period: payload.period, ...r.data };
      this.log.info(`AI loss analysis done (${r.usage.input_tokens} in / ${r.usage.output_tokens} out tokens)`, 'AI');
    });
  }

  // ---------- 2) self-improvement loop for one built-in strategy
  improve({ strategy, rounds = 2, days = this.backtest.last?.days || 365 }) {
    if (!ALL_STRATEGIES.includes(strategy)) return { ok: false, msg: 'unknown strategy' };
    rounds = Math.min(3, Math.max(1, Number(rounds) || 2));
    return this.startJob('improve', async (step) => {
      step('과거 데이터 준비', 5);
      const { config, ctx: ctx0 } = await this.context(days, [strategy]);
      // both timeframes available so a timeframe change can be tested
      const ctx = STRATEGY_CLASS[strategy] === 'CRYPTO' ? await this.backtest.loadData(config, days, symbolsForStrategy(strategy).flatMap((s) => [{ s, tf: '4h' }, { s, tf: '1d' }])) : ctx0;
      const capital = 1_000_000;
      const runWith = (cfg) => {
        const c = structuredClone(config);
        c.strategies[strategy] = cfg;
        return this.backtest.runSplit({ config: c, ctx, strategy, capital, compound: true });
      };
      const cur = config.strategies[strategy];
      const base = runWith(cur);
      const cutDay = ymd(base.cut);
      const history = [];
      const candidates = [];
      const messages = [];
      for (let round = 1; round <= rounds; round++) {
        step(`${round}/${rounds}회차 · Claude가 개선안 작성`, 10 + Math.round(((round - 1) / rounds) * 80));
        const prompt = round === 1
          ? `전략 ${strategy} (${META[strategy].label}, 종목 ${symbolsForStrategy(strategy).join(', ')}, 캔들 ${timeframeOf(strategy, config)})의 설정을 개선하세요.\n현재 설정: ${JSON.stringify({ timeframe: cur.timeframe, shortEnabled: cur.shortEnabled, params: cur.params, stop: cur.stop, takeProfit: cur.takeProfit })}\n변경 가능 항목: ${EDITABLE[strategy]}, ${COMMON_EDIT}\n학습 구간(${ymd(ctx.start)} ~ ${cutDay}) 결과:\n${JSON.stringify(diagnose(base.inSample))}\n\n가설이 서로 다른 개선 후보를 최대 3개 제안하세요. 각 후보의 변경은 1~3개 항목으로 제한하세요.`
          : `이전 후보들의 학습 구간 백테스트 결과입니다 (기준 설정: ${JSON.stringify(brief(base.inSample))}):\n${JSON.stringify(history.slice(-6))}\n\n결과를 보고 가설을 수정해 새 후보를 최대 3개 제안하세요. 이미 시험한 조합은 반복하지 마세요.`;
        messages.push({ role: 'user', content: prompt });
        const r = await this.claude.json({ system: SYSTEM, schema: IMPROVE_SCHEMA, messages, effort: 'high' });
        messages.push({ role: 'assistant', content: r.content });
        step(`${round}/${rounds}회차 · 후보 백테스트`, 10 + Math.round(((round - 0.5) / rounds) * 80));
        for (const c of (r.data.candidates || []).slice(0, 3)) {
          const cand = { id: `${strategy}-${Date.now().toString(36)}-${candidates.length}`, round, label: c.label, hypothesis: c.hypothesis, analysis: r.data.analysis };
          try {
            const { next, applied } = applyChanges(cur, c.changes);
            const valid = validateStrategySettings(strategy, next, cur);
            const res = runWith(valid);
            Object.assign(cand, { changes: applied, settings: valid, inSample: brief(res.inSample), outSample: brief(res.outSample), full: brief(res.full) });
            history.push({ label: c.label, changes: applied.map((a) => `${a.path}: ${a.from} -> ${a.to}`), inSample: cand.inSample });
          } catch (e) {
            cand.error = e.message;
            history.push({ label: c.label, error: e.message });
          }
          candidates.push(cand);
          await new Promise((res) => setImmediate(res));
        }
      }
      // overfitting guard: must beat the baseline in-sample AND not be worse out-of-sample
      const b = { inSample: brief(base.inSample), outSample: brief(base.outSample), full: brief(base.full) };
      for (const c of candidates) {
        if (c.error) { c.verdict = 'INVALID'; continue; }
        const isBetter = score(c.inSample) > score(b.inSample);
        const oosOk = c.outSample.returnPct >= b.outSample.returnPct - 0.5 && c.outSample.maxDrawdownPct <= b.outSample.maxDrawdownPct + 2;
        c.verdict = isBetter && oosOk ? 'PASSED' : isBetter ? 'OVERFIT' : 'WORSE';
        c.score = r2(score(c.full));
      }
      candidates.sort((x, y) => (y.verdict === 'PASSED') - (x.verdict === 'PASSED') || (y.score ?? -1e9) - (x.score ?? -1e9));
      this.state.improvements[strategy] = { at: Date.now(), strategy, days, split: { start: ctx.start, cut: base.cut, end: ctx.end }, baseline: { settings: cur, ...b }, candidates };
      this.log.info(`AI improve ${strategy}: ${candidates.filter((c) => c.verdict === 'PASSED').length}/${candidates.length} candidates passed the out-of-sample check`, 'AI');
    });
  }

  // apply an improvement candidate to the live settings (same validation as a manual save)
  applyCandidate({ strategy, id }) {
    const imp = this.state.improvements[strategy];
    const c = imp?.candidates.find((x) => x.id === id);
    if (!c || c.error) return { ok: false, msg: '후보를 찾을 수 없습니다' };
    const cur = this.store.config.strategies[strategy];
    // keep the user's current order amounts / enabled flag; take only the tested strategy settings
    const next = validateStrategySettings(strategy, { ...c.settings, amounts: cur.amounts, enabled: cur.enabled }, cur);
    const prev = structuredClone(cur);
    this.store.config.strategies[strategy] = next;
    this.controller?.onStrategyConfigChanged(strategy, prev, next);
    this.store.saveConfig();
    c.appliedAt = Date.now();
    this.persist();
    this.log.warn(`${strategy} settings changed from AI candidate "${c.label}": ${c.changes.map((a) => `${a.path} ${a.from}→${a.to}`).join(', ')}`, 'CONFIG_SAVED');
    this.engine?.evaluateAll('config saved');
    return { ok: true };
  }

  // ---------- 3) AI-generated strategy (rule format), backtested and refined
  generate({ idea = '', rounds = 2, days = this.backtest.last?.days || 365 }) {
    rounds = Math.min(3, Math.max(1, Number(rounds) || 2));
    return this.startJob('generate', async (step) => {
      step('과거 데이터 준비', 5);
      const { config, ctx } = await this.context(days);
      const existing = this.backtest.last?.results?.filter((r) => STRATEGY_CLASS[r.strategy] === 'CRYPTO').map((r) => ({ strategy: r.strategy, timeframe: r.timeframe, ...brief(r) })) || [];
      const messages = [];
      const versions = [];
      const cut = ctx.start + (ctx.end - ctx.start) * 0.7;
      for (let round = 1; round <= rounds; round++) {
        step(`${round}/${rounds}회차 · Claude가 전략 설계`, 10 + Math.round(((round - 1) / rounds) * 80));
        const prompt = round === 1
          ? `새 매매 전략을 규칙 형식으로 설계하세요.\n사용자 아이디어: ${idea ? JSON.stringify(idea) : '(없음 — 기존 전략과 겹치지 않는 견고한 전략을 제안)'}\n기존 전략 성과(참고): ${JSON.stringify(existing)}\n학습 구간: ${ymd(ctx.start)} ~ ${ymd(cut)} (그 이후는 검증용이라 보여주지 않습니다)\n규칙 형식: 지표는 id로 선언하고 규칙에서 kind=indicator, ref=id로 참조. HIGHEST/LOWEST는 현재 봉을 제외한 이전 N봉. MOMENTUM_PCT는 N봉 수익률(%). crossAbove/crossBelow는 직전 봉 대비 교차. offset은 몇 봉 전 값, mult는 배수(1=없음). 청산 규칙이 없으면 손절/익절로만 청산.`
          : `이전 버전의 학습 구간 백테스트 결과입니다:\n${JSON.stringify(versions.at(-1).feedback)}\n\n약점을 고쳐 전략 전체를 다시 작성하세요. 과최적화를 피하고 거래 수가 충분하도록 유지하세요.`;
        messages.push({ role: 'user', content: prompt });
        const r = await this.claude.json({ system: SYSTEM, schema: GENERATE_SCHEMA, messages, effort: 'high' });
        messages.push({ role: 'assistant', content: r.content });
        const v = { id: `ai-${Date.now().toString(36)}-${round}`, round, notes: r.data.notes, at: Date.now() };
        try {
          v.dsl = validateDsl(r.data.strategy);
          v.rules = describeRules(v.dsl);
          step(`${round}/${rounds}회차 · 백테스트`, 10 + Math.round(((round - 0.5) / rounds) * 80));
          await this.backtest.loadData(config, days, v.dsl.symbols.map((s) => ({ s, tf: v.dsl.timeframe })));
          const res = this.backtest.runSplit({ config, ctx: this.backtest.cache, custom: compileDsl(v.dsl), strategy: v.dsl.name, capital: 1_000_000, compound: true });
          Object.assign(v, { inSample: brief(res.inSample), outSample: brief(res.outSample), full: brief(res.full), trades: res.full.trades.slice(-200) });
          v.feedback = diagnose(res.inSample);
          // needs enough trades to mean anything, profit in both periods, and return per drawdown above 0.3 in-sample
          const why = [];
          if (res.inSample.metrics.trades < 5) why.push(`학습 구간 거래 ${res.inSample.metrics.trades}건 (5건 미만)`);
          if (!(res.inSample.metrics.returnPct > 0)) why.push('학습 구간 손실');
          if (!(res.outSample.metrics.returnPct > 0)) why.push('검증 구간 손실');
          if (score(res.inSample.metrics) < 0.3) why.push('학습 구간 수익 대비 낙폭 큼');
          v.verdict = why.length ? 'FAILED' : 'PASSED';
          v.verdictReason = why.join(', ');
        } catch (e) {
          v.error = e.message;
          v.feedback = { error: `규칙 검증 실패: ${e.message} — 형식을 고쳐 다시 작성하세요` };
        }
        versions.push(v);
      }
      const entry = { at: Date.now(), idea, days, split: { start: ctx.start, cut, end: ctx.end }, versions };
      this.state.generated = [entry, ...(this.state.generated || [])].slice(0, 10);
      this.log.info(`AI strategy generation done: ${versions.map((v) => v.error ? 'invalid' : `${v.dsl.name} IS ${v.inSample.returnPct}% / OOS ${v.outSample.returnPct}%`).join(' · ')}`, 'AI');
    });
  }

  saveGenerated({ id }) {
    const v = this.state.generated.flatMap((g) => g.versions).find((x) => x.id === id);
    if (!v || !v.dsl) return { ok: false, msg: '전략을 찾을 수 없습니다' };
    if (this.saved.some((s) => s.id === id)) return { ok: true };
    this.saved.unshift({ id, savedAt: Date.now(), dsl: v.dsl, rules: v.rules, inSample: v.inSample, outSample: v.outSample, full: v.full, notes: v.notes });
    writeJson(SAVED, this.saved);
    return { ok: true };
  }

  deleteSaved({ id }) {
    this.saved = this.saved.filter((s) => s.id !== id);
    writeJson(SAVED, this.saved);
    return { ok: true };
  }
}
