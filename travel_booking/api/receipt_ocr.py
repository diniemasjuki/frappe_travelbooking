# travel_booking/api/receipt_ocr.py
#
# Endpoint AI OCR untuk resit pindahan manual (wizard booking Step 3).
# Resit (base64, dari state_receipt_data client) dihantar ke sini, dibaca
# oleh model AI vision (OpenAI-compatible) server-side, dan maklumat
# Reference No + Amount dipulangkan sebagai JSON.
#
# Client: public/js/booknow.js (analyzeReceipt — AI dahulu, fallback
# Tesseract.js jika endpoint ni pulangkan ok:False).
#
# Konfigurasi: Travel Settings → AI Receipt OCR
#   (enable_ai_receipt_ocr, ai_ocr_base_url, ai_ocr_model, ai_ocr_api_key)
#
# Prinsip reka bentuk: endpoint ni TIDAK PERNAH throw untuk kegagalan AI —
# selalu pulangkan {"ok": False, ...} supaya payment flow customer tidak
# terganggu; client fallback ke OCR tempatan / isi manual.

import base64
import binascii
import json
import re

import frappe
from frappe.rate_limiter import rate_limit

# Cap saiz fail selepas decode (5MB) — elak payload besar membebankan
# worker + kos API.
_MAX_BYTES = 5 * 1024 * 1024

# Jenis fail yang diterima. PDF disokong oleh AI path sahaja (Tesseract
# client-side tak boleh proses PDF).
_ALLOWED_MIME = {
    "image/jpeg": "image/jpeg",
    "image/png": "image/png",
    "image/webp": "image/webp",
    "image/gif": "image/gif",
    "application/pdf": "application/pdf",
}
_EXT_FALLBACK = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
    "gif": "image/gif",
    "pdf": "application/pdf",
}

_PROMPT = (
    "You are given a bank transfer receipt or payment slip image (commonly "
    "from Malaysian banks like Maybank, CIMB, RHB, Hong Leong, Public Bank, "
    "or FPX/DuitNow transfers). Extract these fields:\n"
    "- reference_no: the transaction reference / receipt number "
    "(look for labels like 'Ref No', 'Reference', 'Transaction ID', "
    "'FPX', 'M2U', receipt number). Uppercase alphanumerics.\n"
    "- amount: the transferred amount as a number (currency RM/MYR), "
    "without symbols or commas.\n"
    "- date: the transaction/transfer date in YYYY-MM-DD format "
    "(look for 'Date', 'Transaction Date', 'Transfer Date'; handle "
    "DD/MM/YYYY, DD-MM-YYYY, DD MMM YYYY formats).\n"
    "Respond with ONLY a JSON object, no other text:\n"
    '{"reference_no": "<string or empty>", "amount": <number or null>, '
    '"date": "<YYYY-MM-DD or empty>"}\n'
    "If a field cannot be found, use empty string / null."
)


@frappe.whitelist(methods=["POST"], allow_guest=True)
@rate_limit(key="receipt_ocr", limit=10, seconds=600)
def analyze_receipt(filedata: str, filename: str = "") -> dict:
    """Baca resit pindahan dengan AI vision dan pulangkan maklumat asas.

    `filedata`: base64 (data-URL prefix "data:...;base64," diterima) kandungan
    resit. `filename`: pilihan, untuk bantuan tentukan jenis fail.
    """
    settings = _get_settings()
    if not settings.get("enabled"):
        return {"ok": False, "reason": "not_configured"}

    payload, mime = _decode_file(filedata, filename)
    if not payload:
        return {"ok": False, "reason": "invalid_file",
                "message": "Invalid or unsupported receipt file."}

    try:
        result = _call_ai(settings, payload, mime)
    except Exception as e:
        frappe.log_error(
            title="AI Receipt OCR failed",
            message=f"{e!r}\n\nmodel={settings.get('model')}",
            reference_doctype="Booking",
        )
        return {"ok": False, "reason": "ai_error",
                "message": "AI receipt reading failed."}

    if not result.get("ok"):
        return result

    return {
        "ok": True,
        "source": "ai",
        # Normalisasi di sini (bukan hanya dalam _call_ai) — identik untuk
        # mana-mana sumber dan mudah diuji.
        "reference_no": str(result.get("reference_no") or "").strip().upper(),
        "amount": result.get("amount"),
        # Tarikh transaksi (YYYY-MM-DD) — untuk auto-fill Transfer Date
        # pada borang manual payment (billing page). Normalisasi format
        # lazim yang mungkin dikembalikan model.
        "date": _normalize_date(result.get("date")),
    }


def _get_settings() -> dict:
    """Baca konfigurasi AI OCR dari Travel Settings (singleton)."""
    doc = frappe.get_cached_doc("Travel Settings")
    enabled = bool(doc.get("enable_ai_receipt_ocr")) and bool(doc.get("ai_ocr_api_key"))
    return {
        "enabled": enabled,
        "base_url": _normalize_base_url(doc.get("ai_ocr_base_url")),
        "model": (doc.get("ai_ocr_model") or "gpt-4o-mini").strip(),
        "api_key": doc.get_password("ai_ocr_api_key") if enabled else "",
    }


def _normalize_base_url(raw: str) -> str:
    """Normalize base URL ikut cara OpenAI SDK guna dia.

    Kes salah tampal yang biasa (dan diabaikan senyap di sini):
      "POST https://api.openai.com/v1/chat/completions"
        → buang kaedah HTTP + path /chat/completions (SDK append sendiri)
      "https://api.openai.com/v1/chat/completions/"
        → buang trailing path + slash
    Pulangkan default jika kosong sepenuhnya.
    """
    url = (raw or "").strip()
    url = re.sub(r"^(?:GET|POST|PUT|DELETE|PATCH)\s+", "", url, flags=re.IGNORECASE)
    url = re.sub(r"/chat/completions/?$", "", url)
    return url.rstrip("/") or "https://api.openai.com/v1"


def _decode_file(filedata: str, filename: str):
    """Decode + sahkan base64 filedata. Pulangkan (bytes, mime) atau (None, None)."""
    if not filedata:
        return None, None

    mime = ""
    data = filedata.strip()
    if data.startswith("data:"):
        # data-URL: "data:image/png;base64,...."
        header, _, data = data.partition(",")
        mime = header[5:].split(";")[0].strip().lower()

    try:
        payload = base64.b64decode(data, validate=False)
    except (binascii.Error, ValueError):
        return None, None

    if not payload or len(payload) > _MAX_BYTES:
        return None, None

    if mime not in _ALLOWED_MIME:
        # Fallback: tentukan jenis dari extension filename
        ext = (filename or "").rsplit(".", 1)[-1].lower() if "." in (filename or "") else ""
        mime = _EXT_FALLBACK.get(ext, "")
        if not mime:
            return None, None

    return payload, _ALLOWED_MIME[mime]


def _call_ai(settings: dict, payload: bytes, mime: str) -> dict:
    """Panggil OpenAI-compatible chat API dengan kandungan resit.

    Return {"ok": True, "reference_no", "amount"} atau {"ok": False, ...}.
    """
    from openai import OpenAI

    client = OpenAI(
        api_key=settings["api_key"],
        base_url=settings["base_url"],
        timeout=60,
    )

    data_url = f"data:{mime};base64,{base64.b64encode(payload).decode()}"
    response = client.chat.completions.create(
        model=settings["model"],
        temperature=0,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": _PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
    )

    raw = (response.choices[0].message.content or "").strip() if response.choices else ""
    parsed = _parse_ai_json(raw)
    if parsed is None:
        return {"ok": False, "reason": "ai_unparseable",
                "message": "AI response could not be parsed."}

    amount = parsed.get("amount")
    if amount is not None:
        try:
            amount = float(str(amount).replace(",", ""))
        except (TypeError, ValueError):
            amount = None

    return {
        "ok": True,
        "reference_no": str(parsed.get("reference_no") or "").strip().upper(),
        "amount": amount,
        # Tarikh transaksi — diproses oleh _normalize_date di analyze_receipt.
        "date": str(parsed.get("date") or "").strip(),
    }


def _normalize_date(raw) -> str:
    """Normalisasi tarikh daripada respons AI kepada YYYY-MM-DD.

    Terima string YYYY-MM-DD (terus), DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY,
    atau DD MMM YYYY. Pulangkan '' jika tak boleh dikenali.
    """
    import re as _re
    from frappe.utils import getdate

    s = str(raw or "").strip()
    if not s or s.upper().startswith("YYYY"):
        return ""
    # Sudah ISO?
    if _re.match(r"^\d{4}-\d{2}-\d{2}$", s):
        try:
            return str(getdate(s))
        except Exception:
            return ""
    # DD/MM/YYYY / DD-MM-YYYY / DD.MM.YYYY
    m = _re.match(r"^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$", s)
    if m:
        try:
            return str(getdate(f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"))
        except Exception:
            return ""
    # DD MMM YYYY
    m = _re.match(r"^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$", s)
    if m:
        try:
            return str(getdate(f"{m.group(3)}-{m.group(2)}-{m.group(1)}"))
        except Exception:
            return ""
    return ""


def _parse_ai_json(raw: str):
    """Parse JSON dari respons AI — bertolak ansur dengan markdown fences
    dan teks sampingan yang model kadangkala tambah."""
    if not raw:
        return None
    text = raw.strip()
    # Buang markdown code fences ```json ... ```
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        pass
    # Cuba extrak objek JSON pertama dalam teks
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except (ValueError, TypeError):
            return None
    return None
