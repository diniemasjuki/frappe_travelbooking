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
from travel_booking.api.constants import MAX_CABINS_PER_BOOKING
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


@frappe.whitelist(allow_guest=True)
def get_booking_details(trip_group_date: str, trip_package: str = None):
    """Return trip + sailing info + cabin categories with pricing.
    Pricing dibaca dari Trip Package Price (child Trip Package), setiap
    row berkait dengan satu Trip Price Category (kategori bilik/kabin).
    Room Availability dibuang — inventori bilik diurus manual oleh admin.
    """
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
        ["name", "trip_name", "description", "is_a_cruise_trip"],
        as_dict=True
    )
    if not trip:
        frappe.throw("Trip not found.")

    # Pricing rows dari Trip Package Price (child Trip Package), JOIN
    # Trip Price Category untuk dapatkan maklumat kategori bilik/kabin.
    pricing_rows = frappe.db.sql("""
        SELECT
            tpp.pricing_for_class AS room_category,
            tpc.category_name,
            tpc.room_type,
            tpc.capacity,
            tpc.max_capacity,
            tpc.description,
            tpc.room_profile,
            tpc.read_more_url,
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

    cabins = []
    for row in pricing_rows:
        # Room Availability doctype dibuang — semua kategori dianggap available.
        # Kawalan bilik sebenar diurus admin (order batch dari Aroya).
        available = 1

        cabins.append({
            "room_category": row.room_category,
            "room_name":     row.category_name or row.room_category,
            "room_type":     row.room_type,
            "capacity":      row.capacity or 2,
            # max_capacity == 0 eksplisit -> UNLIMITED (jangan fallback ke
            # capacity). None/kosong -> fallback capacity (behavior sedia).
            "max_capacity":  row.max_capacity if row.max_capacity is not None else (row.capacity or 2),
            "description":   row.description or "",
            "room_image":    row.room_profile or "",
            "read_more_url": row.read_more_url or "",
            "pricing": {
                "price_adult_single":     float(row.price_adult_single     or 0),
                "price_adult":            float(row.price_adult           or 0),
                "price_upperberth": float(row.price_upperberth or 0),
                "price_children":         float(row.price_children        or 0),
                "price_infant":           float(row.price_infant          or 0),
            },
            "available":    available,
            "is_available": available > 0,
        })


    return {
        "trip": {
            "name":             trip.name,
            "trip_name":        trip.trip_name,
            "description":      trip.description or "",
            "is_a_cruise_trip": bool(trip.is_a_cruise_trip),
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
    """Senarai currency yang boleh dipaparkan di converter frontend.

    Kriteria (pilihan user "Semua Currency dengan rate"): setiap currency
    AKTIF (enabled=1) yang ada sekurang-kurangnya satu rekod Currency
    Exchange melibatkan company currency (jadi rate boleh diresolve).
    Company currency sentiasa dihadapan (rate=1, identiti).
    Pulangkan [{code, symbol, name, is_company}].
    """
    company_currency = get_company_currency()

    rows = frappe.db.sql(
        """
        SELECT DISTINCT c.name AS code, c.currency_name AS name,
                        c.symbol
        FROM `tabCurrency` c
        WHERE c.enabled = 1
          AND c.name = %s
           OR (
                c.enabled = 1
                AND c.name IN (
                    SELECT from_currency FROM `tabCurrency Exchange`
                    WHERE to_currency = %s AND docstatus != 2
                    UNION
                    SELECT to_currency FROM `tabCurrency Exchange`
                    WHERE from_currency = %s AND docstatus != 2
                )
           )
        """,
        (company_currency, company_currency, company_currency),
        as_dict=True,
    )

    out = []
    seen = set()
    # Company currency first.
    out.append({
        "code": company_currency,
        "symbol": _currency_symbol(company_currency),
        "name": frappe.db.get_value("Currency", company_currency, "currency_name")
        or company_currency,
        "is_company": True,
    })
    seen.add(company_currency)
    for r in rows:
        if r.code in seen:
            continue
        out.append({
            "code": r.code,
            "symbol": r.symbol or r.code,
            "name": r.name or r.code,
            "is_company": False,
        })
        seen.add(r.code)
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
    if len(selections) > MAX_CABINS_PER_BOOKING:
        frappe.throw(
            "Maximum " + str(MAX_CABINS_PER_BOOKING) +
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



# DEPRECATED: Diagnostic test endpoint — should not be in production
@frappe.whitelist(allow_guest=True)
def test_endpoint():
	"""DEPRECATED: Remove in next version. For diagnostics only."""
	import warnings
	warnings.warn("test_endpoint is deprecated", DeprecationWarning, stacklevel=2)
	return {"test": "hello", "list": [1, 2, 3]}


@frappe.whitelist(allow_guest=True)
def get_price_category_config(trip_type="non_cruise"):
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
    """
    if not start_date or not end_date:
        return []

    params = {"start": start_date, "end": end_date, "trip": trip}
    trip_clause = "AND tgd.trip = %(trip)s" if trip else ""

    packages = frappe.db.sql(
        """
        SELECT tp.name AS trip_package, sel.trip_group_date AS group_date,
               tp.package_title, tp.package_type, tp.airport_form,
               ap.airport_name, tp.currency, cur.symbol AS currency_symbol
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
