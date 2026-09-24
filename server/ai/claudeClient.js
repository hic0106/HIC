// Claude API client (official Anthropic SDK). JSON answers via structured outputs (output_config.format).
// Key: data/secrets.json › anthropicApiKey (entered in the UI), or the ANTHROPIC_API_KEY environment variable.
import Anthropic from '@anthropic-ai/sdk';

export const AI_MODEL = 'claude-opus-5';

export class ClaudeError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export class ClaudeClient {
  constructor({ getKey }) {
    this.getKey = getKey;
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  }

  hasKey() { return !!(this.getKey() || process.env.ANTHROPIC_API_KEY); }

  client() {
    const apiKey = this.getKey() || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new ClaudeError('Claude API 키가 설정되지 않았습니다', 'NO_KEY');
    if (!this._c || this._key !== apiKey) { this._c = new Anthropic({ apiKey, maxRetries: 2, timeout: 10 * 60_000 }); this._key = apiKey; }
    return this._c;
  }

  // system: stable instructions (cached); messages: conversation; schema: JSON schema of the answer
  async json({ system, messages, schema, effort = 'high', maxTokens = 32000 }) {
    const c = this.client();
    let res;
    try {
      const stream = c.beta.messages.stream({
        model: AI_MODEL,
        max_tokens: maxTokens,
        // on a safety-classifier decline the request is re-run server-side on the recommended fallback model
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort, format: { type: 'json_schema', schema } },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages,
      });
      res = await stream.finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new ClaudeError('Claude API 키가 올바르지 않습니다 (401)', 'AUTH');
      if (e instanceof Anthropic.PermissionDeniedError) throw new ClaudeError(`Claude API 권한 오류: ${e.message}`, 'PERMISSION');
      if (e instanceof Anthropic.RateLimitError) throw new ClaudeError('Claude API 사용량 한도 초과 — 잠시 후 다시 시도하세요', 'RATE_LIMIT');
      if (e instanceof Anthropic.BadRequestError) throw new ClaudeError(`Claude API 요청 오류: ${e.message}`, 'BAD_REQUEST');
      if (e instanceof Anthropic.APIError) throw new ClaudeError(`Claude API 오류 ${e.status ?? ''}: ${e.message}`, 'API');
      throw new ClaudeError(`Claude API 연결 실패: ${e.message}`, 'NETWORK');
    }
    const u = res.usage || {};
    this.usage.input += u.input_tokens || 0; this.usage.output += u.output_tokens || 0;
    this.usage.cacheRead += u.cache_read_input_tokens || 0; this.usage.cacheWrite += u.cache_creation_input_tokens || 0; this.usage.calls++;
    if (res.stop_reason === 'refusal') throw new ClaudeError(`Claude가 요청을 거절했습니다 (${res.stop_details?.category || 'unknown'})`, 'REFUSAL');
    if (res.stop_reason === 'max_tokens') throw new ClaudeError('응답이 너무 길어 잘렸습니다 (max_tokens)', 'MAX_TOKENS');
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    try {
      return { data: JSON.parse(text), content: res.content, model: res.model, usage: u };
    } catch {
      throw new ClaudeError('Claude 응답을 JSON으로 읽지 못했습니다', 'PARSE');
    }
  }
}
