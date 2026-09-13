"""Cabin Sharing — tambah traveller ke cabin sedia ada (portal traveller).

Senario: customer yang dah ada booking cruise aktif mahu tambah traveller
ke cabin tertentu KEMUDIAN HARI, terus dari panel cabin di portal. Server
cipta SO BAHARU untuk traveller tu dan dipaut ke booking sedia ada
melalui Sales Order.custom_booking SAHAJA — TIADA custom field share
pada Sales Order:

    existed Booking ──< Sales Order (via custom_booking)
          │
          └──< Booking Reservation (slot baharu di bawah Booking sama;
                cabin ditentukan dari panel cabin → slot baharu auto
                mendapat room_id SAMA dengan roommate, rujuk
                BookingReservation.assign_room_id())

Cabin sasaran + room category dibawa dalam DESCRIPTION item SO — corak
sumber tunggal sedia ada: 'Trip | Group | Room Category | Cabin N |
Pax Type'. SO traveller tambahan dikenalpasti TANPA marker:
SO berkaitan booking yang BUKAN SO utama (primary) dan menjual item
TRAVEL-PKG — SO addon menjual item berbeza.

Harga:
- Cabin masih SOLO (1 penghuni asal, belum ada traveller tambahan):
  kadar twin-share TELAH DIKREDITKAN lebihan single-supplement:
      S = price_adult_single yang telah dibayar untuk slot 1 (snapshot SO)
      A = price_adult semasa (Trip Package Price, currency sama)
      Lebihan (excess)      = max(S − A, 0)
      Net SO traveller baru = max(A − excess, 0)   # = 2A − S, clamp ≥ 0
      Jumlah terkutop = S + (2A − S) = 2A ✓  (twin share sebenar)
  Kredit hanya untuk traveller tambahan PERTAMA cabin tu — supplement
  solo cuma menampung satu bed kembar.
- Cabin multi-pax / dah ada traveller tambahan: kadar price_adult penuh.

KATEGORI PAX (modal portal): traveller tambahan dipilih kategorinya —
main_adult (kadar price_adult; kredit solo di atas diterapkan di sini
SAHAJA), extra_bed (kadar price_upperberth penuh) atau infant (kadar
price_infant penuh). Kategori dibawa dalam segment pax_type description
item SO ('Main Guest (Additional)' / 'Extra Bed (Additional)' /
'Infant (Additional)') dan dipetakan semula ke Booking Reservation.pax_type
masa aktivasi slot.

Slot Booking Reservation untuk traveller baharu dicipta SELEPAS SO
dibayar penuh — melalui _recompute_booking_status() (hook Payment Entry
submit), corak yang sama dengan aktivasi booking utama. Idempotensi
aktivasi melalui pautan Booking Reservation.sales_order — slot menyimpan
SO sumbernya (satu booking boleh ada beberapa SO, semuanya dipaut ke
Booking melalui Sales Order.custom_booking sahaja). Rekod traveller
(Passport/dokumen) diisi selepas itu melalui flow sedia ada di
/traveller/travellers (slot kosong → save_booking_traveller).

CABIN BAHARU (bukan sekadar traveller tambahan): selain menambah
traveller ke cabin sedia ada, customer boleh tambah CABIN BARU beserta
seorang traveller (create_new_cabin_order). Cabin baharu diberi
cabin_no = (max cabin_no sedia ada) + 1, dan SO tambahan dibilkan pada
kadar solo (price_adult_single — single supplement terkandung), selari
dengan harga cabin solo pada booking utama. Line SO guna pax_type
"Main Guest (Single)" supaya _extra_cabin_layout() boleh baca snapshot
kadar solo itu — bila traveller KEDUA ditambah ke cabin baharu itu
kemudian (create_additional_traveller_order), kredit lebihan
single-supplement dikira dengan corak yang sama seperti cabin utama.
Cabin tambahan ini digabungkan ke layout _share_context() supaya
muncul dalam get_shareable_cabins dan senarai portal.
"""

import frappe
from frappe import _

from travel_booking.api.addon_manager import _get_owned_booking, _price_hidden_for
from travel_booking.api.constants import get_max_cabins
from travel_booking.api.portal_booking import _portal_access
from travel_booking.api.so_helpers import (
    _cabin_layout_from_so,
    _get_primary_so,
    _get_or_create_travel_item,
    _resolve_so_currency_and_rate,
)
from travel_booking.api.pricing import _get_pricing_map, _validate_selection_capacity
from travel_booking.api.constants import DEFAULT_SELLING_PRICE_LIST, TRAVEL_ITEM_CODE

# Tolerasi bebza pepuluhan (float) bila check "dibayar penuh".
_EPS = 0.01


# ══════════════════════════════════════════════
# CONTEXT (shared oleh kedua-dua endpoint)
# ══════════════════════════════════════════════

def _share_context(booking_number):
    """Resolve booking + layout SO utama + harga pakej semasa.

    Throw (frappe.throw) kalau booking bukan cruise / tiada SO utama /
    reservation belum diaktifkan (booking masih belum bayar langsung).

    B2B: end-customer tempahan partner DINAFIKAN — cabin sharing mencipta
    SO baharu yang dibilkan kepada Customer partner (transaksi kewangan
    partner); paparan kadar net turut tidak dibenarkan.
    """
    booking = _get_owned_booking(booking_number)

    _sc_user, sc_customer_name, _sc_managed = _portal_access()
    if _price_hidden_for(booking, sc_customer_name):
        frappe.throw(
            "Adding a traveller to your cabin is arranged by your travel agent. "
            "Please contact your agent.",
            frappe.PermissionError,
        )

    if not frappe.db.get_value("Booking", booking.name, "is_a_cruise_trip"):
        frappe.throw("Additional traveller is only available for cruise bookings.")

    # Slot mula wujud selepas bayaran pertama (_activate_booking). Tanpa
    # reservation, cabin layout portal belum bermakna — jangan papar.
    if not frappe.db.exists("Booking Reservation", {"booking": booking.name}):
        frappe.throw("This booking is not active yet. Complete your first payment to add a traveller.")

    so_name = _get_primary_so(booking.name)
    if not so_name:
        frappe.throw("Primary Sales Order not found for this booking.")

    # Layout = cabin SO utama + cabin TAMBAHAN yang dicipta melalui
    # create_new_cabin_order (SO tambahan, cabin_no melampaui layout
    # utama). Gabungan ini penting supaya cabin baharu turut muncul dalam
    # get_shareable_cabins (boleh terima traveller ke-2 dst.).
    primary_layout = _cabin_layout_from_so(so_name)
    layout = primary_layout + _extra_cabin_layout(booking.name, primary_layout)
    primary_so = frappe.db.get_value(
        "Sales Order", so_name,
        ["name", "currency", "transaction_date"], as_dict=True)

    pricing_map = _get_pricing_map(booking.trip_package) if booking.trip_package else {}

    trip_name, _departure = _trip_context(booking)
    group_label = frappe.db.get_value("Trip Group Date", booking.trip_date, "trip_group_name") or ""

    return {
        "booking":        booking,
        "booking_doc":    frappe.db.get_value("Booking", booking.name,
                            ["booking_number", "trip_date"], as_dict=True),
        "so_name":        so_name,
        "so_currency":    primary_so.currency,
        "layout":         layout,
        "pricing_map":    pricing_map,
        "trip_name":      trip_name or "",
        "group_label":    group_label,
    }


def _trip_context(booking):
    """(trip_name, departure_date) — corak sama dengan addon_manager."""
    if booking.trip_date:
        row = frappe.db.get_value("Trip Group Date", booking.trip_date,
                                  ["trip", "departure_date"], as_dict=True)
        if row:
            return row.trip, row.departure_date
    return None, None


def _cabin_meta(room_category):
    """(category_name, capacity, max_capacity) dari Trip Price Category."""
    row = frappe.db.get_value("Trip Price Category", room_category,
                              ["category_name", "capacity", "max_capacity"], as_dict=True)
    if not row:
        return room_category, 2, 2
    max_cap = row.max_capacity if row.max_capacity is not None else (row.capacity or 2)
    return (row.category_name or room_category), (row.capacity or 2), max_cap


def _cabin_no_from_description(description):
    """'Trip | Group | Room Category | Cabin N | Pax Type' → N (atau None)."""
    parts = (description or "").split(" | ")
    if len(parts) < 4:
        return None
    try:
        return int(parts[3].strip().lower().replace("cabin", "").strip())
    except ValueError:
        return None


def _extra_cabin_layout(booking_name, primary_layout):
    """Cabin TAMBAHAN (order 'cabin baharu & traveller' —
    create_new_cabin_order) yang cabin_no-nya melampaui layout SO utama.

    Corak sumber tunggal: cabin + kategori dibaca dari description item SO
    tambahan ('Trip | Group | Room Category | Cabin N | Pax Type | ...').
    pax SENGAJA 0 — penghuni cabin tambahan TIDAK dikira di sini kerana
    _activated_extras_for/_pending_extras_for sudah membaca SO tambahan
    yang sama (kira berganda kalau pax diisi); entri ini cukup sekadar
    supaya cabin baharu muncul dalam get_shareable_cabins. single_rate
    diambil dari line 'Main Guest (Single)' (kadar solo snapshot) —
    dipakai untuk kredit lebihan single-supplement bila traveller KEDUA
    menyertai cabin baharu tersebut.
    """
    primary_nos = {c.get("cabin_no") for c in (primary_layout or [])}
    extras = {}
    for line in _share_so_lines(booking_name):
        cabin_no = _cabin_no_from_description(line["description"])
        if cabin_no is None or cabin_no in primary_nos:
            continue
        parts = (line["description"] or "").split(" | ")
        room_category = parts[2].strip() if len(parts) >= 5 else ""
        pax_type      = parts[4].strip() if len(parts) >= 5 else ""
        if cabin_no not in extras:
            extras[cabin_no] = {"cabin_no": cabin_no, "room_category": room_category,
                                "pax": 0, "pax_breakdown": {}, "room_privacy": "",
                                "single_rate": None}
        if (pax_type == "Main Guest (Single)"
                and extras[cabin_no]["single_rate"] is None):
            extras[cabin_no]["single_rate"] = float(line["rate"] or 0)
    return [extras[n] for n in sorted(extras.keys())]


def _next_cabin_no(booking_name, layout):
    """Nombor cabin untuk cabin BAHARU — max cabin_no antara layout
    (SO utama + tambahan) dan reservation sebenar, + 1."""
    nos = [int(c.get("cabin_no") or 0) for c in (layout or [])]
    nos += [int(r.cabin_no or 0) for r in frappe.get_all(
        "Booking Reservation", filters={"booking": booking_name},
        fields=["cabin_no"])]
    return (max(nos) if nos else 0) + 1


def _share_so_lines(booking_name):
    """Semua baris SO traveller tambahan untuk satu booking — dikenalpasti
    TANPA marker: berkaitan booking melalui Sales Order.custom_booking,
    BUKAN SO utama (primary = SO pertama booking), dan menjual item
    TRAVEL-PKG (SO addon menjual item berbeza). SO Cancelled (docstatus=2)
    dikecualikan. Status aktivasi setiap SO dibaca dari pautan
    Booking Reservation.sales_order (di-stamp oleh
    _activate_share_traveller_reservation).
    """
    primary_so = _get_primary_so(booking_name)
    return frappe.db.sql("""
        SELECT so.name AS so_name, soi.description AS description,
               soi.qty AS qty, soi.rate AS rate,
               EXISTS(SELECT 1 FROM `tabBooking Reservation` br
                      WHERE br.sales_order = so.name) AS activated
        FROM `tabSales Order` so
        JOIN `tabSales Order Item` soi
             ON soi.parent = so.name AND soi.parenttype = 'Sales Order'
        WHERE so.custom_booking = %s
          AND so.docstatus IN (0, 1)
          AND soi.item_code = %s
          AND so.name != %s
    """, (booking_name, TRAVEL_ITEM_CODE, primary_so or ""), as_dict=True)


def _activated_extras_for(booking_name, cabin_no=None):
    """Bilangan traveller tambahan yang SUDAH diaktifkan (SO dibayar
    penuh → slot reservation dicipta) untuk satu booking — optional
    ditapis per cabin.

    Dikenalpasti dari SISI SO: SO traveller tambahan yang ada slot
    Booking Reservation membawa sales_order = SO itu (di-stamp masa slot
    dicipta). Label guest_label TIDAK digunakan — label slot seragam
    "Traveller N" untuk semua pax. Cabin dibaca dari description item SO,
    corak sama dengan _pending_share_lines().
    """
    total = 0
    for line in _share_so_lines(booking_name):
        if not line["activated"]:
            continue
        if cabin_no is not None and _cabin_no_from_description(line["description"]) != cabin_no:
            continue
        total += int(line["qty"] or 0) or 1
    return total


def _pending_share_lines(booking_name):
    """Baris item SO traveller tambahan yang PENDING (SO wujud tapi slot
    reservation belum dicipta) untuk satu booking.

    SO traveller tambahan dikenalpasti TANPA custom field pada SO
    (rujuk _share_so_lines). Pending = belum ada slot Booking
    Reservation yang membawa sales_order SO tersebut — slot belum
    pernah diaktifkan.
    """
    lines = []
    for line in _share_so_lines(booking_name):
        if line["activated"]:
            continue
        lines.append({
            "so":       line["so_name"],
            "cabin_no": _cabin_no_from_description(line["description"]),
            "qty":      int(line["qty"] or 0) or 1,
        })
    return lines


def _pending_extras_for(booking_name, cabin_no=None):
    """Bilangan traveller tambahan PENDING (SO belum diaktifkan jadi slot)
    untuk satu booking — optional ditapis per cabin. SO Cancelled
    (docstatus=2) dan yang dah diaktifkan TIDAK dikira."""
    total = 0
    for line in _pending_share_lines(booking_name):
        if cabin_no is not None and line["cabin_no"] != cabin_no:
            continue
        total += line["qty"]
    return total


# ══════════════════════════════════════════════
# API: KELAYAKAN + HARGA (untuk paparan portal)
# ══════════════════════════════════════════════

def _share_category_options(price, excess, occupancy=0, capacity=0, max_capacity=0):
    """Pilihan kategori pax traveller tambahan (share cruise-only → model
    SLOT): Main Adult / Extra Bed / Infant. Kredit lebihan single-supplement
    diterapkan pada kadar Main Adult SAHAJA (kemasan katil kembar); Extra
    Bed & Infant dibayar pada kadar penuh. Kadar NET untuk paparan portal —
    pengiraan SEMULA di server masa create order.

    Rule kategori SELARI booknow (model cruise, rujuk capFor() booknow.js):
    - Main Adult (price_adult): hanya bila base capacity BELUM penuh
      (occupancy < capacity) — dan tak melebihi max_capacity.
    - Extra Bed (price_upperberth): hanya bila base capacity DAH penuh
      (occupancy >= capacity). capacity 0 (tanpa had struktur) → syarat
      booknow cuma >= 1 main guest — cabin add traveller sememangnya sudah
      ada penghuni, jadi sentiasa layak.
    - Infant: enable bila ada >= 1 main guest (dipenuhi) dan ada baki
      max_capacity.
    Kategori yang tak layak dibawa dengan disabled=True + disabled_reason
    supaya modal portal disable pilihan itu DAN create_additional_traveller_
    order enforce rule yang sama di server.
    """
    price = price or {}
    adult_rate  = float(price.get("price_adult")      or 0)
    extra_rate  = float(price.get("price_upperberth") or 0)
    infant_rate = float(price.get("price_infant")     or 0)

    unlimited = (max_capacity == 0)
    base_full = capacity > 0 and occupancy >= capacity
    max_full  = (not unlimited) and occupancy >= max_capacity

    return [
        {
            "key":      "main_adult",
            "label":    "Main Adult",
            "rate":     adult_rate,
            "net_rate": max(adult_rate - excess, 0.0),
            "note":     ("twin-share credit applied") if excess > _EPS else "",
            "disabled": base_full or max_full,
            "disabled_reason": (
                "Cabin base capacity is full — choose Extra Bed instead."
                if base_full else
                ("Cabin is at maximum capacity." if max_full else "")),
        },
        {
            "key":      "extra_bed",
            "label":    "Extra Bed",
            "rate":     extra_rate,
            "net_rate": extra_rate,
            "note":     "",
            "disabled": (capacity > 0 and not base_full) or max_full,
            "disabled_reason": (
                ("Available once the base capacity (" + str(int(capacity)) +
                 " pax) is filled.")
                if (capacity > 0 and not base_full) else
                ("Cabin is at maximum capacity." if max_full else "")),
        },
        {
            "key":      "infant",
            "label":    "Infant",
            "rate":     infant_rate,
            "net_rate": infant_rate,
            "note":     "",
            "disabled": max_full,
            "disabled_reason": (
                "Cabin is at maximum capacity." if max_full else ""),
        },
    ]


@frappe.whitelist()
def get_shareable_cabins(booking_number: str) -> dict:
    """Senarai cabin booking yang BOLEH terima traveller tambahan, lengkap
    dengan harga (solo: kredit lebihan single-supplement; multi-pax /
    dah ada tambahan: kadar adult penuh). Paparan portal; pengiraan
    SEMULA di server masa create order."""
    ctx = _share_context(booking_number)
    booking = ctx["booking"]
    seats_left = _trip_seats_left(booking)

    cabins = []
    for cab in ctx["layout"]:
        cabin_no = cab.get("cabin_no")
        room_category = cab.get("room_category")
        single_rate = cab.get("single_rate")

        meta_name, capacity, max_capacity = _cabin_meta(room_category)

        activated = _activated_extras_for(booking.name, cabin_no)
        pending   = _pending_extras_for(booking.name, cabin_no)
        occupancy = int(cab.get("pax") or 0) + activated + pending
        has_room = (max_capacity == 0) or (occupancy < max_capacity)

        price = ctx["pricing_map"].get(room_category)
        adult_rate = float(price.price_adult or 0) if price else 0.0

        # Kredit single-supplement hanya untuk traveller tambahan PERTAMA
        # cabin yang MASIH solo (1 penghuni asal, tiada tambahan aktif
        # mahupun pending) — supplement solo cuma menampung satu bed
        # kembar. Cabin multi-pax / dah ada tambahan: kadar adult penuh.
        still_solo = (single_rate is not None and occupancy == 1)
        if still_solo:
            excess   = max(float(single_rate) - adult_rate, 0.0)
            net_rate = max(adult_rate - excess, 0.0)
        else:
            excess   = 0.0
            net_rate = adult_rate

        cabins.append({
            "cabin_no":       cabin_no,
            "room_category":  room_category,
            "room_name":      meta_name,
            "capacity":       capacity,
            "max_capacity":   max_capacity,
            "occupancy":      occupancy,
            "single_rate":    float(single_rate) if single_rate is not None else None,
            "adult_rate":     adult_rate,
            "excess_credit":  excess,
            "net_rate":       net_rate,
            "currency":       ctx["so_currency"],
            # Pilihan kategori pax untuk modal portal — kadar net ikut
            # kategori (kredit solo pada Main Adult sahaja) + rule
            # kapasiti selari booknow (occupancy vs capacity/max_capacity).
            "categories":     _share_category_options(
                                  price, excess, occupancy, capacity, max_capacity),
            "eligible":       bool(has_room and seats_left > 0),
            "reason":         "" if (has_room and seats_left > 0) else (
                "Cabin is full." if not has_room else "This trip date is fully booked."),
        })

    return {
        "success": True,
        "booking_number": ctx["booking_doc"].booking_number,
        "currency": ctx["so_currency"],
        "seats_left": seats_left,
        "cabins": cabins,
    }


def _trip_seats_left(booking):
    """Baki tempat peringkat TRIP DATE — corak gate overbooking
    confirm_booking (max_participants == 0 = unlimited), DITAMBAH
    kiraan traveller tambahan (pending SO + slot dah aktif) supaya
    tambah traveller tak boleh oversell trip."""
    td = frappe.db.get_value("Trip Group Date", booking.trip_date,
                             ["max_participants"], as_dict=True)
    if not td or int(td.max_participants or 0) == 0:
        return 999999  # unlimited

    existing_pax = frappe.db.sql("""
        SELECT COALESCE(SUM(b.booked_pax), 0)
        FROM `tabBooking` b
        WHERE b.trip_date = %s AND b.status != 'Cancelled'
    """, booking.trip_date)[0][0] or 0

    trip_booking_names = [r[0] for r in frappe.db.get_all(
        "Booking", filters={"trip_date": booking.trip_date, "status": ["!=", "Cancelled"]},
        pluck="name")]
    extra = 0
    if trip_booking_names:
        # Slot tambahan yang dah aktif — pautan Booking
        # Reservation.sales_order pada SO tambahan setiap booking (label
        # guest_label TIDAK digunakan; slot seragam "Traveller N") …
        for booking_name in trip_booking_names:
            extra += _activated_extras_for(booking_name)
        # … plus SO tambahan yang masih pending — dikenalpasti tanpa
        # custom field marker: bukan SO primary booking tersebut, menjual
        # item TRAVEL-PKG, dan belum ada slot reservation yang membawa
        # sales_order SO tersebut.
        extra += frappe.db.sql("""
            SELECT COALESCE(SUM(soi.qty), 0)
            FROM `tabSales Order` so
            JOIN `tabSales Order Item` soi
                 ON soi.parent = so.name AND soi.parenttype = 'Sales Order'
            WHERE so.custom_booking IN %s
              AND so.docstatus IN (0, 1)
              AND soi.item_code = %s
              AND so.name != (
                  SELECT so2.name FROM `tabSales Order` so2
                  WHERE so2.custom_booking = so.custom_booking
                  ORDER BY so2.creation ASC LIMIT 1)
              AND NOT EXISTS(SELECT 1 FROM `tabBooking Reservation` br
                             WHERE br.sales_order = so.name)
        """, (tuple(trip_booking_names), TRAVEL_ITEM_CODE))[0][0] or 0

    return int(td.max_participants) - int(existing_pax) - int(extra)


# ══════════════════════════════════════════════
# API: CIPTA SO TRAVELLER TAMBAHAN
# ══════════════════════════════════════════════

# Kategori pax traveller tambahan → segment pax_type pada description item
# SO (sumber tunggal layout) + label mesra user. Kredit lebihan
# single-supplement hanya untuk main_adult (rujuk _share_category_options).
_SHARE_CATEGORY_PAX_TYPES = {
    "main_adult": "Main Guest (Additional)",
    "extra_bed":  "Extra Bed (Additional)",
    "infant":     "Infant (Additional)",
}


@frappe.whitelist()
def create_additional_traveller_order(booking_number: str, cabin_no: int,
                                      category: str = "main_adult") -> dict:
    """Cipta SO BAHARU untuk 1 traveller tambahan dalam `cabin_no`.

    `category` — kategori pax traveller: 'main_adult' (kadar adult; kredit
    lebihan single-supplement bila cabin masih solo), 'extra_bed' (kadar
    upper berth penuh) atau 'infant' (kadar infant penuh). Default
    'main_adult' untuk caller lama.

    SO dipaut ke booking sedia ada melalui custom_booking SAHAJA; cabin
    + kategori dibawa dalam description item (sumber tunggal layout).
    Harga dikira SEMULA di server (snapshot SO utama + Trip Package Price
    semasa) — client tidak pernah menentukan harga. SO disubmit terus;
    customer bayar melalui halaman billing portal yang sedia ada.
    """
    ctx = _share_context(booking_number)
    booking = ctx["booking"]

    try:
        cabin_no = int(cabin_no)
    except (TypeError, ValueError):
        frappe.throw("Invalid cabin.")

    category = (category or "main_adult").strip().lower()
    if category not in _SHARE_CATEGORY_PAX_TYPES:
        frappe.throw("Invalid traveller category.")

    cabin = next((c for c in ctx["layout"] if c.get("cabin_no") == cabin_no), None)
    if not cabin:
        frappe.throw("Cabin not found in this booking.")

    # Pengiraan semula (bukan percaya paparan get_shareable_cabins).
    share = get_shareable_cabins(booking_number)
    target = next((c for c in share["cabins"] if c["cabin_no"] == cabin_no), None)
    if not target or not target["eligible"]:
        frappe.throw("This cabin cannot accept an additional traveller right now.")

    cat = next((c for c in target["categories"] if c["key"] == category), None)
    if not cat:
        frappe.throw("Invalid traveller category.")
    # Enforce rule kapasiti kategori yang sama dgn modal (booknow): cth
    # Extra Bed hanya bila base capacity penuh; Main Adult hanya bila
    # base capacity belum penuh. Jangan percaya UI semata-mata.
    if cat.get("disabled"):
        frappe.throw(cat.get("disabled_reason") or
                     "This traveller category is not available for this cabin.")

    room_category = target["room_category"]
    base_rate     = float(cat["rate"])
    # Kredit lebihan single-supplement hanya relevan untuk kategori Main
    # Adult (kemasan katil kembar); Extra Bed & Infant dibayar penuh.
    excess        = float(target["excess_credit"]) if category == "main_adult" else 0.0
    net_rate      = float(cat["net_rate"])
    pax_type      = _SHARE_CATEGORY_PAX_TYPES[category]
    cat_label     = cat["label"]
    so_currency   = ctx["so_currency"]

    so_currency, so_company, so_price_list, conversion_rate = _resolve_so_currency_and_rate(so_currency)

    item_code = _get_or_create_travel_item()
    item_name = (room_category + " (Cabin " + str(cabin_no) + ") \u2014 " +
                 cat_label + " Additional Traveller")
    if category == "main_adult" and excess > _EPS:
        fare_note = ("twin share " + frappe.utils.fmt_money(base_rate, currency=so_currency) +
                     " less single-supplement credit " +
                     frappe.utils.fmt_money(excess, currency=so_currency))
        item_name += " (Twin Share)"
    else:
        fare_note = (cat_label.lower() + " additional traveller fare " +
                     frappe.utils.fmt_money(base_rate, currency=so_currency))

    line = {
        "item_code":   item_code,
        "item_name":   item_name,
        "qty":         1,
        # Net terus (idiom codebase: rate eksplisit, price list mekanikal).
        # Kredit lebihan (kalau ada) dijelaskan dalam description untuk
        # jejak audit.
        "rate":        net_rate,
        "uom":         "Nos",
        "description": (ctx["trip_name"] + " | " + ctx["group_label"] + " | " +
                        room_category + " | Cabin " + str(cabin_no) +
                        " | " + pax_type + " | " + fare_note),
    }

    _original_user = frappe.local.session.user
    frappe.local.session.user = "Administrator"
    try:
        so = frappe.get_doc({
            "doctype":                "Sales Order",
            "customer":               booking.customer,
            "custom_booking":         booking.name,
            "company":                so_company,
            "transaction_date":       frappe.utils.today(),
            "delivery_date":          frappe.utils.today(),
            "order_type":             "Sales",
            "items":                  [line],
            "selling_price_list":     so_price_list or DEFAULT_SELLING_PRICE_LIST,
            "currency":               so_currency,
            "conversion_rate":        conversion_rate,
            "disable_rounded_total":  1,
        })
        so.insert(ignore_permissions=True)
        so.flags.ignore_permissions = True
        so.submit()
        frappe.db.commit()
    finally:
        frappe.local.session.user = _original_user

    # Net = 0 (lebihan melibihi kadar adult) — tak ada apa nak bayar;
    # aktifkan slot terus supaya flow tamat serta-merta.
    if net_rate <= _EPS:
        _activate_share_traveller_reservation(so.name)
        frappe.db.commit()
        return {
            "success":        True,
            "sales_order":    so.name,
            "grand_total":    net_rate,
            "currency":       so_currency,
            "fully_covered":  True,
            "travellers_url": "/traveller/travellers?ref=" + booking_number,
            "message":        "The single-supplement credit fully covers the additional traveller. Please fill in their details.",
        }

    return {
        "success":        True,
        "sales_order":    so.name,
        "grand_total":    net_rate,
        "currency":       so_currency,
        "fully_covered":  False,
        "billing_url":    "/traveller/billing?ref=" + booking_number + "&bill=" + so.name,
        "message":        "Additional traveller order created. Please complete the payment to confirm their slot.",
    }


# ══════════════════════════════════════════════
# API: CABIN BAHARU + TRAVELLER (SO tambahan berasingan)
# ══════════════════════════════════════════════

@frappe.whitelist()
def get_new_cabin_options(booking_number: str) -> dict:
    """Pilihan CABIN BAHARU untuk booking — kategori bilik dari Trip
    Package Price (peta harga semasa), diharga pada kadar SOLO
    (price_adult_single — single supplement terkandung) kerana traveller
    pertama cabin baharu menempah cabin itu seorang diri. Traveller kedua
    boleh menyertai kemudian melalui create_additional_traveller_order
    (dengan kredit lebihan single-supplement, corak sedia ada).
    Paparan portal sahaja; pengiraan semula di server masa create order.
    """
    ctx = _share_context(booking_number)
    booking = ctx["booking"]

    seats_left  = _trip_seats_left(booking)
    next_cabin_no = _next_cabin_no(booking.name, ctx["layout"])
    max_cabins  = get_max_cabins()

    cabins_used = len(ctx["layout"])
    has_cabin_slot = cabins_used < max_cabins
    eligible = seats_left > 0 and has_cabin_slot
    if not eligible:
        reason = ("This trip date is fully booked." if seats_left <= 0
                  else "Maximum " + str(max_cabins) + " cabins are allowed per booking.")
    else:
        reason = ""

    categories = []
    for room_category, price in sorted(ctx["pricing_map"].items()):
        meta_name, capacity, max_capacity = _cabin_meta(room_category)
        categories.append({
            "room_category": room_category,
            "room_name":     meta_name,
            "capacity":      capacity,
            "max_capacity":  max_capacity,
            # Kadar solo = harga seorang diri dalam cabin (single
            # supplement terkandung) — selari dengan baris "Main Guest
            # (Single)" pada booking utama.
            "solo_rate":     float(price.price_adult_single or 0),
            "adult_rate":    float(price.price_adult or 0),
            # Kadar pax tambahan untuk stepper kuantiti dalam modal —
            # extra bed hanya terbuka bila base capacity penuh, infant
            # perlu >= 1 main guest (rule di-enforce semula di server).
            "upperberth_rate": float(price.price_upperberth or 0),
            "infant_rate":     float(price.price_infant or 0),
        })

    return {
        "success":        True,
        "booking_number": ctx["booking_doc"].booking_number,
        "currency":       ctx["so_currency"],
        "seats_left":     seats_left,
        "next_cabin_no":  next_cabin_no,
        "max_cabins":     max_cabins,
        "eligible":       eligible,
        "reason":         reason,
        "categories":     categories,
    }


@frappe.whitelist()
def create_new_cabin_order(booking_number: str, room_category: str,
                           main_guests: int = 1, extra_beds: int = 0,
                           infants: int = 0) -> dict:
    """Cipta CABIN BAHARU + tetamu — SO BAHARU yang berasingan.

    Kuantiti tetamu ikut model cruise booknow (client tidak pernah
    menentukan harga/kelayakan — semua dikira & disemak semula di server):
      main_guests — 1 (kadar solo price_adult_single) atau >= 2 (kadar
                    twin-share price_adult setiap org)
      extra_beds  — katil tambahan (price_upperberth); hanya sah bila
                    base capacity penuh (main_guests == capacity)
      infants     — infant (price_infant); perlu >= 1 main guest
    Semua tetamu berkongsi max_capacity cabin (0 = unlimited). Rule
    kapasiti disemak melalui _validate_selection_capacity (sumber
    tunggal, sama dengan confirm_booking) + had tempat peringkat trip.

    Cabin baharu diberi cabin_no = (max cabin_no sedia ada) + 1. Corak
    SO sama dengan create_additional_traveller_order: dipaut ke booking
    melalui custom_booking, cabin + kategori dibawa dalam description
    item — SATU baris setiap jenis pax. Baris main guest bila
    main_guests == 1 dikekal pax_type "Main Guest (Single)" supaya
    snapshot kadar solo kekal boleh dibaca oleh _extra_cabin_layout
    untuk kredit lebihan single-supplement bila traveller KEDUA
    menyertai cabin itu kemudian. Slot Booking Reservation dicipta
    selepas SO dibayar penuh (aktivasi corak sedia ada); detail
    traveller diisi kemudian di /traveller/travellers.
    """
    ctx = _share_context(booking_number)
    booking = ctx["booking"]

    price = ctx["pricing_map"].get(room_category)
    if not price:
        frappe.throw("Invalid room category for this trip package.")

    try:
        main_guests = int(main_guests or 1)
        extra_beds  = int(extra_beds or 0)
        infants     = int(infants or 0)
    except (TypeError, ValueError):
        frappe.throw("Invalid guest quantity.")
    if main_guests < 1 or extra_beds < 0 or infants < 0:
        frappe.throw("Invalid guest quantity.")

    _meta_name, capacity, max_capacity = _cabin_meta(room_category)

    # Rule kapasiti cabin — sumber tunggal yang sama dengan confirm_booking
    # (_validate_selection_capacity, model cruise): main guest 1..capacity,
    # extra bed hanya bila base capacity penuh, infant perlu >= 1 main
    # guest, dan semua tetamu terhad max_capacity (0 = unlimited).
    _validate_selection_capacity(
        [{"room_category": room_category, "main_guests": main_guests,
          "extra_beds": extra_beds, "infants": infants}],
        {room_category: {"capacity": capacity, "max_capacity": max_capacity}},
        is_cruise=True)

    total_pax = main_guests + extra_beds + infants
    seats_left = _trip_seats_left(booking)
    if seats_left < total_pax:
        frappe.throw(
            "This trip date does not have enough seats left (" +
            str(max(seats_left, 0)) + " remaining) for " +
            str(total_pax) + " guest(s).")

    cabin_no = _next_cabin_no(booking.name, ctx["layout"])
    if cabin_no > get_max_cabins():
        frappe.throw(
            "Maximum " + str(get_max_cabins()) +
            " cabins are allowed per booking (Cabin No " +
            str(cabin_no) + " exceeds the limit)."
        )

    adult_rate  = float(price.price_adult or 0)
    solo_rate   = float(price.price_adult_single or 0)
    upper_rate  = float(price.price_upperberth or 0)
    infant_rate = float(price.price_infant or 0)
    so_currency = ctx["so_currency"]

    so_currency, so_company, so_price_list, conversion_rate = _resolve_so_currency_and_rate(so_currency)

    item_code = _get_or_create_travel_item()

    def _line(pax_type, label, qty, rate, fare_note):
        return {
            "item_code":   item_code,
            "item_name":   room_category + " (Cabin " + str(cabin_no) + ") \u2014 " + label,
            "qty":         qty,
            # Idiom codebase: rate eksplisit, price list mekanikal.
            "rate":        rate,
            "uom":         "Nos",
            "description": (ctx["trip_name"] + " | " + ctx["group_label"] + " | " +
                            room_category + " | Cabin " + str(cabin_no) +
                            " | " + pax_type + " | " + fare_note),
        }

    lines = []
    if main_guests == 1:
        lines.append(_line(
            "Main Guest (Single)", "New Cabin & Traveller", 1, solo_rate,
            "new cabin, solo occupancy fare (single supplement included); "
            "twin-share rate " + frappe.utils.fmt_money(adult_rate, currency=so_currency) +
            " applies to a second traveller added later"))
    else:
        lines.append(_line(
            "Main Guest", "New Cabin Main Guest", main_guests, adult_rate,
            "new cabin, twin-share fare " +
            frappe.utils.fmt_money(adult_rate, currency=so_currency) +
            " x " + str(main_guests) + " guest(s)"))
    if extra_beds:
        lines.append(_line(
            "Extra Bed", "New Cabin Extra Bed", extra_beds, upper_rate,
            "extra bed fare " +
            frappe.utils.fmt_money(upper_rate, currency=so_currency) +
            " x " + str(extra_beds)))
    if infants:
        lines.append(_line(
            "Infant", "New Cabin Infant", infants, infant_rate,
            "infant fare " +
            frappe.utils.fmt_money(infant_rate, currency=so_currency) +
            " x " + str(infants)))

    grand_total = round(sum(float(l["rate"]) * int(l["qty"]) for l in lines), 2)

    _original_user = frappe.local.session.user
    frappe.local.session.user = "Administrator"
    try:
        so = frappe.get_doc({
            "doctype":                "Sales Order",
            "customer":               booking.customer,
            "custom_booking":         booking.name,
            "company":                so_company,
            "transaction_date":       frappe.utils.today(),
            "delivery_date":          frappe.utils.today(),
            "order_type":             "Sales",
            "items":                  lines,
            "selling_price_list":     so_price_list or DEFAULT_SELLING_PRICE_LIST,
            "currency":               so_currency,
            "conversion_rate":        conversion_rate,
            "disable_rounded_total":  1,
        })
        so.insert(ignore_permissions=True)
        so.flags.ignore_permissions = True
        so.submit()
        frappe.db.commit()
    finally:
        frappe.local.session.user = _original_user

    # Jumlah = 0 — tak ada apa nak bayar; aktifkan slot terus supaya
    # cabin + traveller terus wujud dalam senarai.
    if grand_total <= _EPS:
        _activate_share_traveller_reservation(so.name)
        frappe.db.commit()
        return {
            "success":        True,
            "sales_order":    so.name,
            "cabin_no":       cabin_no,
            "grand_total":    grand_total,
            "currency":       so_currency,
            "fully_covered":  True,
            "travellers_url": "/traveller/travellers?ref=" + booking_number,
            "message":        "The new cabin is fully covered. Please fill in the traveller details.",
        }

    return {
        "success":        True,
        "sales_order":    so.name,
        "cabin_no":       cabin_no,
        "grand_total":    grand_total,
        "currency":       so_currency,
        "fully_covered":  False,
        "billing_url":    "/traveller/billing?ref=" + booking_number + "&bill=" + so.name,
        "message":        "New cabin order created. Please complete the payment to confirm the cabin and its traveller slots.",
    }


# ══════════════════════════════════════════════
# AKTIVASI SLOT (dipanggil dari _recompute_booking_status)
# ══════════════════════════════════════════════

def _activate_share_traveller_reservation(so_name):
    """Bila SO traveller tambahan dibayar PENUH, cipta slot Booking
    Reservation dalam cabin sasaran (di bawah Booking yang SAMA).

    SO traveller tambahan dikenalpasti TANPA custom field: berkaitan
    booking (custom_booking), BUKAN SO primary booking tu, dan menjual
    item TRAVEL-PKG. Idempoten melalui pautan Booking Reservation
    sales_order — slot yang dicipta di-stamp dengan SO sumbernya, jadi
    panggilan semula (recompute berulang) tidak mendua slot. Cabin +
    room_category diparse dari description item. Client
    controller BookingReservation.validate() (validate_cabin_capacity)
    jadi penghad terakhir — kalau cabin penuh, insert throw dan CALLER
    bertanggungjawab tangkap (payment tetap direkodkan, corak sedia ada).
    """
    so = frappe.db.get_value(
        "Sales Order", so_name,
        ["name", "docstatus", "customer", "custom_booking",
         "grand_total", "advance_paid"],
        as_dict=True)
    if not so or not so.custom_booking or so.docstatus != 1:
        return None
    if so.name == _get_primary_so(so.custom_booking):
        return None  # SO utama — pax dia diaktifkan oleh _activate_booking
    # Mesti menjual slot pax (TRAVEL-PKG) — SO addon menjual item lain.
    # SATU ATAU LEBIH baris: create_new_cabin_order menghasilkan satu
    # baris setiap jenis pax (Main Guest / Extra Bed / Infant) dalam SO
    # yang sama; create_additional_traveller_order kekal satu baris.
    items = frappe.get_all(
        "Sales Order Item",
        filters={"parent": so_name, "parenttype": "Sales Order",
                 "item_code": TRAVEL_ITEM_CODE},
        fields=["description", "qty"], order_by="idx")
    if not items:
        return None
    if frappe.db.exists("Booking Reservation", {"sales_order": so.name}):
        return None  # dah diaktifkan
    if float(so.advance_paid or 0) < float(so.grand_total or 0) - _EPS:
        return None  # belum dibayar penuh

    # Parse cabin + kategori + pax_type SETIAP baris dahulu — baris yang
    # gagal resolve ialah masalah data; log & batal keseluruhan (aktivasi
    # boleh diulang selepas data dibetulkan, idempoten melalui pautan
    # sales_order).
    plans = []
    for item in items:
        parts = (item.description or "").split(" | ")
        room_category = parts[2].strip() if len(parts) >= 5 else None
        cabin_no = _cabin_no_from_description(item.description)
        if not room_category or not cabin_no or not frappe.db.exists("Trip Price Category", room_category):
            frappe.log_error(
                "Share traveller SO " + str(so_name) + ": room_category/cabin tidak dapat "
                "diresolve dari description item. Reservation perlu dibuat manual.",
                "Share Traveller Activation Error")
            return None

        # Kategori pax dari segment 5 description — "Main Guest (Single)" /
        # "Main Guest" / "Main Guest (Additional)" / "Extra Bed
        # (Additional)" / "Infant (Additional)". Buang akhiran
        # "(Additional)" supaya pax_type reservation seragam dengan slot
        # booking utama; SO lama tanpa segmen berkenaan kekal "Main Guest".
        res_pax_type = "Main Guest"
        if len(parts) >= 5:
            res_pax_type = parts[4].strip().replace(" (Additional)", "") or "Main Guest"

        plans.append((room_category, cabin_no, res_pax_type,
                      max(1, int(item.qty or 1))))

    created = []
    for room_category, cabin_no, res_pax_type, qty in plans:
        for _ in range(qty):
            res = frappe.get_doc({
                "doctype":         "Booking Reservation",
                "booking":         so.custom_booking,
                "room_category":   room_category,
                "cabin_no":        cabin_no,
                "pax_type":        res_pax_type,
                # Label auto "Traveller N" oleh before_insert (seragam dengan
                # pax lain) + Guest Sequence dalam cabin oleh set_guest_sequence.
                "room_privacy":    "Private",
                "is_a_cruise":     1,
                "status":          "Confirmed",
                "document_status": "Pending",
                # Stamp SO sumber — idempotensi aktivasi + jejak audit slot.
                "sales_order":     so.name,
            }).insert(ignore_permissions=True)
            created.append(res.name)

    # Stamp SO sumber diletak terus pada slot di atas (sales_order) —
    # kalau insert throw (cabin penuh dsb.), tiada slot tercipta dan
    # aktivasi boleh diulang lepas data dibetulkan.

    # Cabin yang dah diisi traveller tambahan ialah kumpulan sendiri —
    # tukar room privacy KESELURUHAN penghuni cabin ni kepada "Private"
    # (pilihan "Open Sharing" lama tidak lagi berkaitan).
    frappe.db.set_value("Booking Reservation",
                        {"booking": so.custom_booking, "cabin_no": cabin_no,
                         "name": ["not in", created],
                         "status": ["!=", "Cancelled"]},
                        "room_privacy", "Private", update_modified=False)
    return created[0] if created else None
