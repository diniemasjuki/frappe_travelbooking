# travel_booking/patches/v61_booking_item_backfill.py
#
# FASA 0 (booking-centric) — backfill baris Booking Item untuk SEMUA
# booking sedia ada, daripada item Sales Order. Parser description SO
# digunakan SATU KALI TERAKHIR di sini; selepas patch ini, sumber struktur
# ialah Booking Item (rujuk _booking_items_layout/_write_booking_items di
# api/so_helpers.py).
#
# Setiap baris SO TRAVEL-PKG (rate >= 0) dikembangkan kepada N baris
# per-traveller (qty), ber-stamp SO sumber (kunci idempotensi + penanda
# SO utama vs SO share):
#   - pax_type ternormalisasi: "Main Guest (Single)" → "Main Guest" +
#     rate_basis "Single"; akhiran "(Additional)" → rate_basis
#     "Additional"; label bersih → "Standard".
#   - unit_price = rate baris SO (harga beku asal).
#   - room_privacy = custom_room_privacy baris SO (kosong kekal kosong —
#     persetaraan tepat dengan parse lama).
#   - baris rate negatif (diskaun legacy pra-model PE deduction)
#     DILANGKAU — bukan barisan traveller.
#
# Idempoten: booking yang sudah mempunyai baris Booking Item di-skip —
# selamat dijalankan berulang. Kegagalan satu booking tidak menghalang
# yang lain (rollback booking itu sahaja + Error Log).
#
# Didaftar di bahagian [post_model_sync] patches.txt (perlukan doctype
# Booking Item wujud dahulu).

import frappe

from travel_booking.api.constants import TRAVEL_ITEM_CODE
from travel_booking.api.so_helpers import (
    _item_spec,
    _normalize_pax_type,
    _write_booking_items,
)


def _specs_from_so_items(items):
    """Specs per-traveller daripada baris SO (parse description toleran —
    segmen tambahan fare-note selepas pax_type diabaikan; balutan HTML
    Quill pada description SO lama yang diedit di Desk dibersihkan)."""
    specs = []
    for it in items:
        parts = (it.description or "").split(" | ")
        if len(parts) < 5:
            continue
        rate = float(it.rate or 0)
        if rate < 0:
            continue  # baris diskaun legacy — bukan barisan traveller
        room_category = parts[2].split("<")[0].strip()
        cabin_tag = parts[3].split("<")[0].strip()
        try:
            cabin_no = int(cabin_tag.lower().replace("cabin", "").strip())
        except Exception:
            continue
        if not room_category:
            continue
        pax_type, rate_basis = _normalize_pax_type(parts[4].split("<")[0].strip())
        room_privacy = it.get("custom_room_privacy") or ""
        for _ in range(max(1, int(it.qty or 1))):
            specs.append(_item_spec(room_category, cabin_no, pax_type, rate,
                                    rate_basis=rate_basis,
                                    room_privacy=room_privacy))
    return specs


def execute():
    bookings = frappe.get_all("Booking", pluck="name", order_by="creation asc")
    created_total, skipped, failed = 0, 0, []

    for bname in bookings:
        if frappe.db.exists("Booking Item", {"booking": bname}):
            skipped += 1
            continue

        sos = frappe.db.get_all(
            "Sales Order",
            filters={"custom_booking": bname, "docstatus": ["!=", 2]},
            pluck="name", order_by="creation asc",
        )
        wrote = 0
        try:
            for so_name in sos:
                items = frappe.db.get_all(
                    "Sales Order Item",
                    filters={"parent": so_name, "parenttype": "Sales Order",
                             "item_code": TRAVEL_ITEM_CODE},
                    fields=["description", "qty", "rate", "custom_room_privacy"],
                    order_by="idx",
                )
                specs = _specs_from_so_items(items)
                if not specs:
                    continue
                so_currency = frappe.db.get_value("Sales Order", so_name, "currency")
                # _write_booking_items tambah konteks parent (istable) +
                # idempoten ikut (booking, sales_order).
                wrote += len(_write_booking_items(bname, so_name, specs, so_currency))
            frappe.db.commit()
            created_total += wrote
        except Exception as e:
            # Rollback kerja booking INI sahaja (commit per-booking di atas
            # memastikan booking sebelumnya kekal) — log & teruskan.
            frappe.db.rollback()
            failed.append((bname, str(e)))
            frappe.log_error(
                title="Booking Item Backfill Failed",
                message="Booking " + str(bname) + ": " + str(e),
            )

    print("[v61_booking_item_backfill] bookings={0} rows_created={1} "
          "skipped_existing={2} failed={3}".format(
              len(bookings), created_total, skipped, len(failed)))
    for bname, err in failed:
        print("  FAILED {0}: {1}".format(bname, err))
