# travel_booking/api/pricing.py
#
# Bahagian 0, 1 & 6 dari booking.py asal:
#   - Tetapan bayaran + maklumat bank (get_payment_settings)
#   - Butiran trip/kabin untuk wizard (get_wizard_confirmation,
#     get_booking_details, get_sales_persons)
#   - Kiraan harga backend (fmt_currency, _get_pricing_map,
#     _price_selection, _validate_selection_capacity)
#
# Tiada _send_status_email atau penciptaan dokumen di sini — modul ni
# baca sahaja (read-only) terhadap data, jadi selamat dari masalah
# import membulat (circular import).

import frappe

from travel_booking.api._helpers import get_company_currency
from travel_booking.api.constants import get_max_cabins
from travel_booking.api.so_helpers import _get_primary_so, _compute_payment_status


# ══════════════════════════════════════════════
# 0. GET PAYMENT SETTINGS (Bank Account + Cashback)
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def get_payment_settings():
    """Bank account & cashback info untuk papar di booking.html.

    MULTI-CURRENCY (rujuk dokumen reka bentuk): dipanggil AWAL wizard
    (page load, SEBELUM customer pilih Trip/Package) — currency booking
    BELUM diketahui pada ketika ni. Jadi pulangkan bank details untuk
    SEMUA currency yang dikonfigurasikan sekaligus (dict keyed currency,
    cth {"MYR": {...}, "SGD": {...}}) — frontend pilih currency yang
    BETUL bila customer sampai Step Payment (ikut currency package yang
    dipilih, rujuk state.trip_package's currency di booking.js).

    PENTING: guna getattr()/get() (bukan attribute access terus) untuk
    field yang mungkin dah dibuang/diubah struktur di doctype — elak
    AttributeError yang boleh crash endpoint ni sepenuhnya untuk customer.
    """
    settings = frappe.get_cached_doc("Travel Settings")

    bank_accounts_by_currency = {}
    # Track per-currency online payment availability: True if
    # payment_gateway_account is configured for that currency row.
    online_payment_by_currency = {}
    for row in (settings.get("currency_accounts") or []):
        if not row.currency:
            continue
        bank_display_name = ""
        account_name = ""
        account_number = ""
        if row.bank_account:
            try:
                ba = frappe.db.get_value(
                    "Bank Account", row.bank_account,
                    ["bank", "account_name", "bank_account_no"], as_dict=True
                )
                if ba:
                    bank_display_name = ba.bank or ""
                    account_name = ba.account_name or ""
                    account_number = ba.bank_account_no or ""
            except Exception:
                pass
        bank_accounts_by_currency[row.currency] = {
            "bank_name":      bank_display_name,
            "account_name":   account_name,
            "account_number": account_number,
        }
        online_payment_by_currency[row.currency] = bool(row.payment_gateway_account)

    # Online payment globally available if ANY currency row has a gateway.
    # Frontend pages that don't know the booking currency yet (wizard page
    # load) use this flag to decide whether to show the Online Payment option.
    # Pages that know the currency should use online_payment_by_currency instead.
    online_payment_enabled = any(online_payment_by_currency.values())

    return {
        # dict {currency: {bank_name, account_name, account_number}} —
        # KOSONG ({}) untuk currency yang admin belum konfigurasikan
        # Bank Account (Manual Transfer patut disembunyikan/dilumpuhkan
        # di frontend untuk currency macam ni — rujuk dokumen reka
        # bentuk, "sembunyikan pilihan payment, bukan fallback senyap").
        "bank_accounts":                    bank_accounts_by_currency,
        "cashback_enabled":                 bool(getattr(settings, "manual_transfer_cashback_enabled", 0)),
        "cashback_percent":                 float(getattr(settings, "manual_transfer_cashback_percent", 0) or 0),
        "default_deposit_percent":          float(getattr(settings, "default_deposit_percent", 20) or 20),
        "support_email":                    getattr(settings, "support_email", "") or "",
        "support_phone":                    getattr(settings, "support_phone", "") or "",
        # Online payment (Stripe) availability — hides/disables the Online
        # Payment option at checkout when no Payment Gateway Account is
        # configured in Travel Settings > Currency Accounts.
        "online_payment_enabled":           online_payment_enabled,
        "online_payment_by_currency":       online_payment_by_currency,
        # Minimum chargeable amount (company currency) untuk Online Payment.
        # Bila jumlah caj customer di bawah nilai ni, frontend sembunyikan
        # pilihan Online Payment (fallback ke Manual/Held) dan guard server
        # di create_payment_intent (stripe_checkout.py) reject. 0 = dilumpuhkan.
        "online_payment_min_amount":        float(getattr(settings, "online_payment_min_amount", 0) or 0),
    }


@frappe.whitelist(allow_guest=True)
def get_sales_persons():
    """Senarai Sales Person aktif (staff dalaman RareCruise) untuk dropdown
    optional di wizard booking. Customer boleh pilih staff yang uruskan
    booking dia — disimpan terus dalam Sales Order punya child table
    'Sales Team' sahaja (bukan Booking doctype).

    NOTA: 'Sales Person' adalah Tree doctype (macam Item Group/Territory) —
    ada node 'Group' (folder organisasi, cth root 'Sales Team') yang BUKAN
    staff sebenar. is_group=0 elak folder ni tersalah masuk sebagai pilihan.
    """
    return frappe.get_all(
        "Sales Person",
        filters={"enabled": 1, "is_group": 0},
        fields=["name", "sales_person_name"],
        order_by="sales_person_name ASC",
    )


# ══════════════════════════════════════════════
# 1. GET BOOKING DETAILS
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def get_wizard_confirmation(booking_number: str, pr: str = None):
    """Data ringan untuk papar step Confirm selepas redirect dari checkout (Stripe).
    Tiada data sensitif traveller — hanya untuk paparan status booking.
    Loose-token check via 'pr' (Payment Request) untuk elak sesiapa teka booking_number.

    Approach: Baca terus dari Booking doctype — field trip_name, departure_date,
    return_date, is_a_cruise_trip dah ada pada Booking sendiri!
    """
    # SECURITY FIX (P2/W1): 'pr' WAJIB — dulu opsyenal, jadi sesiapa boleh
    # walk booking_number berurutan (cth BK2609009 → BK2609010) dan baca
    # status + grand_total/advance_paid pelanggan lain TANPA token. Semakan
    # pasangan pr↔booking ada di bawah (STEP 2: pr_so != primary_so →
    # throw) tapi DILANGKAU bila 'pr' kosong. Wizard sentiasa hantar 'pr'
    # (pollWizardConfirmation); kalau gagal, JS render dari snapshot.
    if not pr:
        frappe.throw("Invalid or missing payment reference.", frappe.PermissionError)

    # === STEP 1: Dapatkan Booking record dengan SEMUA field yang diperlukan ===
    # NOTE: Booking guna 'cruise_start'/'cruise_end', BUKAN 'sailing_start'/'sailing_end'
    try:
        booking = frappe.db.get_value("Booking", {"booking_number": booking_number},
            ["name", "booking_number", "status", "trip_package", "trip_date",
             "trip_name", "departure_date", "return_date",
             "cruise_start", "cruise_end", "is_a_cruise_trip", "is_cruise_only"],
            as_dict=True)
    except Exception as e:
        frappe.throw(f"Booking not found: {e}")

    if not booking:
        frappe.throw("Booking not found.")

    # === STEP 2: Extract data dari Booking (field-field ni wujud pada Booking) ===
    trip_name = booking.trip_name or ""
    trip_group_name = ""
    departure_date = str(booking.departure_date) if booking.departure_date else ""
    return_date = str(booking.return_date) if booking.return_date else ""
    # Map cruise_start/end → sailing_start/end untuk frontend consistency
    sailing_start = str(booking.cruise_start) if getattr(booking, 'cruise_start', None) else ""
    sailing_end = str(booking.cruise_end) if getattr(booking, 'cruise_end', None) else ""
    is_cruise_trip = bool(booking.is_a_cruise_trip)

    # === STEP 3: Dapatkan group name dari Trip Group Date (field ni tak ada di Booking) ===
    if booking.trip_date:
        try:
            tgd = frappe.db.get_value("Trip Group Date", booking.trip_date,
                ["trip_group_name"], as_dict=True)
            if tgd:
                trip_group_name = tgd.trip_group_name or ""
        except Exception:
            pass  # Non-critical

    # === STEP 3: Dapatkan package type dari Trip Package ===
    package_label = ""
    if booking.trip_package:
        try:
            pkg_data = frappe.db.get_value("Trip Package", booking.trip_package,
                                          ["package_type"],
                                          as_dict=True)
            if pkg_data:
                package_label = pkg_data.package_type or ""
        except Exception:
            pass  # Non-critical

    primary_so = _get_primary_so(booking.name)

    if pr:
        try:
            pr_so = frappe.db.get_value("Payment Request", pr, "reference_name")
        except Exception:
            pr_so = None  # Payment Request mungkin dah di-delete selepas payment
        if pr_so and pr_so != primary_so:
            frappe.throw("Invalid reference.", frappe.PermissionError)

    # NOTA: "Disable Rounded Total" kini global (Selling Settings) — semua
    # SO (wizard/addon) tak lagi guna rounded_total, standardize ke
    # grand_total sahaja merentasi app (rujuk juga nota di confirm_booking()).
    grand_total = 0
    advance_paid = 0
    if primary_so:
        try:
            so = frappe.db.get_value("Sales Order", primary_so,
                                     ["grand_total", "advance_paid"], as_dict=True)
            if so:
                grand_total  = float(so.grand_total or 0)
                advance_paid = float(so.advance_paid or 0)
        except Exception as _so_err:
            frappe.log_error(f"SO lookup failed: {_so_err}", "Wizard Confirmation")

    return {
        "booking_number":  booking.booking_number,
        "booking_status":  booking.status,
        # Data terus daripada Booking doctype (field dah wujud semasa create)
        "trip_name":       booking.trip_name or "",
        "group_name":      trip_group_name,  # Dari Trip Group Date (Step 2)
        "departure_date":  str(booking.departure_date) if booking.departure_date else "",
        "return_date":     str(booking.return_date) if booking.return_date else "",
        "sailing_start":   sailing_start,
        "sailing_end":     sailing_end,
        "is_cruise_trip":  bool(booking.is_a_cruise_trip),
        "package_label":   package_label,  # Dari Trip Package (Step 3)
        # Flight info tak ada dalam doctype — frontend snapshot akan supply
        "flight_label":    "",
        "flight":          "",
        # Payment info dari Sales Order
        "grand_total":     grand_total,
        "advance_paid":    advance_paid,
        "payment_status":  _compute_payment_status(advance_paid, grand_total),
    }


def _get_booking_details_offer(offer_name: str):
    """Mod OFFER (F5 struktur baharu) untuk get_booking_details: baca kabin
    + harga daripada Package Offer — kontrak pulangan SERASI dengan aliran
    legacy (trip / trip_group_date / cabins) supaya booknow.js Step 1 dan
    trip_detail.js tidak perlu diubah.

    Sumber: tarikh & trip daripada Travel Date (satu sumber kebenaran);
    harga daripada Price Matrix offer; availabiliti kabin daripada kolam
    cabin_rates Trip Cruise Schedule (allotment − occupancy live)."""
    offer = frappe.db.get_value(
        "Package Offer", offer_name,
        ["name", "offer_name", "travel_date", "currency",
         "cruise_schedule", "status_editorial"],
        as_dict=True,
    )
    if not offer:
        frappe.throw("Package Offer not found.")
    if offer.status_editorial != "Active":
        frappe.throw("This package offer is no longer active.")

    td = frappe.db.get_value(
        "Travel Date", offer.travel_date,
        ["name", "trip", "departure_date", "return_date",
         "sailing_start", "sailing_end", "ship_name", "ship_code"],
        as_dict=True,
    )
    if not td:
        frappe.throw("Travel Date {0} not found.".format(offer.travel_date))

    trip = frappe.db.get_value(
        "Trip", td.trip,
        ["name", "trip_name", "description", "is_a_cruise_trip", "trip_image"],
        as_dict=True,
    )
    if not trip:
        frappe.throw("Trip not found.")

    # ── Price Matrix offer (child Trip Package Price parenttype=
    # 'Package Offer') + metadata kategori — resolve kod kanonik v47 →
    # docname (corak _get_offer_pricing_map). ──
    rows = frappe.get_all(
        "Trip Package Price",
        filters={"parent": offer_name, "parenttype": "Package Offer",
                 "parentfield": "price_matrix"},
        fields=["pricing_for_class", "price_adult_single", "price_adult",
                "price_upperberth", "price_children", "price_toddler",
                "price_infant"],
        order_by="idx asc",
    )
    if not rows:
        frappe.throw(
            "Offer {0} has no price matrix rows - configure its Price "
            "Matrix before selling.".format(offer_name)
        )

    cat_by_code, cat_by_name = {}, {}
    for c in frappe.get_all(
        "Trip Price Category",
        fields=["name", "category_code", "category_name", "category_group",
                "capacity", "max_capacity", "description", "room_profile",
                "read_more_url", "youtube_url"],
    ):
        if c.category_code:
            cat_by_code[c.category_code] = c
        cat_by_name[c.name] = c

    pricing_rows = []
    for r in rows:
        cat = (cat_by_code.get(r.pricing_for_class)
               or cat_by_name.get(r.pricing_for_class))
        if not cat:
            continue
        row = frappe._dict({
            "room_category": cat.name,
            "category_name": cat.category_name,
            "category_group": cat.category_group,
            "capacity": cat.capacity,
            "max_capacity": cat.max_capacity,
            "description": cat.description,
            "room_profile": cat.room_profile,
            "read_more_url": cat.read_more_url,
            "youtube_url": cat.youtube_url,
            "price_adult_single": r.price_adult_single,
            "price_adult": r.price_adult,
            "price_upperberth": r.price_upperberth,
            "price_children": r.price_children,
            "price_toddler": r.price_toddler,
            "price_infant": r.price_infant,
        })
        pricing_rows.append(row)
    if not pricing_rows:
        frappe.throw(
            "Offer {0} price matrix has no valid room categories.".format(
                offer_name)
        )

    # Gallery kabin — sumber SAMA dengan aliran legacy (Attachment Gallery
    # Trip Price Category, hanya fail imej PUBLIC).
    gallery_map = {}
    cat_names = [r.room_category for r in pricing_rows]
    if cat_names:
        for f in frappe.get_all(
            "File",
            filters={
                "attached_to_doctype": "Trip Price Category",
                "attached_to_name": ["in", cat_names],
                "is_folder": 0,
                "is_private": 0,
            },
            fields=["attached_to_name", "file_url"],
            order_by="creation asc",
            limit_page_length=0,
        ):
            if f.file_url and f.file_url.lower().endswith(
                (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif")
            ):
                gallery_map.setdefault(f.attached_to_name, []).append(f.file_url)

    # Travel Price Rule — ctx daripada Travel Date (scoping trip/tarikh);
    # scoping pakej/group-date legacy tidak terpakai untuk offer.
    from travel_booking.api.price_rule import (
        apply_price_rules, dominant_rule_info,
    )
    rule_ctx = {
        "trip": td.trip,
        "trip_group_date": None,
        "trip_package": None,
        "currency": offer.currency,
        "departure_date": td.departure_date,
    }
    eff_map, applied_info = apply_price_rules(
        {r.room_category: r for r in pricing_rows}, rule_ctx
    )

    # ── Surcaj ADDON — Total pakej = promo(base) + Σ addon_price_matrix ──
    # Snapshot harga base asal SEBELUM mutasi: bila tiada rule aktif,
    # apply_price_rules pulangkan map ASAL (eff_map ialah objek row yang
    # sama dengan pricing_rows), jadi snapshot awal menjamin original_
    # pricing like-for-like (base asal + Σ addon) untuk strikethrough.
    addon_totals = _get_offer_addon_totals(offer_name)
    orig_base = {
        r.room_category: {c: float(getattr(r, c) or 0) for c in PRICE_SLOT_COLS}
        for r in pricing_rows
    }
    _apply_addon_totals(eff_map, addon_totals)

    # Availabiliti kabin — kolam cabin_rates schedule (kongsi semua offer
    # satu sailing). cabin_available = allotment − occupancy dipulangkan
    # SEBAGAI ANGKA (pool_cabins_left) supaya wizard boleh hadkan pilihan
    # SEMASA pemilihan bilik — bukan tunggu gate check_offer_capacity di
    # confirm_booking sahaja (customer tak sampai ke checkout baru tau
    # penuh). Inventori mengira KABIN (occupancy = DISTINCT room_id),
    # bukan penumpang. Kategori TIADA dalam kolam:
    #   - offer darat (tiada schedule / schedule terhapus) → tiada had,
    #     jualan terbuka (padan gate: return awal, tiada semakan kolam);
    #   - offer CRUISE ber-schedule tapi kategori tak dikonfigur dalam
    #     cabin_rates → available=0 — gate confirm akan menolaknya
    #     ("tiada dalam kolam kategori sailing"), jadi jangan benarkan
    #     dipilih langsung.
    pool: dict = {}
    has_schedule_pool = bool(offer.cruise_schedule) and frappe.db.exists(
        "Trip Cruise Schedule", offer.cruise_schedule
    )
    if has_schedule_pool:
        for r in frappe.get_all(
            "Trip Package Price",
            filters={
                "parent": offer.cruise_schedule,
                "parenttype": "Trip Cruise Schedule",
            },
            fields=["pricing_for_class", "cabin_available"],
        ):
            pool[r.pricing_for_class] = int(r.cabin_available or 0)

    from frappe.utils import date_diff
    nights = date_diff(td.return_date, td.departure_date) if (
        td.return_date and td.departure_date) else 0

    cabins = []
    for row in pricing_rows:
        available = 1
        pool_left = None
        if has_schedule_pool:
            if row.room_category in pool:
                # Boleh negative (isyarat overbooking utk admin — rujuk
                # refresh_cabin_availability); customer lihat 0.
                pool_left = max(0, pool[row.room_category])
                available = 1 if pool_left > 0 else 0
            else:
                available = 0
        eff = eff_map.get(row.room_category) or row
        applied = applied_info.get(row.room_category)

        cabin = {
            "room_category": row.room_category,
            "room_name":     row.category_name or row.room_category,
            "category_group": row.category_group,
            "capacity":      row.capacity or 2,
            "max_capacity":  row.max_capacity if row.max_capacity is not None else (row.capacity or 2),
            "description":   row.description or "",
            "room_image":    row.room_profile or "",
            "room_gallery":  gallery_map.get(row.room_category, []),
            "read_more_url": row.read_more_url or "",
            "room_video_url": row.youtube_url or "",
            "pricing": {
                "price_adult_single":     float(eff.price_adult_single     or 0),
                "price_adult":            float(eff.price_adult           or 0),
                "price_upperberth": float(eff.price_upperberth or 0),
                "price_children":         float(eff.price_children        or 0),
                "price_infant":           float(eff.price_infant          or 0),
            },
            "available":    available,
            "is_available": available > 0,
            # Baki KABIN kolam kontrak sailing utk kategori ni (allotment
            # − occupancy live — keduanya unit KABIN; dikongsi semua offer
            # satu sailing). null = tiada kolam (offer darat) → wizard tak
            # menghadkan pilihan. Dipakai booknow.js utk had bilangan
            # bilik per kategori + badge "N cabins left".
            "pool_cabins_left": pool_left,
        }
        if applied:
            ob = orig_base[row.room_category]
            cabin["original_pricing"] = {
                "price_adult_single": ob["price_adult_single"] + addon_totals.get("price_adult_single", 0),
                "price_adult":        ob["price_adult"]        + addon_totals.get("price_adult", 0),
                "price_upperberth":   ob["price_upperberth"]   + addon_totals.get("price_upperberth", 0),
                "price_children":     ob["price_children"]     + addon_totals.get("price_children", 0),
                "price_infant":       ob["price_infant"]       + addon_totals.get("price_infant", 0),
            }
            cabin["price_rule"] = dominant_rule_info(applied)
        cabins.append(cabin)

    return {
        "trip": {
            "name":             trip.name,
            "trip_name":        trip.trip_name,
            "description":      trip.description or "",
            "is_a_cruise_trip": bool(trip.is_a_cruise_trip),
            "trip_image":       trip.trip_image or "/assets/travel_booking/img/defaultaroya.jpg",
        },
        "trip_group_date": {
            "name":             td.name,
            "trip_group_name":  offer.offer_name or td.name,
            "trip_group_code":  "",
            "departure_date":   str(td.departure_date) if td.departure_date else "",
            "return_date":      str(td.return_date)    if td.return_date    else "",
            "total_days":       (nights + 1) if nights else 0,
            "total_nights":     nights,
            "ship_name":        td.ship_name or "",
            "ship_code":        td.ship_code or "",
        },
        "cabins": cabins,
    }


@frappe.whitelist(allow_guest=True)
def get_booking_details(trip_group_date: str, trip_package: str = None,
                        package_offer: str = None):
    """Return trip + sailing info + cabin categories with pricing.
    Pricing dibaca dari Trip Package Price (child Trip Package), setiap
    row berkait dengan satu Trip Price Category (kategori bilik/kabin).
    Room Availability dibuang — inventori bilik diurus manual oleh admin.

    package_offer (F5 struktur baharu): bila dihantar, mod OFFER dijalankan
    — kabin + harga dibaca terus daripada OFFER (Price Matrix child Trip
    Package Price parenttype='Package Offer'), tarikh/ops daripada Travel
    Date, availabiliti kabin daripada kolam cabin_rates Trip Cruise
    Schedule. trip_group_date/trip_package (nama legacy) diabaikan.
    """
    if package_offer:
        return _get_booking_details_offer(package_offer)
    td = frappe.db.get_value(
        "Trip Group Date", trip_group_date,
        ["name", "trip", "trip_group_name", "trip_group_code", "status",
         "departure_date", "return_date", "sailing_start", "sailing_end",
         "ship_name", "ship_code", "total_days", "total_nights",
         "embarkation_port", "disembarkation_port"],
        as_dict=True
    )
    if not td:
        frappe.throw("Trip Group Date not found.")

    trip = frappe.db.get_value(
        "Trip", td.trip,
        ["name", "trip_name", "description", "is_a_cruise_trip", "trip_image"],
        as_dict=True
    )
    if not trip:
        frappe.throw("Trip not found.")

    # Nama pakej tidak sah (cth nilai basi dari snapshot sesi lama dengan
    # suffix varian "TP260913:1") — dahulu memulangkan 0 kabin secara
    # senyap, kini error jelas supaya frontend/user tahu pilihan pakej
    # perlu dibuat semula (booknow.js resolveTripPackageName() dah
    # auto-betulkan nilai sebegini, throw ni perlindungan lapis kedua).
    if trip_package and not frappe.db.exists("Trip Package", trip_package):
        frappe.throw(
            "Trip Package not found. Please go back and select your package again."
        )

    # Pricing rows dari Trip Package Price (child Trip Package), JOIN
    # Trip Price Category untuk dapatkan maklumat kategori bilik/kabin.
    pricing_rows = frappe.db.sql("""
        SELECT
            tpp.pricing_for_class AS room_category,
            tpc.category_name,
            tpc.category_group,
            tpc.capacity,
            tpc.max_capacity,
            tpc.description,
            tpc.room_profile,
            tpc.read_more_url,
            tpc.youtube_url,
            tpp.price_adult_single,
            tpp.price_adult,
            tpp.price_upperberth,
            tpp.price_children,
            tpp.price_infant
        FROM `tabTrip Package Price` tpp
        JOIN `tabTrip Price Category` tpc ON tpc.name = tpp.pricing_for_class
        WHERE tpp.parent = %s AND tpp.parenttype = 'Trip Package'
        ORDER BY tpp.idx ASC
	    """, trip_package, as_dict=True)

    # Gallery kabin — slide gambar diambil dari Attachment Gallery kategori
    # (rekod File yang dilampir pada Trip Price Category, sama sumber dengan
    # field attachment_gallery_ktzn di Desk). Satu query untuk semua kategori
    # supaya tiada N+1; hanya fail imej PUBLIC — fail private tak akan
    # dapat dihubungi guest portal (URL /files/ perlu auth).
    gallery_map = {}
    cat_names = [r.room_category for r in pricing_rows]
    if cat_names:
        for f in frappe.get_all(
            "File",
            filters={
                "attached_to_doctype": "Trip Price Category",
                "attached_to_name": ["in", cat_names],
                "is_folder": 0,
                "is_private": 0,
            },
            fields=["attached_to_name", "file_url"],
            order_by="creation asc",
            limit_page_length=0,
        ):
            if f.file_url and f.file_url.lower().endswith(
                (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif")
            ):
                gallery_map.setdefault(f.attached_to_name, []).append(f.file_url)

    # Travel Price Rule (promosi price-slash): pricing yang dipulangkan
    # adalah HARGA PROMO (harga jualan sebenar). Bila rule berkesan,
    # original_pricing + price_rule disertakan supaya frontend boleh
    # papar strikethrough harga asal + badge promosi.
    from travel_booking.api.price_rule import (
        apply_price_rules, resolve_ctx, dominant_rule_info,
    )
    rule_ctx = resolve_ctx(trip_package, trip_group_date)
    eff_map, applied_info = apply_price_rules(
        {r.room_category: r for r in pricing_rows}, rule_ctx
    )

    cabins = []
    for row in pricing_rows:
        # Room Availability doctype dibuang — semua kategori dianggap available.
        # Kawalan bilik sebenar diurus admin (order batch dari Aroya).
        available = 1

        # Harga berkesan (promo) — fallback ke row asal bila tiada rule.
        eff = eff_map.get(row.room_category) or row
        applied = applied_info.get(row.room_category)

        cabin = {
            "room_category": row.room_category,
            "room_name":     row.category_name or row.room_category,
            "category_group": row.category_group,
            "capacity":      row.capacity or 2,
            # max_capacity == 0 eksplisit -> UNLIMITED (jangan fallback ke
            # capacity). None/kosong -> fallback capacity (behavior sedia).
            "max_capacity":  row.max_capacity if row.max_capacity is not None else (row.capacity or 2),
            "description":   row.description or "",
            "room_image":    row.room_profile or "",
            # Senarai URL gambar dari Attachment Gallery kategori — sumber
            # utama slide carousel kad kabin (booknow.js). room_image di atas
            # kekal sebagai fallback bila kategori tiada gallery.
            "room_gallery":  gallery_map.get(row.room_category, []),
            "read_more_url": row.read_more_url or "",
            # Link video bilik (YouTube). Di-booknow.js, gambar room_profile
            # jadi POSTER/placeholder — klik untuk embed iframe YouTube.
            "room_video_url": row.youtube_url or "",
            "pricing": {
                "price_adult_single":     float(eff.price_adult_single     or 0),
                "price_adult":            float(eff.price_adult           or 0),
                "price_upperberth": float(eff.price_upperberth or 0),
                "price_children":         float(eff.price_children        or 0),
                "price_infant":           float(eff.price_infant          or 0),
            },
            "available":    available,
            "is_available": available > 0,
        }
        if applied:
            cabin["original_pricing"] = {
                "price_adult_single":     float(row.price_adult_single     or 0),
                "price_adult":            float(row.price_adult            or 0),
                "price_upperberth": float(row.price_upperberth or 0),
                "price_children":         float(row.price_children         or 0),
                "price_infant":           float(row.price_infant           or 0),
            }
            cabin["price_rule"] = dominant_rule_info(applied)
        cabins.append(cabin)


    return {
        "trip": {
            "name":             trip.name,
            "trip_name":        trip.trip_name,
            "description":      trip.description or "",
            "is_a_cruise_trip": bool(trip.is_a_cruise_trip),
            # Cover image untuk background hero banner wizard — fallback
            # default SAMA dengan katalog (_enrich_trips di trip_catalog.py).
            "trip_image":       trip.trip_image or "/assets/travel_booking/img/defaultaroya.jpg",
        },
        "trip_group_date": {
            "name":             td.name,
            "trip_group_name":  td.trip_group_name or "",
            "trip_group_code":  td.trip_group_code or "",
            "departure_date":   str(td.departure_date) if td.departure_date else "",
            "return_date":      str(td.return_date)    if td.return_date    else "",
            "total_days":       td.total_days or 0,
            "total_nights":     td.total_nights or 0,
            "ship_name":        td.ship_name or "",
            "ship_code":        td.ship_code or "",
        },
        "cabins": cabins,
    }


# ══════════════════════════════════════════════
# 6. PRICING — BACKEND CALCULATION
# ══════════════════════════════════════════════

def fmt_currency(amount, currency=None):
    """Format amount dengan symbol currency yang BETUL — SENGAJA baca
    terus dari doctype Currency ERPNext (field 'symbol' native), BUKAN
    hardcode "RM " (rujuk dokumen reka bentuk multi-currency, prinsip
    "reka bentuk sebarang currency" — currency baharu terus berfungsi
    tanpa perlu tambah code setiap kali admin cipta rekod Currency baharu).

    Fallback ke "RM" kalau currency tak dibekalkan (backward-compat untuk
    caller lama yang belum diupdate) atau currency tu tiada rekod Currency
    sepadan (data tak konsisten — jarang berlaku, tapi elak crash).
    """
    symbol = "RM"
    if currency:
        symbol = frappe.db.get_value("Currency", currency, "symbol") or currency
    return "{} {:,.2f}".format(symbol, float(amount))


# ══════════════════════════════════════════════
# DISPLAY CURRENCY CONVERTER
#
# Semua transaksi (SO/Stripe/Payment Entry/invoice) dalam COMPANY CURRENCY.
# Currency lain cuma PAPARAN — customer boleh pilih currency di frontend,
# jumlah ditukar guna rate exchange ERPNext (for_selling). Converter ni
# READ-ONLY: tak ubah accounting; cuma sediakan rate + symbol untuk UI.
# ══════════════════════════════════════════════

# Cache rate exchange 5 minit dalam redis — elak query/fetch berulang setiap
# kali page reload. Rate berubah lambat (admin kemaskini Currency Exchange
# secara berkala); 5 minit antara refresh cukup untuk paparan indicative.
_FX_CACHE_TTL = 300


def _currency_symbol(currency):
    """Symbol untuk satu currency (cth 'RM', 'S$'). Fallback ke code currency
    sendiri kalau tiada rekod Currency / tiada symbol."""
    if not currency:
        return "RM"
    return frappe.db.get_value("Currency", currency, "symbol") or currency


@frappe.whitelist(allow_guest=True)
def get_display_currencies() -> list:
    """Senarai currency yang boleh DIBELI (paksi currency multi-company).

    Ditulis semula untuk model multi-currency sebenar: sumber senarai
    ialah axis Travel Settings > Multi Currency Account (currency ->
    company), BUKAN rekod Currency Exchange. Setiap currency diisytiharkan
    = booking boleh dibuat & di-bil dalam currency itu oleh company yang
    sepadan. Currency default company sentiasa dihadapan (is_company).

    Currency Exchange (get_currency_rate) masih wujud untuk paparan
    indicative cross-rate sahaja — ia TIDAK lagi menentukan senarai.

    Pulangkan [{code, symbol, name, is_company, company}].
    """
    from travel_booking.api.currency_axis import get_currency_axis

    company_currency = get_company_currency()

    out = []
    seen = set()
    for r in get_currency_axis():
        if r["currency"] in seen:
            continue
        out.append({
            "code": r["currency"],
            "symbol": r["symbol"],
            "name": frappe.db.get_value("Currency", r["currency"], "currency_name")
            or r["currency"],
            "is_company": bool(r["currency"] == company_currency),
            "company": r["company"],
        })
        seen.add(r["currency"])

    # Fallback: axis kosong (belum dikonfigur) — pulangkan currency
    # company sahaja supaya selector frontend masih berfungsi.
    if not out:
        out.append({
            "code": company_currency,
            "symbol": _currency_symbol(company_currency),
            "name": frappe.db.get_value("Currency", company_currency, "currency_name")
            or company_currency,
            "is_company": True,
            "company": frappe.db.get_single_value("Global Defaults", "default_company"),
        })
    return out


@frappe.whitelist(allow_guest=True)
def get_currency_rate(from_currency: str, to_currency: str) -> dict:
    """Rate exchange (for_selling) dari -> ke. Wrapper atas
    erpnext.setup.utils.get_exchange_rate dengan cache redis 5 minit.

    Pulangkan {from, to, rate}. rate=None kalau tak boleh resolve (frontend
    tunjuk mesej "rate unavailable" — JANGAN throw, sebab ini paparan sahaja,
    bukan gate kritikal). Jika from==to, rate=1 (cth company->company).
    """
    if not from_currency or not to_currency:
        return {"from": from_currency, "to": to_currency, "rate": None}
    if from_currency == to_currency:
        return {"from": from_currency, "to": to_currency, "rate": 1.0}

    cache = frappe.cache()
    key = "travel_booking:fx:" + from_currency + ":" + to_currency
    cached = cache.get(key)
    if cached:
        try:
            import json as _json
            data = _json.loads(cached)
            import time as _time
            if _time.time() - float(data.get("ts", 0)) < _FX_CACHE_TTL:
                return {
                    "from": from_currency,
                    "to": to_currency,
                    "rate": float(data["rate"]),
                }
        except Exception:
            pass  # cache corrupt — buang & fetch semula

    try:
        from erpnext.setup.utils import get_exchange_rate

        rate = get_exchange_rate(
            from_currency, to_currency, frappe.utils.today(), args="for_selling"
        )
    except Exception:
        rate = None

    if rate:
        import json as _json
        import time as _time
        cache.set(
            key,
            _json.dumps({"rate": float(rate), "ts": _time.time()}),
        )

    return {"from": from_currency, "to": to_currency, "rate": float(rate) if rate else None}


@frappe.whitelist(allow_guest=True)
def convert_amount(amount: float, to_currency: str) -> dict:
    """Tukar satu amaun (dalam company currency) ke currency paparan.

    Pulangkan {company_currency, company_symbol, amount, display_currency,
    display_symbol, converted, rate}. converted=None kalau rate tak boleh
    resolve (frontend fallback ke company currency sahaja). Digunakan oleh
    booking wizard / portal / halaman awam untuk paparan dwi-currency.
    """
    company_currency = get_company_currency()
    amount = float(amount or 0)

    if not to_currency or to_currency == company_currency:
        return {
            "company_currency": company_currency,
            "company_symbol": _currency_symbol(company_currency),
            "amount": amount,
            "display_currency": company_currency,
            "display_symbol": _currency_symbol(company_currency),
            "converted": amount,
            "rate": 1.0,
        }

    r = get_currency_rate(company_currency, to_currency)
    rate = r.get("rate")
    return {
        "company_currency": company_currency,
        "company_symbol": _currency_symbol(company_currency),
        "amount": amount,
        "display_currency": to_currency,
        "display_symbol": _currency_symbol(to_currency),
        "converted": round(amount * float(rate), 2) if rate else None,
        "rate": rate,
    }


def _get_offer_pricing_map(offer_name):
	"""MODEL OFFER-MODE (Nov 2026): bina pricing map SAMA bentuk dengan
	_get_pricing_map() — {category_docname: frappe._dict(price_adult,
	price_adult_single, price_upperberth, price_children, price_toddler,
	price_infant)}.

	SUMBER TUNGGAL — Package Offer.price_matrix (child Trip Package
	Price): 1 baris per room category, lajur slot penuh (adult/single/
	upper/child/toddler/infant). [BUANG Nov 2026] fallback Offer Price —
	medan legacy itu telah ditanggalkan daripada Package Offer.

	Kunci = docname Trip Price Category (kod kanonik v47 -> resolve
	docname). Oksidan: offer tanpa baris matrix -> throw jelas (jangan
	jual offer kosong).

	[Rombakan konsep Nov 2026] price_matrix = BASE (Room Category
	sahaja); addons Flight/Hotel/Transport/Meal dikumpulkan dalam
	addon_price_matrix berasingan — rujuk _get_offer_addons_map.
	Total pakej = base (kategori dipilih × slot) + Σ addons."""
	map_ = _matrix_map(offer_name, "price_matrix")
	if not map_:
		frappe.throw(
			"Offer {0} has no price matrix rows - configure its Price "
			"Matrix before selling.".format(offer_name))
	return map_


def _get_offer_addons_map(offer_name):
	"""ADDONS offer (Nov 2026) — Flight/Hotel/Transport/Meal daripada
	Package Offer.addon_price_matrix (child Trip Package Price). Bentuk
	sama dengan map base; total pakej = base + Σ addons. Tiada throw
	bila kosong — pakej boleh dijual tanpa addon."""
	return _matrix_map(offer_name, "addon_price_matrix")


# Lajur harga slot — kunci lajur Trip Package Price yang membawa surcaj
# addon (sama set lajur dengan map base).
PRICE_SLOT_COLS = ("price_adult_single", "price_adult", "price_upperberth",
				   "price_children", "price_toddler", "price_infant")


def _get_offer_addon_totals(offer_name):
	"""Σ surcaj addon per LAJUR slot — jumlah merentasi SEMUA baris
	addon_price_matrix offer (Flight + Hotel + Transport + Meal sekali).

	Kontrak harga pakej (rujuk description addon_price_matrix):
	    Total pakej = base (Room Category × slot) + Σ addons.
	Surcaj ni DITAMBAH SELEPAS harga promo base (Travel Price Rule
	menyasarkan kadar bilik; addon ialah komponen tetap pakej).

	KEMBALI: {"price_adult": Σ, ...} — {} bila offer tiada addon."""
	addons = _get_offer_addons_map(offer_name)
	if not addons:
		return {}
	totals = {c: 0.0 for c in PRICE_SLOT_COLS}
	for a in addons.values():
		for c in PRICE_SLOT_COLS:
			totals[c] += float(getattr(a, c) or 0)
	return totals


def _apply_addon_totals(pricing_map, addon_totals):
	"""Campurkan surcaj addon per lajur kepada SETIAP baris map harga
	(in-place; map = {kategori: row lajur harga}). Dipakai bersama di
	titik paparan (get_booking_details) dan titik caj (confirm_booking)
	supaya paparan laman == jumlah yang dicas."""
	if not addon_totals:
		return pricing_map
	for price in (pricing_map or {}).values():
		for c, v in addon_totals.items():
			setattr(price, c, float(getattr(price, c) or 0) + v)
	return pricing_map


def _matrix_map(offer_name, parentfield):
	cat_by_code, cat_by_name = {}, {}
	for c in frappe.get_all("Trip Price Category",
			fields=["name", "category_code"]):
		if c.category_code:
			cat_by_code[c.category_code] = c.name
		cat_by_name[c.name] = c.name

	rows = frappe.get_all(
		"Trip Package Price",
		filters={"parent": offer_name, "parenttype": "Package Offer",
				 "parentfield": parentfield},
		fields=["pricing_for_class", "price_adult", "price_adult_single",
				"price_upperberth", "price_children", "price_toddler",
				"price_infant"],
		order_by="idx asc")
	map_ = {}
	for r in rows:
		code = r.pricing_for_class
		cat = cat_by_code.get(code) or cat_by_name.get(code)
		if not cat:
			continue
		map_[cat] = frappe._dict(
			price_adult=r.price_adult,
			price_adult_single=r.price_adult_single,
			price_upperberth=r.price_upperberth,
			price_children=r.price_children,
			price_toddler=r.price_toddler,
			price_infant=r.price_infant)
	return map_


def _get_pricing_map(trip_package):
    """Return {pricing_for_class: {...}} dari Trip Package Price (child
    Trip Package). Setiap row berkait dengan satu Trip Price Category
    (kategori bilik/kabin) melalui field 'pricing_for_class'.
    """
    # Guardrail migrasi currency: harga pakej yang berflag
    # 'price_review_required' belum disemak/diisi semula dalam company
    # currency. Halang SEBARANG kiraan harga (confirm_booking, voucher,
    # addon) supaya booking tak jadi atas harga pra-migrasi yang salah.
    # Admin uncheck flag selepas semak & isi semula harga (company currency).
    if frappe.db.get_value("Trip Package", trip_package, "price_review_required"):
        frappe.throw(
            "Pricing for this package is currently under review. "
            "Please contact the admin to complete the currency review."
        )

    rows = frappe.db.sql("""
        SELECT pricing_for_class AS room_category,
               price_adult_single, price_adult, price_upperberth,
               price_children, price_toddler, price_infant
        FROM `tabTrip Package Price`
        WHERE parent = %s AND parenttype = 'Trip Package'
    """, trip_package, as_dict=True)
    return {r.room_category: r for r in rows}


def _price_selection(price, main_guests, extra_beds, infants, is_cruise=True):
    """Kira harga satu selection.

    Cruise (is_cruise=True) — model SLOT (posisi dalam bilik):
      - main_guests == 1  -> price_adult_single (single occupancy)
      - main_guests >= 2  -> price_adult x setiap org (twin/multi occupancy)
      - extra_beds        -> price_upperberth x setiap org, flat (upper berth)
      - infants           -> price_infant x setiap org

    Non-cruise (is_cruise=False) — model UMUR (flat per pax, tiada single
    supplement): main_guests=Adult (price_adult), extra_beds=Children
    (price_children), infants (price_infant). Field payload sama
    (main_guests/extra_beds/infants) — hanya field harga + label berbeza.
    """
    mg  = int(main_guests or 0)
    eb  = int(extra_beds  or 0)
    inf = int(infants    or 0)

    total = 0.0
    if is_cruise:
        if mg == 1:
            total += float(price.price_adult_single or 0)
        elif mg >= 2:
            total += float(price.price_adult or 0) * mg
        total += float(price.price_upperberth or 0) * eb
    else:
        total += float(price.price_adult or 0) * mg
        total += float(price.price_children or 0) * eb
    total += float(price.price_infant or 0) * inf
    return round(total, 2)


def _validate_selection_capacity(selections, cabin_info_map, is_cruise=True):
    """Sahkan setiap selection ikut had server-side — jangan percaya
    client-side JS je, sebab payload boleh dimanipulasi.

    Cruise (is_cruise=True) — model SLOT:
      - main_guests: 1..capacity
      - extra_beds : 0..(max_capacity - capacity), hanya sah bila
                     main_guests == capacity (bilik penuh Main Guest dulu)
      - infants    : 0..(max_capacity - main_guests - extra_beds), hanya
                     sah bila main_guests >= 1. Had DINAMIK — sepadan tepat
                     dengan capFor() dalam booking.js (frontend).

    Non-cruise (is_cruise=False) — model UMUR:
      - main_guests (Adult)   : 1..max_capacity
      - extra_beds (Children) : 0..(max_capacity - main_guests), bila-bila
                                (TIADA syarat "adult penuh dulu" — bukan slot)
      - infants               : 0..(max_capacity - main_guests - extra_beds),
                                hanya sah bila main_guests >= 1.

    PERATURAN OVERBOOKING (max_capacity == 0 -> UNLIMITED): bila field
    max_capacity diset eksplisit ke 0, cabin dianggap TANPA had — semak
    jumlah total & had extra_bed/infant di-skip (overbooking dibenarkan).
    Rule structural (main_guests >= 1) kekal untuk kedua-dua model.
    max_capacity NULL/kosong -> fallback ke capacity (behavior sedia,
    backward-compat untuk pakej lama yang tak isi max_capacity).
    cabin_info_map: {room_category: {"capacity":.., "max_capacity":..}}
    """
    # PENTING: had maksimum cabin — check DULU sebelum apa-apa, sebab
    # 'selections' terus dari payload customer (boleh dimanipulasi walau
    # frontend dah disable butang "Add another room" bila cecah had).
    # Had dari Travel Settings (get_max_cabins) — 0 = unlimited.
    max_cabins = get_max_cabins()
    if max_cabins and len(selections) > max_cabins:
        frappe.throw(
            "Maximum " + str(max_cabins) +
            " cabins allowed per booking. Please contact us " +
            "directly for larger reservations."
        )

    for sel in selections:
        room_category = sel.get("room_category")
        info = cabin_info_map.get(room_category)
        if not info:
            frappe.throw("Invalid room category: " + str(room_category))

        capacity = int(info.get("capacity") or 0)
        # max_capacity == 0 (eksplisit) -> UNLIMITED. None/kosong -> fallback
        # ke capacity (behavior sedia). Bezakan None daripada 0 supaya pakej
        # lama (max_capacity tak diisi) tak berubah tingkah laku.
        mc = info.get("max_capacity")
        if mc is None:
            max_capacity = capacity
            unlimited = False
        else:
            max_capacity = int(mc)
            unlimited = (max_capacity == 0)

        mg  = int(sel.get("main_guests", 0))
        eb  = int(sel.get("extra_beds", 0))
        inf = int(sel.get("infants", 0))

        # Label ikut model: cruise=slot (Main Guest/Extra Bed), non-cruise=
        # umur (Adult/Children). Mesej ralat dipaparkan ke customer — kena
        # sepadan dengan label yang nampak di wizard.
        adult_lbl = "Main Guest" if is_cruise else "Adult"
        child_lbl = "Extra Bed"  if is_cruise else "Children"

        # main_guests (Adult): minimum 1 sentiasa (kedua-dua model).
        if mg < 1:
            frappe.throw(adult_lbl + " for " + str(room_category) + " must be at least 1.")

        if is_cruise:
            # Model SLOT: extra_bed (upper berth) hanya sah bila main_guest
            # penuh capacity dulu. max_infant DINAMIK (maxCapacity - mg - eb).
            if unlimited:
                max_extra = max_infant = None
            else:
                max_extra  = max(0, max_capacity - capacity)
                max_infant = max(0, max_capacity - mg - eb)
            if capacity > 0 and mg > capacity:
                frappe.throw(adult_lbl + " for " + str(room_category) + " must be between 1 and " + str(capacity) + ".")
            if eb > 0 and capacity > 0 and mg != capacity:
                frappe.throw(child_lbl + " is only allowed when " + adult_lbl + " is full (" + str(capacity) + ") for " + str(room_category) + ".")
            if max_extra is not None and eb > max_extra:
                frappe.throw(child_lbl + " for " + str(room_category) + " exceeds the limit (" + str(max_extra) + ").")
        else:
            # Model UMUR: children dibenarkan bila-bila sehingga
            # (max_capacity - adult). TIADA syarat "adult penuh dulu".
            if unlimited:
                max_children = max_infant = None
            else:
                max_children = max(0, max_capacity - mg)
                max_infant   = max(0, max_capacity - mg - eb)
            if max_children is not None and eb > max_children:
                frappe.throw(child_lbl + " for " + str(room_category) + " exceeds the limit (" + str(max_children) + ").")

        if inf > 0 and mg < 1:
            frappe.throw("Infant is only allowed when " + adult_lbl + " is at least 1 for " + str(room_category) + ".")
        if max_infant is not None and inf > max_infant:
            frappe.throw("Infant for " + str(room_category) + " exceeds the limit (" + str(max_infant) + ").")


# ── ITEMIZED GUESTS (Stage 1 wizard) ──────────────────────────────────────
# Kategori umur sah yang diterima daripada wizard itemized guests.
# "toddler" DIKECUALIKAN buat sekarang — lajur price_toddler belum
# beroperasi (menunggu keputusan harga Fasa B); kontrak ditutup rapat
# supaya payload tak boleh memintas dengan kategori tanpa harga.
_GUEST_CATEGORIES = ("adult", "child", "infant")
_GUEST_SLOTS = ("main", "extra_bed", "infant")


def _validate_guest_list(selections, is_cruise=True):
    """Sahkan medan additive 'guests' (itemized per-guest) pada setiap
    selection — WAJIB konsisten dengan kaunter agregat yang menjadi asas
    harga/kapasiti. Payload TANPA 'guests' (klien lama / panggilan API
    langsung) terus sah — itemization bersifat optional.

    Bentuk: guests: [{slot: "main"|"extra_bed"|"infant",
                      category: "adult"|"child"|"infant"}]

    Cruise (model SLOT): slot diwajibkan — bilangan setiap slot mesti
      sepadan kaunter (main=main_guests, extra_bed=extra_beds,
      infant=infants). Guest PERTAMA mesti slot main + category adult
      (lead guest — selari peraturan wizard di mana Guest 1 dikunci).
    Non-cruise (model UMUR): slot optional (diderive daripada kategori:
      adult->main, child->extra_bed, infant->infant); bilangan kategori
      mesti sepadan kaunter (adult=main_guests, child=extra_beds,
      infant=infants). Guest pertama mesti adult.
    """
    for sel in selections or []:
        if not isinstance(sel, dict):
            frappe.throw("Invalid selection entry.")
        guests = sel.get("guests")
        if guests in (None, []):
            continue  # klien lama — kaunter agregat sahaja, terus sah
        if not isinstance(guests, list):
            frappe.throw("'guests' must be a list for room " + str(sel.get("room_category")) + ".")

        mg  = int(sel.get("main_guests", 0) or 0)
        eb  = int(sel.get("extra_beds", 0) or 0)
        inf = int(sel.get("infants", 0) or 0)
        if len(guests) != mg + eb + inf:
            frappe.throw(
                "Guest list does not match the number of passengers for "
                + str(sel.get("room_category")) + "."
            )

        cats, slots = [], []
        for g in guests:
            if not isinstance(g, dict):
                frappe.throw("Invalid guest entry for " + str(sel.get("room_category")) + ".")
            cat = (g.get("category") or "").strip().lower()
            if cat not in _GUEST_CATEGORIES:
                frappe.throw(
                    "Invalid age category '" + str(cat) + "' for "
                    + str(sel.get("room_category")) + "."
                )
            slot = (g.get("slot") or "").strip().lower()
            if slot:
                if slot not in _GUEST_SLOTS:
                    frappe.throw(
                        "Invalid guest slot '" + str(slot) + "' for "
                        + str(sel.get("room_category")) + "."
                    )
            elif is_cruise:
                frappe.throw("Guest slot is required for cruise rooms.")
            else:
                # Non-cruise: wizard tak hantar slot — derive daripada
                # kategori (pemetaan payload agregat sedia ada).
                slot = {"adult": "main", "child": "extra_bed", "infant": "infant"}[cat]
            cats.append(cat)
            slots.append(slot)

        if is_cruise:
            if (slots.count("main"), slots.count("extra_bed"), slots.count("infant")) != (mg, eb, inf):
                frappe.throw(
                    "Guest slots do not match the passenger counts for "
                    + str(sel.get("room_category")) + "."
                )
        else:
            if (cats.count("adult"), cats.count("child"), cats.count("infant")) != (mg, eb, inf):
                frappe.throw(
                    "Guest age categories do not match the passenger counts for "
                    + str(sel.get("room_category")) + "."
                )
            # Slot (jika dihantar) mesti sepadan kategori — elak konflik
            # antara dua perwakilan pada model umur.
            derived = {"adult": "main", "child": "extra_bed", "infant": "infant"}
            for cat, slot in zip(cats, slots):
                if slot != derived[cat]:
                    frappe.throw(
                        "Guest slot does not match the age category for "
                        + str(sel.get("room_category")) + "."
                    )

        # Lead guest: wajib adult (cruise: juga slot main berth) — selari
        # UI wizard di mana Guest 1 dikunci sebagai adult main berth.
        if cats[0] != "adult" or (is_cruise and slots[0] != "main"):
            frappe.throw(
                "The first guest must be an adult"
                + (" main berth guest" if is_cruise else "")
                + " for " + str(sel.get("room_category")) + "."
            )


# DEPRECATED: Diagnostic test endpoint — should not be in production
@frappe.whitelist(allow_guest=True)
def test_endpoint():
	"""DEPRECATED: Remove in next version. For diagnostics only."""
	import warnings
	warnings.warn("test_endpoint is deprecated", DeprecationWarning, stacklevel=2)
	return {"test": "hello", "list": [1, 2, 3]}


@frappe.whitelist(allow_guest=True)
def get_price_category_config(trip_type: str = "non_cruise"):
    """
    Return active price category labels untuk trip type tertentu.
    Configurable dalam Travel Settings > Price Category Labels.
    Fallback ke defaults kalau setting kosong atau error.
    """
    # Normalize (hyphen/underscore/space seragam) — selari dengan
    # price_config._norm_trip_type supaya kedua endpoint konsisten.
    from travel_booking.api.price_config import _norm_trip_type
    trip_type = _norm_trip_type(trip_type or "non_cruise")
    
    # Default labels (fallback)
    if trip_type == "cruise":
        defaults = [
            {"price_key": "price_adult", "display_label": "Main Adult", "display_note": "Main Guest must be adult at 12+ years old and above.", "sort_order": 0},
            {"price_key": "price_upperberth", "display_label": "Extra Bed", "display_note": "Extra bed such as sofa bed or upper-berth configuration.", "sort_order": 1},
            {"price_key": "price_infant", "display_label": "Infant", "display_note": "Valid for 0-23 month on embarkation date.", "sort_order": 2},
        ]
    else:
        defaults = [
            {"price_key": "price_adult", "display_label": "Adult", "display_note": "12 years old and above.", "sort_order": 0},
            {"price_key": "price_children", "display_label": "Children", "display_note": "2-11 years old on departure date.", "sort_order": 1},
            {"price_key": "price_infant", "display_label": "Infant", "display_note": "Valid for 0-23 month on embarkation date.", "sort_order": 2},
        ]
    
    # Cuba baca dari Travel Settings
    try:
        settings = frappe.get_doc("Travel Settings", "Travel Settings")
        result = []
        for row in (settings.price_category_labels or []):
            active = row.get("is_active") if hasattr(row, "get") else row.is_active
            if not active:
                continue
            applies = _norm_trip_type(row.get("applies_to") or getattr(row, "applies_to", ""))
            if applies not in (trip_type, "both"):
                continue
            result.append({
                "price_key": str(row.get("price_key") or getattr(row, "price_key", "")),
                "display_label": str(row.get("display_label") or getattr(row, "display_label", "")),
                "display_note": str(row.get("display_note") or getattr(row, "display_note", "")),
                "sort_order": int(row.get("sort_order") or getattr(row, "sort_order", 0) or 0),
            })
        if result:
            result.sort(key=lambda x: x.get("sort_order", 0))
            return result
    except Exception:
        pass
    
    return defaults


@frappe.whitelist(allow_guest=True)
def search_packages_by_date(start_date: str, end_date: str, trip: str = None):
    """Cari packages berdasarkan sailing/departure dates.

    Query guna sailing_start:sailing_end (cruise) atau
    departure_date:return_date (non-cruise). Dipanggil oleh
    trip_detail.js bila user pilih tarikh — bukan pre-loaded.
    Filter `trip` (Trip doctype name) hadkan carian kepada trip yang aktif sahaja.

    Currency listing (paksi multi-company — rantaian sama dengan page
    katalog): hanya pakej Active dalam currency terpilih dipulangkan.
    Fallback: bila tiada pakej currency itu pada tarikh tersebut, SEMUA
    pakej native dipulangkan (elak tarikh mati di page detail).
    """
    if not start_date or not end_date:
        return []

    from travel_booking.www.trips import _get_currency_filter
    currency = _get_currency_filter()

    params = {"start": start_date, "end": end_date, "trip": trip, "currency": currency}
    trip_clause = "AND tgd.trip = %(trip)s" if trip else ""
    currency_clause = "AND tp.currency = %(currency)s"

    packages = frappe.db.sql(
        """
        SELECT tp.name AS trip_package, sel.trip_group_date AS group_date,
               tp.package_title, tp.package_type, tp.airport_form,
               ap.airport_name, tp.currency, cur.symbol AS currency_symbol,
               tgd.departure_date, tgd.return_date, tgd.sailing_start, tgd.sailing_end,
               tgd.total_days, tgd.total_nights, tgd.is_cruise_only
        FROM `tabTrip Package` AS tp
        JOIN `tabTrip Package Group Date Select` AS sel ON sel.parent = tp.name
        JOIN `tabTrip Group Date` AS tgd ON tgd.name = sel.trip_group_date
        LEFT JOIN `tabFlight Airport` ap ON ap.name = tp.airport_form
        LEFT JOIN `tabCurrency` cur ON cur.name = tp.currency
        WHERE tp.status = 'Active'
          {trip_clause}
          {currency_clause}
          AND (
            (tgd.sailing_start = %(start)s AND tgd.sailing_end = %(end)s)
            OR
            (tgd.departure_date = %(start)s AND tgd.return_date = %(end)s)
          )
        ORDER BY tp.package_type ASC, tp.package_title ASC
        LIMIT 100
        """.format(trip_clause=trip_clause, currency_clause=currency_clause),
        params,
        as_dict=True,
    )

    # Fallback native: trip ni tiada pakej dalam currency pilihan pada
    # tarikh tersebut — pulangkan semua pakej (currency native pakej,
    # wizard tetap caj dalam currency native).
    if not packages:
        packages = frappe.db.sql(
            """
            SELECT tp.name AS trip_package, sel.trip_group_date AS group_date,
                   tp.package_title, tp.package_type, tp.airport_form,
                   ap.airport_name, tp.currency, cur.symbol AS currency_symbol,
                   tgd.departure_date, tgd.return_date, tgd.sailing_start, tgd.sailing_end,
                   tgd.total_days, tgd.total_nights, tgd.is_cruise_only
            FROM `tabTrip Package` AS tp
            JOIN `tabTrip Package Group Date Select` AS sel ON sel.parent = tp.name
            JOIN `tabTrip Group Date` AS tgd ON tgd.name = sel.trip_group_date
            LEFT JOIN `tabFlight Airport` ap ON ap.name = tp.airport_form
            LEFT JOIN `tabCurrency` cur ON cur.name = tp.currency
            WHERE tp.status = 'Active'
              {trip_clause}
              AND (
                (tgd.sailing_start = %(start)s AND tgd.sailing_end = %(end)s)
                OR
                (tgd.departure_date = %(start)s AND tgd.return_date = %(end)s)
              )
            ORDER BY tp.package_type ASC, tp.package_title ASC
            LIMIT 100
            """.format(trip_clause=trip_clause),
            params,
            as_dict=True,
        )

    result = []
    for p in packages:
        flight_label = (p.airport_name or p.airport_form) if p.airport_form else "No Flight"
        result.append({
            "name": p.trip_package,
            "trip_group_date": p.group_date,
            "package_name": p.package_title or "",
            "package_type": p.package_type or "",
            "flight": p.airport_form or "",
            "flight_label": flight_label,
            "currency": p.currency or "MYR",
            "currency_symbol": p.currency_symbol or (p.currency or "MYR"),
            "departure_date": str(p.departure_date) if p.departure_date else "",
            "return_date": str(p.return_date) if p.return_date else "",
            "sailing_start": str(p.sailing_start) if p.sailing_start else "",
            "sailing_end": str(p.sailing_end) if p.sailing_end else "",
            "total_days": p.total_days,
            "total_nights": p.total_nights,
            "is_cruise_only": bool(p.is_cruise_only),
        })
    return result


@frappe.whitelist(allow_guest=True)
def share_trip_link(url: str):
    """Generate a QR code for a trip share URL.

    No shortening — the full URL is used directly. Returns a base64 PNG
    data URI that the client can display in an <img> tag.

    Returns:
        qr_data_uri: base64 PNG data URI of the QR code
        share_url: the original URL (unchanged)
    """
    import io
    import base64
    import qrcode

    url = (url or "").strip()
    if not url:
        frappe.throw("URL is required.")

    qr = qrcode.QRCode(
        version=1, box_size=10, border=2,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
    )
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    qr_data_uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

    return {
        "share_url": url,
        "qr_data_uri": qr_data_uri,
    }
