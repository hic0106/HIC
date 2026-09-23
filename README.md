# HIC Futures Terminal

Binance USDT-M Perpetual Futures 기반 멀티전략 자동매매 트레이딩 터미널 (BTCUSDT / ETHUSDT / XRPUSDT).

| 전략 | 방향 | 진입 | 청산 | Emergency Stop (기본) |
|---|---|---|---|---|
| TURTLE 20/10 | Long + Short | 종가 > 이전 20일 고가 / 종가 < 이전 20일 저가 **AND** 종가 < SMA200 | Long: 종가 < 이전 10일 저가, Short: 종가 > 이전 10일 고가 | ATR(20)×2.0, 8~18% |
| ADX Trend | Long + Short | ADX>25 & +DI>-DI / ADX>25 & -DI>+DI & 종가<SMA200 | Long: ADX<=25 or -DI>=+DI, Short: ADX<=25 or +DI>=-DI | ATR(14)×2.0, 6~15% |
| TSMOM 30D | Long + Cash | 30일 누적 로그수익률 > 0 | 30일 모멘텀 <= 0 | ATR(20)×3.0, 10~22% |

- 채널 계산에서 현재 봉은 제외합니다. 모든 신호는 **마감된 일봉(1D, UTC 00:00 = KST 09:00)** 기준으로 평가합니다.
- Emergency Stop은 실시간 가격으로 감시하며, 전략 Exit와 Stop 중 먼저 발생한 조건으로 청산합니다.
- 고정 Take Profit은 기본 OFF (전략별로 켤 수 있음).

## 실행

Node.js 20 이상 필요.

```bash
npm install
npm start
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
- **하단 탭**: Positions / Orders / Trades / Strategies(운영 설정) / System Log.

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

## 알아둘 제한사항

- Emergency Stop은 **프로그램 내부에서 감시 후 시장가 청산**합니다. 거래소에 Stop 주문을 걸어두지 않으므로 프로그램/PC가 꺼져 있으면 Stop이 동작하지 않습니다.
- 계정에 수동으로 연 포지션이 같은 코인/방향에 있으면 Hedge Mode 포지션이 합쳐지므로 봇 전용 계정(서브계정) 사용을 권장합니다.
- LIVE Funding Fee는 마크가격 스트림 기준 계산값입니다(실제 차감액과 소수점 차이 가능).

## 개발 / 테스트

```bash
npm test            # 지표·전략·엔진(중복주문/Skip/Stop) 단위 테스트
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
public/               터미널 UI (lightweight-charts)
tools/mock-binance.js 개발용 가짜 거래소
```

차트: [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/)
