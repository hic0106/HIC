# HIC 인수인계 (Claude Code용)

이 파일은 Claude Code가 이 폴더에서 시작할 때 자동으로 읽는다. 다른 세션에서 작업을 이어가기 위한 요약.

## 프로젝트

- Binance USDT-M Futures 다전략 자동매매 터미널. 개인용. 사용자는 한국어 사용, 답변도 한국어.
- 저장소: `hic0106/HIC`, 작업 브랜치: `claude/binance-crypto-trading-terminal-xspxvw` (여기에만 commit/push, PR은 요청 시에만).
- 스택: Node 22 ESM, Express 5, ws, lightweight-charts v5, @anthropic-ai/sdk 0.128.0. 빌드 단계 없음.
- 실행: `start.bat`(Windows, npm install 후 서버 실행) 또는 `npm start` → http://localhost:8420 (`PORT` 환경변수로 변경 가능)
- 테스트: `npm test` (현재 144개 전부 통과). 가짜 서버: `npm run mock`, `npm run dev:mock`(data-mock/ 사용), `npm run mock:claude` + `ANTHROPIC_BASE_URL=http://127.0.0.1:9902`.
- 자세한 사용법/구조: `README.md`.

## 사용자 선호

- 답변 전 사실 확인, 중요한 내용은 검색으로 2차 검증.
- 불필요한 수식어/형용사 없이 짧게.
- UI 문구는 한국어 (`public/js/ko.js`에 번역 테이블).

## 안전 규칙 (반드시 유지)

- API 키는 `data/secrets.json`(gitignore, 0600)에만 저장. UI로 반환하거나 커밋 금지. Claude API 키도 동일(`anthropicApiKey`). `ANTHROPIC_API_KEY` 환경변수도 지원하지만 Claude Code 로그인과 충돌하므로 설정 권장하지 않음.
- Binance 키 권한: Enable Reading + Enable Futures, IP 제한, 출금 금지. 코인 판매(내 자산 화면) 사용 시에만 Enable Spot & Margin Trading + Permits Universal Transfer 추가(사용자 결정 2026-09-25). 출금 API는 절대 쓰지 않음.
- 코인 판매(`server/portfolio/assetSeller.js`): 사용자가 버튼 + `SELL` 입력 시에만. 선물 지갑 자산 → 현물 이동(UMFUTURE_MAIN) → 현물 시장가 매도 → USDT 선물로(MAIN_UMFUTURE). 결과 불명 주문은 재전송 없이 clientOrderId 조회. 봇/AI는 호출하지 않음.
- 레버리지 자동 증가 금지. 레버리지는 전략별(`strategies.<name>.leverage`), 주문금액 = 증거금, 명목 = 금액 × 레버리지, Binance 종목 레버리지 = 켜진 전략 중 최대(`engine.symbolLeverage`). 백테스트는 1x. Controller/AI는 주문 금액(amounts)·enabled 플래그를 바꾸지 않고 주문도 넣지 않는다.
- AI 변경은 사용자가 [적용]을 눌러야만 반영. LIVE 실행 중이면 `APPLY` 입력 확인 필요.
- LIVE 동작(시작, 전체 청산 등)은 입력 확인 필요.
- 커밋 메시지·코드에 모델 식별자 넣지 않기.
- LIVE 봇 실행 중에는 코드/설정 변경 작업 금지. 두 PC에서 동시에 LIVE 실행 금지.

## 전략 (server/store.js DEFAULT_CONFIG)

| 전략 | 종목 | 캔들 | 비고 |
|---|---|---|---|
| TURTLE | 코인 Universe | 4h | 20/10 채널, SMA200 필터, 숏 허용 |
| ADX | 코인 Universe | 4h | ADX14 > 25, SMA200 필터, 숏 허용 |
| TSMOM | 코인 Universe | 1d | lookback 30, 롱만 |
| RAYNER (기본 OFF) | 코인 Universe | 4h | EMA50 + MACD(1,50,9) 히스토그램 가속, STRUCTURE 손절(최근 10봉), 히스토그램 목표 익절(진입 시 고정), 추세당 최대 2회 |
| QQQ_EMA_TREND / QQQ_TSMOM (ON), QQQ_SMA200 / QQQ_TURTLE_50_20 (OFF) | QQQUSDT | 미국 정규장 세션 | 롱/현금만 |

추가 매수: 보유 중 같은 방향 진입 조건이 다시 참이면 캔들당 1회, 포지션당 최대 `general.maxAdds`(기본 0=끔)회 추가. 평균단가 합산, 손절은 추가 체결가 기준 재계산 후 유리한 쪽으로만 이동, LIVE는 기존 Binance Stop 취소 → 총수량으로 재등록. 백테스트에도 반영.

Stop은 ATR_DYNAMIC(min/max 클램프), LIVE에서는 Binance Algo STOP_MARKET로 등록. Take Profit은 봇이 감시.

트레일링 스탑(`general.trailing`, 기본 켜짐 4/6): 진입 ATR 기준, 유리한 방향 activateAtr 도달 시 손절을 본전으로, 이후 최고가 − trailAtr로 따라감(느슨해지지 않음). 1000일 백테스트(2026-09-28)에서 1/2는 세 전략 모두 악화, 4/6은 TREND_RIDER·VOL_BREAKOUT 개선·TSMOM 악화, 추가 매수 3회는 MDD 70%대. 공통 설정 화면에서 변경. 봇 손절은 틱마다, Binance Stop은 최대 1분에 1회 새 Stop 등록 후 기존 취소. 청산 사유 TRAIL_STOP. 백테스트에도 반영(봉 극값으로 올린 뒤 종가가 새 손절 밖이면 그 가격에 청산).

보유 포지션 표: 헤더 더블 클릭 정렬(오름→내림→해제, 한글/영문 localeCompare 'ko'), 전략·종목·방향 텍스트 필터.

## 구성 요소 요약

- `server/portfolio/portfolioService.js`: 선물 지갑 전 자산(USDT 환산, `/fapi/v2/ticker/price`) + Binance 전체 지갑(`/sapi/v1/asset/wallet/balance`, 읽기 권한) 표시.
- `server/universe.js`: 코인 Universe. 시작 시 거래대금(quoteVolume) 상위 20 감시 / 15 신규진입 + 보호 종목(포지션·주문·거래소 Stop) → `assets.registerCryptoSymbols()`로 `SYMBOLS`/`SYMBOL_META`(live 객체) 교체. 24h 재순위는 진입 허용만 갱신, 감시 목록 변경은 재시작 시. 엔진 `preTradeChecks`에서 `UNIVERSE_FILTER`.
- `server/backtest/historicalUniverse.js`: 백테스트용 과거 거래대금 순위(감시 후보 안, 7일 리밸런싱, 직전 30일, 미래 데이터 미사용).

- `server/engine.js`: 전략 평가, 주문 전 검사, PAPER/LIVE 실행, Stop, Funding, PnL.
- `server/scheduler/strategyScheduler.js`: 캔들 마감 시 평가. `run()`은 단일 큐(`this.queue`)로 직렬화, 실제 작업은 `runNow()`.
- `server/risk/riskMonitor.js`: 실시간 Stop·청산가·연결 감시.
- `server/marketData.js`: REST 초기 로드 + WS. 전략 캔들은 설정에서 쓰는 간격만(`barIntervalsFor`, 1m~1M 전부 선택 가능). CHART_INTERVALS(5m/15m/1h/4h/1d)는 WS, 나머지는 마감 후 REST 폴링(`pollBars`), 설정 변경 시 `ensureInterval`로 즉시 로드. 재연결 시 마지막 봉 이후 전부 재조회(`resyncBars`/`resyncDaily`), 비연속 봉이면 DATA_GAP 로그.
- `server/controller/`: Self-Improving Controller V1 (OFF/OBSERVE/PAPER_AUTO/LIVE_APPROVAL).
- `server/portfolio/`: 내 자산 화면. userDataStream(listenKey, `gen` 카운터로 stop 후 소켓 차단), income(최근 3개월, 커서 포함 조회 + tranId 중복 제거).
- `server/strategyConfig.js`: `validateStrategySettings` (설정 API와 AI 적용이 공용).
- `server/backtest/backtester.js`: `backtestStrategy(...)`. 규칙: 마감봉 신호 → 다음 봉 시가 ± 슬리피지 체결, 지표 창은 라이브와 동일(`LIVE_WINDOW` 4h 1000 / 1d 500 / US_SESSION 전체), 봉 내부 Stop/TP(갭은 시가 체결, 둘 다 닿으면 Stop 우선), 과거 펀딩비 반영, 복리 = equity/종목수. 100스텝마다 `setImmediate`로 양보. `computeMetrics`는 끝까지 열린 낙폭도 포함.
- `server/backtest/backtestRunner.js`: 데이터 로딩(klines 1500 페이징, fundingRate, 30분 캐시, `into`로 job별 ctx 고정), `runOne`, `runSplit`(IS 70% / OOS 30%), `run`(결과 `data/backtest-last.json`).
- `server/ai/claudeClient.js`: 모델 `claude-opus-5`, `beta.messages.stream().finalMessage()`, adaptive thinking, json_schema 구조화 출력, system 프롬프트 캐시. 에러는 `ClaudeError`(NO_KEY/AUTH/RATE_LIMIT/REFUSAL/MAX_TOKENS 등).
- `server/ai/dsl.js`: AI 전략용 선언형 JSON DSL (코드 실행 없음). 지표 10종, 규칙 ≤6, 암호화폐 종목만.
- `server/ai/aiService.js`: 
  - `analyze()`: 백테스트 손실 원인 분석.
  - `improve()`: 파라미터 개선 루프. Claude는 IS 결과만 봄. 판정 PASSED/OVERFIT/WORSE/INVALID. 수정 가능 경로는 timeframe, shortEnabled, params.*, stop.*, takeProfit.* (amounts 불가).
  - `applyCandidate()`: 테스트된 변경분만 현재 설정 위에 재적용.
  - `generate()`: AI 전략 생성. 기존 전략은 이름/캔들만 전달. 채택 조건 IS 거래 ≥5, IS>0, OOS>0, score ≥0.3. 저장은 `data/ai-strategies.json`.
- API: `/api/backtest/run|status|result|candles`, `/api/ai/status|key|analyze|improve|generate|apply|save|delete` (`server/index.js`).
- 모바일: `public/m.html` + `js/mobile.js` + `css/mobile.css`, 데이터 `/api/mobile`(2초 폴링). 터치 기기는 index.html에서 `/m`으로 이동(`hic.desktop` localStorage로 PC 화면 고정). Fold8 커버 1열 / 펼침 2열 / Flex 모드 분할.
- 프론트: `public/index.html`(트레이딩 / 내 자산 / 백테스트 탭), `public/js/backtest.js`, `public/js/ai.js`, `public/js/ko.js`.

## 클라우드 운영 (`deploy/`)

- AWS Lightsail 서울/도쿄 Ubuntu + 고정 IP 권장(미국 리전은 Binance 451 차단). `setup-ubuntu.sh`(Node 22, swap, NTP, systemd `hic`), `update.sh`, Windows `connect.bat`(SSH 터널 로컬 8421 → 서버 127.0.0.1:8420), `upload-data.bat`(data 복사). 8420은 외부 공개 금지(인증 없음). 폰: `setup-tailscale.sh`(Tailscale Serve → 127.0.0.1:8420, tailnet 전용, Funnel 금지). WS origin 허용 목록 `HIC_ALLOWED_ORIGINS`(systemd drop-in).
- 실제 운영(2026-09-28): 서버 15.164.158.220 (`ubuntu@`, 키 `%USERPROFILE%\.ssh\LightsailDefaultKey-ap-northeast-2.pem`, 설정 `%USERPROFILE%\.hic-cloud.cmd`), `~/HIC`. 바탕화면 "HIC Cloud" = connect.bat(터널 8421), "HIC Terminal" = 로컬 start.bat(이 PC 서버, LIVE 금지). 폰: Tailscale 설정 완료, https://ip-172-26-1-192.taila35852.ts.net/m (사용자 iPhone 같은 tailnet).
- 배포 절차: 사용자가 봇 정지 → `curl http://127.0.0.1:8421/api/mobile`로 runState STOPPED 확인 → push → `ssh ... 'bash ~/HIC/deploy/update.sh'` → 사용자가 봇 재시작. 설정 변경 API는 `X-HIC: 1` 헤더 필요(CSRF 가드). 이 PC는 git user 미설정 → `git -c user.name=Claude -c user.email=noreply@anthropic.com commit`.

## data/ 폴더 (gitignore, PC 이전 시 복사)

config.json, state.json, secrets.json, portfolio-history.json, backtest-last.json, ai-state.json, ai-strategies.json

## 알려진 제한 / 미결정 항목

- 업그레이드 전 1D로 열린 Turtle/ADX 포지션도 이제 4H 규칙으로 청산 평가됨. 포지션별 원래 캔들 유지 기능은 사용자가 원하면 추가.
- AI 생성 전략은 백테스트/저장만 가능, 실전 실행 기능 없음.
- 시스템 로그 일부는 영어.
- QQQUSDT TradFi-Perps 약관은 2026-09-24 API(`POST /fapi/v1/stock/contract`)로 서명 완료.
- 실계좌 검증(2026-09-24): `/fapi/v1/income`, `/fapi/v1/userTrades`만 -2015 거부(다른 서명 API는 정상). 원인 미확인 — 키 재발급 후 재확인 필요. 실패 시 수수료는 설정값으로 대체됨.
- LIVE 원금(총 수익률 분모) = 현재 계좌 자산(실시간). `liveBaseCapital` 설정 삭제.
- 업비트 키는 미지원(현물 전용). 업비트 현물 모드는 제안만 한 상태.
- PC가 꺼지면 Binance에 등록된 Stop 외 기능은 동작하지 않음.
- 클라우드 개발 환경에서는 Binance/업비트 API가 차단되어 가짜 서버로만 검증함. 실제 API 검증은 로컬에서 필요.

## 진행 상황 (2026-09-28 기준, 다음 세션은 여기서 이어서)

- 서버 = 88a307a (최신), LIVE, 계좌 약 171 USDT. 서버 설정: 추가 매수 3회(사용자 설정, 권장은 0 — 백테스트 MDD 70%대), 트레일링 4/6 ATR, TSMOM lookback 60·상위 10, VOL_BREAKOUT 상위 5(BTC/ETH 포함), TREND_RIDER·TURTLE·ADX 상위 2. TURTLE·ADX 주문금액 10 USDT → BTC 최소수량 미달(BELOW_MIN_QTY), 25 USDT 이상 필요.
- 08:41 사용자가 전체 청산 후 재시작 → 포지션 0. 재진입 대기(REARM)로 TSMOM 등은 조건 리셋까지 진입 안 함(설계대로). 사용자 결정 대기: 그대로 / TURTLE·ADX 금액 상향 / "재진입 대기 해제" 버튼 추가.
- 제안만 한 것(결정 대기): 수익 반납 한도 규칙(최대 수익의 X%까지만 반납) 백테스트, 전략별 트레일링/추가매수 설정(현재 전 전략 공통 — TSMOM은 트레일링에 불리), TREND_RIDER 익절 60%(1000일 백테스트에서만 개선).
- 참고 결과(1000일, 서버 설정): 트레일링 1/2는 세 전략 모두 악화, 4/6은 TREND_RIDER·VOL_BREAKOUT 개선·TSMOM 악화. 청산을 빠르게(trailMult↓) 하면 대체로 악화. TSMOM lookback은 45 부근이 안정적(상위 2 기준 분석, 상위 10에선 미검증).
- QNT 2026-09-28 급등(178→360): VOL_BREAKOUT 291(+64%), TREND_RIDER 321(+80%) 트레일링 청산. EXTERNAL_CLOSE 177 기록은 앱 청산 정리분(서버 재시작으로 실제 체결가 169 대신 현재가 기록).

## 최근 커밋

- 88a307a 청산선 즉시 계산 + 청산선까지 %
- 58ad454 전략 청산선 표시(exitLevel)
- 135e69e 백테스트 추가매수·트레일링 반영, 권장 기본값, 공통 설정 UI
- 6fa2ac6 트레일링 스탑, 포지션 표 정렬/필터
- ce6e812 추가 매수, 외부 청산(-2022) 처리, AI 판정 NO_OOS

- 10af0b7 Ignore dist/
- 77eb5e9 리뷰 수정: 평가 직렬화, 논블로킹 백테스트, 데이터 공백, AI 적용/정보 누출
- 28eb731 Claude AI: 손실 분석, 자동 개선, AI 전략 생성
- 86dbffb 한글 UI
- 2498eb5 백테스트 화면
