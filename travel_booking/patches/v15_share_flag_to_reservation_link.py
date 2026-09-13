"""Ganti flag Sales Order.custom_share_slot_activated dengan pautan
Booking Reservation.sales_order.

Reka bentuk baharu (rujuk api/cabin_sharing.py): idempotensi aktivasi
slot traveller tambahan dibawa oleh slot itu sendiri — setiap slot
Booking Reservation yang dicipta daripada SO share di-stamp dengan
sales_order SO sumbernya. Field Sales Order (Custom Field pada doctype
ERPNext) DIBUANG supaya form/list Sales Order bebas penanda teknikal.

Patch ni:
1. Backfill pautan untuk data sedia ada: setiap SO yang masih
   berflag=1 (aktivasi lama) dipadankan dengan slot reservation sedia
   adanya melalui booking + cabin_no + room_category (diparse dari
   description item SO — nilai sama yang digunakan masa slot dicipta),
   dengan pax_type sebagai penajam pertama dan dilepaskan bertingkat
   kalau tak cukup calon. Padanan ini HEURISTIK (flag lama tak simpan
   nama reservation) — kekurangan calon dilog ke Error Log untuk
   pemeriksaan manual.
2. Buang Custom Field Sales Order/custom_share_slot_activated beserta
   kolum datanya (helper rasmi frappe.model.delete_fields).

Kolum Booking Reservation.sales_order datang dari sync schema doctype
(field dalam doctype JSON) yang berlaku SEBELUM patch post_model_sync.

Idempoten — selamat dijalankan berulang. WAJIB berjalan bersama deploy
kod baharu (bench migrate) sebelum sebarang payment event: selepas
kolum dibuang, kod baharu mengesan "dah aktif" melalui pautan ni —
SO lama yang berflag tapi tak ter-backfill boleh diaktifkan semula
(double slot).
"""

import frappe
from frappe.model import delete_fields

# Snapshot nilai semasa patch ditulis — sengaja TIDAK diimport dari
# constants supaya semantik migration kekal tetap walaupun konstanta
# berubah pada masa depan.
_TRAVEL_ITEM_CODE = "TRAVEL-PKG"


def _parse_description(description):
    """'Trip | Group | Room Category | Cabin N | Pax Type | ...' →
    (room_category, cabin_no, pax_type_reservation) — transformasi sama
    dengan _activate_share_traveller_reservation."""
    parts = (description or "").split(" | ")
    if len(parts) < 5:
        return None, None, None
    try:
        cabin_no = int(parts[3].strip().lower().replace("cabin", "").strip())
    except ValueError:
        return None, None, None
    pax_type = parts[4].strip().replace(" (Additional)", "") or "Main Guest"
    return parts[2].strip(), cabin_no, pax_type


def _stamp_candidates(so_name, booking, cabin_no, room_category, pax_type, needed):
    """Stamp pautan sales_order pada slot sedia ada, bertingkat:
    (cabin, kategori, pax) → (cabin, kategori) → (cabin). Pulangkan
    bilangan yang berjaya di-stamp."""
    tiers = [
        {"cabin_no": cabin_no, "room_category": room_category, "pax_type": pax_type},
        {"cabin_no": cabin_no, "room_category": room_category},
        {"cabin_no": cabin_no},
    ]
    stamped = 0
    for extra_filter in tiers:
        if stamped >= needed:
            break
        filters = {"booking": booking, "sales_order": ["is", "Not Set"]}
        filters.update(extra_filter)
        candidates = frappe.get_all(
            "Booking Reservation", filters=filters,
            pluck="name", order_by="creation asc")
        for name in candidates[: needed - stamped]:
            frappe.db.set_value("Booking Reservation", name,
                                "sales_order", so_name,
                                update_modified=False)
            stamped += 1
    return stamped


def execute():
    if not frappe.db.has_column("Booking Reservation", "sales_order"):
        frappe.throw("Booking Reservation.sales_order belum di-sync oleh migrate")

    # 1. Backfill — hanya bila kolum flag lama MASIH wujud (site yang
    #    kolumnya telah dibuang lebih awal / site baharu: langkau terus).
    if not frappe.db.has_column("Sales Order", "custom_share_slot_activated"):
        rows = []
    else:
        rows = frappe.db.sql("""
        SELECT so.name AS so_name, so.custom_booking AS booking,
               soi.description AS description, soi.qty AS qty
        FROM `tabSales Order` so
        JOIN `tabSales Order Item` soi
             ON soi.parent = so.name AND soi.parenttype = 'Sales Order'
        WHERE soi.item_code = %s
          AND so.docstatus IN (0, 1)
          AND IFNULL(so.custom_share_slot_activated, 0) = 1
        ORDER BY so.creation ASC
    """, (_TRAVEL_ITEM_CODE,), as_dict=True)

    for row in rows:
        # SO primary tak pernah dikira share (flag lama atas SO utama
        # tak diambil kira mana-mana logik — rujuk patch v11).
        primary = frappe.db.get_value(
            "Sales Order", {"custom_booking": row.booking},
            "name", order_by="creation asc")
        if row.so_name == primary:
            continue
        room_category, cabin_no, pax_type = _parse_description(row.description)
        if not cabin_no:
            frappe.log_error(
                "Backfill share link: SO " + str(row.so_name) +
                " — cabin/kategori tak dapat diparse dari description. "
                "Pautan reservation perlu di-stamp manual.",
                "Share Slot Link Backfill")
            continue
        needed = max(1, int(row.qty or 1))
        stamped = _stamp_candidates(
            row.so_name, row.booking, cabin_no, room_category, pax_type, needed)
        if stamped < needed:
            frappe.log_error(
                "Backfill share link: SO " + str(row.so_name) +
                " — slot reservation padanan jumpa " + str(stamped) +
                "/" + str(needed) + " (booking " + str(row.booking) +
                ", cabin " + str(cabin_no) + "). Semak manual.",
                "Share Slot Link Backfill")

    # 2. Buang rekod Custom Field DAHULU — delete_fields TIDAK menyentuh
    # rekod ni; kalau tertinggal, sync meta seterusnya akan mencipta
    # semula kolum yang telah dibuang. Kemudian buang kolum datanya.
    cf_name = "Sales Order-custom_share_slot_activated"
    if frappe.db.exists("Custom Field", cf_name):
        frappe.delete_doc("Custom Field", cf_name, ignore_permissions=True)
    delete_fields({"Sales Order": ["custom_share_slot_activated"]}, delete=1)
