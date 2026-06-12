import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
STOCKS_FILE = DATA_DIR / "stocks.json"
SUMMARIES_FILE = DATA_DIR / "summaries.json"


def read_text(pdf_path):
    reader = PdfReader(str(pdf_path))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def market_for(code):
    if code.startswith("6"):
        return "SH"
    if code.startswith(("4", "8")):
        return "BJ"
    return "SZ"


def compact(text):
    return re.sub(r"\s+", " ", text).strip()


def infer_status(header, body):
    text = f"{header} {body}"
    if "剔出股票池" in text:
        return "剔除"
    if "止损" in text or "减仓" in text:
        if "建仓" not in header and "低吸" not in header:
            return "风险观察"
    if "等待" in header or "站上" in header or "再考虑" in header:
        return "等待"
    if "建仓" in header or "低吸" in header:
        return "观察"
    return "观察"


def extract_rule(header, body, keywords):
    text = compact(f"{header} {body[:320]}")
    parts = re.split(r"[。；;]", text)
    for part in parts:
        if any(keyword in part for keyword in keywords):
            return part.strip(" ，,")
    return ""


def extract_stocks(text):
    pattern = re.compile(r"【(?P<code>\d{6})\s+(?P<name>[^】]+)】(?P<body>.*?)(?=\n【\d{6}\s+[^】]+】|$)", re.S)
    stocks = []
    for match in pattern.finditer(text):
        code = match.group("code")
        name = compact(match.group("name"))
        body = match.group("body").strip()
        lines = [compact(line) for line in body.splitlines() if compact(line)]
        header = lines[0] if lines else ""
        rationale_lines = []
        for line in lines[1:]:
            if line.startswith(("参考", "东北证券", "中邮证券", "国盛证券", "东方证券", "华鑫证券", "华泰证券", "中泰证券", "中银国际证券", "国海证券", "长江证券", "东吴证券", "西部证券", "华创证券", "东海证券", "浙商证券")):
                break
            rationale_lines.append(line)

        reason = "\n".join(rationale_lines[:4]) or compact(body[:260])
        stocks.append(
            {
                "code": code,
                "name": name,
                "market": market_for(code),
                "sector": "",
                "reason": reason,
                "buyZone": extract_rule(header, body, ["建仓", "低吸", "关注价位", "左", "附近"]),
                "stopLoss": extract_rule(header, body, ["止损", "跌破", "创新低", "减仓", "警惕"]),
                "target": "",
                "positionPlan": "按鱼池纪律分仓，单一板块不超过 30%，单一板块最多 2-3 只个股",
                "risk": extract_rule(header, body, ["止损", "跌破", "创新低", "减仓", "警惕"]) or "按视频/鱼池纪律执行止盈止损",
                "status": infer_status(header, body),
                "sourceRule": header,
            }
        )
    return stocks


def extract_date(path, text):
    match = re.search(r"20\d{6}", path.name)
    if match:
        raw = match.group(0)
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    match = re.search(r"(\d{4})\.(\d{2})\.(\d{2})", text)
    if match:
        return "-".join(match.groups())
    return datetime.now().date().isoformat()


def load_json(path, fallback):
    if not path.exists():
        return fallback
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def merge_stock(existing, imported, source_date, source_path):
    now = datetime.now(timezone.utc).isoformat()
    stock_id = f"fishpond-{imported['code']}"
    merged = {
        **existing,
        **imported,
        "id": existing.get("id") or stock_id,
        "updatedAt": now,
        "createdAt": existing.get("createdAt") or now,
        "sourceDate": source_date,
        "source": str(source_path),
        "quote": existing.get("quote"),
    }
    return merged


def main(paths):
    DATA_DIR.mkdir(exist_ok=True)
    stocks = load_json(STOCKS_FILE, [])
    summaries = load_json(SUMMARIES_FILE, [])
    stock_by_code = {item.get("code"): item for item in stocks}
    summary_by_id = {item.get("id"): item for item in summaries}
    report = []

    for raw_path in paths:
        pdf_path = Path(raw_path)
        text = read_text(pdf_path)
        source_date = extract_date(pdf_path, text)
        extracted = extract_stocks(text)
        now = datetime.now(timezone.utc).isoformat()

        for item in extracted:
            stock_by_code[item["code"]] = merge_stock(stock_by_code.get(item["code"], {}), item, source_date, pdf_path)

        summary_id = f"fishpond-{source_date}"
        removed = re.findall(r"【(\d{6})\s+([^】]+)】剔出股票池", text)
        summary_by_id[summary_id] = {
            **summary_by_id.get(summary_id, {}),
            "id": summary_id,
            "date": source_date,
            "title": pdf_path.stem,
            "source": str(pdf_path),
            "status": "已导入",
            "marketView": "鱼池文件已导入。遵循文档看前必读：低吸为主，按目标价、趋势线、技术指标和板块情绪执行止盈止损，分仓配置。",
            "keyPoints": f"自动识别 {len(extracted)} 只股票。"
            + (f" 最新更新剔出：{', '.join(f'{code} {name}' for code, name in removed)}。" if removed else ""),
            "actionItems": "在股票池中查看每只股票的建仓区间、等待条件、止损/减仓规则和入池逻辑；点击刷新行情更新实时价格。",
            "mentionedStocks": [item["code"] for item in extracted],
            "createdAt": summary_by_id.get(summary_id, {}).get("createdAt") or now,
            "updatedAt": now,
        }
        report.append({"file": str(pdf_path), "date": source_date, "stocks": len(extracted)})

    save_json(STOCKS_FILE, sorted(stock_by_code.values(), key=lambda item: item.get("code", "")))
    save_json(SUMMARIES_FILE, sorted(summary_by_id.values(), key=lambda item: item.get("date", ""), reverse=True))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Usage: import_fishpond_pdfs.py file1.pdf [file2.pdf ...]")
    main(sys.argv[1:])
