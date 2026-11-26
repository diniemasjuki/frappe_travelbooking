# travel_booking/patches/v60_addon_offer_recondition.py
#
# RECONDITION TRIP ADDON (Nov 2026) — ganti keterkaitan doctype dalam
# ekosistem addon:
#   Trip Package     → Package Offer
#   Trip Group Date  → Travel Date
#
# Lajur ditukar nama (VALUES KEKAL) supaya sync skema selepas patch jumpa
# lajur yang betul, kemudian NILAI lama dipetakan ke rekod struktur baharu
# melalui anchor provenance cutover F4/F5:
#   Travel Date.legacy_tgd            ← nilai Trip Group Date lama
#   Package Offer.legacy_trip_package ← nilai Trip Package lama
#
# Meliputi TIGA jadual:
#   tabTrip Scoping        (child Trip Addon Package — scoping addon)
#   tabBooking Addon       (header order addon)
#   tabBooking Addon Item  (baris order addon)
#
# Nilai warisan yang TIADA padanan (rekod provenance dipadam) dikosongkan
# — elak Link dangling ke doctype lama. Baris scoping "trip sahaja" kekal
# tak terjejas (Link Trip tak berubah).
#
# WAJIB berjalan pada fasa pre_model_sync (sebelum JSON doctype disinkron)
# — didaftarkan di bahagian [pre_model_sync] patches.txt.

import frappe


# (doctype, old_column, new_column)
COLUMN_RENAMES = [
    ("Trip Scoping", "trip_package", "package_offer"),
    ("Trip Scoping", "group_date", "travel_date"),
    ("Trip Scoping", "group_date_name", "travel_date_name"),
    ("Trip Scoping", "package_title", "offer_name"),
    ("Booking Addon", "trip_package", "package_offer"),
    ("Booking Addon", "trip_date", "travel_date"),
    ("Booking Addon Item", "trip_package", "package_offer"),
    ("Booking Addon Item", "trip_date", "travel_date"),
]


def _column_exists(doctype: str, column: str) -> bool:
    return frappe.db.has_column(doctype, column)


def execute():
    # 1) RENAME LAJUR — nama baru ikut fieldname JSON baharu supaya sync
    #    skema tak cipta lajur kosong & tak buang data.
    for doctype, old, new in COLUMN_RENAMES:
        if _column_exists(doctype, old) and not _column_exists(doctype, new):
            frappe.db.rename_column(doctype, old, new)

    # 2) PEMETAAN NILAI — anchor provenance warisan → rekod struktur baharu.

    # 2a. Trip Group Date → Travel Date (legacy_tgd). Nama paparan
    #     (travel_date_name) hanya wujud pada child Trip Scoping.
    for table in ("tabTrip Scoping", "tabBooking Addon", "tabBooking Addon Item"):
        set_name = (", t.travel_date_name = td.travel_date_name"
                    if table == "tabTrip Scoping" else "")
        frappe.db.sql(f"""
            UPDATE `{table}` t
            JOIN `tabTravel Date` td ON td.legacy_tgd = t.travel_date
            SET t.travel_date = td.name{set_name}
            WHERE IFNULL(t.travel_date, '') != ''
        """)

    # 2b. Trip Package → Package Offer (legacy_trip_package). Baris scoping
    #     yang ada travel_date dipadankan lebih dulu kepada offer PADA
    #     travel date itu (kombinasi date+package); baris package-sahaja
    #     dipadankan ikut legacy + trip. Guard NOT IN (offer sah) — baris
    #     yang sudah menunjuk rekod baharu tidak disentuh (nilai warisan
    #     dan nama paparan tersimpan tidak menghalang pemetaan).
    frappe.db.sql("""
        UPDATE `tabTrip Scoping` ts
        JOIN `tabPackage Offer` po
            ON po.legacy_trip_package = ts.package_offer
            AND po.travel_date = ts.travel_date
        SET ts.package_offer = po.name, ts.offer_name = po.offer_name
        WHERE IFNULL(ts.package_offer, '') != '' AND IFNULL(ts.travel_date, '') != ''
    """)
    frappe.db.sql("""
        UPDATE `tabTrip Scoping` ts
        JOIN `tabPackage Offer` po
            ON po.legacy_trip_package = ts.package_offer
            AND po.trip = ts.trip
        SET ts.package_offer = po.name, ts.offer_name = po.offer_name
        WHERE IFNULL(ts.package_offer, '') != ''
            AND ts.package_offer NOT IN (SELECT name FROM `tabPackage Offer`)
    """)
    for table in ("tabBooking Addon", "tabBooking Addon Item"):
        frappe.db.sql(f"""
            UPDATE `{table}` t
            JOIN `tabPackage Offer` po
                ON po.legacy_trip_package = t.package_offer
                AND po.travel_date = t.travel_date
            SET t.package_offer = po.name
            WHERE IFNULL(t.package_offer, '') != ''
        """)

    # 3) BAKI TAK BERPADANAN — kosongkan (elak Link dangling ke doctype
    #    lama yang telah dibekukan) + nama paparan tanpa pautan.
    frappe.db.sql("""
        UPDATE `tabTrip Scoping` ts
        LEFT JOIN `tabTravel Date` td ON td.name = ts.travel_date
        SET ts.travel_date = '', ts.travel_date_name = ''
        WHERE IFNULL(ts.travel_date, '') != '' AND td.name IS NULL
    """)
    frappe.db.sql("""
        UPDATE `tabTrip Scoping` ts
        LEFT JOIN `tabPackage Offer` po ON po.name = ts.package_offer
        SET ts.package_offer = '', ts.offer_name = ''
        WHERE IFNULL(ts.package_offer, '') != '' AND po.name IS NULL
    """)
    for table in ("tabBooking Addon", "tabBooking Addon Item"):
        frappe.db.sql(f"""
            UPDATE `{table}` t
            LEFT JOIN `tabTravel Date` td ON td.name = t.travel_date
            SET t.travel_date = ''
            WHERE IFNULL(t.travel_date, '') != '' AND td.name IS NULL
        """)
        frappe.db.sql(f"""
            UPDATE `{table}` t
            LEFT JOIN `tabPackage Offer` po ON po.name = t.package_offer
            SET t.package_offer = ''
            WHERE IFNULL(t.package_offer, '') != '' AND po.name IS NULL
        """)

    frappe.db.commit()
