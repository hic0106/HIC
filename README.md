# HIC Futures Terminal

Binance USDT-M Perpetual Futures 기반 멀티자산·멀티전략 자동매매 트레이딩 터미널.

```
CRYPTO  BTCUSDT / ETHUSDT / XRPUSDT  → Turtle 20/10 (4H) · ADX 14/25 (4H) · TSMOM 30d (1D)
TRADFI  QQQUSDT (Invesco QQQ 지수 perpetual) → EMA 50/150 · TSMOM 126 · SMA200(옵션) · Turtle 50/20(옵션)   (미국 정규장 세션)
SELF-IMPROVING CONTROLLER → 두 자산군의 주문 배수만 조절
EXECUTION → Binance Futures
```

| 전략 | 방향 | 진입 | 청산 | Emergency Stop (기본) |
|---|---|---|---|---|
| TURTLE 20/10 (4H) | Long + Short | 종가 > 이전 20봉 고가 / 종가 < 이전 20봉 저가 **AND** 종가 < SMA200 | Long: 종가 < 이전 10봉 저가, Short: 종가 > 이전 10봉 고가 | ATR(20)×2.0, 8~18% |
| ADX Trend (4H) | Long + Short | ADX>25 & +DI>-DI / ADX>25 & -DI>+DI & 종가<SMA200 | Long: ADX<=25 or -DI>=+DI, Short: ADX<=25 or +DI>=-DI | ATR(14)×2.0, 6~15% |
| TSMOM 30D (1D) | Long + Cash | 30일 누적 로그수익률 > 0 | 30일 모멘텀 <= 0 | ATR(20)×3.0, 10~22% |

- 채널 계산에서 현재 봉은 제외합니다. 신호는 전략별 Timeframe의 **마감된 캔들**로만 평가합니다: Turtle·ADX = 4H (KST 01·05·09·13·17·21시 마감), TSMOM = 1D (UTC 00:00 = KST 09:00), QQQ = 미국 정규장 마감(America/New_York). 아래 [StrategyScheduler](#strategyscheduler) 참고.
- Emergency Stop은 실시간 가격으로 감시하며, 전략 Exit와 Stop 중 먼저 발생한 조건으로 청산합니다.
- 고정 Take Profit은 기본 OFF (전략별로 켤 수 있음).

## 실행

Node.js 20 이상 필요.

```bash
npm install
npm start
```

Windows에서는 `start.bat`을 더블클릭하면 서버 실행과 브라우저 열기를 한 번에 합니다(창을 닫으면 종료). 바탕화면 바로가기 만들기(PowerShell):

```powershell
$s = (New-Object -ComObject WScript.Shell).CreateShortcut("$([Environment]::GetFolderPath('Desktop'))\HIC Terminal.lnk")
$s.TargetPath = "$HOME\HIC\start.bat"; $s.WorkingDirectory = "$HOME\HIC"; $s.Save()
```

브라우저에서 `http://127.0.0.1:8420` 접속 (1920×1080 기준 레이아웃). 서버는 기본적으로 localhost에만 바인딩됩니다. 포트 변경: `PORT=9000 npm start`.

프로그램을 실행하면 항상 **STOPPED** 상태로 시작합니다. 상단 `▶ START`를 눌러야 전략이 실행됩니다. 처음 모드는 **PAPER**입니다.

### Binance API 키 설정 (LIVE)

1. Binance → API Management에서 키 생성. **Enable Futures**만 허용, **Withdrawals 비활성**, **IP 제한** 권장.
2. Binance Futures 설정에서 Position Mode를 **Hedge Mode**로 변경 (같은 코인에서 전략별 Long/Short를 분리하기 위해 필수). 터미널의 API KEY 창에서 `Enable Hedge Mode` 버튼으로도 변경할 수 있습니다.
3. 터미널 우측 상단 `⚙ API KEY` → API Key / Secret 입력 → Save → Test Connection.
4. 상단 모드 스위치에서 `LIVE` 선택(LIVE 입력 확인) → `▶ START`(LIVE 입력 확인).

키는 `data/secrets.json`(권한 600)에만 저장되고 브라우저로 다시 전송되지 않습니다. `data/` 폴더는 git에 포함되지 않습니다.
Testnet을 체크하면 주문이 `demo-fapi.binance.com`으로 전송됩니다(시장 데이터는 항상 메인넷 공개 데이터 사용).

## 화면 구성

- **상단**: Total Equity / Today's PnL / Total Return(가장 크게), Available, Invested, Total PnL, Long·Short·Net Exposure, Market Data·Binance API·Bot 상태, 마지막 데이터 시각, PAPER/LIVE 배지, START / STOP ALL BOTS / CLOSE ALL POSITIONS.
- **왼쪽**: Watchlist(가격, 24h 등락, 전략별 상태) + 코인별 Exposure.
- **중앙**: 캔들차트(거래량, 크로스헤어, 줌/팬, 현재가), 전략 포지션 Entry/Stop 라인과 PnL, 거래 마커, SMA200, 20D/10D 채널 — 전략별 On/Off. 아래 전략·계좌 요약.
- **오른쪽**: 선택 종목 시장정보, 전략 상태 패널, Order Book.
- **하단 탭**: Positions / Orders / Trades / Strategies(운영 설정) / Scheduler(전략별 평가 일정 + Signal Log) / Controller / System Log.
- **PORTFOLIO 화면** (상단 `PORTFOLIO` 버튼): 실제 계좌와 전략별 자산 상태. 아래 [Portfolio](#portfolio) 참고.

## 운영 규칙

- 주문금액은 **고정 USDT(포지션 명목금액)**. 전략별 Long/Short 금액, PAPER/LIVE 금액을 따로 저장합니다. 설정은 `Save`를 눌러야 적용되고 `data/config.json`에 저장됩니다.
- 수량은 Binance `stepSize`로 **내림** 처리합니다(설정 금액을 초과하지 않음). `minQty`, `MIN_NOTIONAL` 미달이면 주문을 Skip합니다.
- 잔고 < (주문금액 / 레버리지) × (1 + Balance Buffer) + 예상 수수료 이면 금액을 줄이지 않고 **Skip + 로그**(INSUFFICIENT_BALANCE).
- Strategy + Symbol 조합당 포지션 1개. 보유 중 같은 방향 신호는 무시, 다른 전략의 같은 코인 보유는 허용.
- ADX / TSMOM은 Stop·수동 청산 후 조건이 한 번 false로 돌아온 뒤에만 재진입합니다(Stop 직후 즉시 재진입 방지). Turtle은 새 돌파 종가가 나오면 재진입합니다.
- 기본 레버리지 1x. 봇 정지 상태에서만 변경 가능하며, 프로그램이 임의로 올리지 않습니다.
- PnL에 수수료(LIVE는 실제 체결 수수료 조회), Funding Fee(마크가격·펀딩비로 포지션별 계산), Slippage(PAPER 체결가)를 반영합니다.

### 주문 전 확인 항목

Bot Running, Strategy Enabled, Short Enabled, 모드, 거래소 연결, 데이터 지연, 심볼 TRADING 상태, 기존 포지션/대기 주문, 주문금액, minQty/stepSize, MIN_NOTIONAL, 잔고, Hedge Mode(positionSide), 현재 레버리지.

### 중복 주문 방지

- 주문마다 고유 `newClientOrderId`를 만들고 **전송 전에** 상태 파일에 기록합니다.
- 타임아웃/네트워크 오류/5xx처럼 결과를 알 수 없으면 해당 슬롯을 `UNKNOWN`으로 잠그고 **재전송하지 않습니다**. 10초마다 clientOrderId로 주문을 조회해 체결이면 반영, 미존재가 반복 확인되면 미체결로 처리합니다. 재시작 시에도 동일하게 복구합니다.
- 거래소 포지션 수량과 봇 장부가 다르면 `POSITION_MISMATCH` 경고를 남깁니다.

### STOP ALL BOTS / CLOSE ALL POSITIONS

- STOP ALL BOTS: 전략 실행과 신규 진입 중단. 기존 포지션은 청산하지 않습니다. Emergency Stop은 기본적으로 계속 동작합니다(Strategies › General › `Emergency Stops when STOPPED`로 끌 수 있음).
- CLOSE ALL POSITIONS: 현재 모드의 봇 포지션 전체를 시장가 청산(Exit Reason `EMERGENCY_CLOSE`), `CLOSE ALL` 입력 확인 필요.

### Binance Stop 주문 (LIVE, 기본 ON)

- LIVE 진입 체결 직후 해당 전략 포지션의 수량·Stop 가격으로 Binance에 `STOP_MARKET`(Algo Order API `/fapi/v1/algoOrder`, Hedge Mode `positionSide`)을 등록합니다. **PC나 프로그램이 꺼져 있어도 Binance가 손절을 실행합니다.**
- 봇이 청산(전략 Exit, 수동, CLOSE ALL, Take Profit)할 때는 Binance Stop을 **먼저 취소**한 뒤 시장가 주문을 보냅니다. 취소 결과가 불확실하면 청산을 보류하고 재시도합니다(이중 청산 방지).
- 프로그램이 꺼진 동안 Stop이 체결되었다면, 재시작 후 동기화에서 체결 내역(같은 clientOrderId)을 찾아 `ATR_STOP` 거래로 기록합니다.
- 10초마다 Binance의 열린 Algo 주문과 비교합니다. Stop이 사라졌으면(앱에서 수동 취소 등) 거래소 포지션 수량을 확인한 뒤 다시 등록합니다.
- 봇 내부 Stop 감시는 백업으로 유지됩니다. Binance Stop이 살아 있으면 가격 이탈 후 15초 동안 Binance 체결을 기다리고, 그래도 포지션이 남아 있으면 봇이 직접 청산합니다.
- Trigger 가격 기준: `CONTRACT_PRICE`(최근 체결가, 기본) 또는 `MARK_PRICE` — Strategies › General에서 변경.
- Binance Stop은 STOP ALL BOTS 후에도 거래소에 남아 있습니다.

## QQQUSDT (TradFi index perpetual)

- Binance QQQUSDT(2026-04-06 상장)를 주문 대상으로 씁니다. 종목 메타데이터: `asset_class=TRADFI_INDEX`, `market_type=USDM_PERPETUAL`, `underlying=Invesco QQQ Trust`.
- **LONG / CASH 전용**입니다. QQQ 전략은 Short 신호를 만들지 않고, 설정에서도 Short를 켤 수 없습니다. ADX는 QQQ에 적용하지 않습니다.

| 전략 | 기본 | 진입 | 청산 |
|---|---|---|---|
| QQQ_EMA_TREND | ON, 300 USDT | EMA50 > EMA150 | EMA50 <= EMA150 → CASH |
| QQQ_TSMOM | ON, 250 USDT | 126세션 누적 로그수익률 > 0 (63/126/189/252 선택) | <= 0 → CASH |
| QQQ_SMA200 | OFF | 종가 > SMA200 | 종가 <= SMA200 |
| QQQ_TURTLE_50_20 | OFF | 종가 > 이전 50세션 고가 | 종가 < 이전 20세션 저가 |

- EMA / TSMOM에는 선택 사항으로 SMA200 진입 필터(기본 OFF)가 있습니다.
- Emergency Stop 기본: ATR(20) × 2.5, 5~12%. 고정 Take Profit 기본 OFF. 레버리지는 Crypto와 별도(`Leverage TradFi`, 기본 1x)입니다.
- **신호 시간**: QQQ 전략은 UTC 일봉이 아니라 **미국 정규장(America/New_York 09:30–16:00, 조기폐장 13:00) 종가 기준 세션 일봉**으로 계산합니다. 세션 일봉은 Binance QQQUSDT 30분봉 중 정규장 시간만 모아 만들고, 정규장 종료 후 한 번만 평가합니다. 장외 가격 변동은 신호에 쓰지 않지만 Stop은 24시간 동작합니다. NYSE 휴장일·조기폐장은 `config.json`의 `general.usCalendar`에 있습니다(2026–2027 수록, 이후 연도는 추가 필요).
- **데이터 한계**: Binance QQQUSDT 자체 이력은 2026-04 이후뿐이라(`nativeHistory: LIMITED`) EMA150(152세션), TSMOM 126(128세션), SMA200(202세션)은 세션이 충분히 쌓일 때까지 "insufficient session history"로 대기합니다. ETF 과거 데이터를 섞지 않습니다. `SignalDataProvider` / `ExecutionDataProvider` 구조로 향후 QQQ ETF 세션 데이터로 교체할 수 있습니다.
- Funding은 Crypto와 같은 엔진으로 포지션별 기록합니다(Trading PnL / Fee / Funding / Net PnL).
- 화면: Watchlist CRYPTO / TRADFI 구분, `US OPEN/CLOSED` 표시, QQQ 전략 패널(LONG/CASH, SMA200 ABOVE/BELOW), `US 1D` 세션 차트, 자산군별 Exposure·PnL.
- QQQ 데이터 로드에 실패하거나 거래소에 종목이 없으면 QQQ만 `UNAVAILABLE`이 되고 Crypto 거래는 계속됩니다.

## Self-Improving Controller (V1)

전략 위에 얹은 관리 계층입니다. **매매 신호를 만들지 않고**, 전략별·방향별로 신규 진입 주문금액의 배수만 정합니다.

```
Market Data → Turtle / ADX / TSMOM (기존 신호) → Controller (배수) → 기존 Execution Engine → Binance / Paper
```

- 실제 주문금액 = **Base Order Amount × Multiplier**. Base 금액은 Controller가 수정하지 않습니다.
- Multiplier 고정 단계: PAUSED 0 · REDUCED 0.5 · CAUTIOUS 0.75 · NORMAL 1.0 · BOOSTED 1.25 (최대 1.25, 설정으로도 올릴 수 없음). 선택 사항으로 전략·방향별 최대 주문금액(USDT) 상한을 둘 수 있습니다.
- Long / Short를 별도로 평가합니다(예: Turtle Long NORMAL, Turtle Short REDUCED).
- 신규 진입에만 적용합니다. 청산, Stop, 레버리지, 전략 파라미터, Enabled 여부는 건드리지 않습니다.

### 모드

| 모드 | PAPER 주문 | LIVE 주문 |
|---|---|---|
| OFF | 1.00× | 1.00× |
| **OBSERVE (기본)** | 1.00× (추천만 표시) | 1.00× |
| PAPER AUTO | 추천 자동 적용 | 1.00× |
| LIVE APPROVAL | 추천 자동 적용 | 사용자가 APPROVE한 변경만 적용 |

`DISABLE CONTROLLER` 버튼은 모드를 OFF로 바꾸고 모든 배수를 1.00×로 되돌립니다. 전략은 계속 동작합니다. Controller 계산 오류 시 FAIL SAFE로 1.00×를 사용합니다.

### 데이터와 평가

- **Shadow Portfolio**: 기존 전략 신호(`strategies.evaluate`)와 같은 ATR Stop 규칙으로 가상 포지션을 운용합니다(주문 없음). 1.00× Baseline과 Controller 배수 적용 결과를 동시에 기록해 Controller가 실제로 도움이 되는지 비교합니다.
- 성과 평가는 Baseline 가상 장부의 **일별 Mark-to-Market 곡선**을 씁니다. Controller 배수에 왜곡되지 않고, PAUSED 기간에도 데이터가 쌓여 회복을 판단할 수 있습니다.
- 지표: 30/90/180일 수익률(거래가 적으면 365일), 현재/최대 Drawdown, Downside Volatility, Sharpe, Sortino, Profit Factor, 승률, 평균 손익, 거래 수, 노출일 비율, 연속 손실, 마지막 거래 후 경과일, 30일 구간 일관성.
- Score = Return·Drawdown·Sharpe/Sortino·Consistency 정규화 점수의 가중합(가중치 설정 가능).
- Guard: Drawdown 10%↑ BOOST 금지, 15%↑ 최대 REDUCED, 25%↑ PAUSED · 연속 손실 3회 BOOST 금지 · 30일 수익률이 음수면 배수 증가 금지 · 한 번에 한 단계만 상향 · 데이터 90일 미만은 NORMAL 유지.
- Market Regime(BTC, 규칙 기반): BULL TREND / BEAR TREND / SIDEWAYS / HIGH VOLATILITY / NORMAL. HIGH VOLATILITY는 최대 0.75×, SIDEWAYS는 BOOST 금지, Long BOOST는 BULL/NORMAL에서만, Short BOOST는 BEAR에서만 허용합니다.
- 전략 간 수익률 상관계수와 코인별 Gross Exposure를 계산해 표시합니다. 상관 Guard는 기본 OFF, 코인 노출이 Equity의 50%를 넘으면 해당 전략 BOOST를 막습니다.
- 재평가 주기 기본 7일(1/7/14/30일 선택). 모든 결정은 사유와 함께 `data/controller-history.jsonl`에 저장됩니다.
- 파라미터 자동 최적화는 V1에 없습니다(`ParameterCandidateManager`는 비활성 자리표시자).
- 자산군 분리: Crypto와 TradFi(QQQ)는 Regime(BTC / QQQ 세션)과 성과를 따로 평가하며 서로 순위를 비교하지 않습니다. QQQ 전략도 BOOSTED~PAUSED 상태를 가지지만 EMA 50/150, TSMOM 126은 고정입니다.
- **설정 변경 기록**: Strategies에서 저장할 때마다 변경 내용을 History(`CONFIG_CHANGE`)와 Shadow 차트 마커로 남깁니다. 진입/청산/Stop 파라미터가 바뀌면 기본적으로 변경 이후 데이터만으로 평가하고(`resetHistoryOnParamChange`), 표에 변경 후 수익률과 변경 전 같은 기간 수익률을 나란히 표시합니다. 주문금액만 바꾼 경우는 평가 데이터를 유지합니다.

## StrategyScheduler

전략 인스턴스(전략 × 종목 × Timeframe)별로 **캔들 마감 이벤트**(Binance kline `x=true`, QQQ는 미국 정규장 세션 마감)에 한 번씩 평가합니다. 시계(09:00 등)는 UI 표시와 누락 대비 fallback에만 씁니다.

| 전략 | Timeframe | 평가 시점 |
|---|---|---|
| TURTLE / ADX | 4H | Binance 4H 캔들 마감 (UTC 00·04·08·12·16·20시) |
| TSMOM | 1D | Binance 일봉 마감 (UTC 00:00) |
| QQQ 전략 | US_SESSION | NYSE 정규장 마감 16:00 ET (조기폐장 13:00, 휴장일 제외, DST 자동) — 장외 시간 QQQUSDT 가격 변화로는 재계산하지 않음. 실행은 Binance 24/7 |

- Crypto 전략 Timeframe은 Strategies 탭 `Signal Timeframe`(4H / 1D)에서 바꿀 수 있습니다. 전략 규칙 자체는 동일합니다.
- **중복 방지**: `(strategy, symbol, timeframe, candle close time)` 키를 `data/state.json`(모드별 `scheduler`)에 저장. 같은 캔들은 재시작 후에도 다시 평가·주문하지 않습니다.
- **재시작 / 늦은 START**: 마지막 평가 캔들과 최신 마감 캔들을 비교해 **최신 캔들 1개만** 평가합니다(지표는 전체 히스토리로 재계산). 청산 신호는 늦어도 실행하고, 신규 진입은 캔들 마감 후 `entryGraceMin`(4H 30분, 1D·US_SESSION 120분, `config.json › general.scheduler`) 이내일 때만 실행합니다. 초과 시 `STALE_SIGNAL_SKIPPED` 로그 후 다음 캔들을 기다립니다.
- 일시적 실패(데이터 지연, 주문 결과 UNKNOWN 등)는 같은 캔들 안에서 15초마다 재시도하며, 결과 UNKNOWN 주문은 재전송하지 않고 clientOrderId로 조회합니다.
- **Signal Log** (Scheduler 탭, `data/signals/signals-YYYY-MM-DD.jsonl`): 신호가 없어도 모든 평가를 기록합니다. 예: `TURTLE BTCUSDT 4H Candle Closed C=… 20H Breakout=False 20L Breakdown=False 10L Exit=False 10H Exit=False Result=HOLD`.

### RiskMonitor (실시간)

Emergency Stop / Take Profit은 스케줄러와 분리되어 **모든 가격 틱**에서 검사합니다(캔들 마감을 기다리지 않음). Stop 가격은 진입 시 확정된(마감) 캔들의 ATR로 정해지고 이후 바뀌지 않습니다. 그 외 청산가 근접(LIVE, 10% 이내 경고), 거래소 포지션 불일치, 데이터/API 연결 상태, CLOSE ALL(수동 비상청산)을 담당합니다.

## Portfolio

- **상단 요약**: Total Equity · Today's PnL · Total Return(강조), Available, Total Invested(진입가 기준), Position Value(마크가 기준), Unrealized, Realized Today(LIVE는 Binance income 기준), Total PnL, 현재/최대 Drawdown.
- **Exchange View**: Binance 실제 Wallet / Available / Margin Balance / Unrealized / 포지션(진입가·마크·청산가·증거금) — 진실 원천. `/fapi/v3/account` + `/fapi/v3/positionRisk` REST 스냅샷(15초)과 **User Data Stream**(listenKey, `/private` 경로: ACCOUNT_UPDATE / ORDER_TRADE_UPDATE) 이벤트로 갱신. 스트림이 끊기면 REST 스냅샷으로 복구합니다.
- **Strategy View**: 봇 원장 기준 전략별 투자금·평가액·Long/Short·미실현·오늘 실현·누적 실현(QQQ 전략 포함).
- **Reconciliation**: 거래소 수량과 전략 원장 합계를 종목/방향별로 비교. 차이가 5초 이상 유지되면 `RECONCILIATION WARNING` (예: `BTC LONG Exchange Qty 0.01 Internal 0.008 Diff +0.002`). 자동 수정·숨김 없음. 차이 수량은 `UNATTRIBUTED` 행으로 표시됩니다.
- Asset Allocation(BTC/ETH/XRP/QQQ/CASH, CRYPTO/TRADFI/CASH), Gross Long / Gross Short / Net, 코인별 전략 Net Exposure, All Positions(필터·정렬), PnL Breakdown(Today/7D/30D/All × Symbol/Strategy/Asset Class), Gross/Fees/Funding/Net.
- Equity Curve(1D/7D/1M/3M/ALL, 전략 PnL overlay 옵션): `data/portfolio-history.json`에 5분 간격(35일) + 일별(무기한) 저장. Drawdown은 입출금(TRANSFER)을 제외한 값입니다.
- 체결·청산·비상청산 시 즉시 갱신(Signal → Order → Fill → Position → Portfolio).
- PAPER 모드는 가상 계좌가 Exchange View 역할을 합니다.

## 알아둘 제한사항

- PC가 꺼져 있으면 Binance Stop 외의 기능(신규 진입, 전략 Exit, Take Profit)은 동작하지 않습니다. 24시간 운용은 클라우드 서버에서 실행하세요.
- Take Profit은 Binance에 등록하지 않고 봇이 감시합니다.
- 계정에 수동으로 연 포지션이 같은 코인/방향에 있으면 Hedge Mode 포지션이 합쳐지므로 봇 전용 계정(서브계정) 사용을 권장합니다.
- 전략 원장의 LIVE Funding Fee는 마크가격 스트림 기준 계산값입니다(실제 차감액은 Portfolio › Binance income에 표시).
- 업그레이드 시 Turtle·ADX는 1D → 4H로 바뀝니다. 기존 보유 포지션의 Stop 가격은 그대로이며, 청산 신호는 4H 채널/ADX로 평가됩니다. Controller는 이 변경을 파라미터 변경으로 기록해 이전/이후 성과를 분리 평가합니다.
- Binance income 기록은 최근 3개월만 조회됩니다.

## 개발 / 테스트

```bash
npm test            # 지표·전략·엔진·스케줄러·Portfolio 회귀 테스트
npm run mock        # 로컬 가짜 Binance 서버 (MOCK_DAY_MS=20000 으로 하루를 20초로 가속)
npm run dev:mock    # 가짜 서버에 연결해 터미널 실행 (data-mock/ 사용)
```

## 구조

```
server/index.js       HTTP/WS 서버, API
server/engine.js      전략 평가, 주문 전 검사, PAPER/LIVE 실행, Stop, Funding, PnL
server/strategies.js  Turtle / ADX / TSMOM 신호
server/indicators.js  SMA, ATR, ADX(Wilder), 채널, 로그 모멘텀
server/marketData.js  REST 초기 로드 + WebSocket(/market, /public 경로)
server/binance.js     REST 클라이언트(HMAC 서명), 필터/수량 처리
server/store.js       설정·상태·키 저장(data/)
server/assets.js      종목 메타데이터(asset class, session, provider)
server/session.js     미국 정규장 세션(America/New_York, 휴장일, 조기폐장)
server/dataProviders.js  QQQ 세션 신호 데이터 provider
server/strategiesTradfi.js  QQQ 전략(EMA / TSMOM / SMA200 / Turtle 50-20)
server/strategyRegistry.js  자산군별 전략 매핑
server/scheduler/     StrategyScheduler(캔들 마감 평가·중복 방지·catch-up), Timeframe, Signal Log
server/risk/          RiskMonitor(실시간 Stop·청산가·연결 감시)
server/portfolio/     PortfolioService(Exchange/Strategy View), User Data Stream, Reconciliation, Equity History
server/controller/    Self-Improving Controller (engine, 성과 평가, Regime, 결정 규칙, 저장, Shadow Portfolio)
public/               터미널 UI (lightweight-charts)
tools/mock-binance.js 개발용 가짜 거래소
```

차트: [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/)
