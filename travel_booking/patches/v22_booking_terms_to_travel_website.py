# travel_booking/patches/v22_booking_terms_to_travel_website.py
#
# Pindah pemilihan T&C booking dari Travel Settings.booking_terms (field
# lama, shared merentasi site) ke Travel Website per-vertikal
# (cruise_booking_terms / tour_booking_terms).
#
# LATAR: trip.rarecation.com (tour) dan cruise.rarecation.com (cruise)
# KONGSI satu database — settings singleton manapun dikongsi. Field tunggal
# di Travel Settings memaksa SATU T&C untuk kedua-dua site. Field per-
# vertikal di Travel Website membolehkan T&C berbeza ikut site (konvensyen
# cruise_* / tour_* yang sedia ada dalam doctype tu).
#
# Migrasi: nilai lama (jika ada) dianggap pilihan semasa yang aktif —
# diletakkan ke medan CRUISE (nilai semasa dataset ini ialah dokumen
# RARECRUISE; site tour belum ada T&C tersendiri). Field lama dikosongkan
# supaya tiada dua tempat konfigurasi. Idempotent — selamat untuk kedua-
# dua site (yang migrate kedua akan nampak nilai kosong dan no-op).

import frappe


def execute():
    # BACA tabSingles TERUS (EAV) — get_single_value akan throw bila medan
    # booking_terms dah dibuang dari meta Travel Settings (sync JSON berlaku
    # SEBELUM patches dalam migrate).
    row = frappe.db.sql(
        "SELECT `value` FROM `tabSingles` "
        "WHERE doctype='Travel Settings' AND field='booking_terms' LIMIT 1"
    )
    old = (row[0][0] or "").strip() if row else ""
    if not old:
        return

    existing = (
        frappe.db.get_single_value("Travel Website", "cruise_booking_terms") or ""
    ).strip()
    if not existing:
        # tabSingles ialah EAV — nilai boleh ditulis walaupun sync JSON
        # medan tu belum berlaku pada site ni.
        frappe.db.set_single_value("Travel Website", "cruise_booking_terms", old)

    frappe.db.sql(
        "DELETE FROM `tabSingles` WHERE doctype='Travel Settings' AND field='booking_terms'"
    )

    # Cache config Travel Website di-cache per-site — kosongkan supaya
    # nilai baharu terus hidup tanpa menunggu cache expire.
    frappe.cache().delete_value("travel_website_config")
    frappe.clear_cache(doctype="Travel Website")
