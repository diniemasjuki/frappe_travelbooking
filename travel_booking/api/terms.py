# travel_booking/api/terms.py
#
# Terms & Conditions (T&C) untuk wizard booking /booknow — sumber dokumen
# ialah doctype STANDARD "Terms and Conditions" (ERPNext, module Setup).
#
# PEMILIHAN DOKUMEN — PER-SITE (VERTIKAL). Kedua-dua site bench ni
# (trip.rarecation.com = tour, cruise.rarecation.com = cruise) KONGSI satu
# database, jadi settings singleton mana-mana pun dikongsi. Sebab tu
# pilihan T&C disimpan dalam Travel Website mengikut konvensyen app:
# medan per-vertikal `cruise_booking_terms` / `tour_booking_terms`
# (Desk → Travel Website → tab Cruise/Tour Homepage → section "Booking
# Terms & Conditions"). get_website_config() membaca singleton tu dan
# cache per-site; vertical semasa dikesan dari nama site (rujuk
# _booking_site_vertical).
#
# Gate penuh semakan semula berlaku di confirm_booking() (booking_engine.py)
# — nilai client tidak dipercayai.
#
# NOTA AUDIT: dokumen standard TIDAK ber-versi (nama = tajuk). Disiplin
# versi: JANGAN edit dokumen yang sudah dirujuk booking — cipta dokumen
# baharu dan tukar pilihan di Travel Website. Booking merakam Link ke
# dokumen tepat + masa persetujuan (Booking.terms_accepted_at), dan patch
# v1_terms_and_conditions_track_changes mengaktifkan track_changes pada
# doctype tu supaya suntingan dokumen terus ada version history.

import frappe

from travel_booking.utils.website_config import get_website_config


def _booking_site_vertical() -> str:
    """Vertical site semasa untuk pemilihan T&C — "cruise" atau "tour".

    Nama site bench = domain (trip.rarecation.com / cruise.rarecation.com),
    jadi cari kata kunci dalam nama site; fallback ke request Host bila
    nama site tak berpetunjuk. Workers/email queue juga lulus ujian ni —
    frappe.local.site sentiasa ditetapkan ikut site yang enqueue kerja.
    Default "cruise" konsisten dengan fallback nav/menu seluruh app.
    """
    site = (getattr(frappe.local, "site", "") or "").lower()
    try:
        host = (frappe.get_request_header("Host") or "").split(":")[0].lower()
    except Exception:
        host = ""
    if "cruise" in site or "cruise" in host:
        return "cruise"
    if "trip" in site or "tour" in site or "trip" in host or "tour" in host:
        return "tour"
    return "cruise"


def get_active_terms_record():
    """Dokumen T&C yang DIPILIH untuk vertical site semasa
    (Travel Website → cruise_booking_terms / tour_booking_terms) —
    dict {name, title, content} atau None bila tiada pilihan / dokumen
    di-disabled (panel T&C disembunyikan dan gate dilangkau — rollout
    berperingkat dan boleh mematikan panel tanpa sentuh kod).

    frappe.get_all mengabaikan permission — dipanggil dari page context Guest.
    """
    vertical = _booking_site_vertical()
    terms_name = (get_website_config().get(vertical, {}).get("booking_terms") or "").strip()
    if not terms_name:
        return None
    rows = frappe.get_all(
        "Terms and Conditions",
        filters={"name": terms_name, "disabled": 0},
        fields=["name", "title", "terms"],
        limit=1,
    )
    if not rows:
        return None
    row = rows[0]
    row["content"] = row.pop("terms") or ""
    return row


@frappe.whitelist(allow_guest=True)
def get_active_terms():
    """Endpoint paparan ringan untuk klien (guest OK — kandungan T&C memang
    bahan awam). Wizard /booknow TIDAK guna endpoint ni (kandungan dirender
    server-side di page context) — disediakan untuk halaman/future flow lain
    yang perlukan T&C tanpa render penuh page.
    """
    row = get_active_terms_record()
    if not row:
        return {"enabled": False}
    return {
        "enabled": True,
        "name": row.name,
        "title": row.title,
        "content": row.content,
    }
