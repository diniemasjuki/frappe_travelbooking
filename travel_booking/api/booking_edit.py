# travel_booking/api/booking_edit.py
#
# FASA 1a (booking-centric) — enjin propagasi Booking → Sales Order,
# operasi PAX, laluan ADMIN (Manage Booking app).
#
#   get_booking_edit_state(booking)   — kabin/pax semasa + penghalang +
#                                       pilihan tambah (shareable cabins)
#   remove_booking_pax(...)           — buang pax: Booking Item + slot
#                                       reservation → Cancelled, item SO
#                                       utama dikemas kini IN-PLACE
#                                       (ChildItemUpdater ERPNext),
#                                       jadual bayaran/booking snapshot
#                                       dikira semula automatik oleh hook
#   add_booking_pax(...)              — tambah pax (balut teras
#                                       cabin_sharing; SO tambahan +
#                                       baris "Additional" + slot
#                                       diaktifkan bila dibayar)
#
# Prinsip kewangan (keputusan produk Fasa 1):
#   - Edit in-place pada SO utama untuk kes PENDING / SEPARA BAYAR —
#     grand_total + payment_schedule dikira semula oleh ERPNext; bayaran
#     sedia ada (PE) KEKAL — baki berlebihan dilaporkan sebagai
#     credit_balance TANPA auto-refund (admin urus refund manual).
#   - Kes PENUH + BERINVOIS (Sales Invoice bukan-cancelled wujud untuk
#     SO utama) DISEKAT — baris ber-billed tidak boleh dipinda selamat;
#     guna laluan refund manual sedia ada.
#   - booked_pax kekal dikira daripada qty SO — edit in-place
#     menjaga kebenarannya.

import frappe

from travel_booking.api.constants import TRAVEL_ITEM_CODE, UPGRADE_ITEM_CODE
from travel_booking.api.cabin_sharing import (
    _booking_pricing_map,
    _create_additional_traveller_order_core,
    _share_context_core,
    _shareable_cabins_core,
)
from travel_booking.api.manage_trip_booking import _require_access
from travel_booking.api.pricing import (
    _get_offer_pricing_map,
    _get_pricing_map,
    _validate_selection_capacity,
)
from travel_booking.api.so_helpers import (
    _build_item_specs,
    _get_all_booking_sales_orders,
    _get_or_create_travel_item,
    _get_primary_so,
    _link_booking_sales_order,
    _resolve_so_currency_and_rate,
    _so_items_from_specs,
    _write_booking_items,
)

from frappe import _

_EPS = 0.01

# Pemetaan (pax_type, rate_basis) → medan harga Trip Package Price /
# Price Matrix offer — untuk kira kadar baharu bila tukar kategori.
_PAX_PRICE_FIELD = {
    ("Main Guest", "Single"):   "price_adult_single",
    ("Main Guest", "Standard"): "price_adult",
    ("Extra Bed", "Standard"):  "price_upperberth",
    ("Infant", "Standard"):     "price_infant",
    ("Adult", "Standard"):      "price_adult",
    ("Children", "Standard"):   "price_children",
}


# ══════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════

def _load_booking(booking: str) -> frappe._dict:
    """Booking oleh NAMA dokumen ATAU booking_number — dan pastikan
    wujud. (_require_access dipanggil oleh setiap endpoint.)"""
    name = booking
    if not frappe.db.exists("Booking", booking):
        name = frappe.db.get_value("Booking", {"booking_number": booking}, "name")
    if not name:
        frappe.throw(_("Booking {0} not found.").format(booking))
    return frappe.db.get_value(
        "Booking", name,
        ["name", "booking_number", "status", "payment_status", "booked_pax",
         "trip_package", "package_offer", "trip_date", "customer",
         "is_a_cruise_trip", "booking_channel", "voucher"],
        as_dict=True,
    )


def _primary_so_invoiced(so_name: str) -> bool:
    """SI bukan-cancelled yang merujuk SO utama — baris ber-billed tidak
    boleh dipinda selamat (guard ChildItemUpdater + realiti GL)."""
    return bool(frappe.db.sql("""
        SELECT sii.name
        FROM `tabSales Invoice Item` sii
        JOIN `tabSales Invoice` si ON si.name = sii.parent
        WHERE sii.sales_order = %s AND si.docstatus != 2
        LIMIT 1
    """, (so_name,)))


def _so_state(so_name: str) -> dict:
    """Klasifikasi keadaan kewangan SO utama untuk UI + guard."""
    so = frappe.db.get_value(
        "Sales Order", so_name,
        ["docstatus", "grand_total", "advance_paid", "currency"], as_dict=True)
    if not so:
        return {"state": "missing"}
    invoiced = _primary_so_invoiced(so_name)
    paid = float(so.advance_paid or 0) >= float(so.grand_total or 0) - _EPS
    if invoiced:
        state = "paid_invoiced"
    elif paid and float(so.grand_total or 0) > 0:
        state = "paid_uninvoiced"
    elif float(so.advance_paid or 0) > _EPS:
        state = "partial"
    else:
        state = "unpaid"
    return {
        "state": state,
        "docstatus": so.docstatus,
        "grand_total": float(so.grand_total or 0),
        "advance_paid": float(so.advance_paid or 0),
        "currency": so.currency,
        "invoiced": invoiced,
    }


def _pending_share_sos(booking_name: str, primary_so: str) -> list:
    """SO traveller tambahan yang belum diaktifkan (belum bayar penuh) —
    makluman sahaja: penghuni PENDING tak kelihatan pada slot."""
    return frappe.db.sql("""
        SELECT so.name
        FROM `tabSales Order` so
        INNER JOIN `tabBooking Sales Order` reg
            ON reg.sales_order = so.name AND reg.parenttype = 'Booking'
        WHERE reg.parent = %s AND so.docstatus = 1 AND so.name != %s
          AND EXISTS (SELECT 1 FROM `tabSales Order Item` soi
                      WHERE soi.parent = so.name AND soi.item_code = %s)
          AND NOT EXISTS (SELECT 1 FROM `tabBooking Reservation` br
                          WHERE br.sales_order = so.name)
    """, (booking_name, primary_so or "", TRAVEL_ITEM_CODE), as_dict=True)


def _cabin_rows(booking_name: str, primary_so: str) -> list:
    """Baris Booking Item SO utama dikumpul ikut kabin — untuk state UI
    dan pemilihan baris buang."""
    rows = frappe.get_all(
        "Booking Item",
        filters={"booking": booking_name, "sales_order": primary_so,
                 "status": ["!=", "Cancelled"]},
        fields=["name", "room_category", "cabin_no", "pax_type",
                "rate_basis", "room_privacy", "unit_price", "traveller"],
        order_by="idx asc",
    )
    cabins = {}
    for r in rows:
        key = int(r.cabin_no or 0)
        cab = cabins.setdefault(key, {
            "cabin_no": key,
            "room_category": r.room_category,
            "room_privacy": r.room_privacy,
            "items": [],
        })
        cab["items"].append(r)
    return [cabins[k] for k in sorted(cabins.keys())]


def _pax_label(row) -> str:
    """Label pax SO untuk padan description — cermin _so_items_from_specs."""
    return row.pax_type + (" (Single)" if (row.rate_basis or "Standard") == "Single" else "")


def _cabin_all_items(booking_name: str, cabin_no: int) -> list:
    """SEMUA baris Booking Item aktif satu kabin (SO utama + SO share) —
    untuk semakan komposisi; baris Additional belum aktif juga dikira
    (mereka penghuni komersial kabin itu)."""
    return frappe.get_all(
        "Booking Item",
        filters={"booking": booking_name, "status": ["!=", "Cancelled"],
                 "cabin_no": int(cabin_no)},
        fields=["name", "pax_type"],
        order_by="idx asc",
    )


def _removal_block_reason(cabin: dict, pax_type: str, qty: int) -> str | None:
    """Peraturan komposisi kabin selepas pembuangan — cermin
    _validate_selection_capacity (Extra Bed/Infant perlukan ≥1
    Main/Adult), dikira atas SEMUA baris kabin (termasuk Additional)."""
    same = [r for r in cabin["items"] if r.pax_type == pax_type]
    remain = [r for r in cabin["items"] if r.pax_type != pax_type] + same[qty:]
    if not remain:
        return None  # kabin kosong sepenuhnya dibenarkan (kabin dibuang)
    has_main = any(r.pax_type in ("Main Guest", "Adult") for r in remain)
    if not has_main:
        return ("Cabin {0} would be left without a main guest — extra bed / "
                "infant slots require at least one main guest.").format(cabin["cabin_no"])
    return None


# ══════════════════════════════════════════════
# STATE (untuk dialog admin)
# ══════════════════════════════════════════════

@frappe.whitelist()
def get_booking_edit_state(booking: str) -> dict:
    """Kabin/pax semasa + keadaan SO + penghalang + pilihan tambah —
    untuk dialog 'Edit Pax' pada Manage Booking app (L3)."""
    _require_access()
    b = _load_booking(booking)

    primary_so = _get_primary_so(b.name)
    blocked = []
    if b.status in ("Cancelled", "Abandoned"):
        blocked.append("Booking is {0}.".format(b.status))
    if not primary_so:
        blocked.append("Primary Sales Order not found.")
        so_state = {"state": "missing"}
    else:
        so_state = _so_state(primary_so)
        if so_state["state"] == "paid_invoiced":
            blocked.append(
                "Booking is fully paid and invoiced — structural edits are "
                "locked. Use the manual refund flow instead.")

    pending_share = _pending_share_sos(b.name, primary_so) if primary_so else []
    if pending_share:
        blocked.append(
            "{0} pending add-traveller order(s) not yet paid — settle or "
            "cancel them first.".format(len(pending_share)))

    cabins = []
    # [Fasa 1d] Kabin + pilihan kategori dikira JUGA bila PENGHALANG
    # tunggal ialah paid_invoiced — dialog Edit Pax guna pilihan ni untuk
    # laluan SO tambahan "Upgrade" (create_cabin_upgrade_order). Laluan
    # in-place (buang/tambah/tukar kategori) kekal disekat — blocked
    # kekal dipapar kepada operator.
    invoiced_only = bool(
        primary_so and so_state.get("state") == "paid_invoiced" and len(blocked) == 1)
    if primary_so and (not blocked or invoiced_only):
        pricing_map = _booking_pricing_map(b)
        is_cruise = bool(b.is_a_cruise_trip)
        for cab in _cabin_rows(b.name, primary_so):
            pax_counts = {}
            for r in cab["items"]:
                pax_counts.setdefault(r.pax_type, {"count": 0, "unit_price": r.unit_price,
                                                   "rate_basis": r.rate_basis})
                pax_counts[r.pax_type]["count"] += 1
            cabin_entry = {
                "cabin_no": cab["cabin_no"],
                "room_category": cab["room_category"],
                "room_privacy": cab["room_privacy"],
                "pax": [{"pax_type": pt, "count": v["count"],
                         "unit_price": v["unit_price"], "rate_basis": v["rate_basis"]}
                        for pt, v in sorted(pax_counts.items())],
            }

            # Kategori calon (Fasa 1b) — preview harga/delta/eligibility
            # TANPA mutasi; gate berlock sebenar berlaku masa change.
            current_total = sum(float(r.unit_price or 0) for r in cab["items"])
            comp = _cabin_composition(cab["items"])
            share_blocked = bool(frappe.db.count(
                "Booking Item",
                {"booking": b.name, "status": ["!=", "Cancelled"],
                 "cabin_no": int(cab["cabin_no"]),
                 "sales_order": ["!=", primary_so]})) or bool(frappe.db.count(
                "Booking Reservation",
                {"booking": b.name, "status": ["!=", "Cancelled"],
                 "cabin_no": int(cab["cabin_no"]), "sales_order": ["is", "set"]}))
            category_options = []
            for cat_name, price in sorted(pricing_map.items()):
                if cat_name == cab["room_category"]:
                    continue
                rates, missing = _category_rates(price, cab["items"])
                if rates is None:
                    category_options.append({
                        "category": cat_name, "eligible": False,
                        "reason": _("No rate: {0}").format(", ".join(sorted(set(missing)))),
                        "new_total": None, "delta": None,
                    })
                    continue
                new_total = sum(nr for _r, nr in rates)
                reason = ""
                eligible = True
                if share_blocked:
                    eligible, reason = False, _("Has additional-traveller orders")
                else:
                    try:
                        _validate_selection_capacity(
                            [dict(comp, room_category=cat_name)],
                            _cabin_info_map(cat_name), is_cruise)
                    except Exception as e:
                        eligible, reason = False, str(e)
                    if eligible:
                        # Kolam mengira KABIN — tukar kategori bilik ini
                        # perlukan SATU kabin kelas sasaran (tetamu
                        # berkongsi kabin, bukan satu penumpang satu slot).
                        pool = _offer_pool_available(b, cat_name)
                        if pool is not None and pool < 1:
                            eligible = False
                            reason = _("Only {0} cabin(s) left on this sailing").format(max(0, pool))
                category_options.append({
                    "category": cat_name,
                    "eligible": eligible,
                    "reason": reason,
                    "new_total": round(new_total, 2),
                    "delta": round(new_total - current_total, 2),
                })
            cabin_entry["category_options"] = category_options
            cabins.append(cabin_entry)

    add_options = None
    if not blocked and b.is_a_cruise_trip:
        try:
            ctx = _share_context_core(b)
            add_options = _shareable_cabins_core(ctx)
        except Exception as e:
            # shareable tak tersedia (cth tiada reservation aktif) — buang
            # sahaja yang ditawarkan; jangan gagalkan state.
            add_options = {"unavailable": str(e)}

    return {
        "booking": b.name,
        "booking_number": b.booking_number,
        "status": b.status,
        "booked_pax": b.booked_pax,
        "primary_so": primary_so,
        "so_state": so_state,
        "blocked": blocked,
        "cabins": cabins,
        "add_options": add_options,
    }


# ══════════════════════════════════════════════
# BUANG PAX (propagasi Booking Item → SO in-place)
# ══════════════════════════════════════════════

@frappe.whitelist()
def remove_booking_pax(booking: str, cabin_no: int, pax_type: str,
                       qty: int = 1, reason: str = "") -> dict:
    """Buang `qty` pax (pax_type) daripada satu kabin — SO UTAMA sahaja.

    Rantaian propagasi (SATU transaksi):
      1. Baris Booking Item dipilih (Active, SO utama) → status Cancelled.
      2. Slot reservation berpadanan → Cancelled (slot tanpa traveller
         didahulukan, kemudian dokumen paling tidak lengkap) — hook
         mengira semula ketersediaan kabin/seat penerbangan automatik.
      3. Item SO utama dikemas kini IN-PLACE melalui ChildItemUpdater
         ERPNext (qty dikurangkan / baris dibuang) — grand_total,
         payment_schedule, status SO + snapshot Booking (booked_pax,
         payment_status) dikira semula AUTOMATIK oleh hook
         on_update_after_submit → _recompute_booking_status.
      4. Baki berlebihan (advance_paid > grand_total baharu) DILAPORKAN
         sebagai credit_balance — TIADA auto-refund (keputusan produk).

    DISEKAT: booking Cancelled/Abandoned, SO utama berinvois (paid_
    invoiced), komposisi kabin jadi tak sah, atau semua pax habis.
    """
    _require_access()
    b = _load_booking(booking)
    reason = (reason or "").strip()
    if not reason:
        frappe.throw(_("A reason is required for removing a guest."))
    qty = int(qty or 1)
    if qty < 1:
        frappe.throw(_("Quantity must be at least 1."))
    pax_type = (pax_type or "").strip()

    if b.status in ("Cancelled", "Abandoned"):
        frappe.throw(_("Cannot edit a {0} booking.").format(b.status))

    primary_so = _get_primary_so(b.name)
    if not primary_so:
        frappe.throw(_("Primary Sales Order not found."))

    so_state = _so_state(primary_so)
    if so_state["state"] == "paid_invoiced":
        frappe.throw(
            _("Booking is fully paid and invoiced — structural edits are "
              "locked. Use the manual refund flow instead."),
            title=_("Booking Invoiced"))

    cabins = _cabin_rows(b.name, primary_so)
    cabin = next((c for c in cabins if int(c["cabin_no"]) == int(cabin_no)), None)
    if not cabin:
        frappe.throw(_("Cabin {0} not found in this booking.").format(cabin_no))
    rows = [r for r in cabin["items"] if r.pax_type == pax_type]
    if len(rows) < qty:
        frappe.throw(_("Cabin {0} only has {1} '{2}' row(s).")
                     .format(cabin_no, len(rows), pax_type))

    # Jangan biarkan booking kosong sama sekali — kira SEMUA baris aktif
    # (SO utama + SO share: baris Additional belum aktif tetap penghuni
    # komersial booking ini).
    total_active = frappe.db.count(
        "Booking Item", {"booking": b.name, "status": ["!=", "Cancelled"]})
    if total_active - qty < 1:
        frappe.throw(_("A booking must keep at least one guest."))

    # Komposisi kabin selepas pembuangan — atas SEMUA baris kabin itu
    # (termasuk Additional daripada SO share).
    cabin_all = {"cabin_no": cabin["cabin_no"],
                 "items": _cabin_all_items(b.name, cabin_no)}
    block = _removal_block_reason(cabin_all, pax_type, qty)
    if block:
        frappe.throw(_(block))

    # ── 0. Sahkan item SO utama SEBELUM sebarang mutasi ─────────────
    # (Semua guard di awal supaya kegagalan tidak meninggalkan kerja
    # separuh sihat — pesanan "tiada perubahan" sentiasa benar.)
    label = _pax_label(rows[0])
    so_items = frappe.db.get_all(
        "Sales Order Item",
        filters={"parent": primary_so, "parenttype": "Sales Order"},
        fields=["name", "item_code", "item_name", "qty", "rate", "uom",
                "description", "conversion_factor", "custom_room_privacy"],
        order_by="idx",
    )
    matched = []
    for it in so_items:
        parts = (it.description or "").split(" | ")
        if (len(parts) >= 5
                and parts[2].strip() == cabin["room_category"]
                and parts[3].strip().lower() == ("cabin " + str(int(cabin_no)))
                and parts[4].strip() == label):
            matched.append(it)
    if not matched:
        frappe.throw(_("Matching Sales Order line not found for cabin {0} "
                       "({1}). No changes were made.").format(cabin_no, label))

    matched_total_qty = sum(int(m.qty or 0) for m in matched)
    if matched_total_qty < qty:
        frappe.throw(_("Sales Order line quantity ({0}) is less than the "
                       "requested removal.").format(matched_total_qty))

    # SO utama mesti KEKAL ≥1 barisan traveller (jadual items SO tidak
    # boleh kosong — MandatoryError ERPNext). Baris share/additional
    # tidak membantu: mereka pada SO berasingan.
    travel_pkg_qty = sum(
        int(it.qty or 0) for it in so_items if it.item_code == TRAVEL_ITEM_CODE)
    if travel_pkg_qty - qty < 1:
        frappe.throw(
            _("Removing this guest would empty the original Sales Order. "
              "If the whole original booking should be cancelled, use the "
              "booking cancellation flow instead."),
            title=_("Original Order Would Be Empty"))

    # Kurangkan daripada baris pertama yang padan (baris single biasanya
    # qty=1; baris agregat qty=N).
    remaining_to_remove = qty
    new_items = []
    for it in so_items:
        if it in matched and remaining_to_remove > 0:
            take = min(remaining_to_remove, int(it.qty or 0))
            remaining_to_remove -= take
            new_qty = int(it.qty or 0) - take
            if new_qty <= 0:
                continue  # baris dibuang daripada senarai → padam
            new_items.append({
                "docname": it.name,
                "item_code": it.item_code,
                "qty": new_qty,
                "rate": float(it.rate or 0),
                "description": it.description,
                "uom": it.uom,
                "conversion_factor": it.conversion_factor,
            })
        else:
            new_items.append({
                "docname": it.name,
                "item_code": it.item_code,
                "qty": float(it.qty or 0),
                "rate": float(it.rate or 0),
                "description": it.description,
                "uom": it.uom,
                "conversion_factor": it.conversion_factor,
            })

    # ── 1. Batalkan baris Booking Item ──────────────────────────────
    removed_items = []
    for r in rows[:qty]:
        doc = frappe.get_doc("Booking Item", r.name)
        doc.status = "Cancelled"
        doc.save(ignore_permissions=True)
        removed_items.append(r.name)

    # ── 2. Slot reservation berpadanan → Cancelled ──────────────────
    # Keutamaan: slot TANPA traveller dahulu, kemudian dokumen paling
    # tidak lengkap, kemudian terlama (stabil).
    res = frappe.get_all(
        "Booking Reservation",
        filters={"booking": b.name, "status": ["!=", "Cancelled"],
                 "cabin_no": int(cabin_no), "pax_type": pax_type},
        fields=["name", "traveller", "document_status", "creation"],
    )
    res.sort(key=lambda r: (
        0 if not r.traveller else 1,
        {"Incomplete": 0, "Open for Update": 1, "Pending Verification": 2,
         "Verified": 3}.get(r.document_status, 4),
        r.creation or "",
    ))
    removed_reservations = []
    for r in res[:qty]:
        rdoc = frappe.get_doc("Booking Reservation", r.name)
        rdoc.status = "Cancelled"
        rdoc.save(ignore_permissions=True)
        removed_reservations.append(r.name)

    # ── 3. Kemas kini item SO utama IN-PLACE ────────────────────────
    # Senarai `new_items` telah dibina di langkah 0 (pra-mutasi).
    # ChildItemUpdater memadam baris yang TIADA dalam senarai,
    # mengemas kini baris ber-docname, mengira semula grand_total /
    # payment_schedule / status, dan hook on_update_after_submit
    # menyegar semula snapshot Booking secara automatik.
    from erpnext.accounts.services.child_item_update import ChildItemUpdater
    _original_user = frappe.local.session.user
    frappe.local.session.user = "Administrator"
    try:
        ChildItemUpdater("Sales Order", primary_so, "items").update(new_items)
        frappe.db.commit()
    finally:
        frappe.local.session.user = _original_user

    # ── 4. Baca semula hasil propagasi (hook dah jalan dalam-process) ─
    so_after = frappe.db.get_value(
        "Sales Order", primary_so,
        ["grand_total", "advance_paid", "currency", "status"], as_dict=True)
    b_after = frappe.db.get_value(
        "Booking", b.name,
        ["booked_pax", "payment_status", "status"], as_dict=True)
    credit_balance = round(
        float(so_after.advance_paid or 0) - float(so_after.grand_total or 0), 2)

    # ── 5. Audit ────────────────────────────────────────────────────
    _audit_edit(
        b.name,
        title="Pax Removed",
        reason=reason,
        details=("Removed {0} × '{1}' from Cabin {2} ({3}). "
                 "Items: {4}. Reservations: {5}. New SO total: {6} {7}.")
                .format(qty, pax_type, cabin_no, cabin["room_category"],
                        ", ".join(removed_items),
                        ", ".join(removed_reservations) or "-",
                        so_after.currency, so_after.grand_total),
        credit_balance=credit_balance,
    )

    return {
        "success": True,
        "removed_items": removed_items,
        "removed_reservations": removed_reservations,
        "sales_order": primary_so,
        "grand_total": float(so_after.grand_total or 0),
        "advance_paid": float(so_after.advance_paid or 0),
        "credit_balance": max(0.0, credit_balance),
        "currency": so_after.currency,
        "booked_pax": b_after.booked_pax,
        "payment_status": b_after.payment_status,
    }


# ══════════════════════════════════════════════
# TAMBAH PAX (admin — balut teras cabin_sharing)
# ══════════════════════════════════════════════

@frappe.whitelist()
def add_booking_pax(booking: str, cabin_no: int, category: str,
                    reason: str = "") -> dict:
    """Tambah 1 traveller ke kabin sedia ada — LALUAN ADMIN (gate
    _require_access, bukan ownership portal). Mekanik penuh cabin_sharing:
    SO tambahan (berdaftar pada registri Booking.sales_orders), baris
    Booking Item "Additional", slot
    reservation diaktifkan bila SO dibayar penuh. `category` =
    main_adult / extra_bed / infant."""
    _require_access()
    b = _load_booking(booking)
    reason = (reason or "").strip()
    if not reason:
        frappe.throw(_("A reason is required for adding a guest."))

    if b.status in ("Cancelled", "Abandoned"):
        frappe.throw(_("Cannot edit a {0} booking.").format(b.status))

    ctx = _share_context_core(b)
    result = _create_additional_traveller_order_core(ctx, cabin_no, category)

    _audit_edit(
        b.name,
        title="Pax Added",
        reason=reason,
        details=("Added 1 '{0}' to Cabin {1} — SO {2} ({3} {4}).")
                .format(category, cabin_no, result.get("sales_order"),
                        result.get("currency"), result.get("grand_total")),
        credit_balance=None,
    )
    return result


# ══════════════════════════════════════════════
# TUKAR ROOM CATEGORY (Fasa 1b — propagasi penuh)
# ══════════════════════════════════════════════

def _cabin_composition(rows: list) -> dict:
    """{main_guests, extra_beds, infants} daripada baris Booking Item
    kabin — format selections untuk _validate_selection_capacity /
    check_offer_capacity."""
    comp = {"main_guests": 0, "extra_beds": 0, "infants": 0}
    for r in rows:
        if r.pax_type in ("Main Guest", "Adult"):
            comp["main_guests"] += 1
        elif r.pax_type in ("Extra Bed", "Children"):
            comp["extra_beds"] += 1
        elif r.pax_type == "Infant":
            comp["infants"] += 1
    return comp


def _category_rates(price, rows: list):
    """Kadar baharu setiap baris kabin untuk SATU kategori calon.
    Return (rates, missing_fields): rates = [(row, new_rate)], atau
    (None, [medan harga yang tiada]) bila komposisi tak boleh diharga."""
    rates, missing = [], []
    for r in rows:
        field = _PAX_PRICE_FIELD.get((r.pax_type, r.rate_basis or "Standard")) \
            or _PAX_PRICE_FIELD.get((r.pax_type, "Standard"))
        if not field:
            missing.append("{0} ({1})".format(r.pax_type, r.rate_basis))
            continue
        value = price.get(field)
        if value is None:
            missing.append(field)
            continue
        rates.append((r, float(value)))
    if missing:
        return None, missing
    return rates, []


def _offer_pool_available(booking: frappe._dict, room_category: str) -> int | None:
    """Baca ketersediaan kolam cabin_rates offer untuk kategori (preview
    TANPA lock — gate berlock sebenar check_offer_capacity berlaku masa
    change). None = tiada kolam (offer darat / legacy) — tiada had."""
    if not booking.package_offer:
        return None
    from travel_booking.utils.flags import use_package_offers
    if not use_package_offers():
        return None
    schedule = frappe.db.get_value("Package Offer", booking.package_offer, "cruise_schedule")
    if not schedule:
        return None
    row = frappe.db.get_value(
        "Trip Package Price",
        {"parent": schedule, "parenttype": "Trip Cruise Schedule",
         "pricing_for_class": room_category},
        ["cabin_allotment", "cabin_occupancy"], as_dict=True)
    if not row:
        return 0
    return int(row.cabin_allotment or 0) - int(row.cabin_occupancy or 0)


def _cabin_info_map(room_category: str) -> dict:
    """{category: {capacity, max_capacity}} untuk _validate_selection_capacity."""
    row = frappe.db.get_value(
        "Trip Price Category", room_category,
        ["capacity", "max_capacity"], as_dict=True) or frappe._dict()
    return {room_category: {
        "capacity": int(row.capacity or 2),
        "max_capacity": int(row.max_capacity) if row.max_capacity is not None else int(row.capacity or 2),
    }}


@frappe.whitelist()
def change_booking_cabin_category(booking: str, cabin_no: int,
                                  new_category: str, reason: str = "") -> dict:
    """Tukar room category SATU kabin — propagasi penuh Booking → SO:

      1. Baris Booking Item kabin (SO utama): room_category + unit_price
         dikemas kini (harga semasa kategori baharu, offer/legacy).
      2. Setiap slot reservation kabin: room_category baharu, disimpan
         dengan flags.skip_cabin_capacity_validation (kapasiti/mismatch
         sudah divalidasi pra-mutasi) — hook sync_cabin_availability
         mengira semula KEDUA-DUA kolam (lama terbebas, baharu diduduki).
      3. Item SO utama berpadanan kabin: description (kategori diganti,
         segmen trip|group dikekalkan) + rate baharu — ChildItemUpdater
         in-place → grand_total/payment_schedule/snapshot Booking
         automatik.

    Pra-validasi (sebelum sebarang mutasi): kategori wujud + boleh
    diharga untuk komposisi kabin; kapasiti kategori baharu
    (_validate_selection_capacity); kolam offer (check_offer_capacity,
    offer-mode sahaja); baris SO padan; kabin TANPA baris share.

    credit_balance dilaporkan tanpa auto-refund (corak 1a).
    """
    _require_access()
    b = _load_booking(booking)
    reason = (reason or "").strip()
    if not reason:
        frappe.throw(_("A reason is required for changing the room category."))
    new_category = (new_category or "").strip()
    if not new_category:
        frappe.throw(_("Please choose a new room category."))

    if b.status in ("Cancelled", "Abandoned"):
        frappe.throw(_("Cannot edit a {0} booking.").format(b.status))

    primary_so = _get_primary_so(b.name)
    if not primary_so:
        frappe.throw(_("Primary Sales Order not found."))
    if _so_state(primary_so)["state"] == "paid_invoiced":
        frappe.throw(
            _("Booking is fully paid and invoiced — structural edits are "
              "locked. Use the manual refund flow instead."),
            title=_("Booking Invoiced"))

    cabins = _cabin_rows(b.name, primary_so)
    cabin = next((c for c in cabins if int(c["cabin_no"]) == int(cabin_no)), None)
    if not cabin:
        frappe.throw(_("Cabin {0} not found in this booking.").format(cabin_no))
    rows = cabin["items"]
    if not rows:
        frappe.throw(_("Cabin {0} has no bookable rows.").format(cabin_no))
    old_category = cabin["room_category"]
    if new_category == old_category:
        frappe.throw(_("Cabin {0} is already {1}.").format(cabin_no, old_category))

    # Kabin TANPA baris share — SO tambahan membawa kategori lama dalam
    # description sendiri (v1: urus di Desk / settle dahulu).
    share_rows = frappe.db.count(
        "Booking Item",
        {"booking": b.name, "status": ["!=", "Cancelled"],
         "cabin_no": int(cabin_no), "sales_order": ["!=", primary_so]})
    if share_rows:
        frappe.throw(
            _("Cabin {0} has additional-traveller orders — settle or cancel "
              "them before changing the room category.").format(cabin_no))
    stamped_slots = frappe.db.count(
        "Booking Reservation",
        {"booking": b.name, "status": ["!=", "Cancelled"],
         "cabin_no": int(cabin_no), "sales_order": ["is", "set"]})
    if stamped_slots:
        frappe.throw(
            _("Cabin {0} has activated additional-traveller slots — manage "
              "them from Desk before changing the room category.").format(cabin_no))

    # ── Pra-validasi harga / kapasiti / kolam offer ───────────────────
    if not frappe.db.exists("Trip Price Category", new_category):
        frappe.throw(_("Room category {0} not found.").format(new_category))

    pricing_map = _booking_pricing_map(b)
    price = pricing_map.get(new_category)
    if not price:
        frappe.throw(_("No current pricing found for {0}.").format(new_category))

    rates, missing = _category_rates(price, rows)
    if missing:
        frappe.throw(
            _("Cannot price this cabin in {0}: missing {1}.").format(
                new_category, ", ".join(sorted(set(missing)))))

    comp = _cabin_composition(rows)
    _validate_selection_capacity(
        [dict(comp, room_category=new_category)],
        _cabin_info_map(new_category),
        bool(b.is_a_cruise_trip),
    )

    if b.package_offer:
        from travel_booking.utils.flags import use_package_offers
        if use_package_offers():
            from travel_booking.utils.offer_factory import check_offer_capacity
            check_offer_capacity(b.package_offer,
                                 [dict(comp, room_category=new_category)])

    # ── Padan baris SO ikut kabin (segmen description) ────────────────
    so_items = frappe.db.get_all(
        "Sales Order Item",
        filters={"parent": primary_so, "parenttype": "Sales Order"},
        fields=["name", "item_code", "qty", "rate", "uom",
                "description", "conversion_factor"],
        order_by="idx",
    )
    cabin_tag = "cabin " + str(int(cabin_no))
    cabin_lines = []
    for it in so_items:
        parts = (it.description or "").split(" | ")
        if (len(parts) >= 5
                and parts[2].strip() == old_category
                and parts[3].strip().lower() == cabin_tag):
            cabin_lines.append(it)
    if not cabin_lines:
        frappe.throw(_("Matching Sales Order lines not found for cabin {0}. "
                       "No changes were made.").format(cabin_no))

    # ── Mutasi 1: baris Booking Item ──────────────────────────────────
    for r, new_rate in rates:
        doc = frappe.get_doc("Booking Item", r.name)
        doc.room_category = new_category
        doc.unit_price = new_rate
        doc.save(ignore_permissions=True)

    # ── Mutasi 2: slot reservation (skip flag — pra-divalidasi) ───────
    res_names = frappe.get_all(
        "Booking Reservation",
        filters={"booking": b.name, "status": ["!=", "Cancelled"],
                 "cabin_no": int(cabin_no)},
        pluck="name",
    )
    for res_name in res_names:
        rdoc = frappe.get_doc("Booking Reservation", res_name)
        rdoc.room_category = new_category
        # Kapasiti + konsistensi kategori kabin sudah divalidasi
        # pra-mutasi (_validate_selection_capacity) — skip guard supaya
        # simpan berjujukan tidak tersentuh mismatch sementara; hook
        # ketersediaan kekal berjalan (kira semula kolam lama + baharu).
        rdoc.flags.skip_cabin_capacity_validation = True
        rdoc.save(ignore_permissions=True)

    # ── Mutasi 3: item SO in-place (description + rate baharu) ────────
    new_items = []
    rate_by_label = {}
    for r, new_rate in rates:
        rate_by_label[_pax_label(r)] = new_rate
    for it in so_items:
        parts = (it.description or "").split(" | ")
        if it in cabin_lines:
            parts[2] = " " + new_category + " "
            description = " | ".join(parts)
            label = parts[4].strip() if len(parts) >= 5 else ""
            new_rate = rate_by_label.get(label, float(it.rate or 0))
            new_items.append({
                "docname": it.name,
                "item_code": it.item_code,
                "qty": float(it.qty or 0),
                "rate": new_rate,
                "description": description,
                "uom": it.uom,
                "conversion_factor": it.conversion_factor,
            })
        else:
            new_items.append({
                "docname": it.name,
                "item_code": it.item_code,
                "qty": float(it.qty or 0),
                "rate": float(it.rate or 0),
                "description": it.description,
                "uom": it.uom,
                "conversion_factor": it.conversion_factor,
            })

    from erpnext.accounts.services.child_item_update import ChildItemUpdater
    _original_user = frappe.local.session.user
    frappe.local.session.user = "Administrator"
    try:
        ChildItemUpdater("Sales Order", primary_so, "items").update(new_items)
        # ChildItemUpdater mengemas kini description + rate sahaja —
        # item_name (paparan portal/dokumen) kekal kategori lama. Medan
        # paparan semata-mata; selaraskan ikut format _so_line
        # ("Category (Cabin N) — Pax Type").
        for it in cabin_lines:
            parts = (it.description or "").split(" | ")
            label = parts[4].strip() if len(parts) >= 5 else ""
            frappe.db.set_value(
                "Sales Order Item", it.name, "item_name",
                "{0} (Cabin {1}) \u2014 {2}".format(
                    new_category, int(cabin_no), label),
                update_modified=False,
            )
        frappe.db.commit()
    finally:
        frappe.local.session.user = _original_user

    # ── Baca semula hasil propagasi ───────────────────────────────────
    so_after = frappe.db.get_value(
        "Sales Order", primary_so,
        ["grand_total", "advance_paid", "currency"], as_dict=True)
    credit_balance = round(
        float(so_after.advance_paid or 0) - float(so_after.grand_total or 0), 2)

    _audit_edit(
        b.name,
        title="Cabin Category Changed",
        reason=reason,
        details=("Cabin {0}: {1} → {2}. New SO total: {3} {4}.")
                .format(cabin_no, old_category, new_category,
                        so_after.currency, so_after.grand_total),
        credit_balance=credit_balance,
    )

    return {
        "success": True,
        "cabin_no": int(cabin_no),
        "old_category": old_category,
        "new_category": new_category,
        "sales_order": primary_so,
        "grand_total": float(so_after.grand_total or 0),
        "advance_paid": float(so_after.advance_paid or 0),
        "credit_balance": max(0.0, credit_balance),
        "currency": so_after.currency,
    }


# ══════════════════════════════════════════════
# CABIN UPGRADE ORDER (Fasa 1d — kes PENUH + BERINVOIS)
# ══════════════════════════════════════════════

@frappe.whitelist()
def create_cabin_upgrade_order(booking: str, cabin_no: int,
                               new_category: str, reason: str = "") -> dict:
    """Tukar room category SATU kabin untuk booking PENUH + BERINVOIS —
    SO utama KEKAL SEPENUHNYA (baris ber-billed tak boleh dipinda
    selamat; PE/PR/Stripe rujuk nama SO itu). Delta harga NAIK ditanggung
    SO TAMBAHAN "Upgrade" (corak addon SO — registri purpose "Upgrade"):

      1. Baris Booking Item kabin: room_category baharu; unit_price KEKAL
         BEKU (rekod komersial asal pada SO utama tidak berubah).
      2. Slot reservation kabin: room_category baharu, disimpan dengan
         flags.skip_cabin_capacity_validation (kapasiti pra-divalidasi) —
         hook sync_cabin_availability mengira semula KEDUA-DUA kolam.
      3. SO tambahan SATU baris delta (item TRAVEL-UPG — BUKAN
         TRAVEL-PKG supaya agregat booked_pax + _share_so_lines tidak
         terkira berganda), rate = jumlah kadar baharu kabin − jumlah
         kadar BER-BILLED baris SO utama kabin itu. Snapshot Booking
         (total/paid/payment_status) dikira semula serta-merta.

    Hanya untuk NAIK harga (delta > 0) — turun harga pada booking
    berinvois kekal laluan refund manual (keputusan produk Fasa 1).
    """
    _require_access()
    b = _load_booking(booking)
    reason = (reason or "").strip()
    if not reason:
        frappe.throw(_("A reason is required for creating a cabin upgrade order."))
    new_category = (new_category or "").strip()
    if not new_category:
        frappe.throw(_("Please choose a new room category."))

    if b.status in ("Cancelled", "Abandoned"):
        frappe.throw(_("Cannot edit a {0} booking.").format(b.status))

    primary_so = _get_primary_so(b.name)
    if not primary_so:
        frappe.throw(_("Primary Sales Order not found."))
    so_state = _so_state(primary_so)
    if so_state["state"] != "paid_invoiced":
        # Semua kes belum berinvois — laluan in-place Edit Pax.
        frappe.throw(
            _("This path is only for fully paid and invoiced bookings — "
              "use 'Edit Pax' (change room category) instead."),
            title=_("Booking Not Invoiced"))

    cabins = _cabin_rows(b.name, primary_so)
    cabin = next((c for c in cabins if int(c["cabin_no"]) == int(cabin_no)), None)
    if not cabin:
        frappe.throw(_("Cabin {0} not found in this booking.").format(cabin_no))
    rows = cabin["items"]
    if not rows:
        frappe.throw(_("Cabin {0} has no bookable rows.").format(cabin_no))
    old_category = cabin["room_category"]
    if new_category == old_category:
        frappe.throw(_("Cabin {0} is already {1}.").format(cabin_no, old_category))

    # Kabin TANPA baris share — cermin guard change_booking_cabin_category.
    share_rows = frappe.db.count(
        "Booking Item",
        {"booking": b.name, "status": ["!=", "Cancelled"],
         "cabin_no": int(cabin_no), "sales_order": ["!=", primary_so]})
    if share_rows:
        frappe.throw(
            _("Cabin {0} has additional-traveller orders — settle or cancel "
              "them before upgrading the room category.").format(cabin_no))
    stamped_slots = frappe.db.count(
        "Booking Reservation",
        {"booking": b.name, "status": ["!=", "Cancelled"],
         "cabin_no": int(cabin_no), "sales_order": ["is", "set"]})
    if stamped_slots:
        frappe.throw(
            _("Cabin {0} has activated additional-traveller slots — manage "
              "them from Desk before upgrading the room category.").format(cabin_no))

    # ── Pra-validasi harga / kapasiti / kolam offer ───────────────────
    if not frappe.db.exists("Trip Price Category", new_category):
        frappe.throw(_("Room category {0} not found.").format(new_category))

    pricing_map = _booking_pricing_map(b)
    price = pricing_map.get(new_category)
    if not price:
        frappe.throw(_("No current pricing found for {0}.").format(new_category))

    rates, missing = _category_rates(price, rows)
    if missing:
        frappe.throw(
            _("Cannot price this cabin in {0}: missing {1}.").format(
                new_category, ", ".join(sorted(set(missing)))))

    comp = _cabin_composition(rows)
    _validate_selection_capacity(
        [dict(comp, room_category=new_category)],
        _cabin_info_map(new_category),
        bool(b.is_a_cruise_trip),
    )

    if b.package_offer:
        from travel_booking.utils.flags import use_package_offers
        if use_package_offers():
            from travel_booking.utils.offer_factory import check_offer_capacity
            check_offer_capacity(b.package_offer,
                                 [dict(comp, room_category=new_category)])

    # ── Padan baris SO ikut kabin (delta vs kadar BER-BILLED) ──────────
    so_items = frappe.db.get_all(
        "Sales Order Item",
        filters={"parent": primary_so, "parenttype": "Sales Order"},
        fields=["name", "item_code", "qty", "rate", "uom",
                "description", "conversion_factor"],
        order_by="idx",
    )
    cabin_tag = "cabin " + str(int(cabin_no))
    cabin_lines = []
    for it in so_items:
        parts = (it.description or "").split(" | ")
        if (len(parts) >= 5
                and parts[2].strip() == old_category
                and parts[3].strip().lower() == cabin_tag):
            cabin_lines.append(it)
    if not cabin_lines:
        frappe.throw(_("Matching Sales Order lines not found for cabin {0}. "
                       "No changes were made.").format(cabin_no))

    billed_total = round(sum(
        float(it.rate or 0) * float(it.qty or 0) for it in cabin_lines), 2)
    new_total = round(sum(nr for _r, nr in rates), 2)
    delta = round(new_total - billed_total, 2)
    if delta <= _EPS:
        frappe.throw(
            _("New cabin total ({0} {1}) is not higher than the billed "
              "amount — use the refund flow for price reductions.").format(
                  so_state["currency"], billed_total),
            title=_("Not An Upgrade"))

    # ── Mutasi 1: baris Booking Item (kategori sahaja — unit_price beku) ──
    for r in rows:
        doc = frappe.get_doc("Booking Item", r.name)
        doc.room_category = new_category
        doc.save(ignore_permissions=True)

    # ── Mutasi 2: slot reservation (skip flag — pra-divalidasi) ───────
    res_names = frappe.get_all(
        "Booking Reservation",
        filters={"booking": b.name, "status": ["!=", "Cancelled"],
                 "cabin_no": int(cabin_no)},
        pluck="name",
    )
    for res_name in res_names:
        rdoc = frappe.get_doc("Booking Reservation", res_name)
        rdoc.room_category = new_category
        rdoc.flags.skip_cabin_capacity_validation = True
        rdoc.save(ignore_permissions=True)

    # ── Mutasi 3: SO tambahan "Upgrade" (delta) — Administrator ───────
    trip = _booking_trip(b)
    trip_name = (frappe.db.get_value("Trip", trip, "trip_name")
                 if trip else "") or ""
    group_label = (frappe.db.get_value(
        "Trip Group Date", b.trip_date, "trip_group_name") or "")

    upgrade_label = "Upgrade ({0} \u2192 {1})".format(old_category, new_category)
    fare_note = ("new fare {0} less billed {1}".format(new_total, billed_total))
    line = {
        "item_code":   _get_or_create_travel_item(
            UPGRADE_ITEM_CODE, "Trip Cabin Upgrade"),
        "item_name":   "{0} (Cabin {1}) \u2014 {2}".format(
            new_category, int(cabin_no), upgrade_label),
        "qty":         1,
        # Delta eksplisit (idiom codebase: rate eksplisit, price list
        # mekanikal). Asal-usul delta dijelaskan dalam description untuk
        # jejak audit — SO utama TIDAK diubah.
        "rate":        delta,
        "uom":         "Nos",
        "description": (trip_name + " | " + group_label + " | " +
                        new_category + " | Cabin " + str(int(cabin_no)) +
                        " | " + upgrade_label + " | " + fare_note),
    }

    _original_user = frappe.local.session.user
    frappe.local.session.user = "Administrator"
    try:
        so_currency, so_company, so_price_list, conversion_rate = \
            _resolve_so_currency_and_rate(so_state["currency"])
        so = frappe.get_doc({
            "doctype":                "Sales Order",
            "customer":               b.customer,
            "company":                so_company,
            "transaction_date":       frappe.utils.today(),
            "delivery_date":          frappe.utils.today(),
            "order_type":             "Sales",
            "items":                  [line],
            "selling_price_list":     so_price_list,
            "currency":               so_currency,
            "conversion_rate":        conversion_rate,
            "disable_rounded_total":  1,
        })
        so.insert(ignore_permissions=True)
        so.flags.ignore_permissions = True
        so.submit()

        # [Nov 2026] SO upgrade didaftarkan pada registri
        # Booking.sales_orders — purpose "Upgrade" (enum sedia ada).
        _link_booking_sales_order(b.name, so.name, "Upgrade")

        # Snapshot Booking dikira semula serta-merta: hook on_update SO
        # berlaku SEBELUM pendaftaran registri (hook tak nampak booking
        # lagi) — panggil enjin agregat terus, corak sync_booking_payment_
        # status. Delta belum dibayar → payment_status Partially Paid.
        from travel_booking.api.booking_engine import _recompute_booking_status
        _recompute_booking_status(primary_so)
        frappe.db.commit()
    finally:
        frappe.local.session.user = _original_user

    _audit_edit(
        b.name,
        title="Cabin Upgrade Order",
        reason=reason,
        details=("Cabin {0}: {1} \u2192 {2}. Upgrade SO {3} (delta {4} {5}); "
                 "primary SO {6} unchanged.").format(
                     cabin_no, old_category, new_category,
                     so.name, so_currency, delta, primary_so),
        credit_balance=None,
    )

    # Agregat booking selepas upgrade (semua SO live registri) — advance
    # tertunggak + baki delta untuk Payment Link operator.
    agg_total = 0.0
    agg_paid = 0.0
    for so_name in _get_all_booking_sales_orders(b.name):
        row = frappe.db.get_value(
            "Sales Order", so_name, ["grand_total", "advance_paid"], as_dict=True)
        if row:
            agg_total += float(row.grand_total or 0)
            agg_paid += float(row.advance_paid or 0)

    return {
        "success": True,
        "booking": b.name,
        "cabin_no": int(cabin_no),
        "old_category": old_category,
        "new_category": new_category,
        "upgrade_sales_order": so.name,
        "delta": delta,
        "grand_total": round(agg_total, 2),
        "advance_paid": round(agg_paid, 2),
        "balance": round(agg_total - agg_paid, 2),
        "currency": so_currency,
    }


# ══════════════════════════════════════════════
# RESCHEDULE (Fasa 1c — tukar tarikh/pakej, unpaid path)
# ══════════════════════════════════════════════

def _reschedule_guards(b, primary_so: str) -> list:
    """Guard bersama options + operasi. Return senarai mesej penghalang
    (kosong = dibenarkan). v1: unpaid sahaja — booking belum bayar ⇒
    tiada reservation (aktivasi berlaku selepas bayaran pertama)."""
    blocked = []
    if b.status in ("Cancelled", "Abandoned"):
        blocked.append("Booking is {0}.".format(b.status))
        return blocked
    if not primary_so:
        blocked.append("Primary Sales Order not found.")
        return blocked

    so = frappe.db.get_value(
        "Sales Order", primary_so,
        ["docstatus", "grand_total", "advance_paid", "currency"], as_dict=True)
    if not so or so.docstatus != 1:
        blocked.append("Primary Sales Order is not submitted.")
    elif float(so.advance_paid or 0) > _EPS:
        blocked.append(
            "Booking has payments ({0} {1}) — reschedule requires the "
            "refund flow, which is not automated yet. Settle the refund "
            "first, or create a new booking.".format(
                so.currency, so.advance_paid))
    elif _primary_so_invoiced(primary_so):
        blocked.append("Booking is invoiced — structural edits are locked.")

    if frappe.db.exists("Booking Addon", {"booking": b.name, "status": ["!=", "Cancelled"]}):
        blocked.append("Booking has add-on orders — cancel them first.")
    if frappe.db.count("Booking Item",
                       {"booking": b.name, "status": ["!=", "Cancelled"],
                        "sales_order": ["!=", primary_so]}):
        blocked.append("Booking has additional-traveller orders — settle them first.")
    if frappe.db.count("Booking Reservation",
                       {"booking": b.name, "status": ["!=", "Cancelled"]}):
        blocked.append("Booking has active reservations (paid) — refund flow required.")
    if (b.get("booking_channel") or "Direct") == "B2B":
        blocked.append("B2B bookings — reschedule via Desk (partner pricing).")
    return blocked


def _booking_trip(b) -> str | None:
    return frappe.db.get_value("Trip Group Date", b.trip_date, "trip") if b.trip_date else None


def _booking_selections(b, primary_so: str) -> list:
    """Selections daripada Booking Item aktif (SO utama), dikumpul ikut
    kabin (nombor kabin dinormalisasi 1..n oleh _build_item_specs —
    reschedule atas booking unpaid tiada reservation, tiada konflik)."""
    rows = frappe.get_all(
        "Booking Item",
        filters={"booking": b.name, "sales_order": primary_so,
                 "status": ["!=", "Cancelled"]},
        fields=["room_category", "cabin_no", "pax_type", "rate_basis",
                "room_privacy"],
        order_by="idx asc",
    )
    cabins = {}
    for r in rows:
        key = int(r.cabin_no or 0)
        cab = cabins.setdefault(key, {
            "room_category": r.room_category,
            "main_guests": 0, "extra_beds": 0, "infants": 0,
            "room_privacy": "",
        })
        if r.pax_type in ("Main Guest", "Adult"):
            cab["main_guests"] += 1
        elif r.pax_type in ("Extra Bed", "Children"):
            cab["extra_beds"] += 1
        elif r.pax_type == "Infant":
            cab["infants"] += 1
        if (r.rate_basis or "Standard") == "Single" and r.room_privacy:
            cab["room_privacy"] = r.room_privacy
    return [cabins[k] for k in sorted(cabins.keys())]


def _target_pricing_map(b, package_offer, trip_package) -> dict:
    """Peta harga pakej SASARAN — offer-mode: Price Matrix offer +
    price rule + surcaj (cermin _booking_pricing_map); legacy: Trip
    Package Price. Kekal berasingan daripada _booking_pricing_map
    (booking SEMASA) kerana sasaran berbeza."""
    if package_offer:
        from travel_booking.utils.flags import use_package_offers
        if use_package_offers():
            from travel_booking.api.cabin_sharing import _booking_pricing_map as _bpm
            # _booking_pricing_map bina ctx booking — untuk sasaran,
            # replika cabang offer sahaja (rule ctx ikut offer sasaran).
            pricing_map = _get_offer_pricing_map(package_offer)
            from travel_booking.api.pricing import (
                _get_offer_addon_totals, _apply_addon_totals,
            )
            from travel_booking.api.price_rule import apply_price_rules
            td = (frappe.db.get_value(
                "Package Offer", package_offer,
                ["legacy_tgd", "travel_date"], as_dict=True))
            dep = None
            if td and td.travel_date:
                dep = frappe.db.get_value("Travel Date", td.travel_date, "departure_date")
            elif td and td.legacy_tgd:
                dep = frappe.db.get_value("Trip Group Date", td.legacy_tgd, "departure_date")
            rule_ctx = {
                "trip": _booking_trip(b),
                "trip_group_date": None,
                "trip_package": None,
                "currency": frappe.db.get_value("Package Offer", package_offer, "currency"),
                "departure_date": dep,
            }
            eff_map, _applied = apply_price_rules(pricing_map, rule_ctx)
            addon_totals = _get_offer_addon_totals(package_offer)
            if addon_totals:
                if eff_map is not pricing_map:
                    _apply_addon_totals(eff_map, addon_totals)
                _apply_addon_totals(pricing_map, addon_totals)
            return eff_map
    return _get_pricing_map(trip_package) if trip_package else {}


def _reschedule_estimate(pricing_map: dict, selections: list):
    """(anggaran jumlah, [kategori tiada harga]) untuk komposisi semasa
    pada peta harga sasaran."""
    total, missing = 0.0, []
    for sel in selections:
        price = pricing_map.get(sel["room_category"])
        if not price:
            missing.append(sel["room_category"])
            continue
        rows = [frappe._dict(pax_type=pt, rate_basis="Single" if pt == "Main Guest" and sel["main_guests"] == 1 else "Standard")
                for pt, n in (("Main Guest", sel["main_guests"]),
                              ("Extra Bed", sel["extra_beds"]),
                              ("Infant", sel["infants"]))
                for _ in range(n)]
        if not rows:
            continue
        rates, miss = _category_rates(price, rows)
        if rates is None:
            missing.extend("{0}:{1}".format(sel["room_category"], m) for m in miss)
            continue
        total += sum(nr for _r, nr in rates)
    return round(total, 2), missing


@frappe.whitelist()
def get_booking_reschedule_options(booking: str) -> dict:
    """Senarai tarikh + pakej sasaran (trip sama, currency sama) dengan
    anggaran jumlah untuk komposisi semasa — untuk dialog Reschedule."""
    _require_access()
    b = _load_booking(booking)
    primary_so = _get_primary_so(b.name)
    blocked = _reschedule_guards(b, primary_so)

    trip = _booking_trip(b)
    so_currency = (frappe.db.get_value("Sales Order", primary_so, "currency")
                   if primary_so else None)
    selections = _booking_selections(b, primary_so) if primary_so else []

    dates = []
    if not blocked and trip and selections:
        from travel_booking.utils.flags import use_package_offers
        if use_package_offers():
            from travel_booking.utils.new_catalog import get_bundle_new
            _trips, tgds, pkgs, _flags = get_bundle_new()
        else:
            from travel_booking.utils.trip_catalog import get_ready_bundle
            _trips, tgds, pkgs, _flags = get_ready_bundle()
        today = frappe.utils.getdate()
        for g in (tgds.get(trip) or []):
            if g.get("name") == b.trip_date:
                continue
            if g.get("departure_date") and frappe.utils.getdate(g["departure_date"]) < today:
                continue
            pkgs_for_date = pkgs.get(g["name"]) or []
            if not pkgs_for_date:
                continue
            pkg_options = []
            for p in pkgs_for_date:
                reason = ""
                eligible = True
                if p.get("currency") != so_currency:
                    eligible, reason = False, "Different currency ({0})".format(p.get("currency"))
                else:
                    pmap = _target_pricing_map(b, p.get("offer"), p.get("name"))
                    est, missing = _reschedule_estimate(pmap, selections)
                    if missing:
                        eligible, reason = False, "No rate: {0}".format(", ".join(sorted(set(missing))[:3]))
                    elif eligible:
                        # Kolam ketersediaan sailing sasaran (preview tanpa
                        # lock — gate berlock sebenar check_offer_capacity
                        # berlaku masa operasi). Komposisi per kategori —
                        # kolam mengira KABIN: setiap selection (bilik)
                        # = SATU kabin; tetamu berkongsi kabin.
                        needed = {}
                        for sel in selections:
                            if sel["main_guests"] + sel["extra_beds"] + sel["infants"] <= 0:
                                continue
                            needed[sel["room_category"]] = needed.get(sel["room_category"], 0) + 1
                        for cat, n in needed.items():
                            pool = _offer_pool_available(b, cat) if p.get("offer") else None
                            # _offer_pool_available baca kolam offer BOOKING
                            # — untuk sasaran, resolve schedule offer sasaran.
                            if p.get("offer"):
                                sched = frappe.db.get_value("Package Offer", p["offer"], "cruise_schedule")
                                if sched:
                                    row = frappe.db.get_value(
                                        "Trip Package Price",
                                        {"parent": sched, "parenttype": "Trip Cruise Schedule",
                                         "pricing_for_class": cat},
                                        ["cabin_allotment", "cabin_occupancy"], as_dict=True)
                                    pool = (int(row.cabin_allotment or 0) - int(row.cabin_occupancy or 0)) if row else 0
                                else:
                                    pool = None
                            if pool is not None and pool < n:
                                eligible, reason = False, "Only {0} cabin(s) left on this sailing".format(max(0, pool))
                                break
                pkg_options.append({
                    "package": p.get("name"),
                    "package_type": p.get("package_type") or "",
                    "offer": p.get("offer") or "",
                    "estimate_total": est if eligible else None,
                    "eligible": eligible, "reason": reason,
                })
            dates.append({
                "trip_group_date": g["name"],
                "departure_date": g.get("departure_date"),
                "group_name": g.get("trip_group_name") or "",
                "packages": pkg_options,
            })

    return {
        "booking": b.name,
        "booking_number": b.booking_number,
        "blocked": blocked,
        "current_trip_date": b.trip_date,
        "current_currency": so_currency,
        "dates": dates,
    }


@frappe.whitelist()
def reschedule_booking(booking: str, new_trip_group_date: str,
                       new_package_offer: str = "", new_trip_package: str = "",
                       reason: str = "") -> dict:
    """Reschedule — pindah booking (unpaid) ke tarikh/pakej lain dalam
    trip yang sama, SO baharu pada harga semasa:

      1. SO lama: cancel (PR dibersihkan dahulu) — hook on_cancel
         mengira semula snapshot Booking (SO Cancelled dikecualikan
         daripada agregat wang).
      2. SO baharu: komposisi semasa diharga pada peta harga sasaran
         (offer/legacy + price rule + surcaj), payload cermin
         confirm_booking (payment schedule termasuk), submit.
      3. Booking Item: baris lama → Cancelled; baris baharu ber-stamp
         SO baharu.
      4. Booking: trip_date/trip_package (+ stamp offer-mode) → save
         (fetched fields auto-segar); snapshot diskaun basi di-reset
         (voucher dilepaskan); payment_due_amount = jumlah baharu.

    v1 DISEKAT: berbayar, addon order, baris share, B2B, currency
    berbeza, trip berbeza, tarikh lepas.
    """
    _require_access()
    b = _load_booking(booking)
    reason = (reason or "").strip()
    if not reason:
        frappe.throw(_("A reason is required for rescheduling."))
    new_trip_group_date = (new_trip_group_date or "").strip()

    primary_so = _get_primary_so(b.name)
    blocked = _reschedule_guards(b, primary_so)
    if blocked:
        frappe.throw(_(blocked[0]), title=_("Reschedule Not Available"))

    old_so_doc = frappe.get_doc("Sales Order", primary_so)
    old_currency = old_so_doc.currency
    old_tgd = b.trip_date
    old_pkg = b.trip_package

    # ── Resolve konteks sasaran (cermin cabang F5 confirm_booking) ────
    travel_package = ""
    package_offer = (new_package_offer or "").strip()
    trip_package = (new_trip_package or "").strip()

    if package_offer:
        from travel_booking.utils.flags import use_package_offers
        if use_package_offers():
            offer = frappe.db.get_value(
                "Package Offer", package_offer,
                ["currency", "legacy_tgd", "legacy_trip_package", "travel_date"],
                as_dict=True)
            if not offer:
                frappe.throw(_("Package Offer {0} not found.").format(package_offer))
            if offer.currency:
                trip_group_date = (offer.legacy_tgd or frappe.db.get_value(
                    "Travel Date", offer.travel_date, "legacy_tgd") or "")
                trip_package = offer.legacy_trip_package or None
            else:
                from travel_booking.utils.offer_factory import resolve_legacy_from_offer
                trip_group_date, trip_package = resolve_legacy_from_offer(
                    package_offer, new_trip_package or "")
            travel_package = frappe.db.get_value(
                "Package Offer", package_offer, "package") or ""
    if not package_offer or not trip_group_date:
        trip_group_date = new_trip_group_date
    if not trip_package:
        trip_package = (new_trip_package or "").strip() or None

    if not trip_group_date or not frappe.db.exists("Trip Group Date", trip_group_date):
        frappe.throw(_("Target departure date not found."))
    if trip_package and not frappe.db.exists("Trip Package", trip_package):
        frappe.throw(_("Target package {0} not found.").format(trip_package))

    # Guard konteks
    tgd = frappe.db.get_value(
        "Trip Group Date", trip_group_date,
        ["trip", "departure_date", "trip_group_name"], as_dict=True)
    if tgd.trip != _booking_trip(b):
        frappe.throw(_("Reschedule is only available within the same trip."))
    if (trip_group_date == old_tgd and (trip_package or "") == (old_pkg or "")
            and (package_offer or "") == (b.package_offer or "")):
        frappe.throw(_("Booking is already on this date and package."))
    if tgd.departure_date and frappe.utils.getdate(tgd.departure_date) < frappe.utils.getdate():
        frappe.throw(_("Target departure date is in the past."))

    # ── Harga sasaran + validasi komposisi ─────────────────────────────
    pricing_map = _target_pricing_map(b, package_offer or None, trip_package)
    if not pricing_map:
        frappe.throw(_("No current pricing found for the target package."))
    selections = _booking_selections(b, primary_so)
    if not selections:
        frappe.throw(_("Booking has no active guests to reschedule."))
    estimate, missing = _reschedule_estimate(pricing_map, selections)
    if missing:
        frappe.throw(_("Cannot price this booking on the target package: "
                       "missing {0}.").format(", ".join(sorted(set(missing)))))

    target_currency = (frappe.db.get_value("Package Offer", package_offer, "currency")
                       if package_offer
                       else frappe.db.get_value("Trip Package", trip_package, "default_currency"))
    target_currency = target_currency or old_currency
    if target_currency != old_currency:
        frappe.throw(
            _("Target package is in {0} but the booking is in {1} — "
              "cross-currency reschedule is not supported yet.").format(
                  target_currency, old_currency))

    is_cruise = bool(frappe.db.get_value("Trip Group Date", trip_group_date, "is_a_cruise_trip"))
    _cabin_info = {}
    for sel in selections:
        _cabin_info.update(_cabin_info_map(sel["room_category"]))
    _validate_selection_capacity(selections, _cabin_info, is_cruise)

    if package_offer:
        from travel_booking.utils.flags import use_package_offers
        if use_package_offers():
            from travel_booking.utils.offer_factory import check_offer_capacity
            check_offer_capacity(package_offer, selections)

    # ── 1. Cancel SO lama ─────────────────────────────────────────────
    from travel_booking.api.booking_engine import _cancel_payment_requests_for_so
    _original_user = frappe.local.session.user
    frappe.local.session.user = "Administrator"
    try:
        _cancel_payment_requests_for_so(primary_so)
        old_so_doc.flags.ignore_permissions = True
        old_so_doc.cancel()

        # ── 2. SO baharu (cermin payload confirm_booking) ─────────────
        specs = _build_item_specs(selections, pricing_map, is_cruise)
        so_items = _so_items_from_specs(specs, _booking_trip(b) and
                                        frappe.db.get_value("Trip", _booking_trip(b), "trip_name") or "",
                                        tgd.trip_group_name or "")
        so_currency, so_company, so_price_list, conversion_rate = \
            _resolve_so_currency_and_rate(target_currency)

        _msg_log_len = len(frappe.message_log)
        new_so = frappe.get_doc({
            "doctype": "Sales Order",
            "customer": b.customer,
            "company": so_company,
            "transaction_date": frappe.utils.today(),
            "delivery_date": frappe.utils.today(),
            "order_type": "Sales",
            "items": so_items,
            "selling_price_list": so_price_list,
            "currency": so_currency,
            "conversion_rate": conversion_rate,
            "disable_rounded_total": 1,
        })
        new_so.insert(ignore_permissions=True)

        # [Nov 2026] SO pengganti didaftarkan pada REGISTRI
        # Booking.sales_orders (menggantikan set field custom_booking pada
        # SO — SO tidak lagi memegang link ke Booking). Purpose "Main
        # Booking": pengganti SO utama yang dibatalkan di langkah 1 —
        # _get_primary_so melangkau SO cancelled, jadi SO ini menjadi
        # utama walaupun idx registri selepas SO lama.
        _link_booking_sales_order(b.name, new_so.name, "Main Booking")

        from travel_booking.api.booking_engine import (
            _compute_schedule_rows, _effective_payment_terms,
        )
        try:
            _deposit_pct, _final_days = _effective_payment_terms(
                package_offer if package_offer else None)
            _sched = _compute_schedule_rows(
                new_so.grand_total, _deposit_pct, _final_days,
                tgd.departure_date, new_so.transaction_date)
            if _sched:
                new_so.payment_schedule = []
                for _row in _sched:
                    new_so.append("payment_schedule", _row)
        except Exception as e:
            frappe.log_error(
                title="Reschedule SO Payment Schedule Error",
                message="Failed to build payment schedule for SO " +
                        str(new_so.name) + ": " + str(e),
            )

        new_so.flags.ignore_permissions = True
        new_so.submit()
        del frappe.message_log[_msg_log_len:]

        # ── 3. Booking Item: lama Cancelled + baharu ──────────────────
        for row in frappe.get_all(
                "Booking Item",
                filters={"booking": b.name, "status": ["!=", "Cancelled"]},
                pluck="name"):
            doc = frappe.get_doc("Booking Item", row)
            doc.status = "Cancelled"
            doc.save(ignore_permissions=True)
        _write_booking_items(b.name, new_so.name, specs, so_currency)

        # ── 4. Booking context + snapshot reset ──────────────────────
        bdoc = frappe.get_doc("Booking", b.name)
        bdoc.trip_date = trip_group_date
        bdoc.trip_package = trip_package
        if package_offer:
            bdoc.travel_package = travel_package or None
            bdoc.package_offer = package_offer
        # Voucher dilepaskan (penggunaan lama tak sah untuk harga baharu)
        if bdoc.voucher:
            from travel_booking.api.booking_engine import _release_voucher_for_booking
            _release_voucher_for_booking(b.name)
            bdoc.voucher = None
        bdoc.voucher_discount = 0
        bdoc.referral_discount = 0
        bdoc.price_rule_discount = 0
        bdoc.applied_price_rules = None
        bdoc.payment_due_amount = round(float(new_so.grand_total or 0), 2)
        bdoc.save(ignore_permissions=True)

        frappe.db.commit()
    finally:
        frappe.local.session.user = _original_user

    _audit_edit(
        b.name,
        title="Booking Rescheduled",
        reason=reason,
        details=("Date {0} → {1}; package {2} → {3}. New SO {4} "
                 "({5} {6}); old SO {7} cancelled.")
                .format(old_tgd, trip_group_date, old_pkg or "-",
                        trip_package or package_offer or "-",
                        new_so.name, so_currency, new_so.grand_total,
                        primary_so),
        credit_balance=None,
    )

    return {
        "success": True,
        "booking": b.name,
        "booking_number": b.booking_number,
        "old_trip_date": old_tgd,
        "new_trip_date": trip_group_date,
        "new_package": trip_package or package_offer,
        "old_sales_order": primary_so,
        "new_sales_order": new_so.name,
        "grand_total": float(new_so.grand_total or 0),
        "currency": so_currency,
        "departure_date": str(tgd.departure_date) if tgd.departure_date else "",
    }


# ══════════════════════════════════════════════
# ROOMMATE MATCH (Fasa 1e — solo "Open Sharing" → twin share)
# ══════════════════════════════════════════════

def _solo_match_context(b, primary_so) -> dict:
    """Kelayakan SATU booking untuk padanan roommate + konteks harga.

    Syarat (semua mesti benar, cermin janji wizard "Find me a roommate"):
      - cruise, bukan Cancelled/Abandoned, bukan B2B (harga partner
        tersembunyi — corak _price_hidden_for);
      - SO utama wujud + TIADA SO share pending;
      - SOLO tulen: SATU baris Booking Item aktif (SO utama), Main Guest
        ber-rate_basis "Single" — iaitu kadar price_adult_single;
      - reservation aktif wujud (booking telah bayar — slot bilik dah
        diaktifkan) dan ber-room_privacy "Open Sharing" (persetujuan
        berkongsi bilik diisytiharkan masa checkout);
      - SO utama BUKAN paid_invoiced (baris ber-billed tak boleh
        dipinda selamat — penempatan sahaja, rujuk Rooming Board).

    Return dict konteks (row, reservation, kadar, gender, so_state).
    Throw dengan sebab bila tak layak — dipakai oleh state (paparan)
    DAN apply (re-validasi server-side; client tidak pernah dipercayai).
    """
    if not b.is_a_cruise_trip:
        frappe.throw("Roommate matching is only available for cruise bookings.")
    if b.status in ("Cancelled", "Abandoned"):
        frappe.throw("Cannot match a {0} booking.".format(b.status))
    if (b.get("booking_channel") or "Direct") == "B2B":
        frappe.throw("B2B bookings are arranged by the partner — roommate "
                     "matching is not available.")
    if not primary_so:
        frappe.throw("Primary Sales Order not found.")
    if _pending_share_sos(b.name, primary_so):
        frappe.throw("Booking has pending add-traveller orders — settle or "
                     "cancel them first.")

    rows = frappe.get_all(
        "Booking Item",
        filters={"booking": b.name, "status": ["!=", "Cancelled"]},
        fields=["name", "room_category", "cabin_no", "pax_type",
                "rate_basis", "room_privacy", "unit_price", "sales_order"],
        order_by="idx asc",
    )
    if len(rows) != 1 or rows[0].sales_order != primary_so:
        frappe.throw("Roommate matching needs a solo booking (exactly one "
                     "traveller).")
    row = rows[0]
    if row.pax_type not in ("Main Guest", "Adult"):
        frappe.throw("Roommate matching needs a main guest travelling alone.")
    if (row.rate_basis or "Standard") != "Single":
        frappe.throw("This booking is not on the single-occupancy rate.")

    reservation = frappe.db.get_value(
        "Booking Reservation",
        {"booking": b.name, "status": ["!=", "Cancelled"],
         "cabin_no": int(row.cabin_no or 0)},
        ["name", "room_id", "room_privacy", "traveller_full_name",
         "guest_label"], as_dict=True)
    if not reservation:
        frappe.throw("This booking is not active yet — its room slot is "
                     "created after the first payment.")
    privacy = reservation.room_privacy or row.room_privacy
    if privacy != "Open Sharing":
        frappe.throw("This traveller did not opt in to share a cabin "
                     "(room privacy is not 'Open Sharing').")

    so_state = _so_state(primary_so)
    if so_state["state"] == "paid_invoiced":
        frappe.throw("Booking is fully paid and invoiced — fare changes are "
                     "locked. Place the guests together via the Rooming "
                     "Board; any refund follows the manual flow.")

    # Gender diisytiharkan sendiri masa checkout — snapshot pada baris SO
    # ("custom_roommate_gender", patch v20). SO = sumber tunggal.
    gender = next((g for g in frappe.get_all(
        "Sales Order Item",
        filters={"parent": primary_so, "parenttype": "Sales Order",
                 "item_code": TRAVEL_ITEM_CODE},
        pluck="custom_roommate_gender") if g), "")

    pricing_map = _booking_pricing_map(b)
    price = pricing_map.get(row.room_category) or {}
    if price.get("price_adult") is None:
        frappe.throw("No current twin-share rate found for {0}."
                     .format(row.room_category))

    twin_rate = float(price.get("price_adult") or 0)
    single_rate = float(row.unit_price or 0)
    return {
        "row":              row,
        "reservation":      reservation,
        "room_category":    row.room_category,
        "cabin_no":         int(row.cabin_no or 0),
        "gender":           gender,
        "single_rate":      single_rate,
        "twin_rate":        twin_rate,
        # Kredit single-supplement — formula sama cabin_sharing
        # (_shareable_cabins_core): lebihan solo atas kadar twin semasa.
        "excess":           round(max(single_rate - twin_rate, 0.0), 2),
        "so_state":         so_state,
    }


@frappe.whitelist()
def get_roommate_match_state(booking: str) -> dict:
    """State untuk dialog 'Roommate Matched' (L3 Travel Manager):
    kelayakan booking ini + pralihat refund (kadar single → twin semasa)
    + senarai CALON solo lain (sailing + kategori + gender sama, dua-dua
    ber-persetujuan Open Sharing, SO belum berinvois).

    Semakan tanpa mutasi — gate berlock sebenar berlaku masa apply."""
    _require_access()
    b = _load_booking(booking)
    primary_so = _get_primary_so(b.name)

    ctx, eligible, reason = None, False, ""
    if primary_so:
        try:
            ctx = _solo_match_context(b, primary_so)
            eligible, reason = True, ""
        except Exception as e:
            eligible, reason = False, str(e)

    solo = None
    if eligible:
        solo = {
            "room_category": ctx["room_category"],
            "cabin_no":      ctx["cabin_no"],
            "single_rate":   ctx["single_rate"],
            "twin_rate":     ctx["twin_rate"],
            "excess":        ctx["excess"],
            "gender":        ctx["gender"],
            "so_state":      ctx["so_state"]["state"],
            "grand_total":   ctx["so_state"]["grand_total"],
            "advance_paid":  ctx["so_state"]["advance_paid"],
            "currency":      ctx["so_state"]["currency"],
            # Pralihat credit selepas tukar kadar (corak remove_booking_pax:
            # dilaporkan, TANPA auto-refund — admin urus refund manual).
            "credit_preview": round(max(
                float(ctx["so_state"]["advance_paid"] or 0)
                - (float(ctx["so_state"]["grand_total"] or 0) - ctx["excess"]),
                0.0), 2),
        }

    candidates = []
    if eligible:
        for cand in frappe.get_all(
                "Booking",
                filters={"trip_date": b.trip_date,
                         "status": ["not in", ("Cancelled", "Abandoned")],
                         "name": ["!=", b.name]},
                pluck="name"):
            cb = _load_booking(cand)
            cprimary = _get_primary_so(cb.name)
            if not cprimary:
                continue
            try:
                cctx = _solo_match_context(cb, cprimary)
            except Exception:
                continue  # tak layak — bukan calon, tiada sebab dipapar
            if cctx["room_category"] != ctx["room_category"]:
                continue
            if not ctx["gender"] or cctx["gender"] != ctx["gender"]:
                continue
            candidates.append({
                "booking":        cb.name,
                "booking_number": cb.booking_number,
                "customer":       cb.customer,
                "traveller_name": (cctx["reservation"].traveller_full_name
                                   or cctx["reservation"].guest_label or ""),
                "gender":         cctx["gender"],
                "so_state":       cctx["so_state"]["state"],
                "single_rate":    cctx["single_rate"],
                "twin_rate":      cctx["twin_rate"],
                "excess":         cctx["excess"],
                "currency":       cctx["so_state"]["currency"],
            })

    return {
        "booking": b.name,
        "booking_number": b.booking_number,
        "status": b.status,
        "eligible": eligible,
        "reason": reason,
        "solo": solo,
        "candidates": candidates,
    }


def _twin_share_so_plan(primary_so: str, ctx: dict) -> dict:
    """Pra-bina senarai item SO baharu untuk SATU sisi padanan (pra-mutasi
    — semua guard mesti lulus sebelum ini dipanggil). Baris solo
    "Main Guest (Single)" kabin itu ditukar: label → "Main Guest",
    rate → kadar twin semasa. Return {new_items, line_name, line_rate}."""
    so_items = frappe.db.get_all(
        "Sales Order Item",
        filters={"parent": primary_so, "parenttype": "Sales Order"},
        fields=["name", "item_code", "qty", "rate", "uom",
                "description", "conversion_factor"],
        order_by="idx",
    )
    label = _pax_label(ctx["row"])
    cabin_tag = "cabin " + str(ctx["cabin_no"])
    new_items, line_name = [], None
    for it in so_items:
        parts = (it.description or "").split(" | ")
        is_match = (len(parts) >= 5
                    and parts[2].strip() == ctx["room_category"]
                    and parts[3].strip().lower() == cabin_tag
                    and parts[4].strip() == label)
        if is_match:
            line_name = it.name
            parts[4] = " Main Guest "
            new_items.append({
                "docname": it.name,
                "item_code": it.item_code,
                "qty": float(it.qty or 0),
                "rate": ctx["twin_rate"],
                "description": " | ".join(parts),
                "uom": it.uom,
                "conversion_factor": it.conversion_factor,
            })
        else:
            new_items.append({
                "docname": it.name,
                "item_code": it.item_code,
                "qty": float(it.qty or 0),
                "rate": float(it.rate or 0),
                "description": it.description,
                "uom": it.uom,
                "conversion_factor": it.conversion_factor,
            })
    if line_name is None:
        frappe.throw(_("Matching Sales Order line not found for cabin {0} "
                       "({1}). No changes were made.")
                     .format(ctx["cabin_no"], label))
    return {"new_items": new_items, "line_name": line_name}


def _apply_twin_share_side(b, primary_so: str, ctx: dict,
                           join_room_id: str | None,
                           join_cabin_no: int | None) -> None:
    """Mutasi SATU sisi padanan (dalam transaksi + Administrator):
    Booking Item (rate_basis Standard + unit_price twin) → reservation
    (privacy Private; sisi JOINER turut bawa room_id + cabin_no bilik
    PEMILIK — penempatan merentas booking, corak arrange_group_rooming)
    → item SO in-place (label + rate) melalui ChildItemUpdater.

    `apply_fare` (ctx): hanya bila excess > 0 (kadar twin SEMASA lebih
    rendah daripada kadar single berbayar) — kadar TIDAK pernah
    dinaikkan senyap-senyap (harga semasa boleh berubah selepas
    snapshot booking); sisi excess=0 hanya penempatan + privacy."""
    apply_fare = ctx["excess"] > _EPS
    plan = _twin_share_so_plan(primary_so, ctx) if apply_fare else None

    # ── Mutasi 1: baris Booking Item — Single → Standard, kadar twin ──
    if apply_fare:
        item_doc = frappe.get_doc("Booking Item", ctx["row"].name)
        item_doc.rate_basis = "Standard"
        item_doc.unit_price = ctx["twin_rate"]
        item_doc.save(ignore_permissions=True)

    # ── Mutasi 2: slot reservation — Private + penempatan room_id ─────
    rdoc = frappe.get_doc("Booking Reservation", ctx["reservation"].name)
    rdoc.room_privacy = "Private"
    if join_room_id:
        # Penempatan MERENTAS booking: reservation tetamu ini membawa
        # room_id bilik pemilik supaya assign_room_id() tidak jana semula
        # ikut booking sendiri; cabin_no mengikut penomboran PEMILIK.
        rdoc.room_id = join_room_id
        rdoc.cabin_no = int(join_cabin_no or ctx["cabin_no"])
    rdoc.flags.skip_cabin_capacity_validation = True
    rdoc.save(ignore_permissions=True)

    # ── Mutasi 3: item SO in-place (label "Main Guest (Single)" → ─────
    # "Main Guest", rate = kadar twin semasa) — cermin rantaian
    # change_booking_cabin_category.
    if apply_fare:
        from erpnext.accounts.services.child_item_update import ChildItemUpdater
        ChildItemUpdater("Sales Order", primary_so, "items").update(plan["new_items"])
        frappe.db.set_value(
            "Sales Order Item", plan["line_name"], "item_name",
            "{0} (Cabin {1}) \u2014 Main Guest".format(
                ctx["room_category"], ctx["cabin_no"]),
            update_modified=False,
        )


@frappe.whitelist()
def apply_roommate_match(booking: str, partner_booking: str,
                         reason: str = "") -> dict:
    """Padankan DUA solo "Open Sharing" (booking berasingan) — tetamu
    berkongsi SATU bilik + KEDUA-DUA sisi ditukar kepada kadar twin share:

      1. Penempatan: reservation JOINER membawa room_id bilik PEMILIK
         (penempatan merentas booking — kapasiti kolam mengira DISTINCT
         room_id, jadi SATU kabin terbebas automatik oleh hook); kedua-dua
         reservation → room_privacy "Private" (corak
         _activate_share_traveller_reservation).
      2. Kadar: baris "Main Guest (Single)" SO utama TIAP-TIAP booking
         diharga semula IN-PLACE kepada kadar price_adult semasa
         (ChildItemUpdater — grand_total/payment_schedule/snapshot Booking
         dikira semula automatik oleh hook). HANYA bila excess > 0
         (kadar twin semasa LEBIH RENDAH daripada kadar single berbayar)
         — kadar tidak pernah dinaikkan senyap (harga semasa boleh berubah
         selepas snapshot booking); sisi excess=0 hanya penempatan.
      3. Kredit lebihan single-supplement DILAPORKAN (credit_balance)
         TANPA auto-refund; payment_status → "Request Refund" bila
         berlebihan (dilindungi daripada ditulis semula oleh recompute
         sehingga admin selesaikan refund manual).

    Pra-validasi penuh KEDUA-DUA sisi (re-kira server-side, client tidak
    dipercayai): kelayakan _solo_match_context + sailing sama + kategori
    sama + gender sama + kapasiti bilik gabungan.
    """
    _require_access()
    reason = (reason or "").strip()
    if not reason:
        frappe.throw(_("A reason is required for matching roommates."))
    partner_booking = (partner_booking or "").strip()
    if not partner_booking:
        frappe.throw(_("Please choose the traveller to match with."))

    b_owner = _load_booking(booking)
    b_joiner = _load_booking(partner_booking)
    if b_owner.name == b_joiner.name:
        frappe.throw(_("Please choose a traveller from a DIFFERENT booking — "
                       "to add a guest to this booking's own cabin, use "
                       "'Edit Pax' (add guest)."))

    primary_owner = _get_primary_so(b_owner.name)
    primary_joiner = _get_primary_so(b_joiner.name)
    ctx_owner = _solo_match_context(b_owner, primary_owner)
    ctx_joiner = _solo_match_context(b_joiner, primary_joiner)

    if b_owner.trip_date != b_joiner.trip_date:
        frappe.throw(_("Both bookings must be on the same sailing."))
    if ctx_owner["room_category"] != ctx_joiner["room_category"]:
        frappe.throw(_("Both travellers must be in the same room category "
                       "({0} vs {1}).").format(ctx_owner["room_category"],
                                                ctx_joiner["room_category"]))
    if not ctx_owner["gender"] or ctx_owner["gender"] != ctx_joiner["gender"]:
        frappe.throw(_("Both travellers must have declared the same roommate "
                       "gender."))

    # Kapasiti bilik GABUNGAN (2 main guest) — pra-divalidasi; guard
    # terakhir tetap validate_cabin_capacity doctype masa save (skip flag
    # dipasang kerana bilik belum sepenuhnya terbentuk semasa save
    # berjujukan — cermin change_booking_cabin_category).
    _validate_selection_capacity(
        [{"main_guests": 2, "extra_beds": 0, "infants": 0,
          "room_category": ctx_owner["room_category"]}],
        _cabin_info_map(ctx_owner["room_category"]), True)

    owner_room_id = ctx_owner["reservation"].room_id
    if not owner_room_id:
        frappe.throw(_("Owner room ID missing — regenerate the rooming "
                       "arrangement first (Rooms tab)."))

    # ── Mutasi KEDUA-DUA sisi — SATU transaksi, Administrator ────────
    _original_user = frappe.local.session.user
    frappe.local.session.user = "Administrator"
    try:
        _apply_twin_share_side(b_owner, primary_owner, ctx_owner,
                               join_room_id=None, join_cabin_no=None)
        _apply_twin_share_side(b_joiner, primary_joiner, ctx_joiner,
                               join_room_id=owner_room_id,
                               join_cabin_no=ctx_owner["cabin_no"])
        frappe.db.commit()
    finally:
        frappe.local.session.user = _original_user

    # ── Baca semula hasil propagasi + status refund ───────────────────
    # (SELEPAS recompute — hook on_update_after_submit SO sudah berlaku
    # dalam ChildItemUpdater; tulis Request Refund kemudian supaya tidak
    # ditimpa oleh _compute_payment_status.)
    from travel_booking.api.booking_engine import _recompute_booking_status
    results = {}
    for side, (bside, primary_so, sctx) in (
            ("owner", (b_owner, primary_owner, ctx_owner)),
            ("joiner", (b_joiner, primary_joiner, ctx_joiner))):
        _recompute_booking_status(primary_so)
        so_after = frappe.db.get_value(
            "Sales Order", primary_so,
            ["grand_total", "advance_paid", "currency"], as_dict=True)
        credit_balance = round(
            float(so_after.advance_paid or 0) - float(so_after.grand_total or 0), 2)
        if credit_balance > _EPS:
            frappe.db.set_value("Booking", bside.name, "payment_status",
                                "Request Refund")
        results[side] = {
            "booking": bside.name,
            "booking_number": bside.booking_number,
            "sales_order": primary_so,
            "grand_total": float(so_after.grand_total or 0),
            "advance_paid": float(so_after.advance_paid or 0),
            "credit_balance": max(0.0, credit_balance),
            "currency": so_after.currency,
            "payment_status": ("Request Refund" if credit_balance > _EPS
                               else frappe.db.get_value(
                                   "Booking", bside.name, "payment_status")),
        }

    # ── Audit KEDUA-DUA booking (jejak silang) ────────────────────────
    for side, (bside, _pso, sctx) in (
            ("owner", (b_owner, primary_owner, ctx_owner)),
            ("joiner", (b_joiner, primary_joiner, ctx_joiner))):
        partner = (b_joiner if side == "owner" else b_owner)
        fare_part = ("Cabin {0} rate {1} \u2192 {2} ({3}).".format(
            sctx["cabin_no"], sctx["single_rate"], sctx["twin_rate"],
            sctx["reservation"].name)
            if sctx["excess"] > _EPS else
            "Cabin {0} rate {1} unchanged (no single-supplement "
            "difference at current rates).".format(
                sctx["cabin_no"], sctx["single_rate"]))
        _audit_edit(
            bside.name,
            title="Roommate Matched \u2014 Twin Share",
            reason=reason,
            details=("Matched with booking {0} ({1}). {2} Shared room "
                     "{3}. New SO total: {4} {5}.").format(
                         partner.booking_number, partner.name,
                         fare_part, owner_room_id,
                         results[side]["currency"],
                         results[side]["grand_total"]),
            credit_balance=results[side]["credit_balance"] or None,
        )

    return {
        "success": True,
        "owner": results["owner"],
        "joiner": results["joiner"],
        "room_id": owner_room_id,
    }


# ══════════════════════════════════════════════
# AUDIT
# ══════════════════════════════════════════════

def _audit_edit(booking_name: str, title: str, reason: str,
                details: str, credit_balance: float | None = None) -> None:
    """Jejak audit edit booking — Communication pada Booking (corak
    booking_hub.update_booking_status)."""
    try:
        frappe.get_doc({
            "doctype": "Communication",
            "subject": "Booking Edit: " + title,
            "content": (details + ("<br/>Reason: " + reason if reason else "") +
                        ("<br/>Credit balance: {0}".format(credit_balance)
                         if credit_balance else "")),
            "sending_user": frappe.session.user,
            "communication_medium": "Other",
            "sent_or_received": "Sent",
            "reference_doctype": "Booking",
            "reference_name": booking_name,
            "status": "Linked",
        }).insert(ignore_permissions=True)
    except Exception:
        frappe.log_error(
            title="Booking Edit Audit Failed",
            message="Booking " + str(booking_name) + " (" + title + "): " +
                    frappe.get_traceback(),
        )
