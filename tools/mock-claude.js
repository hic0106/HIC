// Local fake of the Claude Messages API (SSE streaming) for UI/dev testing of the AI features without a real key.
// Usage: node tools/mock-claude.js   then run the app with ANTHROPIC_BASE_URL=http://127.0.0.1:9902
import http from 'node:http';

const PORT = Number(process.env.MOCK_CLAUDE_PORT || 9902);
let n = 0;

function reply(body) {
  const schema = body.output_config?.format?.schema || {};
  const props = schema.properties || {};
  const text = JSON.stringify(body.messages?.at(-1)?.content || '');
  if (props.lossCauses || props.portfolioRisks) {
    return { overall: '(가짜 응답) 추세 추종 전략은 횡보 구간에서 반복 손절이 손실의 대부분입니다.', strategies: [
      { strategy: 'TURTLE', verdict: 'MIXED', summary: '4시간 돌파가 잦아 수수료 비중이 큽니다.', lossCauses: [{ cause: '횡보장 가짜 돌파', evidence: '전략 청산 거래의 과반이 손실', severity: 'HIGH' }, { cause: '수수료·펀딩 누적', evidence: '수수료가 매매손익의 상당 부분', severity: 'MEDIUM' }], suggestions: ['진입 기간 확대', '1일 캔들 검토'] },
      { strategy: 'QQQ_EMA_TREND', verdict: 'NO_DATA', summary: '데이터 부족', lossCauses: [], suggestions: [] },
    ], portfolioRisks: ['코인 3종목 상관관계가 높음'], nextSteps: ['자동 개선으로 진입 기간 검증'] };
  }
  if (props.candidates) {
    const turtle = text.includes('TURTLE');
    return { analysis: '(가짜 응답) 진입 기준을 느슨하게 해 잡음을 줄이는 방향을 시험합니다.', candidates: turtle
      ? [{ label: '진입 기간 30', hypothesis: '가짜 돌파 감소', changes: [{ path: 'params.entryPeriod', value: String(25 + (n % 3) * 5) }] }, { label: '1일 캔들', hypothesis: '잡음 감소', changes: [{ path: 'timeframe', value: '1d' }] }]
      : [{ label: '손절 넓히기', hypothesis: '조기 손절 감소', changes: [{ path: 'stop.atrMult', value: '3' }] }] };
  }
  if (props.strategy) {
    const o = (ref, kind = 'indicator') => ({ kind, ref, value: 0, offset: 0, mult: 1 });
    return { notes: '(가짜 응답) EMA 교차 + RSI 필터', strategy: {
      name: 'EMA_RSI_TREND', description: '빠른 EMA가 느린 EMA를 상향 돌파하고 RSI가 50 이상이면 롱, EMA가 다시 아래로 가면 청산.', rationale: '추세 초입 포착, 횡보장에서는 손실.', timeframe: '1d', symbols: ['BTCUSDT', 'ETHUSDT'],
      indicators: [{ id: 'fast', type: 'EMA', period: 12 + (n % 2) * 8, source: 'close' }, { id: 'slow', type: 'EMA', period: 50, source: 'close' }, { id: 'rsi', type: 'RSI', period: 14, source: 'close' }],
      long: { enabled: true, entry: { mode: 'all', rules: [{ left: o('fast'), op: 'crossAbove', right: o('slow') }, { left: o('rsi'), op: '>', right: { kind: 'value', ref: '', value: 50, offset: 0, mult: 1 } }] }, exit: { mode: 'any', rules: [{ left: o('fast'), op: '<', right: o('slow') }] } },
      short: { enabled: false, entry: { mode: 'all', rules: [] }, exit: { mode: 'all', rules: [] } },
      stop: { mode: 'ATR_DYNAMIC', atrPeriod: 14, atrMult: 3, minPct: 5, maxPct: 18, fixedPct: 8 }, takeProfit: { enabled: false, pct: 30 }, resetAfterStop: true,
    } };
  }
  return { ok: true };
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (req.url.split('?')[0] !== '/v1/messages') { res.writeHead(404); return res.end('{}'); }
    const body = JSON.parse(raw || '{}');
    n++;
    console.log(`mock claude #${n} model=${body.model} beta=${req.headers['anthropic-beta']} stream=${!!body.stream} fallbacks=${JSON.stringify(body.fallbacks)} effort=${body.output_config?.effort}`);
    const text = JSON.stringify(reply(body));
    const msg = { id: `msg_mock_${n}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ...msg, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { ...msg.usage, output_tokens: 400 } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: msg });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (let i = 0; i < text.length; i += 400) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 400) } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 400 } });
    ev('message_stop', {});
    res.end();
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Mock Claude API on http://127.0.0.1:${PORT}`));
