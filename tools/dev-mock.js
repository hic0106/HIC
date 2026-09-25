// Runs the terminal against the local mock exchange (cross-platform env setup).
process.env.BINANCE_REST_BASE ||= 'http://127.0.0.1:9901';
process.env.BINANCE_WS_BASE ||= 'ws://127.0.0.1:9901';
process.env.BINANCE_SPOT_BASE ||= 'http://127.0.0.1:9901';
process.env.HIC_DATA_DIR ||= './data-mock';
await import('../server/index.js');
