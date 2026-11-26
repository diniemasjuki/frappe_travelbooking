# travel_booking/api/addon_manager.py
#
# Portal endpoints untuk upsell addon/insurance selepas booking confirmed:
#   - get_available_addons(booking_number) — katalog Addon Package yang
#     layak untuk booking ni (scoped ikut Package Offer / Travel Date —
#     RECONDITION Nov 2026, dahulu Trip Package / Trip Group Date), dengan
#     status stok/cutoff untuk paparan portal.
#   - checkout_addons(booking_number, lines, ...) — cart checkout:
#     re-price server-side, cipta SATU Sales Order addon (item "Trip Addon
#     Package") + Booking Addon (header) + Booking Addon Item (baris).
#     Manual Transfer: Payment Entry DRAFT + resit dilampirkan serta-merta
#     (menunggu admin verify); Online Payment: payment URL gateway.
#
# Ownership booking disahkan setiap panggilan melalui _get_customer()
# (portal_booking.py) — customer HANYA boleh checkout addon untuk booking
# dia sendiri, tak kira apa booking_number dihantar.

import frappe
import json

from travel_booking.api.portal_booking import (
    _portal_access,
    _booking_action_allowed,
    _price_hidden_for,
)
from travel_booking.api.constants import ADDON_PACKAGE_ITEM_CODE
from travel_booking.api.so_helpers import (
    _get_or_create_travel_item,
    _get_primary_so,
    _link_booking_sales_order,
    _resolve_so_currency_and_rate,
    _create_manual_payment_entry,
)
from travel_booking.utils.upload_normalize import _decode_and_normalize_upload


# ══════════════════════════════════════════════
# OWNERSHIP GUARD
# ══════════════════════════════════════════════

def _get_owned_booking(booking_number):
    """Sahkan booking_number wujud DAN milik customer yang sedang login.
    Pulang dict {name, customer, package_offer, trip_package, trip_date,
    status, affiliate, booking_channel, end_customer}, atau throw
    PermissionError. Dipanggil di SETIAP endpoint dalam modul ni sebelum
    apa-apa operasi — jangan percaya booking_number dari client tanpa
    verify ownership.

    package_offer = keterkaitan struktur baharu (RECONDITION Nov 2026);
    trip_package/trip_date ialah medan warisan booking lama — kekal dibaca
    untuk resolusi konteks (legacy mapping melalui provenance offer).

    ON-BEHALF: manager (booked_by) juga dibenarkan — addon/upsell
    melibatkan maklumat traveller, jadi perlukan tahap akses "Docs"
    (rujuk _booking_action_allowed). Downstream SO dibina atas
    booking.customer (bukan session user) supaya IDOR kekal terkawal.

    B2B: end-customer tempahan partner turut dibenarkan pada tahap Docs
    (lihat status addon) — tapi endpoint transaksi (checkout) MENAFIKAN
    dia secara eksplisit melalui _price_hidden_for() kerana SO addon
    dibilkan kepada Customer partner.
    """
    _user, customer_name, managed = _portal_access()
    booking = frappe.db.get_value(
        "Booking", {"booking_number": booking_number},
        ["name", "customer", "package_offer", "trip_package", "trip_date",
         "status", "affiliate", "booking_channel", "end_customer"], as_dict=True
    )
    if not booking or not _booking_action_allowed(booking, customer_name, managed, "Docs"):
        frappe.throw("Booking not found.", frappe.PermissionError)
    if booking.status == "Cancelled":
        frappe.throw("This booking has been cancelled.")
    return booking


# ══════════════════════════════════════════════
# GET AVAILABLE ADDONS (katalog untuk portal)
# ══════════════════════════════════════════════

@frappe.whitelist()
def _booking_offer_context(booking: frappe._dict) -> tuple:
    """Terbitkan konteks offer booking: (package_offer, travel_date,
    trip_name, departure_date) — RECONDITION Nov 2026.

    Keterkaitan scoping addon kini Package Offer / Travel Date. Booking
    baharu (struktur baharu) membawa package_offer terus; booking warisan
    (trip_package/trip_date → doctype lama yang dibekukan) dipetakan ke
    rekod baharu melalui anchor provenance:
      Booking.trip_date    → Travel Date.legacy_tgd
      Booking.trip_package → Package Offer.legacy_trip_package
    trip_name diperlukan untuk padanan scoping peringkat TRIP (addon yang
    di-scope "trip sahaja"); departure_date untuk cutoff jualan.
    """
    package_offer = booking.get("package_offer") or None
    travel_date = None
    trip_name = None
    departure_date = None

    if package_offer:
        offer = frappe.db.get_value(
            "Package Offer", package_offer,
            ["travel_date", "trip", "departure_date"], as_dict=True
        )
        if offer:
            travel_date = offer.travel_date or None
            trip_name = offer.trip or None
            departure_date = offer.departure_date or None

    # Konteks warisan — petakan ke rekod baharu melalui provenance.
    legacy_td = None
    if booking.get("trip_date") and not travel_date:
        legacy_td = frappe.db.get_value(
            "Travel Date", {"legacy_tgd": booking.trip_date}, "name"
        )
        if legacy_td and not package_offer:
            travel_date = legacy_td

    legacy_offer = None
    if booking.get("trip_package") and not package_offer:
        legacy_offer = frappe.db.get_value(
            "Package Offer", {"legacy_trip_package": booking.trip_package}, "name"
        )
        if legacy_offer:
            package_offer = legacy_offer
            if not travel_date:
                travel_date = frappe.db.get_value(
                    "Package Offer", legacy_offer, "travel_date")

    # trip_name / departure_date — daripada Travel Date baharu (utama),
    # fallback doctype warisan (masih wujud — dibekukan, tak dipadam).
    if travel_date:
        td = frappe.db.get_value(
            "Travel Date", travel_date, ["trip", "departure_date"], as_dict=True
        )
        if td:
            trip_name = td.trip or trip_name
            departure_date = td.departure_date or departure_date
    if not trip_name and booking.get("trip_date"):
        tgd = frappe.db.get_value(
            "Trip Group Date", booking.trip_date, ["trip", "departure_date"], as_dict=True
        )
        if tgd:
            trip_name = tgd.trip
            departure_date = departure_date or tgd.departure_date
    if not trip_name and booking.get("trip_package"):
        trip_name = frappe.db.get_value("Trip Package", booking.trip_package, "trip_link")
    return package_offer, travel_date, trip_name, departure_date


def _scoping_is_applicable(
    applicable_to: str | None,
    scopings: list,
    package_offer_name: str | None,
    travel_date_name: str | None,
    trip_name: str | None,
) -> bool:
    """Logik padanan scoping addon package — konsisten dengan
    Trip Addon Package.is_applicable_for_context (rujuk situ untuk
    semantik row scoping). Dipisah di sini supaya get_available_addons boleh
    guna scoping yang di-bulk-load (elak N+1 get_doc per package).
    """
    if applicable_to == "All Trips" or not applicable_to:
        return True

    for s in scopings:
        # Row trip+offer (travel date KOSONG): addon sah untuk Package
        # Offer tertentu PADA TRIP tersebut sahaja — merangkumi SEMUA
        # tarikh yang offer itu sah. Bila row nyatakan trip, booking
        # juga mesti dari trip sama (guard data tak konsisten).
        if s.package_offer and package_offer_name and s.package_offer == package_offer_name:
            if not s.trip or not trip_name or s.trip == trip_name:
                return True
        if s.travel_date and travel_date_name and s.travel_date == travel_date_name:
            return True
        if (
            s.trip
            and not s.travel_date
            and not s.package_offer
            and trip_name
            and s.trip == trip_name
        ):
            return True

    if not package_offer_name and not travel_date_name and not trip_name:
        return any(s.trip for s in scopings)
    return False


@frappe.whitelist()
def get_available_addons(booking_number: str, currency: str = None):
    """Senarai Trip Addon (produk) dengan Trip Addon Package sebagai variant.
    Setiap addon boleh ada beberapa package (plan type, pricing, scoping berbeza).
    Hanya package yang applicable untuk booking ni yang di-return.

    currency (opsyenal) — model multi-currency: hanya rate dalam currency
    ini dipaparkan; package tanpa rate currency ini DISEMBUNYIKAN. Default:
    currency booking utama (SO utama). Customer bebas tukar selector
    currency di portal — pilihan itu menentukan company yang mengeluarkan
    SO addon (paksi currency multi-company).

    Checkout_addons() re-price semula dari DB — jangan percaya harga dari
    client.

    Whitelisted untuk page desk Booking Portal (/app/booking-manager —
    staf beli addon bagi pihak customer); gate akses DI DALAM fungsi
    melalui _get_owned_booking() (pemilik / manager on-behalf / staf
    MANAGED_ALL) — sama seperti endpoint addon yang lain.
    """
    booking = _get_owned_booking(booking_number)
    _b2b_user, b2b_customer_name, _b2b_managed = _portal_access()
    hide_prices = _price_hidden_for(booking, b2b_customer_name)

    # Default currency = currency booking utama (SO utama booking ni,
    # melalui registri Booking.sales_orders).
    from travel_booking.api.currency_axis import get_declared_currencies, get_default_currency
    if not currency:
        primary_so = _get_primary_so(booking.name)
        currency = (
            frappe.db.get_value("Sales Order", primary_so, "currency")
            if primary_so else None
        ) or get_default_currency()
    declared = get_declared_currencies()
    if currency and declared and currency not in declared:
        frappe.throw(
            "Currency '{0}' is not available. Available currencies: {1}.".format(
                currency, ", ".join(sorted(declared))
            ),
            title="Currency Not Available",
        )

    package_offer, travel_date, trip_name, departure_date = _booking_offer_context(booking)

    out = _build_addon_catalog(
        package_offer_name=package_offer,
        travel_date_name=travel_date,
        trip_name=trip_name,
        departure_date=departure_date,
        currency=currency,
    )

    # B2B end-customer: harga addon DITAPIS dari respons (katalog tetap
    # nampak — maklumat perjalanan) dan checkout disekat.
    if hide_prices:
        for addon in out:
            for pkg in addon["packages"]:
                pkg["unit_price"] = None
                pkg["currency"] = ""
                pkg["purchasable"] = False

    # Meta currency untuk selector portal (pilihan bebas — setiap currency
    # yang diisytiharkan dalam axis, walaupun tiada addon punya rate
    # untuknya; frontend hanya disable/hide pilihan tanpa hasil).
    from travel_booking.api.currency_axis import get_currency_options, _currency_symbol
    currency_options = [
        {"currency": o["currency"], "symbol": o["symbol"]}
        for o in get_currency_options()
    ]

    return {
        "addons": out,
        "currency": currency,
        "currency_symbol": _currency_symbol(currency),
        "currency_options": currency_options,
        # B2B end-customer: tiada pembelian sendiri — addon diuruskan oleh
        # staf partner (SO addon dibilkan kepada Customer partner).
        "can_checkout": not hide_prices,
        "price_hidden": hide_prices,
    }


def _build_addon_catalog(package_offer_name, travel_date_name, trip_name,
                         departure_date, currency):
    """Bina katalog addon (senarai Trip Addon + package variants) yang
    layak untuk SATU konteks offer — dikongsi oleh:

      - get_available_addons (portal — konteks daripada booking sedia ada)
      - get_wizard_addons    (wizard /booknow — konteks daripada pilihan
                              offer/tarikh customer, SEBELUM booking wujud)

    Tapisan: package Active + addon tak disabled + scoping match + ADA
    rate dalam currency diminta + status stok/cutoff. Harga dalam respons
    adalah untuk PAPARAN sahaja — checkout/confirm re-price semula dari
    DB (jangan percaya harga dari client).
    """
    rows = frappe.db.sql("""
        SELECT DISTINCT
            ap.name, ap.addon, ap.addon_title, ap.addon_package_name,
            ap.sales_cutoff_enabled, ap.sales_cutoff_days_before_departure,
            ap.max_qty_per_booking, ap.max_total_qty, ap.current_qty_sold,
            ap.applicable_to, ap.scope,
            a.addon_type, a.description, a.cover_image, a.youtube_video_url
        FROM `tabTrip Addon Package` ap
        JOIN `tabTrip Addon` a ON a.name = ap.addon
        WHERE ap.status = 'Active' AND a.disable = 0
        ORDER BY a.addon_type, a.addon_title, ap.addon_package_name
    """, as_dict=True)

    today = frappe.utils.getdate()

    # Bulk-load SEMUA row scoping sekali — elak get_doc penuh per package
    # (N+1; katalog addon boleh ada puluhan package, setiap paparan page
    # booking_addons memuatkan kesemuanya).
    scoping_map = {}
    for s in frappe.get_all(
        "Trip Scoping", {}, ["parent", "trip", "travel_date", "package_offer"]
    ):
        scoping_map.setdefault(s.parent, []).append(s)

    # Bulk-load SEMUA rate rows sekali (sama punca N+1) — resolve harga
    # ikut currency terpilih.
    rate_map = {}
    for rr in frappe.get_all(
        "Trip Addon Package Rate",
        {"parenttype": "Trip Addon Package", "enabled": 1},
        ["parent", "currency", "unit_price"],
    ):
        rate_map.setdefault(rr.parent, {})[rr.currency] = float(rr.unit_price or 0)

    # Build package dicts, grouped by parent Trip Addon
    addon_map = {}   # {addon_name: {addon-level fields, packages: [...]}}

    for r in rows:
        # Padanan scoping: package_offer / travel_date / trip.
        # Fallback konservatif: hanya "All Trips" dianggap applicable bila
        # data scoping gagal dibaca — JANGAN bolong scoping dengan
        # "sebarang row wujud → True" (fallback lama).
        is_applicable = _scoping_is_applicable(
            r.applicable_to,
            scoping_map.get(r.name, []),
            package_offer_name,
            travel_date_name,
            trip_name,
        )

        if not is_applicable:
            continue

        # Resolusi harga multi-currency: hanya rate row untuk currency terpilih.
        # Package tanpa harga dalam currency ini DISEMBUNYIKAN.
        rates = rate_map.get(r.name, {})
        if currency in rates:
            price = rates[currency]
        else:
            continue  # tiada rate currency ini — sembunyikan package

        sold_out = bool(r.max_total_qty and r.current_qty_sold >= r.max_total_qty)
        cutoff_closed = False
        if r.sales_cutoff_enabled and departure_date:
            days_left = frappe.utils.date_diff(departure_date, today)
            cutoff_closed = days_left < (r.sales_cutoff_days_before_departure or 0)

        remaining = None
        if r.max_total_qty:
            remaining = max(0, r.max_total_qty - (r.current_qty_sold or 0))

        pkg = {
            "addon_package":      r.name,
            "addon_package_name": r.addon_package_name or "",
            "scope":               r.scope,
            "applicable_to":       r.applicable_to,
            "currency":            currency,
            "unit_price":          price,
            "max_qty_per_booking": r.max_qty_per_booking or 0,
            "remaining":           remaining,
            "sold_out":            sold_out,
            "cutoff_closed":       cutoff_closed,
            "purchasable":         not sold_out and not cutoff_closed,
        }

        # Group by parent Trip Addon
        if r.addon not in addon_map:
            addon_map[r.addon] = {
                "addon":            r.addon,
                "addon_title":       r.addon_title,
                "addon_type":        r.addon_type or "Other",
                "description":       r.description or "",
                "cover_image":       r.cover_image or "",
                "youtube_video_url": r.youtube_video_url or "",
                "gallery_images":    [],
                "packages":          [],
            }
        addon_map[r.addon]["packages"].append(pkg)

    # Batch-fetch gallery images from tabFile (addon_gallery is a virtual field;
    # images live in tabFile with attached_to_field='addon_gallery', is_private=0)
    addon_names = list(addon_map.keys())
    if addon_names:
        gallery_rows = frappe.db.sql("""
            SELECT attached_to_name, file_url
            FROM tabFile
            WHERE attached_to_doctype = 'Trip Addon'
              AND attached_to_field = 'addon_gallery'
              AND is_private = 0
              AND attached_to_name IN %s
            ORDER BY creation ASC
        """, (tuple(addon_names),), as_dict=True)
        for gr in gallery_rows:
            if gr.attached_to_name in addon_map:
                addon_map[gr.attached_to_name]["gallery_images"].append(gr.file_url)

    # Convert to list, sorted by addon_type then title
    return sorted(addon_map.values(), key=lambda x: (x["addon_type"], x["addon_title"]))


# ══════════════════════════════════════════════
# WIZARD CATALOG (Step 2 /booknow — sebelum booking wujud)
# ══════════════════════════════════════════════

def _resolve_wizard_offer_context(trip_group_date, travel_package, package_offer):
    """Normalisasi konteks wizard kepada tuple (package_offer, travel_date,
    trip_name, departure_date) — RECONDITION Nov 2026: scoping addon kini
    hidup dalam ruang Package Offer / Travel Date.

    Laluan:
      - package_offer dihantar (flag use_package_offers ON) → konteks offer
        terus: offer.travel_date + offer.trip + offer.departure_date;
      - selain itu → parameter legacy terus (?trip_group_date= & pakej
        katalog lama) dipetakan ke rekod baharu melalui provenance
        (Travel Date.legacy_tgd / Package Offer.legacy_trip_package) —
        nama warisan kekal sebagai fallback trip_name.
    """
    package_offer_name = None
    travel_date_name = None
    trip_name = None
    departure_date = None

    if package_offer:
        from travel_booking.utils.flags import use_package_offers
        if use_package_offers():
            offer = frappe.db.get_value(
                "Package Offer", package_offer,
                ["travel_date", "trip", "departure_date"], as_dict=True,
            )
            if offer:
                package_offer_name = package_offer
                travel_date_name = offer.travel_date or None
                trip_name = offer.trip or None
                departure_date = offer.departure_date or None
                return package_offer_name, travel_date_name, trip_name, departure_date

    # Laluan legacy — petakan nama warisan ke rekod baharu (jika wujud).
    if trip_group_date:
        travel_date_name = frappe.db.get_value(
            "Travel Date", {"legacy_tgd": trip_group_date}, "name")
    if travel_package and not package_offer_name:
        package_offer_name = frappe.db.get_value(
            "Package Offer",
            {"legacy_trip_package": travel_package, "trip": ["!=", ""]},
            "name",
        )
        if package_offer_name and not travel_date_name:
            travel_date_name = frappe.db.get_value(
                "Package Offer", package_offer_name, "travel_date")

    if travel_date_name:
        td = frappe.db.get_value(
            "Travel Date", travel_date_name, ["trip", "departure_date"], as_dict=True,
        )
        if td:
            trip_name = td.trip
            departure_date = td.departure_date
    if not trip_name and trip_group_date:
        tgd = frappe.db.get_value(
            "Trip Group Date", trip_group_date,
            ["trip", "departure_date"], as_dict=True,
        )
        if tgd:
            trip_name = tgd.trip
            departure_date = departure_date or tgd.departure_date
    if not trip_name and travel_package:
        trip_name = frappe.db.get_value("Trip Package", travel_package, "trip_link")
    return package_offer_name, travel_date_name, trip_name, departure_date


@frappe.whitelist(allow_guest=True)
def get_wizard_addons(trip_group_date: str = None, travel_package: str = None,
                      package_offer: str = None, currency: str = None):
    """Katalog addon untuk Step 2 (Add-ons) wizard /booknow — dipanggil
    SEBELUM booking wujud, jadi terima konteks trip/pakej yang customer
    pilih di Step 1 (bukan booking_number macam get_available_addons).

    allow_guest: wizard 100% guest-capable (sama macam confirm_booking).
    Respons HANYA data katalog awam (tajuk/gambar/harga paparan) — semua
    semakan transaksi (harga sebenar, stok, cutoff, had qty) dijalankan
    SEMULA server-side semasa confirm_booking().
    """
    package_offer_name, travel_date_name, trip_name, departure_date = (
        _resolve_wizard_offer_context(trip_group_date, travel_package, package_offer)
    )

    from travel_booking.api.currency_axis import get_default_currency
    if not currency:
        currency = get_default_currency()
    from travel_booking.api.currency_axis import get_declared_currencies
    declared = get_declared_currencies()
    if declared and currency not in declared:
        frappe.throw(
            "Currency '{0}' is not available. Available currencies: {1}.".format(
                currency, ", ".join(sorted(declared))
            ),
            title="Currency Not Available",
        )

    addons = _build_addon_catalog(
        package_offer_name=package_offer_name,
        travel_date_name=travel_date_name,
        trip_name=trip_name,
        departure_date=departure_date,
        currency=currency,
    )

    from travel_booking.api.currency_axis import _currency_symbol
    return {
        "addons": addons,
        "currency": currency,
        "currency_symbol": _currency_symbol(currency),
    }


# ══════════════════════════════════════════════
# CHECKOUT (cart -> 1 Sales Order addon)
# ══════════════════════════════════════════════

@frappe.whitelist()
def checkout_addons(booking_number: str, lines: str, payment_method: str = "Online Payment",
                    receipt: str = None, bank_transfer_ref: str = None, currency: str = None):
    """lines = JSON list [{"addon_package": "AP-xxx", "qty": 2,
    "travellers": ["BR-xxx", ...]}, ...].

    currency (opsyenal) — currency rate yang dipilih customer semasa
    checkout (model multi-currency: bebas pilih, tak semestinya sama
    dengan currency booking utama). SO addon akan dikeluarkan oleh
    company yang sepadan dengan currency ini (paksi currency). Default:
    currency booking utama. Re-validated sepenuhnya server-side —
    setiap package mesti ADA rate (atau fallback legacy) dalam currency
    ini, kalau tidak throw.

    Server-side re-price SEMUA baris dari DB (jangan sesekali percaya rate
    dari client). Travellers array wajib untuk Per Pax scope — server
    re-derive qty dari len(travellers) untuk Per Pax.

    Per Pax: setiap traveller = 1 SO line (qty=1) + 1 Booking Addon Item row
    dengan booking_reservation diset.
    Per Booking: 1 SO line (qty=N) + 1 Booking Addon Item row tanpa reservation.

    Selepas cipta SO + Booking Addon, redirect ke billing page.
    """
    booking = _get_owned_booking(booking_number)

    # B2B: end-customer TIDAK boleh menempah addon berbayar — tempahan
    # addon adalah transaksi kewangan yang dibilkan kepada Customer
    # partner. Staf partner (managed set) kekal dibenarkan.
    _ck_user, ck_customer_name, _ck_managed = _portal_access()
    if _price_hidden_for(booking, ck_customer_name):
        frappe.throw(
            "Add-ons for this booking are managed by your travel agent. "
            "Please contact your agent to add extras.",
            frappe.PermissionError,
        )

    if isinstance(lines, str):
        lines = json.loads(lines)
    if not lines:
        frappe.throw("Please select at least one item.")

    # Currency checkout: default = currency booking utama (SO utama melalui
    # registri Booking.sales_orders); mesti diisytiharkan dalam axis (throw
    # jika tidak — jangan fallback senyap ke currency lain, harga cart akan
    # berubah tanpa customer sedar).
    from travel_booking.api.currency_axis import get_declared_currencies, get_default_currency
    if not currency:
        primary_so = _get_primary_so(booking.name)
        currency = (
            frappe.db.get_value("Sales Order", primary_so, "currency")
            if primary_so else None
        ) or get_default_currency()
    declared = get_declared_currencies()
    if declared and currency not in declared:
        frappe.throw(
            "Currency '{0}' is not available. Available currencies: {1}.".format(
                currency, ", ".join(sorted(declared))
            ),
            title="Currency Not Available",
        )

    validated_lines = _validate_addon_lines(booking, lines, currency)
    return _create_addon_order(booking, validated_lines,
                               payment_method=payment_method,
                               receipt=receipt,
                               bank_transfer_ref=bank_transfer_ref)


def _validate_addon_lines(booking, lines, currency, eligible_pax=None):
    """Semak + re-price SEMUA baris cart addon daripada DB (jangan sesekali
    percaya rate/qty dari client). Dipakai bersama oleh:

      - checkout_addons (portal — baris penuh dengan `travellers`)
      - confirm_booking (wizard /booknow — baris qty sahaja, lihat
        `eligible_pax` di bawah)

    `booking` ialah rekod/dict Booking (perlukan name, customer,
    trip_package, trip_date) — scoping + had qty per booking disemak
    terhadap booking INI.

    eligible_pax (opsyenal, laluan wizard): bilangan pax LAYAK (bukan
    infant) dalam booking. Bila diberikan, baris Per Pax BOLEH datang
    tanpa `travellers` — nama traveller belum wujud masa wizard (Booking
    Reservation hanya dicipta selepas bayaran pertama, rujuk
    _activate_booking). qty diambil terus daripada baris (disahkan ≤
    eligible_pax) dan baris item akan di-auto-assign kemudian oleh
    _assign_unassigned_addon_items().
    """
    if isinstance(lines, str):
        lines = json.loads(lines)
    if not lines:
        frappe.throw("Please select at least one item.")

    validated_lines = []
    package_offer, travel_date, trip_name, departure_date = _booking_offer_context(booking)
    today = frappe.utils.getdate()

    for line in lines:
        ap_name = line.get("addon_package")
        travellers = line.get("travellers") or []
        if not ap_name:
            continue

        ap = frappe.db.get_value(
            "Trip Addon Package", ap_name,
            ["name", "addon", "addon_title", "addon_package_name", "scope",
             "applicable_to", "status",
             "sales_cutoff_enabled", "sales_cutoff_days_before_departure",
             "max_qty_per_booking", "max_total_qty", "current_qty_sold"],
            as_dict=True
        )
        if not ap or ap.status != "Active":
            frappe.throw("One of the selected items is no longer available.")

        # Resolusi harga multi-currency (server-side, sumber kebenaran):
        # hanya rate row untuk currency checkout. Tiada rate = item tak
        # dijual dalam currency ni — throw.
        rate_row = frappe.db.get_value(
            "Trip Addon Package Rate",
            {"parent": ap.name, "parenttype": "Trip Addon Package",
             "currency": currency, "enabled": 1},
            "unit_price",
        )
        if rate_row is not None:
            unit_price = float(rate_row or 0)
        else:
            frappe.throw(
                ap.addon_title + " is not available in " + currency +
                ". Please choose another currency or remove it from your cart.",
                title="Addon Currency Unavailable"
            )

        scope = ap.scope or "Per Booking"
        # Per Pax: qty daripada traveller count (jangan percaya client).
        # Laluan WIZARD (eligible_pax diberikan, tiada travellers): qty
        # eksplisit — nama traveller belum wujud, baris diwujudkan sebagai
        # "unassigned" dan di-assign selepas reservation dicipta.
        if scope == "Per Pax":
            if travellers:
                qty = len(travellers)
            elif eligible_pax is not None:
                qty = int(line.get("qty", 0) or 0)
                if qty <= 0:
                    continue
                if qty > eligible_pax:
                    frappe.throw(
                        ap.addon_title + " is limited to " + str(eligible_pax) +
                        " guest(s) on this booking."
                    )
            else:
                frappe.throw("Please select at least one traveller for " + ap.addon_title + ".")
        else:
            qty = int(line.get("qty", 0))
            if qty <= 0:
                continue

        # Scoping check (logik sama dengan get_available_addons — trip-level
        # match kini disokong; fallback konservatif hanya "All Trips").
        scopings = frappe.get_all(
            "Trip Scoping", {"parent": ap.name}, ["trip", "travel_date", "package_offer"]
        )
        is_applicable = _scoping_is_applicable(
            ap.applicable_to, scopings,
            package_offer, travel_date, trip_name,
        )
        if not is_applicable:
            frappe.throw("One of the selected items is not valid for this booking.")

        if ap.sales_cutoff_enabled and departure_date:
            days_left = frappe.utils.date_diff(departure_date, today)
            if days_left < (ap.sales_cutoff_days_before_departure or 0):
                frappe.throw(ap.addon_title + " is no longer available for purchase (sales closed).")

        if ap.max_qty_per_booking:
            existing = frappe.db.sql("""
                SELECT COALESCE(SUM(qty), 0)
                FROM `tabBooking Addon Item`
                WHERE addon_package = %s AND booking = %s AND status != 'Cancelled'
            """, (ap.name, booking.name))[0][0]
            if (existing + qty) > ap.max_qty_per_booking:
                frappe.throw(
                    "You can only purchase up to " + str(ap.max_qty_per_booking) +
                    " of " + ap.addon_title + " per booking."
                )

        if ap.max_total_qty and (ap.current_qty_sold or 0) + qty > ap.max_total_qty:
            frappe.throw(ap.addon_title + " has reached its maximum quantity available.")

        validated_lines.append({
            "addon_package":      ap.name,
            "addon":              ap.addon,
            "addon_title":        ap.addon_title,
            "addon_package_name": ap.addon_package_name or "",
            "scope":              scope,
            "currency":           currency,
            "unit_price":         unit_price,
            "qty":                qty,
            "travellers":         travellers,
        })

    if not validated_lines:
        frappe.throw("Please select at least one item.")

    return validated_lines


def _create_addon_order(booking, validated_lines, payment_method="Online Payment",
                        receipt=None, bank_transfer_ref=None):
    """Cipta SATU order addon untuk booking: Booking Addon (header) +
    Sales Order addon (item "Trip Addon Package") + Booking Addon Item
    (baris) + Payment Entry DRAFT untuk Manual Transfer.

    Dipakai bersama oleh checkout_addons (portal) dan confirm_booking
    (wizard /booknow — dipanggil SELEPAS booking utama + SO utama +
    pembayaran utama siap; kegagalan di-skip oleh caller supaya booking
    utama tidak tergugur).

    Baris Per Pax dengan `travellers`: 1 SO line (qty=1) + 1 item row
    ber-reservation SETIAP traveller (portal).
    Baris Per Pax TANPA travellers (wizard): 1 SO line qty=N + N item
    row qty=1 "unassigned" — auto-assign oleh
    _assign_unassigned_addon_items() bila reservation wujud.
    Baris Per Booking: 1 SO line (qty=N) + 1 item row tanpa reservation.
    """
    # Konteks offer (RECONDITION Nov 2026) untuk stamp header Booking
    # Addon: package_offer/travel_date daripada konteks booking. Laluan
    # wizard (confirm_booking) menghantar dict diperkaya offer semasa;
    # laluan portal (checkout_addons) menghantar Document Booking yang
    # medan package_offer dah di-stamp pada booking.
    package_offer, travel_date, _ctx_trip, _ctx_dep = _booking_offer_context(booking)

    # Cart guard: SEMUA baris mesti currency yang sama — dikunci semula
    # kepada currency checkout yang di-derive di atas (bukan dari set
    # currency package, yang kini boleh berbeza-beza ikut rate). Guard
    # ini kekal sebagai pertahanan kedua terhadap cart bercampur.
    currencies = {l["currency"] for l in validated_lines}
    if len(currencies) > 1:
        frappe.throw("Selected items have mismatched currencies. Please contact support.")
    so_currency = currencies.pop()

    grand_total = sum(l["unit_price"] * l["qty"] for l in validated_lines)
    # Paksi multi-company: currency checkout menentukan company + price
    # list SO addon. conversion_rate=1.0 (SO dalam company currency
    # company berkenaan — harga rate native, tiada conversion).
    so_currency, so_company, so_price_list, conversion_rate = \
        _resolve_so_currency_and_rate(so_currency)

    # Batch-resolve traveller display names from Booking Reservation
    all_traveller_names = set()
    for l in validated_lines:
        all_traveller_names.update(l["travellers"])
    traveller_map = {}
    if all_traveller_names:
        rows = frappe.db.sql("""
            SELECT name, traveller_full_name, guest_label
            FROM `tabBooking Reservation`
            WHERE name IN %s
        """, (tuple(all_traveller_names),), as_dict=True)
        for r in rows:
            traveller_map[r.name] = r.traveller_full_name or r.guest_label or "Guest"

    # Ensure the ERPNext Item exists
    item_code = _get_or_create_travel_item(
        item_code=ADDON_PACKAGE_ITEM_CODE,
        item_name="Trip Addon Package",
    )

    # Attribute the addon sale to the booking's affiliate Sales Partner
    # when the affiliate app's Affiliate Settings.commission_on_addons is
    # enabled. The SO's sales_partner then triggers the affiliate app's
    # Sales Order.on_update hook (create_commission_if_eligible) so the
    # affiliate earns commission on addon sales too - not just the
    # primary package SO. When disabled, addons stay unattributed.
    addon_sales_partner = None
    if booking.affiliate:
        try:
            if frappe.db.get_single_value(
                "Affiliate Settings", "commission_on_addons"
            ):
                addon_sales_partner = booking.affiliate
        except Exception:
            # Affiliate app not installed / Settings missing - skip
            # attribution silently rather than block the addon checkout.
            pass

    _original_user = frappe.local.session.user
    frappe.local.session.user = "Administrator"
    try:
        # Build SO items (scope-aware)
        so_items = []
        for l in validated_lines:
            price_str = l["currency"] + " " + str(l["unit_price"])
            pkg_label = (l["addon_package_name"] + " (" + price_str + ")") if l["addon_package_name"] else price_str

            if l["scope"] == "Per Pax":
                if l["travellers"]:
                    for tr_name in l["travellers"]:
                        tname = traveller_map.get(tr_name, "Unknown")
                        so_items.append({
                            "item_code":   item_code,
                            "item_name":   "Trip Addon Package",
                            "qty":         1,
                            "rate":        l["unit_price"],
                            "uom":         "Nos",
                            "description": l["addon_title"] + " | " + pkg_label + " | Traveller: " + tname,
                        })
                else:
                    # WIZARD — nama traveller belum wujud (reservation
                    # dicipta selepas bayaran pertama). Satu baris qty=N;
                    # baris item "unassigned" di-auto-assign kemudian.
                    so_items.append({
                        "item_code":   item_code,
                        "item_name":   "Trip Addon Package",
                        "qty":         l["qty"],
                        "rate":        l["unit_price"],
                        "uom":         "Nos",
                        "description": l["addon_title"] + " | " + pkg_label +
                                       " | Travellers: to be assigned (" +
                                       str(l["qty"]) + " guest(s))",
                    })
            else:
                traveller_list = ""
                if l["travellers"]:
                    named = [traveller_map.get(t, "Unknown") for t in l["travellers"]]
                    traveller_list = " | Travellers: " + ", ".join(named)
                so_items.append({
                    "item_code":   item_code,
                    "item_name":   "Trip Addon Package",
                    "qty":         l["qty"],
                    "rate":        l["unit_price"],
                    "uom":         "Nos",
                    "description": l["addon_title"] + " | " + pkg_label + traveller_list,
                })

        # Create Booking Addon (header) BEFORE the Sales Order so the SO
        # can carry custom_booking_addon as a reverse link. sales_order is
        # set after SO submit via db_set. package_offer/travel_date (repo
        # RECONDITION Nov 2026) = keterkaitan konteks booking — dipetakan
        # ke rekod baharu walaupun booking warisan (rujuk
        # _booking_offer_context); view group addon (manage-booking-app)
        # menghubung order ke tarikh melalui medan ini.
        order = frappe.get_doc({
            "doctype":      "Booking Addon",
            "booking":      booking.name,
            "status":       "Pending",
            "currency":     so_currency,
            "total_amount": grand_total,
            "package_offer": package_offer or "",
            "travel_date":   travel_date or "",
        })
        order.insert(ignore_permissions=True)

        so = frappe.get_doc({
            "doctype":               "Sales Order",
            "customer":              booking.customer,
            "custom_booking_addon":  order.name,
            # Company pengeluar SO addon ditentukan oleh currency rate yang
            # dipilih customer (paksi currency multi-company).
            "company":               so_company,
            "transaction_date":      frappe.utils.today(),
            "delivery_date":         frappe.utils.today(),
            "order_type":            "Sales",
            "items":                 so_items,
            "selling_price_list":    so_price_list,
            "currency":              so_currency,
            "conversion_rate":       conversion_rate,
            "disable_rounded_total": 1,
            "sales_partner":         addon_sales_partner,
        })
        so.insert(ignore_permissions=True)
        so.flags.ignore_permissions = True
        so.submit()

        # Daftar SO addon pada registri Booking.sales_orders ([Nov 2026]
        # menggantikan set Sales Order.custom_booking — Booking yang
        # memiliki senarai SO-nya; idempotent).
        _link_booking_sales_order(booking.name, so.name, "Addon")

        # Reverse link: set sales_order on the header after SO is submitted.
        order.db_set("sales_order", so.name)

        # Create Booking Addon Item rows (scope-aware)
        for l in validated_lines:
            if l["scope"] == "Per Pax":
                if l["travellers"]:
                    for tr_name in l["travellers"]:
                        frappe.get_doc({
                            "doctype":             "Booking Addon Item",
                            "addon_order":         order.name,
                            "addon_package":       l["addon_package"],
                            "booking_reservation": tr_name,
                            "qty":                 1,
                            "currency":            l["currency"],
                            "unit_price":          l["unit_price"],
                            "amount":              l["unit_price"],
                            "status":              "Pending",
                        }).insert(ignore_permissions=True)
                else:
                    # WIZARD — N baris qty=1 TANPA reservation ("unassigned");
                    # _assign_unassigned_addon_items() isi booking_reservation
                    # bila reservation dicipta selepas bayaran pertama.
                    for _i in range(int(l["qty"])):
                        frappe.get_doc({
                            "doctype":       "Booking Addon Item",
                            "addon_order":   order.name,
                            "addon_package": l["addon_package"],
                            "qty":           1,
                            "currency":      l["currency"],
                            "unit_price":    l["unit_price"],
                            "amount":        l["unit_price"],
                            "status":        "Pending",
                        }).insert(ignore_permissions=True)
            else:
                frappe.get_doc({
                    "doctype":       "Booking Addon Item",
                    "addon_order":   order.name,
                    "addon_package": l["addon_package"],
                    "qty":           l["qty"],
                    "currency":      l["currency"],
                    "unit_price":    l["unit_price"],
                    "amount":        l["unit_price"] * l["qty"],
                    "status":        "Pending",
                }).insert(ignore_permissions=True)

        # Increment current_qty_sold on each Trip Addon Package
        for l in validated_lines:
            new_sold = frappe.db.get_value("Trip Addon Package", l["addon_package"], "current_qty_sold") or 0
            frappe.db.set_value("Trip Addon Package", l["addon_package"], "current_qty_sold", new_sold)

        # MANUAL TRANSFER — cipta Payment Entry DRAFT + attach resit
        # (corak sama dengan booking wizard & portal billing). Dahulu
        # parameter receipt/bank_transfer_ref diterima tapi dibuang terus:
        # customer upload bukti transfer, tiada PE dicipta, admin tiada
        # rekod untuk verify dan order tergantung Pending. PE draft kini
        # membawa resit (PDF auto-render ke PNG oleh helper normalization)
        # + no. rujukan bank; submit oleh admin menyalakan hook
        # on_payment_entry_submit → refresh_payment_status → Booking
        # Addon Pending → Confirmed.
        pe_name = None
        if payment_method == "Manual Transfer":
            try:
                pe_name = _create_manual_payment_entry(
                    so_name           = so.name,
                    customer_name     = booking.customer,
                    amount            = grand_total,
                    receipt_data      = receipt or "",
                    label             = "receipt-" + order.name,
                    bank_transfer_ref = bank_transfer_ref,
                )
            except Exception:
                # Order + SO sudah dicipta & disubmit — JANGAN throw
                # (customer akan retry dan cipta order pendua). Log error
                # + fallback: attach resit TERUS pada Booking Addon
                # supaya bukti tetap sampai kepada admin untuk cipta PE
                # manual di Desk.
                frappe.log_error(
                    title="Addon Manual PE Error",
                    message="Addon manual payment entry failed for SO " +
                            so.name + " (booking " + booking.name +
                            ", addon order " + order.name + ").",
                )
                if receipt:
                    try:
                        file_content, file_name = _decode_and_normalize_upload(
                            receipt, "receipt-" + order.name + ".png", label="receipt")
                        frappe.get_doc({
                            "doctype":             "File",
                            "file_name":           file_name,
                            "attached_to_doctype": "Booking Addon",
                            "attached_to_name":    order.name,
                            "is_private":          1,
                            "content":             file_content
                        }).insert(ignore_permissions=True)
                    except Exception:
                        frappe.log_error(
                            title="Addon Receipt Fallback Failed",
                            message="Could not attach addon receipt to " +
                                    "Booking Addon " + order.name + ".",
                        )

        frappe.db.commit()
    finally:
        frappe.local.session.user = _original_user

    return {
        "success":      True,
        "addon_order":   order.name,
        "sales_order":   so.name,
        "payment_entry": pe_name,
        "grand_total":   grand_total,
        "currency":      so_currency,
        # Portal hantar booking_number; wizard (confirm_booking) hantar
        # Document Booking — kedua-dua ada booking_number.
        "billing_url":   "/traveller/billing?ref=" + (
            getattr(booking, "booking_number", None) or booking.name),
    }


# ══════════════════════════════════════════════
# AUTO-ASSIGN (baris wizard "unassigned" → reservation)
# ══════════════════════════════════════════════

# Keutamaan padanan: pax PEMBAYAR dulu (harga penuh), pax tambahan
# kemudian. Infant dilangkau sepenuhnya — selari semakan eligible_pax
# wizard (qty addon per-pax dibatasi kepada pax bukan-infant).
_PAX_PRIORITY = (
    "Main Guest (Single)", "Main Guest", "Adult", "Extra Bed", "Children",
)


def _assign_unassigned_addon_items(booking_name):
    """Auto-assign Booking Reservation kepada baris addon Per Pax yang
    "unassigned" (booking_reservation kosong — dicipta oleh wizard
    /booknow sebelum reservation wujud). Dipanggil oleh
    _activate_booking() sebaik slot reservation dicipta (bayaran pertama
    masuk melalui hook Payment Entry submit).

    Padanan 1:1 FIFO, ikut keutamaan pax pembayar (rujuk _PAX_PRIORITY),
    kemudian susunan creation. Baris lebihan (cth ditambah admin secara
    manual selepas itu) kekal unassigned untuk admin isi di Desk.

    Idempoten: baris yang dah ada reservation / sudah Cancelled tak
    tersentuh. Return bilangan baris yang di-assign.
    """
    items = frappe.get_all(
        "Booking Addon Item",
        filters={
            "booking": booking_name,
            "booking_reservation": ("is", "not set"),
            "status": ("!=", "Cancelled"),
        },
        fields=["name", "addon_package"],
        order_by="creation asc",
    )
    if not items:
        return 0

    # Hanya baris Per Pax — baris Per Booking memang kekal tanpa
    # reservation (enforce_scope kosongkannya semula kalau diisi).
    pkg_scopes = {
        p["name"]: p["scope"]
        for p in frappe.get_all(
            "Trip Addon Package",
            filters={"name": ("in", list({i["addon_package"] for i in items}))},
            fields=["name", "scope"],
        )
    }
    items = [
        i for i in items
        if (pkg_scopes.get(i["addon_package"]) or "Per Booking") == "Per Pax"
    ]
    if not items:
        return 0

    reservations = frappe.get_all(
        "Booking Reservation",
        filters={"booking": booking_name, "status": ("!=", "Cancelled")},
        fields=["name", "pax_type"],
        order_by="creation asc",
    )
    # Infant dilangkau (corak eligible_pax wizard); pax jenis lain ikut
    # keutamaan _PAX_PRIORITY, yang tak dikenali diletak paling hujung.
    def _prio(r):
        pt = r["pax_type"] or ""
        return _PAX_PRIORITY.index(pt) if pt in _PAX_PRIORITY else 98
    reservations = [r for r in reservations if (r["pax_type"] or "") != "Infant"]
    reservations.sort(key=_prio)

    assigned = 0
    for item, res in zip(items, reservations):
        # get_doc + save (bukan db.set_value) supaya validate + fetch
        # traveller_name + refresh_related (kaunter stok) semua jalan.
        doc = frappe.get_doc("Booking Addon Item", item["name"])
        doc.booking_reservation = res["name"]
        doc.save(ignore_permissions=True)
        assigned += 1
    return assigned


def _cancel_addon_orders_for_booking(booking_name):
    """Cancel SEMUA Booking Addon order + baris item booking ni yang
    BELUM dibayar (payment_status Pending). Dipanggil daripada
    _cancel_booking_cascade() — meliputi semua laluan pembatalan booking
    (admin Desk, Abandoned, dan re-confirm wizard /booknow bila customer
    kembali dari Stripe dan confirm semula — booking lama di-cancel
    sebelum booking baharu dicipta).

    SO addon itu sendiri sudah di-cancel oleh cascade (ia mengumpul
    SEMUA SO berkaitan booking melalui registri Booking.sales_orders).
    Helper ni cuma menutup order header + baris supaya:
      - kaunter current_qty_sold dikira semula (refresh_related baca
        baris status != Cancelled), dan
      - had max_qty_per_booking booking baharu tak tersekat oleh baris
        order lama yang hangus.

    Order yang sudah ada bayaran (Partially Paid / Paid) TIDAK
    di-cancel — refund manual (corak sama dengan SO berbayar); log sahaja
    supaya admin nampak.
    """
    orders = frappe.get_all(
        "Booking Addon",
        filters={"booking": booking_name, "status": ("!=", "Cancelled")},
        fields=["name", "payment_status"],
    )
    for o in orders:
        if (o["payment_status"] or "Pending") != "Pending":
            frappe.log_error(
                title="Addon Order Cancel Skipped - Refund Needed",
                message=("Booking " + booking_name + " cancelled but addon order " +
                         o["name"] + " has payment_status '" +
                         str(o["payment_status"]) +
                         "'. Refund & cancel requires manual action."),
            )
            continue
        # Baris item dahulu (save → refresh_related kira semula kaunter),
        # kemudian header order.
        for it in frappe.get_all(
            "Booking Addon Item",
            filters={"addon_order": o["name"], "status": ("!=", "Cancelled")},
            pluck="name",
        ):
            try:
                item_doc = frappe.get_doc("Booking Addon Item", it)
                item_doc.status = "Cancelled"
                item_doc.save(ignore_permissions=True)
            except Exception as e:
                frappe.log_error(
                    title="Addon Item Cancel Failed",
                    message=("Could not cancel Booking Addon Item " + it +
                             " (order " + o["name"] + "): " + str(e)),
                )
        try:
            order_doc = frappe.get_doc("Booking Addon", o["name"])
            order_doc.status = "Cancelled"
            order_doc.save(ignore_permissions=True)
        except Exception as e:
            frappe.log_error(
                title="Addon Order Cancel Failed",
                message=("Could not cancel Booking Addon " + o["name"] +
                         " (booking " + booking_name + "): " + str(e)),
            )


# ══════════════════════════════════════════════
# GET BOOKING ADDONS (sejarah pembelian — portal)
# ══════════════════════════════════════════════

@frappe.whitelist()
def get_booking_addons(booking_number: str):
    """Senarai Booking Addon + baris untuk booking ni — untuk
    paparan "apa yang saya dah beli" di portal (Manage Add-on page).

    Setiap baris (Booking Addon Item) membawa medan pengepal
    ternormalisasi (order_status, order_payment_status, dll) supaya
    boleh di-group by addon_package / traveller tanpa kehilangan info
    order asal.
    """
    booking = _get_owned_booking(booking_number)

    orders = frappe.get_all(
        "Booking Addon",
        filters={"booking": booking.name},
        fields=["name", "status", "payment_status", "currency", "total_amount",
                "sales_order", "order_date"],
        order_by="order_date desc",
    )

    # Batch-fetch addon_package_name for all lines across all orders
    all_pkg_names = set()
    for o in orders:
        o["lines"] = frappe.get_all(
            "Booking Addon Item",
            filters={"addon_order": o.name},
            fields=["name", "addon_title", "addon_package", "addon",
                    "booking_reservation", "traveller_name", "scope",
                    "qty", "unit_price", "amount", "currency",
                    "status", "valid_from", "valid_to"],
            order_by="creation asc",
        )
        for l in o["lines"]:
            if l.get("addon_package"):
                all_pkg_names.add(l["addon_package"])

    pkg_name_map = {}
    if all_pkg_names:
        for name, pkg_name in frappe.db.sql(
            "SELECT name, addon_package_name FROM `tabTrip Addon Package` WHERE name IN %s",
            (tuple(all_pkg_names),), as_list=True
        ):
            pkg_name_map[name] = pkg_name

    # Denormalize header fields onto each line for grouping views
    for o in orders:
        for l in o["lines"]:
            l["order_name"] = o["name"]
            l["order_status"] = o["status"]
            l["order_payment_status"] = o["payment_status"]
            l["order_total"] = o["total_amount"]
            l["order_currency"] = o["currency"]
            l["sales_order"] = o.get("sales_order")
            l["order_date"] = o.get("order_date")
            l["addon_package_name"] = pkg_name_map.get(l.get("addon_package"), "")

    # Simbol currency (MYR->RM, SGD->S$) pada order & baris — frontend papar
    # simbol yang BETUL ikut currency order, bukan simbol company sahaja.
    sym_cache = {}
    def _sym(cur):
        if not cur:
            return ""
        if cur not in sym_cache:
            sym_cache[cur] = frappe.get_cached_value("Currency", cur, "symbol") or cur
        return sym_cache[cur]

    for o in orders:
        o["currency_symbol"] = _sym(o.get("currency"))
        for l in o["lines"]:
            l["currency_symbol"] = _sym(l.get("currency"))

    # B2B end-customer: angka harga/order payment status DITAPIS — paparan
    # "apa yang saya dah beli" untuk traveller hanya nama & status item.
    _ga_user, ga_customer_name, _ga_managed = _portal_access()
    if _price_hidden_for(booking, ga_customer_name):
        for o in orders:
            o["total_amount"] = None
            o["payment_status"] = None
            for l in o["lines"]:
                l["unit_price"] = None
                l["amount"] = None
                l["order_total"] = None
                l["order_payment_status"] = None

    return orders

@frappe.whitelist()
def search_package_offers_by_travel_date(
    doctype: str,
    txt: str,
    searchfield: str,
    start: int,
    page_len: int,
    filters: dict | str | None = None,
) -> list:
    """Link-search Package Offer yang sah untuk satu Travel Date / trip
    (RECONDITION Nov 2026 — menggantikan search_trip_packages_by_group_date
    yang menapis Trip Package melalui jadual M:N Trip Package Group Date
    Select; Package Offer kini berpaut TERUS kepada Travel Date).

    Digunakan oleh filter dependent child table Trip Scoping (Trip Addon
    Package di Desk): pilih trip → travel date difilter ikut trip → offer
    difilter ikut travel date. Fallback: tiada travel_date dalam filters
    tapi ada trip → pulangkan semua offer Active trip tersebut.
    """
    # Link-query Frappe menghantar filters sebagai dict, tetapi panggilan
    # API terus (GET) membawa JSON string — terima kedua-dua bentuk.
    if isinstance(filters, str):
        try:
            import json as _json

            filters = _json.loads(filters)
        except Exception:
            filters = {}
    filters = filters or {}
    td = filters.get("travel_date") or ""
    trip = filters.get("trip") or ""
    txt = (txt or "").strip()
    like = "%" + txt + "%"

    if td:
        return frappe.db.sql(
            """
            SELECT po.name, po.offer_name
            FROM `tabPackage Offer` po
            WHERE po.travel_date = %(td)s
              AND po.status_editorial = 'Active'
              AND (po.name LIKE %(like)s OR IFNULL(po.offer_name, '') LIKE %(like)s)
            ORDER BY po.name
            LIMIT %(limit)s OFFSET %(start)s
            """,
            {"td": td, "like": like, "limit": page_len, "start": start},
            as_list=True,
        )

    if trip:
        return frappe.db.sql(
            """
            SELECT po.name, po.offer_name
            FROM `tabPackage Offer` po
            WHERE po.trip = %(trip)s AND po.status_editorial = 'Active'
              AND (po.name LIKE %(like)s OR IFNULL(po.offer_name, '') LIKE %(like)s)
            ORDER BY po.name
            LIMIT %(limit)s OFFSET %(start)s
            """,
            {"trip": trip, "like": like, "limit": page_len, "start": start},
            as_list=True,
        )

    return []
