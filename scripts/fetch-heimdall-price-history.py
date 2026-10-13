"""Export real daily spot candles using Heimdall's existing exchange fetcher."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from datetime import datetime, timedelta, timezone

SKILL_ROOT = Path(__file__).resolve().parent.parent
DAY_MS = 86_400_000


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--heimdall-root", type=Path, required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--start-date", required=True)
    parser.add_argument("--end-date", help="Last completed UTC candle date; defaults to yesterday")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,31}", args.task_id):
        raise ValueError("Invalid task id")
    project = SKILL_ROOT / "artifacts" / args.task_id
    if not (project / ".media-task-workspace.json").is_file():
        raise ValueError("Run media-task-workspace.mjs preflight and ensure first")
    target = project / "price-history.json"
    if target.exists():
        raise FileExistsError(f"Price snapshot already exists: {target}")
    start = datetime.strptime(args.start_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    until = (datetime.strptime(args.end_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
             + timedelta(days=1)) if args.end_date else today
    if until > today or start >= until:
        raise ValueError("The requested range must contain completed UTC days")
    root = args.heimdall_root.resolve(strict=True)
    sys.dont_write_bytecode = True
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    sys.path.insert(0, str(root))
    # Import existing fetch implementation without starting the application or its database.
    previous_cwd = Path.cwd()
    try:
        os.chdir(root)  # Heimdall's own settings resolve its .env here.
        from app.services.market.exchange_gateway import ExchangeGateway
        from app.services.market.symbol_routing import MarketSymbolRouting
        from app.services.market.exchange_kline_fetcher import ExchangeKlineFetcher
        from config import settings
        from utils.logger import logger
    finally:
        os.chdir(previous_cwd)
    import logging
    logger.handlers.clear()
    logger.addHandler(logging.StreamHandler(sys.stderr))
    routing = MarketSymbolRouting(ExchangeGateway(settings.EXCHANGE_ID))
    gateway = routing.gateway_for_symbol(args.symbol)
    since_ms, until_ms = int(start.timestamp() * 1000), int(until.timestamp() * 1000)
    rows = ExchangeKlineFetcher(routing).fetch_gap(args.symbol, "1d", since_ms, until_ms)
    if len(rows) < 2:
        raise ValueError("The exchange returned fewer than two real candles")
    seen = set()
    for row in rows:
        timestamp = int(row[0])
        if timestamp in seen or timestamp % DAY_MS or not (since_ms <= timestamp < until_ms):
            raise ValueError(f"Duplicate or invalid daily candle: {timestamp}")
        if len(row) != 6 or not all(isinstance(v, (int, float)) for v in row):
            raise ValueError("Unexpected Heimdall OHLCV row")
        if row[4] <= 0:
            raise ValueError("Closing prices must be positive")
        seen.add(timestamp)
    rows.sort(key=lambda r: r[0])
    missing = [ts for ts in range(int(rows[0][0]), until_ms, DAY_MS) if ts not in seen]
    if missing:
        raise ValueError(f"Incomplete exchange history: {len(missing)} missing UTC days, first={missing[0]}")
    document = {
        "protocol": "visual-multimedia-price-history", "version": 1,
        "symbol": routing.fetch_symbol(args.symbol),
        "asset_name": args.symbol.split("/")[0],
        "quote_currency": args.symbol.split("/")[1],
        "timeframe": "1d", "timezone": "UTC", "price_basis": "daily-close",
        "source": {
            "provider": gateway.exchange.name, "exchange": gateway.exchange_id,
            "collector": "Heimdall",
            "url": "https://developers.binance.com/en/docs/binance-spot-api-docs/rest-api/market-data-endpoints"
                if gateway.exchange_id == "binance" else gateway.exchange.urls.get("www", ""),
            "requested_start": args.start_date,
            "requested_end": (until - timedelta(days=1)).strftime("%Y-%m-%d"),
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
            "fetcher_sha256": hashlib.sha256((root / "app/services/market/exchange_kline_fetcher.py").read_bytes()).hexdigest(),
            "pre_first_candle": "unavailable; no price inferred",
        },
        "columns": ["timestamp", "open", "high", "low", "close", "volume"],
        "rows": rows,
    }
    target.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "file": str(target), "candles": len(rows),
        "first_date": datetime.fromtimestamp(rows[0][0]/1000, timezone.utc).strftime("%Y-%m-%d"),
        "last_date": datetime.fromtimestamp(rows[-1][0]/1000, timezone.utc).strftime("%Y-%m-%d"),
        "first_close": rows[0][4], "last_close": rows[-1][4],
        "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
