// 화면 표시용 한글 라벨 (서버 값/코드는 영문 그대로 두고 표시할 때만 변환)
export const SIDE = { LONG: '롱', SHORT: '숏' };
export const MODE = { PAPER: '모의투자', LIVE: '실전' };
export const STATUS = {
  LONG: '롱 보유', SHORT: '숏 보유', FLAT: '대기', CASH: '현금', PENDING: '주문 중', UNKNOWN: '확인 중', OFF: '꺼짐',
  RUNNING: '실행 중', STOPPED: '정지', RETRYING: '재시도 중', DISABLED: '꺼짐', UNAVAILABLE: '사용 불가',
  CONNECTED: '연결됨', CONNECTING: '연결 중', DISCONNECTED: '끊김', ERROR: '오류', NO_KEYS: '키 없음', UNVERIFIED: '미확인',
  OPEN: '개장', CLOSED: '폐장', OK: '일치', MISMATCH: '불일치', SYNCING: '동기화 중',
};
export const EXIT = {
  STRATEGY_EXIT: '전략 청산', ATR_STOP: 'ATR 손절', FIXED_STOP: '고정 손절', TAKE_PROFIT: '익절',
  MANUAL_EXIT: '수동 청산', EMERGENCY_CLOSE: '전체 비상청산',
  STRUCTURE_STOP: '구조 손절', RAYNER_HIST_TP: '히스토그램 목표 익절', STOP_INVALID: '손절가 오류 (진입 취소)',
};
export const ORDER_STATUS = {
  SUBMITTED: '전송됨', FILLED: '체결', REJECTED: '거부', UNKNOWN: '확인 중', NOT_PLACED: '미접수', ACTIVE: '활성',
  NEW: '대기', PLACING: '등록 중', TRIGGERED: '발동', FAILED: '실패', REPLACE: '재등록', CANCELED: '취소',
};
export const TF = { '1m': '1분', '3m': '3분', '5m': '5분', '15m': '15분', '30m': '30분', '1h': '1시간', '2h': '2시간', '4h': '4시간', '6h': '6시간', '8h': '8시간', '12h': '12시간', '1d': '1일', '3d': '3일', '1w': '1주', '1M': '1개월', US_SESSION: '미국 정규장' };
export const STRAT = {
  TURTLE: '터틀', ADX: 'ADX', TSMOM: 'TSMOM', RAYNER: 'Rayner', QQQ_EMA_TREND: 'QQQ EMA', QQQ_TSMOM: 'QQQ TSMOM', QQQ_SMA200: 'QQQ SMA200', QQQ_TURTLE_50_20: 'QQQ 터틀50/20', UNATTRIBUTED: '미귀속(수동)',
};
export const CLASS = { CRYPTO: '코인', TRADFI_INDEX: '미국지수(QQQ)', CASH: '현금' };

// Signal Log 결과 코드 -> 한글
export function resultKo(r = '') {
  return String(r)
    .replace(/ENTRY_SKIPPED (LONG|SHORT)/g, (_, s) => `${SIDE[s]} 진입 건너뜀`)
    .replace(/STALE_ENTRY_SKIPPED (LONG|SHORT)/g, (_, s) => `늦은 ${SIDE[s]} 신호 건너뜀`)
    .replace(/ENTRY (LONG|SHORT)/g, (_, s) => `${SIDE[s]} 진입`)
    .replace(/EXIT (LONG|SHORT)/g, (_, s) => `${SIDE[s]} 청산`)
    .replace(/WAIT_REARM (LONG|SHORT)/g, (_, s) => `${SIDE[s]} 재진입 대기`)
    .replace(/MAX_TREND_ENTRIES (LONG|SHORT)/g, (_, s) => `${SIDE[s]} 추세당 최대 진입 도달`)
    .replace(/(청산) (RAYNER_HIST_TP|STRUCTURE_STOP)/g, (_, a, r) => `${a} (${EXIT[r]})`)
    .replace(/EXIT_FAILED/g, '청산 실패')
    .replace(/^HOLD$/, '유지(변화 없음)')
    .replace(/BOT_STOPPED/g, '봇 정지 중')
    .replace(/DISABLED/g, '전략 꺼짐')
    .replace(/NOT_READY/g, '데이터 부족')
    .replace(/ALREADY_EVALUATED/g, '이미 평가됨')
    .replace(/SKIP /g, '보류 ')
    .replace(/\b[A-Z][A-Z_]{3,}\b/g, (c) => CODE[c] || c);
}

// Signal Log 조건 문자열 (서버 영문) -> 한글
export function detailKo(d = '') {
  return String(d)
    .replace(/(\d+)H Breakout=/g, '$1봉 최고가 돌파=').replace(/(\d+)L Breakdown=/g, '$1봉 최저가 이탈=')
    .replace(/(\d+)L Exit=/g, '$1봉 최저가 청산=').replace(/(\d+)H Exit=/g, '$1봉 최고가 청산=')
    .replace(/LongExit=/g, '롱청산=').replace(/ShortExit=/g, '숏청산=').replace(/Long=/g, '롱진입=').replace(/Short=/g, '숏진입=').replace(/Exit=/g, '청산=')
    .replace(/LongTarget=/g, '롱목표=').replace(/ShortTarget=/g, '숏목표=').replace(/Hist=/g, '히스토그램=').replace(/EntriesL\/S=/g, '추세내 진입(롱/숏)=')
    .replace(/Mom(\d+)=/g, '모멘텀$1=').replace(/=True/g, '=예').replace(/=False/g, '=아니오')
    .replace(/insufficient session history \((\d+)\/(\d+) US sessions\)/, '미국장 데이터 부족 ($1/$2 세션)').replace(/insufficient data \((\d+)\/(\d+)\)/, '데이터 부족 ($1/$2)');
}

// 주문/신호 보류 사유 코드 -> 한글
export const CODE = {
  BELOW_MIN_NOTIONAL: '최소 주문금액 미달', BELOW_MIN_QTY: '최소 수량 미달', ABOVE_MAX_QTY: '최대 수량 초과', INSUFFICIENT_BALANCE: '잔고 부족',
  CONTROLLER_PAUSED: '자동조절 중지', DATA_DELAY: '시세 지연', ORDER_PENDING: '주문 처리 중', EXCHANGE_DISCONNECTED: '거래소 연결 끊김',
  NO_PRICE: '가격 없음', BUSY: '처리 중', STOP_CANCEL_FAILED: '손절주문 취소 실패', ORDER_REJECTED: '주문 거부', ORDER_UNKNOWN: '주문 결과 확인 중',
  LEVERAGE_MISMATCH: '레버리지 불일치', POSITION_MODE: '포지션 모드 오류', SYMBOL_NOT_TRADABLE: '거래 불가 종목', INVALID_AMOUNT: '주문금액 미설정',
  POSITION_EXISTS: '이미 보유 중', BOT_STOPPED: '봇 정지', STRATEGY_DISABLED: '전략 꺼짐', SHORT_DISABLED: '숏 꺼짐',
  UNIVERSE_FILTER: '거래대금 진입 순위 밖', STOP_INVALID: '손절가 오류 (진입 취소)', MAX_TREND_ENTRIES: '추세당 최대 진입 도달', UNIVERSE: '종목 선정',
};
export const codeKo = (t = '') => String(t).replace(/\b[A-Z][A-Z_]{3,}\b/g, (c) => CODE[c] || c);
// 슬롯의 마지막 신호 표시 (서버 영문) -> 한글
export const sigKo = (t = '') => String(t)
  .replace(/^WAIT \(stale (LONG|SHORT) signal skipped\)$/, (_, s) => `대기 (늦은 ${SIDE[s]} 신호 건너뜀)`)
  .replace(/^WAIT \((LONG|SHORT) re-arm\)$/, (_, s) => `대기 (${SIDE[s]} 재진입 대기)`)
  .replace(/^WAIT \((LONG|SHORT) max entries per trend\)$/, (_, s) => `대기 (${SIDE[s]} 추세당 최대 진입)`)
  .replace(/^WAIT$/, '대기').replace(/^HOLD (LONG|SHORT)$/, (_, s) => `${SIDE[s]} 유지`)
  .replace(/^(LONG|SHORT) ENTRY$/, (_, s) => `${SIDE[s]} 진입`).replace(/^EXIT \((\w+)\)$/, (_, r) => `청산 (${EXIT[r] || r})`);
