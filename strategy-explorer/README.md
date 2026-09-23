# AI Strategy Explorer — Quant Research Laboratory

OHLCV(선택: quote_volume, number_of_trades, taker_buy_volume, funding_rate, open_interest, long_short_ratio)만 입력받아
반복되는 가격·거래량 행동을 스스로 찾고, 강타입 Strategy DSL 규칙으로 표현하고, 비용 포함 백테스트와
과최적화 방화벽으로 검증하는 **연구 전용** 프로그램이다.

> AI가 창의적일수록 검증기는 더 보수적이어야 한다.

## 0. 범위와 금지 사항

- 연구 전용이다. 주문, 계정 조회, API 키, 서명 요청 코드가 없다. Binance 제공자는 공개 시세 엔드포인트
  3개(`/fapi/v1/klines`, `/fapi/v1/fundingRate`, `/api/v3/klines`)만 허용하고 나머지 경로는 `PermissionError`.
- 저장소의 기존 자동매매 프로그램(`server/`, `public/`, `tools/`: Turtle, ADX, TSMOM, QQQ 전략, 주문 엔진,
  Self-Improving Controller, Paper/Live 계좌, 기존 Strategy DB)을 import·수정·참조하지 않는다.
  `tests/test_safety.py`가 이를 검사한다.
- 발견한 전략을 어디에도 자동 배포하지 않는다. 결과물은 사람이 검토할 recipe 파일뿐이다.
- Final Holdout 반복 조회, 실패 Trial 삭제, Trial 수 숨기기, 비용 없는 결과의 Winner 표시는 코드와 DB 트리거로 차단된다.

## 1. 설치와 실행

```bash
cd strategy-explorer
pip install -e ".[dev]"            # numpy, pandas, pytest (+ pyarrow: ".[parquet]", Claude: ".[llm]")

# 합성 데이터 데모: 숨겨진 squeeze -> breakout 행동을 재발견하는지 확인
strategy-explorer run --config configs/demo_synthetic.toml
# 귀무 테스트: 엣지가 없는 마팅게일 -> Winner 0개, holdout LOCKED 유지
strategy-explorer run --config configs/null_synthetic.toml

# 실제 데이터(공개 시세만, API 키 불필요)
strategy-explorer run --config configs/binance_btcusdt_4h.toml

# UI (기본 127.0.0.1:8765)
strategy-explorer ui

strategy-explorer list candidates
strategy-explorer export --candidate 3          # workspace/exports/<이름>_<해시>/ 에 recipe 파일 생성
strategy-explorer holdout status
```

설정 값은 `--set section.key=value`로 덮어쓴다(예: `--set search.max_trials=5000`). 설치 없이
`PYTHONPATH=src python -m strategy_explorer ...`로도 실행된다.

기타 명령: `compile --dsl "..."`(DSL 타입 검사), `grammar`(DSL 레퍼런스), `make-synthetic`, `fetch-binance`
(공개 klines + funding을 CSV로 저장), `data-report`(데이터 품질 보고서).

## 2. 파이프라인

```
DATA ─ 품질 검사 · 분할(TRAIN/VALIDATION/TEST/FINAL HOLDOUT) · 홀드아웃은 로드 직후 잘려 LOCKED 등록
  │
DISCOVERY (TRAIN만) ─ HMM 레짐 · 조건부 패턴 마이닝(BH-FDR) · matrix-profile 모티프 · shapelet
  │
SEARCH (예산 사전 확정, explore/exploit 분할) ─ Typed GP + NSGA-II · MCTS · LLM/템플릿 가설 · 패턴 기반 가설
  │     모든 Trial(실패·중복·무효 DSL 포함)을 append-only ledger에 기록. 탐색 중 OOS 지표는 봉인.
SELECTION ─ 검증 전 풀(train 기준) → VALIDATION+TEST 다목적 NSGA-II 선택
  │
VALIDATION ─ look-ahead 절단 테스트 · walk-forward(폴드별 재적합) · 파라미터 민감도 · 스트레스 · DSR · PBO
  │           · 집중도 · 레짐별 성과 · 교차 자산 · 알려진 전략 지문(NOVEL/KNOWN_LIKE/HYBRID) → Gate
FINAL HOLDOUT ─ 모든 게이트 통과 후보(RESEARCH_WINNER)만, 단 한 번 평가 후 CONSUMED
  │
EXPORT ─ strategy_recipe.json 외 7개 파일
```

## 3. 데이터

- 제공자: `synthetic`, `csv`, `parquet`, `binance`(공개 시세). `DataProvider` 추상 클래스로 확장한다.
- CSV 열: `timestamp, open, high, low, close[, volume, quote_volume, number_of_trades, taker_buy_volume,
  funding_rate, open_interest, long_short_ratio]`. 타임스탬프는 s/ms/us/ns 정수 또는 ISO-8601(UTC).
  경로가 디렉터리면 `{ASSET}_{TIMEFRAME}.csv`, 옆의 `.meta.json`에 `asset_class` 지정 가능.
- 정렬·중복 제거·OHLC 보정·결측 구간 보고. 재현성 해시(`data_version`)는 정제된 배열 기준.
- 멀티 타임프레임(5m/15m/1h/4h/1d): 상위 봉은 UTC 버킷으로 리샘플하고 **완결된 봉만** 사용, 상위 봉의 종가 시각
  이후 기준 봉에만 정렬한다(look-ahead 없음).

## 4. Strategy DSL

강타입 + 단위(차원) 검사. `SERIES[unit]`, `BOOLEAN`, `FLOAT`, `SIGNAL`과 리터럴 `WINDOW`, `QUANT`, `TF`,
`REGIME`, `PATTERN`. 단위는 `price, volume, qvolume, trades, oi, log_*, dimless`.
상수와 비교할 수 있는 것은 `dimless` 시리즈뿐이다(스케일 불변). `GT(close, 50000)`은 타입 오류.

```
DIRECTION: long
LONG_ENTRY: ONSET(AND(GT(volume_return(1), 1.271), GT(close_location_in_range(), 0.9883)))
LONG_EXIT: LT(slope(log(close), 5), 0)
MAX_HOLD: 6
STOP_LOSS: 0.04
```

- 섹션: `DIRECTION, LONG_ENTRY, LONG_EXIT, SHORT_ENTRY, SHORT_EXIT, MAX_HOLD, STOP_LOSS, TAKE_PROFIT`.
- `WHEN`(레벨), `ONSET`(상승 에지) 신호. NaN은 unknown이며 신호를 내지 않는다(3값 논리).
- 정규화: AND/OR 평탄화·정렬·중복 제거, `LT(a,b)→GT(b,a)` 등. 전략 해시 = 정규화 텍스트의 sha256.
- 상위 타임프레임 `tf("1d", x)`, 레짐 `regime_is(k)`/`regime_prob(k)`(인과적 필터 확률), 발견된 패턴
  `pattern_distance("M1")`. 모든 연산자는 인과적이다. 전체 목록: `strategy-explorer grammar`.

## 5. 체결·비용 모델

- 신호는 봉 t 종가에서 계산, 체결은 t+1(+지연) **시가**. 슬리피지는 체결가에 적용, 수수료는 편도마다 부과.
- 펀딩: `none | constant | series`(Binance 과거 펀딩: 양수면 롱이 지불, 숏이 수취).
- 청산 조건은 체결 봉 종가부터 평가, `MAX_HOLD`/`STOP_LOSS`/`TAKE_PROFIT`은 종가 기준, 구간 끝에서 강제 청산,
  각 구간은 무포지션에서 시작. 비용 0 모델의 결과는 Gate에서 무조건 REJECTED.

## 6. 탐색

- **Trial 예산**: `search.max_trials` 사전 확정, `explore_fraction`(기본 0.6)으로 구조 변경(explore)과
  파라미터 조정(exploit) 상한을 엄격히 분리. 무효 DSL은 기록하되 예산에서 제외.
- **Typed GP**: 타입 보존 변이(subtree/point/window/threshold/조건 추가·삭제/hoist/청산 변경/방향/교차).
  임계값은 TRAIN 분위수에서만 샘플. NSGA-II(제약 지배) 목적: sortino, consistency, max_drawdown, complexity.
- **MCTS**: 타입이 보장된 편집 연산 트리에서 UCT + progressive widening.
- **Novelty**: 행동 벡터(포지션·수익 블록) 코사인 유사도, 동일 행동 해시 중복 제거, near-duplicate 패널티.
- **알려진 전략 지문**: RSI, SMA/EMA 교차, MACD, Donchian, Bollinger, TSMOM, ADX, Stochastic, Buy&Hold 등의
  기준 구현과 포지션 유사도 + 구조 매칭 → `NOVEL / KNOWN_LIKE / HYBRID`.
- **연구 메모리**: 실패한 계열(비용 후 손실, 엣지 없음, 불안정)을 기록해 다음 실험에서 패널티.
  LLM에는 TRAIN 요약만 전달한다.

## 7. 검증 방화벽과 Gate

| 검사 | 기본 기준 |
|---|---|
| positive_oos_expectation (critical) | VALIDATION+TEST 기대값 > 0 그리고 TEST 수익 > 0 |
| minimum_trade_count | OOS ≥ 15, TRAIN ≥ 20 |
| acceptable_drawdown | OOS MDD ≥ −35% |
| transaction_cost_survival (critical) | 수수료×2, 슬리피지×2, 둘 다×2에서 수익 > 0 |
| stress_survival | + 지연 1봉, 불리한 진입 5bps > 0, 10% 거래 누락 MC에서 80% 이상 양수 |
| parameter_stability | 파라미터 이웃 변형의 60% 이상 양수, 중앙 Sortino ≥ 원본의 50%, TEST에서 50% 이상 양수 |
| walk_forward_survival | anchored 5폴드(폴드별 재적합): 60% 이상 양수, 누적 OOS 수익 > 0 |
| deflated_sharpe | DSR ≥ 0.95 |
| pbo | 실험 수준 CSCV PBO ≤ 0.30 |
| no_lookahead (critical) | 데이터 절단 후 신호 동일 |
| no_single_trade/month_dominance | 최대 거래·월 비중 ≤ 50% (30/40/50% 경고) |
| costs_modelled (critical) | 수수료 또는 슬리피지 > 0 |

- 상태: 전부 통과 `RESEARCH_WINNER`, critical 실패 또는 통과율 70% 미만 `REJECTED`, 그 외 `PROMISING`.
- **DSR**(Bailey & López de Prado 2014): TRAIN 구간 per-bar SR, N = 행동 군집으로 센 유효 시행 수
  (raw N도 보고), 왜도·첨도 보정. 기준 SR0의 분산 V[SR]은 기본 `sampling`(귀무가설 하 SR 추정량 분산
  ≈ 1/(T−1))이다. 논문식 `cross_sectional`(시행 간 SR 분산)은 탐색이 같은 엣지를 여러 번 찾거나 비용으로
  손실 나는 시행이 많을수록 SR0가 올라가 실제 엣지도 통과할 수 없어서 진단값으로 함께 기록한다.
  더 엄격하게 하려면 `dsr.variance = "max"` 또는 `"cross_sectional"`.
- **PBO**: 상위 60개 시행의 일별 수익 행렬에 CSCV(16블록). 후보별 파라미터 이웃 PBO는 진단값.
- 교차 자산: 같은 recipe를 다른 자산에(홀드아웃 시작 이전 구간만) 적용 → `Asset-specific / Crypto-general /
  Cross-asset`.

## 8. Final Holdout Vault

- 데이터셋 키(자산:타임프레임)와 구간 해시로 등록, 실행 중 `LOCKED`. 탐색·선택·검증 코드는 홀드아웃이 잘린
  데이터만 받으며 접근 시 `PermissionError`.
- `RESEARCH_WINNER`만 평가, **한 트랜잭션**에서 결과 저장과 `CONSUMED` 전환. DB 트리거가 소비된 구간의 재잠금,
  등록·평가 기록의 삭제, 평가 결과 수정을 막는다. 같은 구간 재평가 요청은 `HoldoutConsumedError`.
- 전략을 수정하면 같은 홀드아웃을 다시 쓸 수 없다. `holdout.mode = "prospective"`로 소비된 구간 이후의
  새 데이터를 기다린다(`AWAITING_DATA`).

## 9. Trial Ledger와 재현성

- SQLite(WAL). trials 테이블은 DELETE/UPDATE 금지 트리거, holdout 평가는 불변, 후보는 삭제 금지.
- 실험마다 `random_seed, data_version, code_version(패키지·git 커밋·소스 해시), config_hash, trial_budget,
  cost_model`을 기록. 난수는 (seed, 용도 키)로 파생되어 워커 수와 무관하게 결과가 같다(테스트로 검증).

## 10. LLM (선택)

기본은 `llm.provider = "offline"`(결정적 템플릿 가설 생성기). Claude를 쓰려면:

```bash
pip install -e ".[llm]"
export ANTHROPIC_API_KEY=...
strategy-explorer run --config configs/demo_synthetic.toml --set llm.provider=anthropic
```

- 모델 기본값 `claude-opus-5`, adaptive thinking, `output_config`(effort + JSON schema 구조화 출력),
  시스템 프롬프트 캐시, 서버측 거절 fallback(`fallbacks="default"`, beta `server-side-fallback-2026-07-01`,
  `llm.server_side_fallbacks = false`로 끔).
- LLM은 **제안자**일 뿐이다. 제안은 DSL로 컴파일·타입 검사되고 같은 예산·ledger·검증을 거친다. LLM이 보는 정보는
  TRAIN 통계와 TRAIN 요약뿐(VALIDATION/TEST/HOLDOUT 비노출). 호출은 `llm_calls`에 기록되고 `replay`로 재현된다.
- 역할: 가설 생성, 반성 루프(`reflection_every` 세대마다), 선택: 차트 이미지 가설(`vision`), MCTS 확장,
  후보 설명문.

## 11. UI

`strategy-explorer ui` → http://127.0.0.1:8765. 탭: DATA, PATTERN LAB, STRATEGY DISCOVERY, EXPERIMENTS,
CANDIDATES, VALIDATION, RESEARCH MEMORY. 후보 카드, 설명, SHOW EXAMPLES(좋은/나쁜/거짓 신호 거래 차트),
EXPORT STRATEGY RECIPE. 서버는 Host 헤더를 검사하고(DNS rebinding 방어), POST는 같은 출처의 JSON만 받는다.

## 12. Export 파일

`strategy_recipe.json`, `strategy_description.md`, `strategy_report.md`, `validation_report.json`,
`equity_curve.csv`, `trades.csv`, `trial_lineage.json`, `signal_check.csv`(다른 구현과 신호 대조용).
recipe에는 `research_only: true`, 체결 규칙, 필요 피처, 비용 모델, 검증 요약, 시행 수, 재현 정보가 들어간다.

## 13. 설정 파일

`configs/`의 TOML. 주요 섹션: `experiment, data, split, costs, costs_by_asset_class, backtest, search, gp, mcts,
selection, patterns, regimes, llm, memory, walk_forward, sensitivity, stress, pbo, gate, dsr, novelty,
cross_asset, holdout, export`. 기본값은 `src/strategy_explorer/config.py`의 `DEFAULTS`.

## 14. 테스트

```bash
python -m pytest tests          # 69개
```

귀무 과정에서 Winner가 나오지 않음, 심어둔 행동의 재발견과 기본 게이트 통과, 홀드아웃 1회 평가·재사용 거부,
ledger append-only, 워커 수 무관 재현성, look-ahead 절단 테스트, DSR/PBO/BH 수치 검증, HMM 순전파의 인과성,
패턴 마이닝의 귀무 오발견률, LLM 정보 흐름(TRAIN 전용)과 요청 형태, UI API·경로 조작·교차 출처 요청 거부,
주문/계정 코드 부재.

## 15. 한계

- 백테스트는 봉 단위다. 봉 내부 경로, 호가 깊이, 부분 체결, 거래소 장애는 모델링하지 않는다.
  손절·익절은 종가 기준이다.
- 통계 검정(DSR, PBO, BH)은 가정(정상성, 근사 독립)에 의존한다. 게이트 통과는 미래 수익을 보장하지 않는다.
- 합성 데이터 결과는 파이프라인 동작 확인용이다.
- V1은 강화학습을 핵심에 두지 않는다.
