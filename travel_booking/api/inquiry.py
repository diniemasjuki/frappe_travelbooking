# travel_booking/api/inquiry.py
#
# Endpoint awam untuk floating chat widget (mini contact form) pada semua
# page awam cruise/tour. Setiap submission disimpan sebagai rekod
# Travel Inquiry untuk follow-up oleh team.
#
# Client: templates/includes/chat_widget.html
#   POST /api/method/travel_booking.api.inquiry.create_inquiry
#     prospect_name (wajib), phone (wajib), email (opsyenal),
#     message (opsyenal), source_page (hidden — URL page semasa),
#     affiliate_code (opsyenal — kod referral dari link ?sp=, untuk
#       attribution affiliate),
#     trip / trip_group_date / trip_package (opsyenal — pilihan semasa
#       user dalam session booknow, dibaca dari sessionStorage oleh
#       widget), company_website (honeypot tersembunyi — bot sahaja
#       yang mengisi)
#
# Konfigurasi widget (enable/teks): Travel Website → Floating Chat Button.

import frappe
from frappe.rate_limiter import rate_limit

from travel_booking.api.voucher import validate_affiliate_code
from travel_booking.travel_booking_management.doctype.travel_inquiry.travel_inquiry import (
    derive_domain,
)
from travel_booking.utils.website_config import get_website_config

_DEFAULT_SUCCESS_MESSAGE = (
    "Thank you! Your question has been sent. Our team will contact you soon."
)


@frappe.whitelist(methods=["POST"], allow_guest=True)
@rate_limit(key="travel_inquiry", limit=10, seconds=600)
def create_inquiry(
    prospect_name: str,
    phone: str,
    email: str = "",
    message: str = "",
    source_page: str = "",
    affiliate_code: str = "",
    trip: str = "",
    trip_group_date: str = "",
    trip_package: str = "",
    company_website: str = "",
) -> dict:
    """Simpan soalan prospect dari floating chat form sebagai Travel Inquiry.

    `affiliate_code` (param URL `?sp=` pada page asal) di-resolve kepada
    Sales Partner melalui validate_affiliate_code() — mekanisme sama dengan
    booking. Kod tak sah/tak verified TIDAK menolak inquiry; attribution
    hanya dibiarkan kosong.

    `trip`/`trip_group_date`/`trip_package` (pilihan semasa user dalam
    session booknow) disahkan wujud dalam DB sebelum disimpan — nilai
    session yang korup/stale dibuang senyap tanpa menolak lead.

    `company_website` ialah honeypot tersembunyi pada borang — request yang
    mengisinya (bot) menerima respons "berjaya" tanpa sebarang rekod
    dicipta, supaya bot tidak tahu ia telah ditolak.

    Validasi (nama/phone wajib, format phone, format email) dilaksanakan
    oleh controller TravelInquiry.validate().
    """
    if company_website:
        return {"ok": True, "name": "", "message": _success_message()}

    doc = frappe.get_doc(
        {
            "doctype": "Travel Inquiry",
            "prospect_name": prospect_name,
            "phone": phone,
            "email": email,
            "message": message,
            "source_page": source_page,
            "domain": derive_domain(source_page),
            **_resolve_affiliate(affiliate_code),
            "trip": _valid_link("Trip", trip),
            "trip_group_date": _valid_link("Trip Group Date", trip_group_date),
            "trip_package": _valid_link("Trip Package", trip_package),
        }
    ).insert(ignore_permissions=True)

    return {"ok": True, "name": doc.name, "message": _success_message()}


def _valid_link(doctype: str, value: str) -> str:
    """Sahkan value ialah nama rekod yang benar-benar wujud.

    Data dari session booknow (sessionStorage) boleh jadi korup atau
    stale — lead dari prospect tidak sepatutnya gagal disimpan semata-mata
    kerana satu Link tak sah.
    """
    value = (value or "").strip()
    if not value:
        return ""
    return value if frappe.db.exists(doctype, value) else ""


def _resolve_affiliate(affiliate_code: str) -> dict:
    """Resolve kod referral kepada field attribution Travel Inquiry.

    Pulangkan {"affiliate": ..., "referral_code_used": ...} untuk kod yang
    sah, atau kosong sepenuhnya — inquiry dari prospect tidak sepatutnya
    gagal semata-mata kerana kod referral tak sah.
    """
    code = (affiliate_code or "").strip().upper()
    if not code:
        return {}

    try:
        res = validate_affiliate_code(code)
    except Exception:
        # Jangan biarkan isu resolve menghalang lead masuk.
        return {}

    if not res.get("valid"):
        return {}

    return {
        "affiliate": res.get("sales_partner") or "",
        "referral_code_used": code,
    }


def _success_message() -> str:
    """Mesej jaya dari konfigurasi Travel Website (fallback lalai)."""
    chat = get_website_config().get("chat") or {}
    return chat.get("success_message") or _DEFAULT_SUCCESS_MESSAGE
