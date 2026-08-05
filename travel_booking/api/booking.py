# travel_booking/api/booking.py
# Booking Wizard API — Public Landing Page
# ─────────────────────────────────────────

import frappe
import json
import random
import string

from travel_booking.api._helpers import get_customer_by_email, get_customer_email, get_customer_phone


# ══════════════════════════════════════════════
# 0. GET PAYMENT SETTINGS (Bank Account + Cashback)
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def get_payment_settings():
    """Bank account & cashback info untuk papar di booking.html —
    ganti nilai hardcoded (Maybank / 5% cashback) dengan Travel Settings.

    PENTING: guna getattr() (bukan attribute access terus) untuk field
    yang mungkin dah dibuang/diubah struktur di doctype (cth support_email/
    support_phone dibuang dalam kemas kini terkini) — elak AttributeError
    yang boleh crash endpoint ni sepenuhnya untuk customer.
    """
    settings = frappe.get_cached_doc("Travel Settings")

    # bank_name sekarang Link ke "Bank Account" (bukan teks Data terus) —
    # cuba resolve nama bank SEBENAR untuk paparan (cth "Maybank"), fallback
    # ke nilai mentah (docname Bank Account) kalau gagal, supaya tetap ada
    # sesuatu dipaparkan (bukan kosong/error) walau struktur berubah lagi
    # di masa depan.
    bank_display_name = getattr(settings, "bank_name", "") or ""
    if bank_display_name:
        try:
            resolved = frappe.db.get_value("Bank Account", bank_display_name, "bank")
            if resolved:
                bank_display_name = resolved
        except Exception:
            pass

    return {
        "bank_name":                        bank_display_name,
        "account_name":                     getattr(settings, "account_name", "") or "",
        "account_number":                   getattr(settings, "account_number", "") or "",
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
    """
    booking = frappe.db.sql("""
        SELECT
            b.name, b.booking_number, b.status,
            tm.trip_name, td.trip_group_name, td.departure_date, td.return_date
        FROM `tabBooking` b
        LEFT JOIN `tabTrip Group Date`   td ON td.name = b.trip_date
        LEFT JOIN `tabTrip` tm ON tm.name = td.trip
        WHERE b.booking_number = %s
    """, booking_number, as_dict=True)

    if not booking:
        frappe.throw("Booking tidak ditemui.")
    booking = booking[0]

    primary_so = _get_primary_so(booking.name)

    if pr:
        pr_so = frappe.db.get_value("Payment Request", pr, "reference_name")
        if pr_so and pr_so != primary_so:
            frappe.throw("Rujukan tidak sah.", frappe.PermissionError)

    # NOTA: "Disable Rounded Total" kini global (Selling Settings) — semua
    # SO (wizard/addon) tak lagi guna rounded_total, standardize ke
    # grand_total sahaja merentasi app (rujuk juga nota di confirm_booking()).
    grand_total = 0
    advance_paid = 0
    if primary_so:
        so = frappe.db.get_value("Sales Order", primary_so,
                                 ["grand_total", "advance_paid"], as_dict=True)
        if so:
            grand_total  = float(so.grand_total or 0)
            advance_paid = float(so.advance_paid or 0)

    return {
        "booking_number":  booking.booking_number,
        "booking_status":  booking.status,
        "trip_name":       booking.trip_name or "",
        "group_name":      booking.trip_group_name or "",
        "departure_date":  str(booking.departure_date) if booking.departure_date else "",
        "return_date":     str(booking.return_date) if booking.return_date else "",
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
        frappe.throw("Trip Group Date tidak ditemui.")

    trip = frappe.db.get_value(
        "Trip", td.trip,
        ["name", "trip_name", "description", "is_a_cruise_trip"],
        as_dict=True
    )
    if not trip:
        frappe.throw("Trip tidak ditemui.")

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
            tpp.price_adult_single,
            tpp.price_adult,
            tpp.price_upperberth,
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
            "max_capacity":  row.max_capacity or row.capacity or 2,
            "description":   row.description or "",
            "room_image":    row.room_profile or "",
            "pricing": {
                "price_adult_single":     float(row.price_adult_single     or 0),
                "price_adult":            float(row.price_adult           or 0),
                "price_upperberth": float(row.price_upperberth or 0),
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
# 2. SEND OTP
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True, methods=["POST"])
def send_otp(email: str):
    email = (email or "").strip().lower()
    if not email:
        frappe.throw("Sila masukkan alamat email.")

    # ── Rate limiting IKUT IP — WAJIB berlaku SEBELUM sebarang cawangan
    # logik lain (termasuk check existing customer di bawah). ──
    #
    # PENTING (perlanggaran keselamatan yang dibetulkan di sini): endpoint
    # ni allow_guest=True (sesiapa, tanpa login, boleh panggil). Cawangan
    # "email existing" (return verified:True) di bawah SEBELUM ni langsung
    # TIADA had kadar — sesiapa boleh cuba beribu-ribu alamat email sesaat
    # dan sistem akan DEDAHKAN sama ada setiap satu tu customer sedia ada
    # RareCruise atau tidak (melalui verified:true vs verified:false). Ini
    # "email enumeration" — bocor senarai pelanggan sistem kepada
    # sesiapa sahaja tanpa had. Had kadar sebelum ni (cooldown/hourly)
    # cuma terpakai untuk cawangan "email baru" (hantar OTP sebenar),
    # BUKAN untuk cawangan existing-customer yang justeru paling mudah
    # disalah guna untuk scraping (tiada kos hantar emel pun). Kita had
    # di peringkat IP di SINI — sebelum cawangan mana-mana — supaya
    # kedua-dua cawangan terhad kadar yang sama.
    #
    # Had digenerus (30/minit) berbanding had per-email (5/jam) sebab
    # tujuannya lain: ni untuk block scraping pukal pantas dari SATU IP
    # merentasi BANYAK email, bukan untuk had customer tunggal minta OTP
    # berulang (yang dah diuruskan cooldown_key/hourly_key di bawah).
    client_ip = frappe.local.request_ip or "unknown"
    ip_rate_key = "send_otp_ip_" + client_ip
    ip_count = frappe.cache().get_value(ip_rate_key)
    if ip_count and int(ip_count) >= 30:
        frappe.throw("Terlalu banyak permintaan. Sila cuba lagi sebentar.")
    frappe.cache().set_value(ip_rate_key, str(int(ip_count or 0) + 1), expires_in_sec=60)

    # PENTING: check kewujudan "User" (akaun portal login), BUKAN
    # "Customer" (rekod pelanggan ERPNext). Docname User = alamat email
    # (rujuk _ensure_portal_user() di bawah, yang cipta User dengan
    # docname = email semasa booking pertama). User wujud = signal yang
    # LEBIH TEPAT untuk "orang ni dah pernah verify emel & ada akses
    # portal" berbanding sekadar Customer wujud — sebab Customer BOLEH
    # dicipta tanpa emel pernah disahkan langsung (cth admin cipta
    # Customer terus di Desk, atau import data pukal) — kes tu Customer
    # wujud tapi orang tu tak pernah verify email ni sendiri, jadi tak
    # patut skip OTP.
    if frappe.db.exists("User", email):
        # Ambil nama & phone customer SEDIA ADA supaya frontend boleh
        # auto-fill + lock field Full Name/Phone Number sekali (bukan
        # cuma email) — elak customer perlu taip semula maklumat yang
        # sistem SEBENARNYA dah ada untuk mereka.
        full_name = ""
        phone     = ""
        customer_name = get_customer_by_email(email)
        if customer_name:
            full_name = frappe.db.get_value("Customer", customer_name, "customer_name") or ""
            phone     = get_customer_phone(customer_name) or ""
        return {
            "verified":  True,
            "message":   "Email disahkan.",
            "full_name": full_name,
            "phone":     phone,
        }

    # ── Rate limiting — elak spam/abuse hantar OTP berulang-ulang ──
    # Lapisan 1: cooldown 60 saat antara setiap request (elak klik
    # "Resend" berturut-turut serta-merta).
    cooldown_key = "booking_otp_cooldown_" + email
    if frappe.cache().get_value(cooldown_key):
        frappe.throw("Sila tunggu sebentar sebelum minta OTP sekali lagi.")

    # Lapisan 2: had maksimum 5 request sejam per email. Simpan timestamp
    # permintaan PERTAMA dalam tetingkap semasa (bukan cuma counter) —
    # setiap kali cache di-set semula, expires_in_sec dikira SECARA EKSPLISIT
    # sebagai baki tetingkap 1 jam dari masa PERTAMA tu. Ini elak
    # pergantungan pada tingkah laku "adakah TTL sedia ada dikekalkan bila
    # expires_in_sec tak diberi" — sesuatu yang tak jelas didokumenkan dan
    # berisiko (Redis punya SET biasa buang TTL sedia ada secara default).
    hourly_key  = "booking_otp_hourly_" + email
    hourly_data = frappe.cache().get_value(hourly_key)
    now_ts = frappe.utils.now_datetime().timestamp()
    if hourly_data:
        first_ts, count = hourly_data.split("|")
        first_ts, count = float(first_ts), int(count)
        remaining = 3600 - (now_ts - first_ts)
        if remaining <= 0:
            # Tetingkap 1 jam dah tamat — mula semula dari permintaan ni.
            first_ts, count, remaining = now_ts, 0, 3600
        elif count >= 5:
            frappe.throw("Terlalu banyak permintaan OTP untuk email ini. Sila cuba lagi selepas 1 jam.")
    else:
        first_ts, count, remaining = now_ts, 0, 3600

    settings = frappe.get_cached_doc("Travel Settings")
    otp_expiry_minutes = int(settings.otp_expiry_minutes or 10)

    otp = ''.join(random.choices(string.digits, k=6))
    frappe.cache().set_value("booking_otp_" + email, otp,
                             expires_in_sec=otp_expiry_minutes * 60)

    try:
        frappe.sendmail(
            recipients=[email],
            # Sender TIDAK di-hardcode — biar Frappe guna default Outgoing
            # Email Account (Settings > Email Account) macam function email
            # lain dalam app ni. Hardcode domain lain dari domain sebenar
            # site punca email silently gagal/masuk spam (SPF/DKIM mismatch).
            subject="Rarecation Booking — Kod Pengesahan",
            message="""
            <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
                <h2 style="color: #B8860B;">Kod Pengesahan Booking</h2>
                <p>Gunakan kod berikut untuk mengesahkan email anda:</p>
                <div style="font-size: 36px; font-weight: bold; letter-spacing: 8px;
                            color: #B8860B; margin: 24px 0; text-align: center;">
                    """ + otp + """
                </div>
                <p style="color: #666;">Kod ini akan tamat dalam """ + str(otp_expiry_minutes) + """ minit.</p>
                <p style="color: #666; font-size: 12px;">
                    Jika anda tidak membuat permintaan ini, abaikan email ini.
                </p>
            </div>
            """,
            now=True
        )
    except Exception as e:
        # Buang OTP yang dah simpan supaya user tak reload dgn OTP "hantu"
        # yang tak pernah sampai ke inbox.
        frappe.cache().delete_value("booking_otp_" + email)
        frappe.log_error("OTP email failed: " + str(e), "Booking OTP Error")
        frappe.throw("Gagal menghantar OTP. Sila cuba lagi sebentar, atau hubungi kami.")

    # Emel berjaya dihantar — SEKARANG baru set cooldown & kemas kini counter
    # sejam (bukan sebelum sendmail), supaya kegagalan hantar emel tak
    # "gunakan" kuota rate-limit customer secara tak adil.
    frappe.cache().set_value(cooldown_key, "1", expires_in_sec=60)
    frappe.cache().set_value(hourly_key, str(first_ts) + "|" + str(count + 1),
                             expires_in_sec=int(remaining))

    return {"verified": False, "message": "OTP dihantar ke email anda."}


# ══════════════════════════════════════════════
# 3. VERIFY OTP
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True, methods=["POST"])
def verify_otp(email: str, otp: str):
    email     = email.strip().lower()
    cache_key = "booking_otp_" + email
    stored    = frappe.cache().get_value(cache_key)

    if not stored:
        frappe.throw("OTP telah tamat tempoh. Sila minta semula.")
    if stored != otp.strip():
        frappe.throw("OTP tidak sah. Sila cuba semula.")

    settings = frappe.get_cached_doc("Travel Settings")
    session_minutes = int(settings.email_verified_session_minutes or 30)

    frappe.cache().delete_value(cache_key)
    frappe.cache().set_value(
        "booking_email_verified_" + email, True, expires_in_sec=session_minutes * 60
    )
    return {"success": True, "message": "Email berjaya disahkan."}


# ══════════════════════════════════════════════
# 5. VOUCHER VALIDATION
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def validate_voucher(code: str, trip_group_date: str, grand_total: float, email: str = "",
                     selections: str = "", trip_package: str = None):
    """Validate voucher + kira discount ikut scope (Voucher doctype terkini).

    PENTING — model diskaun: diskaun HANYA dikira dari subtotal cabin/room
    yang match scope voucher (applicable_trips/applicable_packages/
    applicable_room_categories), BUKAN dari grand_total keseluruhan. Kalau
    scope kosong (semua 3 field), voucher applicable untuk semua — diskaun
    dikira dari grand_total penuh.

    `selections` (JSON list per-cabin, sama struktur dengan confirm_booking)
    + `trip_package` diperlukan untuk kira subtotal ikut scope dengan tepat.
    Kalau tak dihantar (contoh preview awal sebelum room dipilih), kita
    fallback guna grand_total penuh sebagai anggaran.
    """
    code        = (code or "").strip().upper()
    grand_total = float(grand_total or 0)

    if not code:
        return {"valid": False, "message": "Please enter a voucher code."}

    voucher = frappe.db.get_value(
        "Voucher", {"voucher_code": code},
        ["name", "status", "discount_type", "discount_value",
         "valid_from", "valid_until", "max_usage", "max_usage_per_customer"],
        as_dict=True
    )

    if not voucher:
        return {"valid": False, "message": "Invalid voucher code."}
    if voucher.status != "Active":
        return {"valid": False, "message": "This voucher is no longer active."}

    today = frappe.utils.getdate()
    if voucher.valid_from and frappe.utils.getdate(voucher.valid_from) > today:
        return {"valid": False, "message": "This voucher is not yet valid."}
    if voucher.valid_until and frappe.utils.getdate(voucher.valid_until) < today:
        return {"valid": False, "message": "This voucher has expired."}

    # Usage count dikira LIVE dari doctype standalone 'Voucher Usage'
    # (bukan child table lagi — rujuk field 'voucher' Link, bukan 'parent').
    usage_count = frappe.db.count("Voucher Usage", {"voucher": voucher.name})
    if voucher.max_usage and usage_count >= voucher.max_usage:
        return {"valid": False, "message": "This voucher has reached its maximum usage."}

    # Once per customer (ikut max_usage_per_customer, default 1 kalau tak diisi)
    customer = get_customer_by_email(email.strip().lower()) if email else None
    if customer and voucher.max_usage_per_customer:
        customer_usage = frappe.db.count(
            "Voucher Usage", {"voucher": voucher.name, "customer": customer}
        )
        if customer_usage >= voucher.max_usage_per_customer:
            return {"valid": False, "message": "You have reached the usage limit for this voucher."}

    # Scope: kosong semua 3 = applicable untuk semua trip/package/room.
    scope_trips      = [r.trip          for r in frappe.get_all("Voucher Applicable Trip",          filters={"parent": voucher.name}, fields=["trip"])]
    scope_packages   = [r.trip_package  for r in frappe.get_all("Voucher Applicable Package",        filters={"parent": voucher.name}, fields=["trip_package"])]
    scope_categories = [r.room_category for r in frappe.get_all("Voucher Applicable Room Category",  filters={"parent": voucher.name}, fields=["room_category"])]
    has_scope = bool(scope_trips or scope_packages or scope_categories)

    if not has_scope:
        # Tiada scope — diskaun dikira dari grand_total penuh.
        eligible_amount = grand_total
    else:
        # Ada scope — perlu selections + trip_package untuk kira subtotal
        # cabin yang match sahaja.
        if isinstance(selections, str) and selections:
            selections = json.loads(selections)
        if not selections or not trip_package:
            # Tiada breakdown cabin dihantar — tak boleh kira scope dengan
            # tepat. Anggap TIDAK eligible (selamat: elak over-discount).
            return {"valid": False, "message": "Please select your rooms before applying this voucher."}

        trip_of_package = frappe.db.get_value("Trip Package", trip_package, "trip_link")
        package_ok = (not scope_packages) or (trip_package in scope_packages)
        trip_ok    = (not scope_trips)    or (trip_of_package in scope_trips)

        if not (package_ok and trip_ok):
            return {"valid": False, "message": "This voucher is not valid for this trip or package."}

        pricing_map = _get_pricing_map(trip_package)
        eligible_amount = 0.0
        for sel in selections:
            room_category = sel.get("room_category")
            if scope_categories and room_category not in scope_categories:
                continue  # cabin ni tak match scope room category — skip
            price = pricing_map.get(room_category)
            if not price:
                continue
            eligible_amount += _price_selection(
                price,
                int(sel.get("main_guests", 0)),
                int(sel.get("extra_beds", 0)),
                int(sel.get("infants", 0)),
            )

        if eligible_amount <= 0:
            return {"valid": False, "message": "None of your selected rooms are eligible for this voucher."}

    if voucher.discount_type == "Percentage":
        discount_amount = round(eligible_amount * (float(voucher.discount_value) / 100), 2)
    else:
        discount_amount = min(float(voucher.discount_value), eligible_amount)

    return {
        "valid":           True,
        "discount_amount": discount_amount,
        "discount_type":   voucher.discount_type,
        "discount_value":  voucher.discount_value,
        "eligible_amount": eligible_amount,
        "message":         "Voucher applied! You save " + fmt_currency(discount_amount) + ".",
    }


def fmt_currency(amount):
    return "RM {:,.2f}".format(float(amount))


# ══════════════════════════════════════════════
# 5b. REFERRAL / AFFILIATE CODE VALIDATION
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def validate_affiliate_code(code: str, trip_group_date: str = None):
    """Validate referral/affiliate code. Discount % kepada CUSTOMER tetap
    sama untuk semua trip — diambil dari
    Travel Settings.default_referral_discount_percent (bukan dari commission
    rate affiliate, yang merupakan konsep berasingan diurus oleh app
    'affiliate').

    Referral code disimpan pada Sales Partner.referral_code (field native
    ERPNext) — bukan doctype 'Affliate' yang tak wujud. Setiap Sales Partner
    yang dicipta oleh app 'affiliate' link balik ke satu Affiliate Profile;
    kita pastikan affiliate tu 'Verified' sebelum terima kod dia.
    """
    code = (code or "").strip().upper()
    if not code:
        return {"valid": False, "message": "Please enter a referral code."}

    sales_partner = frappe.db.get_value(
        "Sales Partner", {"referral_code": code},
        ["name", "partner_name"], as_dict=True
    )
    if not sales_partner:
        return {"valid": False, "message": "Invalid referral code."}

    affiliate_status = frappe.db.get_value(
        "Affiliate Profile", {"sales_partner": sales_partner.name}, "status"
    )
    if affiliate_status and affiliate_status != "Verified":
        return {"valid": False, "message": "This referral code is no longer active."}

    settings = frappe.get_cached_doc("Travel Settings")
    discount_percent = float(settings.default_referral_discount_percent or 0)

    # PENTING: kod referral tetap SAH (sales_partner tetap dipulangkan untuk
    # attribution/commission affiliate) walaupun discount_percent = 0 (belum
    # dikonfigurasikan admin di Travel Settings) — customer sekadar TAK
    # dapat extra discount, tapi affiliate TETAP patut dapat commission
    # bila SO/SI dibayar penuh (diuruskan app 'affiliate', konsep
    # berasingan sepenuhnya dari discount customer ni). Sebelum ni,
    # discount_percent<=0 pulangkan valid:False sepenuhnya — ini secara
    # tak sengaja putuskan attribution affiliate JUGA (bukan cuma sekat
    # discount), memandangkan confirm_booking() hanya set sales_partner
    # bila ar.get("valid") bernilai True.
    message = (
        "Referral code applied! You get " + str(discount_percent) + "% off."
        if discount_percent > 0
        else "Referral code applied!"
    )

    return {
        "valid":            True,
        "discount_percent": discount_percent,
        "affiliate_name":   sales_partner.partner_name,
        "sales_partner":    sales_partner.name,
        "message":          message,
    }


# ══════════════════════════════════════════════
# 6. PRICING — BACKEND CALCULATION
# ══════════════════════════════════════════════

def _get_pricing_map(trip_package):
    """Return {pricing_for_class: {...}} dari Trip Package Price (child
    Trip Package). Setiap row berkait dengan satu Trip Price Category
    (kategori bilik/kabin) melalui field 'pricing_for_class'.
    """
    rows = frappe.db.sql("""
        SELECT pricing_for_class AS room_category,
               price_adult_single, price_adult, price_upperberth,
               price_children, price_toddler, price_infant
        FROM `tabTrip Package Price`
        WHERE parent = %s AND parenttype = 'Trip Package'
    """, trip_package, as_dict=True)
    return {r.room_category: r for r in rows}


def _price_selection(price, main_guests, extra_beds, infants):
    """Kira harga satu selection — model SLOT (posisi dalam bilik), bukan
    kategori umur:
      - main_guests == 1  -> price_adult_single (satu org, single occupancy)
      - main_guests >= 2  -> price_adult x setiap org (twin/multi occupancy)
      - extra_beds        -> price_upperberth x setiap org, flat
                             (tak kira umur), hanya sah bila main_guests
                             sudah capai capacity (max) bilik tu
      - infants           -> price_infant x setiap org (harga SEBENAR dari
                             pakej, BUKAN percuma) — tak dikira dalam
                             capacity bilik (Main Guest + Extra Bed)
    """
    mg = int(main_guests or 0)
    eb = int(extra_beds  or 0)
    inf = int(infants    or 0)

    total = 0.0
    if mg == 1:
        total += float(price.price_adult_single or 0)
    elif mg >= 2:
        total += float(price.price_adult or 0) * mg

    total += float(price.price_upperberth or 0) * eb
    total += float(price.price_infant or 0) * inf
    return round(total, 2)


# Had maksimum cabin per booking — MESTI disegerakkan dengan
# MAX_CABINS_PER_BOOKING dalam booking.js (frontend) dan
# validate_cabin_capacity() dalam booking_reservation.py (admin manual
# di Desk), supaya konsisten merentasi ketiga-tiga laluan.
MAX_CABINS_PER_BOOKING = 8


def _validate_selection_capacity(selections, cabin_info_map):
    """Sahkan setiap selection ikut had SLOT (server-side) — jangan percaya
    client-side JS je, sebab payload boleh dimanipulasi.
      - main_guests: 1..capacity
      - extra_beds : 0..(max_capacity - capacity), hanya sah bila
                     main_guests == capacity (bilik penuh Main Guest dulu)
      - infants    : 0..(max_capacity - main_guests - extra_beds), hanya
                     sah bila main_guests >= 1. Had DINAMIK (bukan formula
                     tetap max_capacity//2) — sepadan tepat dengan capFor()
                     dalam booking.js (frontend).
    cabin_info_map: {room_category: {"capacity":.., "max_capacity":..}}
    """
    # PENTING: had maksimum cabin — check DULU sebelum apa-apa, sebab
    # 'selections' terus dari payload customer (boleh dimanipulasi walau
    # frontend dah disable butang "Add another room" bila cecah had).
    if len(selections) > MAX_CABINS_PER_BOOKING:
        frappe.throw(
            "Maksimum " + str(MAX_CABINS_PER_BOOKING) +
            " cabin dibenarkan untuk satu booking. Sila hubungi kami " +
            "terus untuk tempahan lebih besar."
        )

    for sel in selections:
        room_category = sel.get("room_category")
        info = cabin_info_map.get(room_category)
        if not info:
            frappe.throw("Kategori bilik tidak sah: " + str(room_category))

        capacity     = int(info.get("capacity") or 0)
        max_capacity = int(info.get("max_capacity") or capacity)
        max_extra    = max(0, max_capacity - capacity)

        mg  = int(sel.get("main_guests", 0))
        eb  = int(sel.get("extra_beds", 0))
        inf = int(sel.get("infants", 0))

        # max_infant DINAMIK — sama formula dengan capFor() frontend
        # (maxCapacity - main_guests - extra_beds). SEBELUM NI guna formula
        # TETAP (max_capacity // 2) yang tak ambil kira berapa ruang
        # main_guests/extra_beds DAH guna — boleh terlalu ketat (tolak
        # selection sah, cth Main Guest=1 patut boleh Infant=3 dalam cabin
        # 4-pax, tapi formula lama cap kat 2) atau dalam kes lain terlalu
        # longgar berbanding apa frontend sebenarnya benarkan.
        max_infant = max(0, max_capacity - mg - eb)

        if mg < 1 or mg > capacity:
            frappe.throw("Main Guest untuk " + str(room_category) + " mesti antara 1 dan " + str(capacity) + ".")
        if eb > 0 and mg != capacity:
            frappe.throw("Extra Bed hanya dibenarkan bila Main Guest sudah penuh (" + str(capacity) + ") untuk " + str(room_category) + ".")
        if eb > max_extra:
            frappe.throw("Extra Bed untuk " + str(room_category) + " melebihi had (" + str(max_extra) + ").")
        if inf > 0 and mg < 1:
            frappe.throw("Infant hanya dibenarkan bila Main Guest sekurang-kurangnya 1 untuk " + str(room_category) + ".")
        if inf > max_infant:
            frappe.throw("Infant untuk " + str(room_category) + " melebihi had (" + str(max_infant) + ").")


# ══════════════════════════════════════════════
# 7. CONFIRM BOOKING
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def confirm_booking(trip_group_date: str, selections: str, billing: str,
                    payment_type: str = "Full Payment", payment_method: str = "Online Payment",
                    receipt: str = None, voucher_code: str = "", affiliate_code: str = "", amount_paid: float = None,
                    trip_package: str = None, sales_persons: str = None, bank_transfer_ref: str = None):
    if isinstance(selections, str):
        selections = json.loads(selections)
    if isinstance(billing, str):
        billing = json.loads(billing)

    email = billing.get("email", "").strip().lower()
    bank_transfer_ref = (bank_transfer_ref or "").strip()

    if payment_method == "Manual Transfer" and not bank_transfer_ref:
        # Nombor rujukan transaksi DARI BANK CUSTOMER SENDIRI (bukan rujukan
        # booking kami) — perlu untuk admin padankan bayaran ni dengan
        # penyata bank semasa verify manual. Wajib diisi di frontend
        # (booking.html/js), tapi disahkan semula di sini supaya panggilan
        # terus ke API (skip frontend) tak boleh langkau keperluan ni.
        frappe.throw("Sila masukkan nombor rujukan transfer bank anda.")

    # PENTING: gate OTP ni MESTI konsisten dengan send_otp()'s logic
    # (check User/akaun portal, bukan Customer) — kalau tidak, boleh
    # berlaku kes frontend skip OTP (sebab send_otp() kata verified=True
    # ikut User wujud) tapi backend di sini masih throw sebab Customer
    # tak wujud (cth booking pertama customer tu, User belum dicipta lagi
    # tapi dia baru sahaja verify OTP dalam sesi ni — is_verified cache
    # akan cover kes tu). existing_customer (rekod Customer, kalau ada)
    # kekal diguna BERASINGAN semata-mata untuk elak cipta Customer
    # berganda — bukan untuk tentukan sama ada OTP diperlukan.
    is_verified       = frappe.cache().get_value("booking_email_verified_" + email)
    has_portal_user   = bool(frappe.db.exists("User", email))
    existing_customer = get_customer_by_email(email)

    if not has_portal_user and not is_verified:
        frappe.throw("Email belum disahkan. Sila verify OTP dahulu.")

    customer_name = existing_customer or _create_customer(billing)

    # Trip info
    td = frappe.db.get_value("Trip Group Date", trip_group_date,
                             ["trip", "trip_group_name", "departure_date"], as_dict=True)
    if not td:
        frappe.throw("Trip Group Date tidak ditemui.")
    trip_name = frappe.db.get_value("Trip", td.trip, "trip_name") or ""

    if not trip_package:
        frappe.throw("Sila pilih pakej terlebih dahulu.")

    # Backend pricing (dari Trip Package yang dipilih)
    pricing_map = _get_pricing_map(trip_package)

    # Sahkan had slot (Main Guest/Extra Bed/Infant) server-side sebelum kira
    # harga — cabin_info_map dari Trip Price Category (capacity/max_capacity).
    cabin_info_rows = frappe.db.sql("""
        SELECT tpp.pricing_for_class AS room_category,
               tpc.capacity, tpc.max_capacity
        FROM `tabTrip Package Price` tpp
        JOIN `tabTrip Price Category` tpc ON tpc.name = tpp.pricing_for_class
        WHERE tpp.parent = %s AND tpp.parenttype = 'Trip Package'
    """, trip_package, as_dict=True)
    cabin_info_map = {r.room_category: r for r in cabin_info_rows}
    _validate_selection_capacity(selections, cabin_info_map)

    so_items    = _build_so_items(selections, pricing_map, trip_name, td.trip_group_name)
    grand_total = sum(float(it["rate"]) * int(it["qty"]) for it in so_items)
    pre_discount_total = grand_total  # snapshot BEFORE any voucher/referral discount — used for affiliate commission calc later

    # Voucher — hantar selections + trip_package supaya diskaun dikira ikut
    # scope (subtotal cabin yang match sahaja), bukan grand_total keseluruhan.
    voucher_discount = 0
    if voucher_code:
        vr = validate_voucher(voucher_code, trip_group_date, grand_total,
                              billing.get("email", ""), json.dumps(selections), trip_package)
        if vr.get("valid"):
            voucher_discount = float(vr.get("discount_amount", 0))
            grand_total = grand_total - voucher_discount
            so_items.append({
                "item_code":   _get_or_create_travel_item(),
                "item_name":   "Voucher Discount (" + voucher_code + ")",
                "qty":         1,
                "rate":        -voucher_discount,
                "uom":         "Nos",
                "description": "Voucher code: " + voucher_code,
            })

    # Referral / Affiliate — Tier B: dikira dari baki SELEPAS voucher (sepadan
    # dengan UI). Discount % kepada CUSTOMER tetap sama untuk semua trip
    # (Travel Settings). sales_partner (bukan "Affliate" — doctype tu tak
    # wujud) di-link terus ke SO di bawah, supaya hook automation app
    # 'affiliate' (create_commission_if_eligible di Sales Order.on_update)
    # dapat cipta Affiliate Commission untuk affiliate ni secara automatik.
    referral_discount = 0
    sales_partner      = None
    if affiliate_code:
        ar = validate_affiliate_code(affiliate_code, trip_group_date)
        if ar.get("valid"):
            # PENTING: sales_partner di-set di SINI SEBAIK SAHAJA kod sah
            # (tak kira discount_percent > 0 atau tidak) — attribution
            # affiliate untuk commission MESTI berlaku serta-merta bila
            # kod referral sah, berasingan sepenuhnya dari sama ada
            # customer dapat extra discount. Line item SO (di bawah) untuk
            # discount hanya ditambah kalau referral_discount > 0 — elak
            # baris "-RM0.00" yang tak bermakna pada resit/invois.
            sales_partner     = ar.get("sales_partner")
            referral_percent  = float(ar.get("discount_percent", 0))
            referral_discount = round(grand_total * (referral_percent / 100), 2)
            if referral_discount > 0:
                grand_total = grand_total - referral_discount
                so_items.append({
                    "item_code":   _get_or_create_travel_item(),
                    "item_name":   "Referral Discount (" + affiliate_code.strip().upper() + ")",
                    "qty":         1,
                    "rate":        -referral_discount,
                    "uom":         "Nos",
                    "description": "Referral code: " + affiliate_code.strip().upper(),
                })

    # Manual Transfer cashback — dikira SEBELUM SO dicipta supaya boleh
    # apply terus sebagai Additional Discount pada SO (masuk GL Entry
    # berasingan sebagai "Discount Allowed", bukan sekadar tolak nombor).
    settings = frappe.get_cached_doc("Travel Settings")
    cashback_percent = 0
    if payment_method == "Manual Transfer" and settings.manual_transfer_cashback_enabled:
        cashback_percent = float(settings.manual_transfer_cashback_percent or 0)

    # Delivery Date = sehari SEBELUM tarikh berlepas — SO "kena complete"
    # (dari segi expected fulfilment ERPNext) sebelum trip bermula. Fallback
    # ke hari ini kalau departure_date somehow kosong (elak SO gagal insert).
    if td.departure_date:
        delivery_date = frappe.utils.add_days(td.departure_date, -1)
    else:
        delivery_date = frappe.utils.today()

    # Sales Order — insert & submit sebagai Administrator (elak isu permission
    # customer terhadap Link field dalaman seperti Account semasa validate SO).
    _original_user = frappe.session.user
    frappe.set_user("Administrator")
    try:
        so_payload = {
            "doctype":            "Sales Order",
            "customer":           customer_name,
            "transaction_date":   frappe.utils.today(),
            "delivery_date":      delivery_date,
            "order_type":         "Sales",
            "items":              so_items,
            "selling_price_list": "Standard Selling",
            # PENTING: matikan pembundaran ke ringgit-penuh untuk SO booking.
            # Tanpa ni, ERPNext boleh bundar grand_total (cth RM9.50) ke
            # rounded_total (cth RM10.00) — sedangkan jumlah SEBENAR yang
            # dicaj/dibayar customer (Stripe/manual transfer/Payment Entry)
            # sentiasa ikut grand_total tepat. Jurang ni punca SO kekal
            # "ada baki" (Rounding Adjustment) walaupun booking dah settle
            # penuh dari segi bisnes. Bayaran kita semua elektronik (Stripe/
            # bank transfer) — tiada keperluan bundar ringgit-penuh macam
            # transaksi tunai fizikal.
            #
            # NOTA: "Disable Rounded Total" kini turut dihidupkan SECARA
            # GLOBAL di Selling Settings — flag di sini kekal (defence-in-
            # depth untuk SO ni khusus, tak bergantung semata-mata pada
            # setting global yang admin boleh terlupa/tersilap toggle),
            # tapi puncanya sekarang global — semua SO (termasuk addon
            # yang admin cipta manual di Desk) turut terjamin
            # rounded_total=0, jadi seluruh app boleh standardize terus
            # ke grand_total sahaja (rujuk juga booking.py properties,
            # portal_booking.py, portal_payment.py, stripe_checkout.py).
            "disable_rounded_total": 1,
        }
        if sales_partner:
            so_payload["sales_partner"] = sales_partner
        if sales_persons:
            # Optional — staff dalaman RareCruise yang uruskan booking ni,
            # boleh lebih dari SATU (customer tambah melalui "+ Add
            # another" di wizard). Disimpan terus dalam SO's child table
            # 'Sales Team' sahaja (bukan Booking doctype).
            #
            # NOTA PENTING: ERPNext ENFORCE "Total allocated percentage for
            # sales team should be 100" semasa simpan Sales Order — kita
            # TAK BOLEH biarkan allocated_percentage kosong/0 macam rancangan
            # asal (admin tak boleh isi sendiri lepas ni sebab SO gagal
            # simpan dari awal). Jadi kita auto-bahagi SAMA RATA merentasi
            # semua sales person dipilih — customer tak nampak/isi peratus
            # ni langsung, cuma teknikal untuk penuhi validation ERPNext.
            # Admin boleh edit manual di Desk kemudian kalau nak nisbah lain.
            sp_list = sales_persons
            if isinstance(sp_list, str):
                sp_list = json.loads(sp_list)
            sp_list = [sp for sp in (sp_list or []) if sp]  # buang kosong/duplikat
            sp_list = list(dict.fromkeys(sp_list))
            if sp_list:
                n = len(sp_list)
                base_pct = round(100.0 / n, 2)
                rows = []
                for i, sp in enumerate(sp_list):
                    # Baris terakhir dapat baki supaya jumlah TEPAT 100.00
                    # (elak ralat float, cth 3 orang: 33.33+33.33+33.34=100).
                    pct = base_pct if i < n - 1 else round(100.0 - base_pct * (n - 1), 2)
                    rows.append({"sales_person": sp, "allocated_percentage": pct})
                so_payload["sales_team"] = rows
        if cashback_percent > 0:
            if not settings.cashback_discount_account:
                frappe.throw("Cashback Discount Account belum ditetapkan dalam Travel Settings.")
            so_payload.update({
                "apply_discount_on":              "Grand Total",
                "additional_discount_percentage": cashback_percent,
                "additional_discount_account":    settings.cashback_discount_account,
            })

        # PENTING: item 'TRAVEL-PKG' dikongsi untuk SEMUA jenis pax (Main
        # Guest/Extra Bed/Infant/Voucher/Referral) dengan rate berbeza-beza
        # setiap baris — ERPNext punya insert_item_price() automatik
        # "kemaskini" Item Price pada Price List "Standard Selling" setiap
        # kali rate SO Item tak sepadan dengan rate tersimpan, dan
        # frappe.msgprint() sekali untuk setiap baris ("Item Price updated
        # for TRAVEL-PKG..."). Mesej ni TIDAK BERBAHAYA (bukan error), tapi
        # ia bocor masuk response API sebagai _server_messages, dan boleh
        # disalah anggap sebagai error oleh sebarang caller yang tak teliti
        # (rujuk fix di public/js/booking.js apiCall()). Kita redakan
        # sepenuhnya di sini — simpan panjang frappe.message_log SEBELUM,
        # pangkas balik ke panjang asal SELEPAS — supaya msgprint yang
        # timbul dalam window insert/submit ni tak sampai ke response,
        # tanpa ganggu logik ERPNext sendiri (Item Price tetap dikemaskini
        # macam biasa, cuma notifikasi visualnya yang disekat).
        _msg_log_len_before = len(frappe.message_log)

        so = frappe.get_doc(so_payload)
        so.insert(ignore_permissions=True)
        so.flags.ignore_permissions = True
        so.submit()

        del frappe.message_log[_msg_log_len_before:]
    finally:
        frappe.set_user(_original_user)

    # Guna grand_total SEBENAR dari SO (selepas additional discount, jika ada)
    # supaya deposit/full-payment dikira dari jumlah yang betul-betul perlu
    # dibayar. "Disable Rounded Total" kini global (Selling Settings) — SO
    # ni (dan semua SO lain dalam app) tak lagi ada rounded_total berlainan
    # dari grand_total, jadi guna grand_total terus tanpa fallback.
    grand_total = float(so.grand_total or 0)

    # Deposit calc
    if amount_paid is not None:
        amount_paid = float(amount_paid)
    default_deposit_percent = float(settings.default_deposit_percent or 20)
    std_deposit    = round(grand_total * (default_deposit_percent / 100), 2)
    deposit_amount = amount_paid if amount_paid is not None else (std_deposit if payment_type == "Deposit" else grand_total)

    if amount_paid is not None and abs(amount_paid - grand_total) < 0.01:
        payment_type = "Full Payment"
    elif amount_paid is not None:
        payment_type = "Deposit"

    # Semua booking mula sebagai "Pending" (belum bayar langsung). Bila
    # bayaran PERTAMA masuk (Partially Paid atau Paid), status auto-tukar
    # ke "Accepted" (rujuk _recompute_booking_status()). Reservation TIDAK
    # dicipta di sini — dicipta bila payment_status jadi "Paid" (melalui
    # hook Payment Entry). Flight & stateroom di-assign admin secara manual
    # kemudian (isian tu yang trigger status "Processing").
    booking = frappe.get_doc({
        "doctype":        "Booking",
        "trip_date":      trip_group_date,
        "trip_package":   trip_package,
        "customer":       customer_name,
        "status":         "Pending",
        "payment_status": "Pending",
        "booking_number": _generate_booking_number(),
        # PENTING: attribution affiliate (untuk commission) TAK bergantung
        # pada referral_discount > 0 — sales_partner dah sah (atau None)
        # ditentukan di atas terus dari validate_affiliate_code(), jadi
        # guna terus di sini tanpa syarat tambahan.
        "affiliate":            sales_partner,
        "pre_discount_total":   pre_discount_total,
    })
    booking.insert(ignore_permissions=True)

    # Portal access — cipta User serentak dengan Booking (bukan lazy-created
    # bila customer minta login link). Kalau email ni dah ada User (returning
    # customer), tak buat apa-apa — reuse User sedia ada.
    is_new_user = _ensure_portal_user(email, customer_name)
    if is_new_user:
        # Emel "Set Your Password" BERASINGAN, dihantar SEKALI SAHAJA di
        # sini — tak kira payment method atau status booking pertama
        # customer (Pending/Accepted/dsb). Lebih mudah & selamat dari
        # cuba sertakan pautan ni ke dalam emel status pertama (yang mana
        # laluan trigger emel status pertama berbeza-beza ikut payment
        # method/hasil bayaran — mudah tersasar, rujuk sejarah bug).
        full_name  = billing.get("full_name") or "Customer"
        first_name = full_name.split()[0] if full_name else "Customer"
        _send_set_password_email(email, first_name)

    # SO utama dikaitkan SEMATA-MATA melalui Sales Order.custom_booking (one-
    # standard: SO rujuk Booking, bukan dua-hala). SO dicipta SEBELUM Booking
    # wujud, jadi baru boleh diisi sekarang selepas booking.name ada.
    frappe.db.set_value("Sales Order", so.name, "custom_booking", booking.name)

    res_created = 0  # dicipta bila Confirmed (hook Payment Entry)

    if voucher_code and voucher_discount > 0:
        used_voucher_name, used_voucher_usage_name = _use_voucher(
            voucher_code, customer_name, booking.name, voucher_discount
        )
        if used_voucher_name:
            frappe.db.set_value("Booking", booking.name, {
                "voucher":       used_voucher_name,
                "voucher_usage": used_voucher_usage_name,
            })

    # Online Payment → jana Stripe payment URL (bayar ikut payment_type: deposit/full)
    # PENTING: emel "Pending" TIDAK dihantar di sini untuk Online Payment.
    # Kalau bayaran berjaya serta-merta, webhook terus hantar emel "Accepted"
    # (lompat terus, elak customer dapat 2 emel berturut-turut untuk satu
    # tindakan). Emel "Pending" untuk Online Payment hanya dihantar oleh:
    #   (a) webhook payment_intent.payment_failed (Stripe confirm gagal), atau
    #   (b) checkout.html punya timeout 5 minit (customer tak siapkan bayaran)
    # — kedua-dua di stripe_checkout.py, guna _send_status_email() yang sama.
    payment_url = ""
    if payment_method == "Online Payment":
        pay_amount = deposit_amount if payment_type == "Deposit" else grand_total
        payment_url = _create_payment_url(
            customer_name = customer_name,
            so_name       = so.name,
            amount        = pay_amount,
            booking_number = booking.booking_number,
        )
    elif payment_method == "Manual Transfer" and receipt:
        _create_manual_payment_entry(
            so_name       = so.name,
            customer_name = customer_name,
            amount        = deposit_amount,
            receipt_data  = receipt,
            label         = "receipt-" + booking.booking_number,
            bank_transfer_ref = bank_transfer_ref,
        )
    elif payment_method == "Pay Later":
        # Tiada bayaran cuba dibuat sekarang — SO + Booking dah cipta
        # (grand_total penuh, advance_paid=0) macam biasa di atas, cuma
        # SKIP terus penciptaan Payment Entry/Stripe URL. Customer bayar
        # KEMUDIAN melalui portal (mekanisme sedia ada — tab Payment &
        # Invoice, "Pay Now" — tiada perubahan diperlukan di situ).
        # Booking Reservation TIDAK dicipta serta-merta (rujuk
        # _recompute_booking_status(): trigger bergantung payment_status
        # mula ada bayaran — kekal begitu, keputusan sengaja).
        pass

    frappe.db.commit()

    if payment_method in ("Manual Transfer", "Pay Later"):
        # Manual Transfer — booking betul-betul "Pending" (menunggu admin
        # verify resit). Pay Later — booking "Pending" sebab memang belum
        # ada bayaran langsung. Kedua-dua kongsi mesej/template EMAIL yang
        # sama ("Booking Pending") — keputusan sengaja, elak template
        # baharu buat masa ni. (Wizard memaksa upload resit untuk Manual
        # Transfer sebelum submit, tapi check ni tak bergantung pada
        # 'receipt' supaya tetap selamat kalau dipanggil terus via API.)
        _send_status_email(booking.name, "Pending",
                           email_override=billing.get("email", ""))

    return {
        "success":        True,
        "booking":        booking.name,
        "booking_number": booking.booking_number,
        "sales_order":    so.name,
        "grand_total":    grand_total,
        "amount_due":     deposit_amount,
        "reservations_created": res_created,
        "booking_status": booking.status,
        "payment_status": _compute_payment_status(0, grand_total),
        "advance_paid":   0,
        "payment_type":   payment_type,
        "payment_method": payment_method,
        "payment_url":    payment_url,
        "cashback_percent": cashback_percent,
        "cashback_amount":  round(so.discount_amount, 2) if cashback_percent > 0 else 0,
        "voucher_discount":  round(voucher_discount, 2),
        "referral_discount": round(referral_discount, 2),
    }



def _create_manual_payment_entry(so_name, customer_name, amount, receipt_data="", label="receipt", bank_transfer_ref=""):
    """Manual transfer — cipta Payment Entry DRAFT + attach resit.
    Draft (docstatus 0) = menunggu admin verify & submit. Corak sama dgn portal.
    """
    import base64
    from erpnext.accounts.party import get_party_account

    so = frappe.db.get_value("Sales Order", so_name, ["company", "currency"], as_dict=True)
    if not so:
        return None

    original_user = frappe.session.user
    frappe.set_user("Administrator")
    try:
        company = so.company or frappe.db.get_single_value("Global Defaults", "default_company")
        # PENTING: guna Travel Settings.manual_transfer_paid_to_account
        # (configurable di Desk) kalau admin dah tetapkan — elak bergantung
        # pada "Account jenis Bank PERTAMA yang jumpa" (tak konsisten kalau
        # company ada lebih dari satu akaun Bank). Fallback ke kelakuan
        # LAMA kalau setting ni belum diisi (backward compat).
        paid_to = frappe.db.get_single_value("Travel Settings", "manual_transfer_paid_to_account")
        if not paid_to:
            paid_to = frappe.db.get_value("Account",
                {"account_type": "Bank", "company": company, "is_group": 0}, "name")
        party_account = get_party_account("Customer", customer_name, company)

        pe = frappe.new_doc("Payment Entry")
        pe.payment_type    = "Receive"
        pe.company         = company
        pe.posting_date    = frappe.utils.today()
        pe.party_type      = "Customer"
        pe.party           = customer_name
        pe.party_account   = party_account
        pe.paid_from       = party_account
        pe.paid_to         = paid_to
        pe.paid_amount     = float(amount)
        pe.received_amount = float(amount)
        # PENTING: reference_no = nombor rujukan/transaksi DARI BANK
        # CUSTOMER SENDIRI (bukan nombor SO kami) — inilah tujuan asal
        # field "Cheque/Reference No" dalam Payment Entry ERPNext, untuk
        # admin padankan bayaran ni dengan penyata bank semasa verify.
        # Pautan ke SO sendiri sudah cukup dikesan melalui child table
        # 'references' di bawah — reference_no tak perlu (dan sebelum ni
        # SALAH) diisi dengan so_name yang redundant.
        pe.reference_no    = bank_transfer_ref or so_name
        pe.reference_date  = frappe.utils.today()
        pe.append("references", {
            "reference_doctype": "Sales Order",
            "reference_name":    so_name,
            "allocated_amount":  float(amount),
        })
        pe.remarks = "Manual transfer (booking) untuk " + so_name + \
                     (". Ref: " + bank_transfer_ref if bank_transfer_ref else "") + \
                     ". Pending verification."
        pe.insert(ignore_permissions=True)

        if receipt_data:
            ext = ".png"
            if receipt_data.startswith("data:"):
                head = receipt_data.split(",")[0]
                if "pdf" in head:
                    ext = ".pdf"
                elif "jpeg" in head or "jpg" in head:
                    ext = ".jpg"
                elif "png" in head:
                    ext = ".png"
                receipt_data = receipt_data.split(",")[1]
            file_content = base64.b64decode(receipt_data)
            frappe.get_doc({
                "doctype":             "File",
                "file_name":           label + ext,
                "attached_to_doctype": "Payment Entry",
                "attached_to_name":    pe.name,
                "is_private":          1,
                "content":             file_content
            }).insert(ignore_permissions=True)
        return pe.name
    except Exception as e:
        frappe.log_error("Manual payment entry (booking) failed: " + str(e), "Manual PE Error")
        return None
    finally:
        frappe.set_user(original_user)


def _create_payment_url(customer_name, so_name, amount, booking_number):
    """Cipta Payment Intent (checkout kita sendiri) untuk online payment.
    Redirect selepas bayar dikawal oleh checkout.html -> balik ke wizard step Confirm.
    Status bayaran sebenar ditentukan oleh webhook (stripe_checkout.stripe_webhook),
    bukan redirect ini.
    """
    try:
        from travel_booking.api.stripe_checkout import create_payment_intent
        result = create_payment_intent(
            sales_order=so_name,
            amount=amount,
            source="wizard",
            booking_number=booking_number,
        )
        return result.get("checkout_url", "")
    except Exception as e:
        frappe.log_error("Payment checkout creation failed: " + str(e), "Payment URL Error")
        return ""



def _create_customer(billing):
    customer = frappe.get_doc({
        "doctype":        "Customer",
        "customer_name":  billing.get("full_name"),
        "customer_type":  "Individual",
        "customer_group": frappe.db.get_single_value(
                            "Selling Settings", "customer_group") or "Individual",
        "territory":      frappe.db.get_single_value(
                            "Selling Settings", "territory") or "All Territories",
    })
    customer.insert(ignore_permissions=True)

    contact = frappe.get_doc({
        "doctype":    "Contact",
        "first_name": billing.get("full_name"),
        "email_ids":  [{"email_id": billing.get("email"), "is_primary": 1}],
        "phone_nos":  [{"phone": billing.get("phone"), "is_primary_phone": 1}],
        "links":      [{"link_doctype": "Customer", "link_name": customer.name}],
    })
    contact.insert(ignore_permissions=True)
    return customer.name


def _build_so_items(selections, pricing_map, trip_name="", group_label=""):
    """Bina SO items dengan harga dari backend pricing_map.
    Model SLOT (posisi bilik): Main Guest (single/twin) / Extra Bed /
    Infant. Harga ditentukan oleh SLOT, bukan label umur — kecuali Infant
    yang sentiasa guna price_infant sendiri.
    """
    items        = []
    default_item = _get_or_create_travel_item()

    for cabin_no, sel in enumerate(selections, start=1):
        room_category = sel.get("room_category")
        main_guests   = int(sel.get("main_guests", 0))
        extra_beds    = int(sel.get("extra_beds", 0))
        infants       = int(sel.get("infants", 0))

        price = pricing_map.get(room_category)
        if not price:
            frappe.throw("Harga tidak ditemui untuk kategori: " + str(room_category))

        if main_guests == 1:
            items.append(_so_line(default_item, room_category, "Main Guest (Single)",
                                  1, float(price.price_adult_single or 0),
                                  trip_name, group_label, cabin_no))
        elif main_guests >= 2:
            items.append(_so_line(default_item, room_category, "Main Guest",
                                  main_guests, float(price.price_adult or 0),
                                  trip_name, group_label, cabin_no))
        if extra_beds > 0:
            items.append(_so_line(default_item, room_category, "Extra Bed",
                                  extra_beds, float(price.price_upperberth or 0),
                                  trip_name, group_label, cabin_no))
        if infants > 0:
            items.append(_so_line(default_item, room_category, "Infant",
                                  infants, float(price.price_infant or 0),
                                  trip_name, group_label, cabin_no))
    return items


def _so_line(item_code, room_category, pax_type, qty, rate, trip_name, group_label, cabin_no=1):
    cabin_tag = "Cabin " + str(cabin_no)
    return {
        "item_code":   item_code,
        "item_name":   room_category + " (" + cabin_tag + ") \u2014 " + pax_type,
        "qty":         qty,
        "rate":        rate,
        "uom":         "Nos",
        "description": trip_name + " | " + group_label + " | " + room_category + " | " + cabin_tag + " | " + pax_type,
    }


def _get_or_create_travel_item():
    item_code = "TRAVEL-PKG"
    if frappe.db.exists("Item", item_code):
        return item_code

    frappe.get_doc({
        "doctype":                       "Item",
        "item_code":                     item_code,
        "item_name":                     "Travel Package",
        "item_group":                    "Services",
        "stock_uom":                     "Nos",
        "is_stock_item":                 0,
        "is_sales_item":                 1,
        "include_item_in_manufacturing": 0,
    }).insert(ignore_permissions=True)
    return item_code


def _cabin_layout_from_so(so_name):
    """Susunan cabin dari SO items (SO = sumber tunggal), ikut turutan cabin.
    description: 'Trip | Group Label | Room Category | Cabin N | Pax Type'.
    Return: [{cabin_no, room_category, pax, pax_breakdown}] disusun ikut
    cabin_no. pax_breakdown = {"Main Guest": 2, "Extra Bed": 1, ...} —
    pecahan pax_type SEBENAR yang customer beli untuk cabin ni, perlu
    untuk isi cabin_no/pax_type pada setiap Booking Reservation individu
    (rujuk _activate_booking()). 'pax' (jumlah keseluruhan) dikekalkan
    untuk backward compat dengan caller sedia ada (portal_booking.py
    Pass 2 grouping) yang cuma perlukan kuantiti, bukan breakdown.
    """
    items = frappe.db.get_all("Sales Order Item",
                              filters={"parent": so_name},
                              fields=["description", "qty"], order_by="idx")
    layout = {}
    for it in items:
        parts = (it.description or "").split(" | ")
        if len(parts) < 5:
            continue
        room_category = parts[2].strip()
        cabin_tag     = parts[3].strip()
        pax_type      = parts[4].strip()

        # PENTING: "Main Guest (Single)" cuma label PRICING/paparan (beza
        # price_adult_single vs price_adult — rujuk _build_so_items()) —
        # dari segi kapasiti/kiraan slot Booking Reservation, ia SAMA
        # dengan "Main Guest" biasa (satu-satu tetap ambil 1 slot). Field
        # pax_type (Select) pada Booking Reservation cuma terima 3 nilai
        # tetap ("Main Guest"/"Extra Bed"/"Infant") — tanpa normalize ni,
        # _activate_booking() akan cuba simpan "Main Guest (Single)" terus
        # dan Frappe tolak dengan error validation (LinkValidationError
        # gaya Select), block booking/update Payment Entry yang trigger
        # laluan ni.
        if pax_type == "Main Guest (Single)":
            pax_type = "Main Guest"

        try:
            cabin_no = int(cabin_tag.lower().replace("cabin", "").strip())
        except Exception:
            continue
        if cabin_no not in layout:
            layout[cabin_no] = {"cabin_no": cabin_no, "room_category": room_category, "pax": 0, "pax_breakdown": {}}
        qty = int(it.qty or 0)
        layout[cabin_no]["pax"] += qty
        layout[cabin_no]["pax_breakdown"][pax_type] = layout[cabin_no]["pax_breakdown"].get(pax_type, 0) + qty
    return [layout[n] for n in sorted(layout.keys())]


def _activate_booking(booking_name):
    """Cipta Booking Reservation (status Confirmed) bila booking Confirmed.
    Idempotent. Reservation dicipta dengan room_category + cabin_no +
    pax_type terisi (bukan cuma room_category macam sebelum ni) — setiap
    slot individu terus tahu cabin & jenis pax dia dari mula, konsisten
    dengan apa customer beli di SO, dan sepadan dengan validate() capacity
    check baharu (rujuk booking_reservation.py) yang bergantung pada
    field-field ni. flight & stateroom_no tetap admin assign kemudian.
    Cabin layout diambil dari SO UTAMA (cabin booking asal), bukan addon SO.
    """
    if frappe.db.count("Booking Reservation", {"booking": booking_name}):
        return 0
    so_name = _get_primary_so(booking_name)
    if not so_name:
        return 0
    count = 0
    for cabin in _cabin_layout_from_so(so_name):
        for pax_type, qty in cabin.get("pax_breakdown", {}).items():
            for _ in range(int(qty)):
                frappe.get_doc({
                    "doctype":         "Booking Reservation",
                    "booking":         booking_name,
                    "room_category":   cabin.get("room_category"),
                    "cabin_no":        cabin.get("cabin_no"),
                    "pax_type":        pax_type,
                    "status":          "Confirmed",
                    "document_status": "Pending",
                }).insert(ignore_permissions=True)
                count += 1
    return count


def _compute_payment_status(paid, total):
    """Kira nilai Payment Status (field 'payment_status' pada Booking, BUKAN
    virtual) dari jumlah dibayar vs jumlah keseluruhan SO. Refund status
    (Request Refund/Pending Refund/Refunded) TIDAK dikira di sini — ia
    ditetapkan secara berasingan melalui proses cancel/refund (rujuk
    _cancel_booking_cascade dan proses refund manual admin).
    """
    if paid <= 0:
        return "Pending"
    elif paid >= total - 0.001:
        return "Paid"
    return "Partially Paid"


def _resolve_booking_from_so(so_name):
    """Cari nama Booking yang berkaitan dengan SO ni, terus melalui
    Sales Order.custom_booking. Pulang None kalau tiada kaitan.
    """
    return frappe.db.get_value("Sales Order", so_name, "custom_booking")


def _get_all_booking_sales_orders(booking_name, include_cancelled=False):
    """Semua SO yang berkaitan booking ni, melalui Sales Order.custom_booking
    (satu-satunya sumber rujukan — utama dan addon setara secara struktur).
    Secara default, SO Cancelled (docstatus=2) DIKECUALIKAN — supaya tak
    masuk kiraan Total/Payment Status/booking_status/waterfall allocation.
    Guna include_cancelled=True HANYA untuk paparan UI (transparency),
    bukan untuk logic status atau pembayaran.
    """
    filters = {"custom_booking": booking_name}
    if not include_cancelled:
        filters["docstatus"] = ["!=", 2]
    return frappe.get_all("Sales Order", filters=filters, pluck="name")


def _get_primary_so(booking_name):
    """SO 'utama' (cabin booking asal) — ditakrif sebagai SO PERTAMA yang
    dicipta untuk booking ni (creation paling awal), bukan field berasingan.
    Ini gantikan Booking.sales_order sepenuhnya — one-to-many standard
    (Sales Order.custom_booking → Booking), bukan rujukan dua-hala.
    """
    return frappe.db.get_value(
        "Sales Order", {"custom_booking": booking_name},
        "name", order_by="creation asc"
    )


def _recompute_booking_status(so_name):
    """Kira semula payment_status dari GABUNGAN SEMUA SO yang berkaitan
    booking (SO utama + SO addon seperti excursion/servis tambahan yang
    admin create berasingan, dikaitkan melalui Sales Order.custom_booking).

    PENTING (flow status baharu):
    - "Pending" -> "Accepted": auto, sebaik bayaran PERTAMA masuk (Partially
      Paid atau Paid) — booking baru mula sebagai "Pending" (belum bayar).
    - "Accepted" -> "Processing"/"Confirmed": TIDAK berlaku di sini —
      peralihan ni kini MANUAL sepenuhnya (admin pilih terus value baharu
      di field status Booking di Desk; rujuk on_booking_update()).
    - "Cancelled" tetap sticky (status di-skip, tapi payment_status tetap
      dikemaskini supaya rekod bayaran refund/partial kekal tepat).
    """
    booking_name = _resolve_booking_from_so(so_name)
    if not booking_name:
        return

    all_so_names = _get_all_booking_sales_orders(booking_name)
    if not all_so_names:
        return

    # NOTA: "Disable Rounded Total" kini global (Selling Settings) — semua
    # SO berkaitan booking tak lagi ada rounded_total berlainan dari
    # grand_total, jadi standardize ke grand_total sahaja.
    total = 0
    paid  = 0
    for name in all_so_names:
        so = frappe.db.get_value("Sales Order", name, ["grand_total", "advance_paid"], as_dict=True)
        if so:
            total += float(so.grand_total or 0)
            paid  += so.advance_paid or 0

    new_payment_status = _compute_payment_status(paid, total)

    # prog_payment: peratusan kemajuan bayaran, formula (1 - (balance/total))
    # * 100 — field STORED sebenar (bukan @property macam total_amount/
    # balance_amount), jadi WAJIB ditulis eksplisit di sini setiap kali
    # payment data SO berkaitan berubah (bukan dikira on-the-fly semasa
    # baca), supaya sentiasa terkini untuk paparan List View/laporan.
    balance = max(0, total - paid)
    new_prog_payment = round((1 - (balance / total)) * 100) if total > 0 else 0

    b = frappe.db.get_value("Booking", booking_name, ["name", "status", "payment_status", "prog_payment"], as_dict=True)
    if not b:
        return

    if b.prog_payment != new_prog_payment:
        frappe.db.set_value("Booking", b.name, "prog_payment", new_prog_payment)

    # Reservation dicipta sebaik payment_status mula ada sebarang bayaran
    # (Partially Paid ATAU Paid) — bukan perlu tunggu Paid penuh. Ini
    # sepadan dengan _activate_booking() sendiri idempotent (check dulu
    # kalau Reservation dah wujud), jadi selamat panggil berulang.
    had_any_payment = b.payment_status in ("Partially Paid", "Paid")

    if b.payment_status != new_payment_status:
        frappe.db.set_value("Booking", b.name, "payment_status", new_payment_status)

    if b.status == "Cancelled":
        return  # sticky — status tak berubah walau bayaran berubah

    # Pending -> Accepted: auto, sebaik bayaran PERTAMA masuk. Email
    # "Accepted" dihantar HANYA pada transisi ni (bila status memang
    # "Pending" sebelum ni) — bukan setiap kali _recompute dipanggil.
    if new_payment_status in ("Partially Paid", "Paid") and b.status == "Pending":
        frappe.db.set_value("Booking", b.name, "status", "Accepted")
        _send_status_email(b.name, "Accepted")

    # Reservation dicipta sebaik payment_status mula ada sebarang bayaran —
    # TIDAK bergantung pada status booking (Processing/Confirmed kini
    # ditetapkan admin secara manual, bukan auto dari sini).
    if new_payment_status in ("Partially Paid", "Paid") and not had_any_payment:
        _activate_booking(b.name)


def on_payment_entry_submit(doc, method=None):
    """Hook: Payment Entry submit → resit + kemas kini status booking + cipta reservation.
    Berfungsi untuk Payment Entry terhadap SO UTAMA mahupun SO ADDON — kedua-dua
    diselesaikan balik ke Booking yang sama melalui _resolve_booking_from_so().
    """
    _send_receipt_email(doc)  # resit setiap bayaran (runcit-runcit pun dapat bukti)
    for ref in (doc.references or []):
        if ref.reference_doctype == "Sales Order" and ref.reference_name:
            _recompute_booking_status(ref.reference_name)


def on_payment_entry_cancel(doc, method=None):
    """Hook: Payment Entry cancel → kira semula status booking."""
    for ref in (doc.references or []):
        if ref.reference_doctype == "Sales Order" and ref.reference_name:
            _recompute_booking_status(ref.reference_name)


def on_booking_update(doc, method=None):
    """Hook: Booking.on_update — kesan peralihan status yang dibuat MANUAL
    oleh admin di Desk (pilih value baharu terus di field 'status'), dan
    hantar email sepadan. Turut kesan peralihan ke 'Cancelled' untuk
    jalankan cascade.

    PENTING: "Pending" -> "Accepted" TIDAK dikesan di sini — peralihan tu
    automatik ikut bayaran (rujuk _recompute_booking_status(), dipanggil
    dari hook Payment Entry), bukan admin pilih terus di dropdown. Begitu
    juga "Completed" (auto ikut tarikh trip, rujuk mark_completed_trips()).
    Fungsi ni HANYA kesan dua peralihan MANUAL: ke "Processing" dan ke
    "Confirmed" (admin pilih terus value baharu di field status), serta
    peralihan ke "Cancelled" (boleh manual atau dari mana-mana laluan lain).
    """
    old = doc.get_doc_before_save()
    if not old or old.status == doc.status:
        return  # tiada perubahan status — tak perlu buat apa-apa

    if doc.status == "Cancelled":
        _cancel_booking_cascade(doc)
    elif doc.status == "Processing" and old.status != "Processing":
        _send_status_email(doc.name, "Processing")
    elif doc.status == "Confirmed" and old.status != "Confirmed":
        _send_status_email(doc.name, "Confirmed")


def mark_completed_trips(booking_name=None):
    """Scheduled task (harian, rujuk hooks.py scheduler_events) — auto-tukar
    status booking ke 'Completed' selepas tarikh berlepas (departure_date)
    trip berlalu. Hanya booking yang 'Confirmed' layak (booking yang tak
    sempat Confirmed sebelum trip bermula TIDAK di-auto-complete — perlu
    semakan manual admin). booking_name (opsyenal) untuk test/panggil manual
    terhadap satu booking sahaja.
    """
    params = {"today": frappe.utils.today()}
    extra_filter = ""
    if booking_name:
        extra_filter = "AND b.name = %(booking_name)s"
        params["booking_name"] = booking_name

    bookings = frappe.db.sql("""
        SELECT b.name
        FROM `tabBooking` b
        JOIN `tabTrip Group Date` td ON td.name = b.trip_date
        WHERE b.status = 'Confirmed'
          AND td.departure_date IS NOT NULL
          AND td.departure_date < %(today)s
          {extra}
    """.format(extra=extra_filter), params, as_dict=True)

    for b in bookings:
        try:
            frappe.db.set_value("Booking", b.name, "status", "Completed")
            _send_status_email(b.name, "Completed")
        except Exception as e:
            frappe.log_error(
                "Gagal auto-complete booking " + b.name + ": " + str(e),
                "Booking Auto-Complete Error"
            )
    frappe.db.commit()


def _release_voucher_for_booking(booking_name):
    """Lepaskan voucher yang diguna booking ni — padam rekod Voucher Usage
    terus (doctype STANDALONE sekarang, bukan child table lagi — rujuk
    field 'voucher' Link, bukan 'parent'). usage_count dikira live dari
    bilangan rekod Voucher Usage yang wujud, jadi cukup padam rekod sahaja
    — tiada field counter berasingan untuk decrement, dan TIADA perlu
    load/lock/save Voucher induk (tiada child table untuk disegerakkan
    lagi — jauh lebih ringkas dari pendekatan lama). Turut kosongkan
    Booking.voucher/voucher_usage (field rujukan cepat BAHARU) supaya
    tak tinggal rujukan ke rekod yang dah dipadam.
    """
    for u in frappe.db.get_all("Voucher Usage",
                               filters={"booking": booking_name},
                               pluck="name"):
        try:
            frappe.delete_doc("Voucher Usage", u, ignore_permissions=True)
        except Exception:
            pass
    frappe.db.set_value("Booking", booking_name, {"voucher": None, "voucher_usage": None})


def _cancel_booking_cascade(booking_doc):
    """Bila booking Cancelled: reservation -> Inactive, lepas voucher,
    cancel SEMUA SO berkaitan (utama + addon) yang belum bayar (kalau dah
    bayar, log utk refund manual — SO tu KEKAL, tak di-cancel). Kalau ada
    bayaran sedia ada, payment_status ditukar ke "Request Refund" supaya
    admin nampak booking ni perlukan proses refund (Pending Refund/Refunded
    ditetapkan admin secara manual selepas refund diproses melalui bank/Stripe).
    """
    for r in frappe.get_all("Booking Reservation",
                            filters={"booking": booking_doc.name, "status": "Confirmed"},
                            fields=["name"]):
        res = frappe.get_doc("Booking Reservation", r.name)
        res.status = "Cancelled"
        res.save(ignore_permissions=True)

    _release_voucher_for_booking(booking_doc.name)

    total_paid = 0
    for so_name in _get_all_booking_sales_orders(booking_doc.name):
        so = frappe.db.get_value("Sales Order", so_name,
                                 ["advance_paid", "docstatus"], as_dict=True)
        if not so:
            continue
        total_paid += so.advance_paid or 0
        if (so.advance_paid or 0) <= 0 and so.docstatus == 1:
            try:
                so_doc = frappe.get_doc("Sales Order", so_name)
                so_doc.flags.ignore_permissions = True
                so_doc.cancel()
            except Exception as e:
                frappe.log_error("Cancel SO gagal " + so_name + ": " + str(e), "Booking Cancel")
        elif (so.advance_paid or 0) > 0:
            frappe.log_error(
                "Booking " + booking_doc.name + " dibatalkan tetapi SO " + so_name +
                " ada bayaran RM" + str(so.advance_paid) + ". Refund & cancel SO perlu manual.",
                "Booking Cancel - Refund Needed")

    if total_paid > 0:
        frappe.db.set_value("Booking", booking_doc.name, "payment_status", "Request Refund")


def _use_voucher(code, customer_name, booking_name, discount_amount=0):
    """Rekod penggunaan voucher — cipta rekod BAHARU di doctype standalone
    'Voucher Usage' (bukan append ke child table lagi). Row-lock pada
    Voucher (FOR UPDATE) DIKEKALKAN sebagai mekanisme SERIALIZATION —
    walaupun kita tak load/ubah/save dokumen Voucher itu sendiri lagi,
    lock ni tetap perlu untuk elak race condition: dua booking guna kod
    yang sama hampir serentak, kedua-dua check max_usage LULUS sebelum
    mana-mana sempat rekod usage, jadi both proceed dan usage_count
    akhirnya melebihi max_usage. Lock paksa request kedua tunggu sehingga
    request pertama selesai (commit), baru boleh teruskan — insert
    berlaku SELEPAS lock diperoleh, dalam transaksi yang sama.

    Pulangkan (voucher_name, usage_name) — atau (None, None) kalau gagal
    — supaya caller boleh isi Booking.voucher/voucher_usage (field Link
    BAHARU pada Booking, rujukan cepat tanpa perlu query Voucher Usage
    berasingan setiap kali).
    """
    try:
        code = (code or "").strip().upper()
        voucher_name = frappe.db.get_value("Voucher", {"voucher_code": code}, "name")
        if not voucher_name:
            return None, None
        frappe.db.sql("SELECT name FROM `tabVoucher` WHERE name = %s FOR UPDATE", voucher_name)
        usage_doc = frappe.get_doc({
            "doctype":         "Voucher Usage",
            "voucher":         voucher_name,
            "customer":        customer_name,
            "booking":         booking_name,
            "discount_amount": discount_amount,
        })
        usage_doc.insert(ignore_permissions=True)
        return voucher_name, usage_doc.name
    except Exception as e:
        frappe.log_error("Voucher usage tracking failed: " + str(e), "Voucher Error")
        return None, None


def _generate_booking_number():
    while True:
        suffix = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        booking_number = "RC" + suffix
        if not frappe.db.exists("Booking", {"booking_number": booking_number}):
            return booking_number


def _ensure_portal_user(email, customer_name):
    """Cipta User portal serentak dengan Booking (kalau belum wujud untuk
    email ni). Password diisi random placeholder — TIDAK PERNAH didedahkan
    kepada customer secara langsung (tiada raw password dalam emel).
    Customer sentiasa masuk portal melalui pautan "Set Your Password"
    (reset_password_key, hantar sekali dalam emel booking pertama) atau
    Magic Link (login page). Pulangkan True kalau User baru dicipta.
    """
    email = (email or "").strip().lower()
    if not email:
        return False
    if frappe.db.exists("User", email):
        return False

    customer_full_name = frappe.db.get_value("Customer", customer_name, "customer_name") or customer_name
    first_name = customer_full_name.split()[0] if customer_full_name else "Customer"
    last_name  = " ".join(customer_full_name.split()[1:]) if len(customer_full_name.split()) > 1 else ""

    new_user = frappe.get_doc({
        "doctype":            "User",
        "email":              email,
        "first_name":         first_name,
        "last_name":          last_name,
        "enabled":            1,
        "user_type":          "Website User",
        "send_welcome_email": 0,
        "new_password":       frappe.generate_hash(length=16),
        "roles":              [{"role": "Traveller"}]
    })
    new_user.flags.ignore_permissions = True
    new_user.flags.ignore_password_policy = True
    new_user.insert()
    frappe.db.commit()
    return True


def get_site_url():
    """Domain untuk pautan emel — DINAMIK ikut domain sebenar customer guna
    untuk buat request (test.rpwp.my atau dev.rpwp.my — dua-dua hala ke
    site Frappe yang SAMA, sengaja tak override site_config.json punya
    'host_name' supaya migration/deployment site tak terjejas).

    Dipanggil dari konteks request customer sebenar (contoh: confirm_booking,
    forgot_password) -> guna domain request tu terus (frappe.local.request.host).
    Dipanggil dari konteks TANPA request customer (contoh: webhook Stripe —
    request datang dari Stripe, bukan browser customer; scheduled task;
    bench console) -> fallback ke frappe.utils.get_url() biasa (guna
    site_config.json punya host_name).
    """
    if getattr(frappe.local, "request", None) and frappe.local.request.host:
        protocol = "https://" if frappe.get_request_header("X-Forwarded-Proto", "") == "https" else "http://"
        return protocol + frappe.local.request.host
    return frappe.utils.get_url()


def _generate_set_password_url(email):
    """Reuse mekanisme reset_password_key sedia ada (forgot_password()) untuk
    pautan "Set Your Password" pertama kali — bukan sistem token berasingan.
    Tiada mode= dalam URL supaya set-password.html papar mod "first" (default).
    """
    reset_key = frappe.generate_hash(length=32)
    frappe.db.set_value("User", email, "reset_password_key", reset_key)
    site_url = get_site_url()
    return site_url + "/set-password?key=" + reset_key + "&email=" + email


def _send_set_password_email(email, first_name):
    """Emel BERASINGAN "Set Your Password" — dihantar SEKALI SAHAJA, terus
    selepas User portal baru dicipta (_ensure_portal_user() pulangkan True),
    TAK KIRA payment method atau status booking pertama customer tu.

    Reka bentuk ni sengaja dipermudah (bukan lagi cuba sertakan pautan set-
    password ke DALAM emel status booking pertama, ikut is_new_user flag) —
    pendekatan lama tu rapuh: setiap laluan yang boleh trigger emel status
    PERTAMA (Manual Transfer -> Pending, Online Payment berjaya -> Accepted,
    webhook gagal -> Pending, checkout timeout -> Pending) kena masing-
    masing ingat hantar is_new_user dengan betul — 1 daripada 4 laluan tu
    pernah tersasar (Accepted, bila _recompute_booking_status() panggil
    _send_status_email() tanpa is_new_user), customer terlepas pautan set-
    password. Emel berasingan ni tak bergantung pada status booking langsung
    — dihantar terus lepas User dicipta, penuh, sendiri.
    """
    try:
        context = {
            "first_name":       first_name,
            "set_password_url": _generate_set_password_url(email),
        }
        email_template = frappe.get_doc("Email Template", "Set Your Password")
        message = email_template.get_formatted_response(context)
        subject = frappe.render_template(email_template.subject, context)

        frappe.sendmail(
            recipients=[email],
            # Sender TIDAK di-hardcode — biar Frappe guna default Outgoing
            # Email Account, sama macam send_otp(). Hardcode domain lain
            # dari domain sebenar site punca email silently gagal/masuk
            # spam (SPF/DKIM mismatch).
            subject=subject,
            message=message,
            now=True
        )
    except Exception as e:
        frappe.log_error("Set Your Password email failed: " + str(e), "Booking Email Error")


# ══════════════════════════════════════════════
# EMAIL — CONFIRMATION
# ══════════════════════════════════════════════


PRINT_FORMAT_RECEIPT = "Rarecation Receipt"


def _booking_email_context(booking_name):
    b = frappe.db.get_value("Booking", booking_name,
                            ["booking_number", "customer", "trip_date"],
                            as_dict=True)
    if not b:
        return None
    trip_name = ""
    group_name = ""
    if b.trip_date:
        td = frappe.db.get_value("Trip Group Date", b.trip_date, ["trip", "trip_group_name"], as_dict=True)
        if td:
            group_name = td.trip_group_name or ""
            trip_name = frappe.db.get_value("Trip", td.trip, "trip_name") or ""
    # NOTA: "Disable Rounded Total" kini global — standardize ke grand_total.
    grand_total   = 0
    advance_paid  = 0
    for so_name in _get_all_booking_sales_orders(booking_name):
        so_vals = frappe.db.get_value("Sales Order", so_name,
                                      ["grand_total", "advance_paid"], as_dict=True)
        if so_vals:
            grand_total  += float(so_vals.grand_total or 0)
            advance_paid += so_vals.advance_paid or 0
    return {
        "email":           get_customer_email(b.customer),
        "full_name":       frappe.db.get_value("Customer", b.customer, "customer_name") or "Customer",
        "booking_number":  b.booking_number,
        "trip_name":       trip_name,
        "group_name":      group_name,
        "grand_total":     grand_total,
        "advance_paid":    advance_paid,
        "payment_status":  _compute_payment_status(advance_paid, grand_total),
    }


def _send_status_email(booking_name, status, email_override=None):
    """Email status: Pending / Accepted / Processing / Confirmed / Completed.
    Kandungan (subject + HTML lengkap termasuk shell/logo/footer) DITARIK
    dari Email Template doctype ("Booking Pending", "Booking Accepted", dsb.)
    — boleh diedit terus di Frappe Desk (Settings > Email Template) tanpa
    perlu sentuh kod. Function ni cuma sediakan context (data) dan hantar.

    Pautan portal disertakan untuk SEMUA status (bukan lagi booking_view+PIN).
    Emel "Set Your Password" untuk customer BAHARU dihantar BERASINGAN
    (rujuk _send_set_password_email(), dipanggil terus di confirm_booking()
    bila User baru dicipta) — bukan lagi disertakan bersyarat ke dalam
    emel status ni ikut flag is_new_user.
    """
    STATUS_TEMPLATE_MAP = {
        "Pending":    "Booking Pending",
        "Accepted":   "Booking Accepted",
        "Processing": "Booking Processing",
        "Confirmed":  "Booking Confirmed",
        "Completed":  "Booking Completed",
    }
    template_name = STATUS_TEMPLATE_MAP.get(status)
    if not template_name:
        return

    try:
        ctx = _booking_email_context(booking_name)
        if not ctx:
            return
        email = email_override or ctx["email"]
        if not email:
            return

        first_name  = ctx["full_name"].split()[0] if ctx["full_name"] else "Customer"
        site_url    = get_site_url()

        context = {
            "booking_number":   ctx["booking_number"],
            "first_name":       first_name,
            "trip_name":        ctx["trip_name"],
            "group_name":       ctx["group_name"],
            "total_fmt":        "RM {:,.2f}".format(float(ctx["grand_total"] or 0)),
            # Pending: payment belum masuk, tak perlu papar Amount Paid/Payment
            # Status (dah jelas dari konteks) — kekalkan None untuk status ni.
            "amount_paid_fmt":  ("RM {:,.2f}".format(float(ctx.get("advance_paid") or 0))
                                  if status != "Pending" else None),
            "payment_status":   ctx["payment_status"] if status != "Pending" else None,
            "booking_url":      site_url + "/traveller_portal",
        }

        email_template = frappe.get_doc("Email Template", template_name)
        message = email_template.get_formatted_response(context)
        subject = frappe.render_template(email_template.subject, context)

        frappe.sendmail(
            recipients=[email],
            # Sender TIDAK di-hardcode — rujuk nota di _send_set_password_email().
            subject=subject,
            message=message,
            now=True
        )
    except Exception as e:
        frappe.log_error("Status email (" + status + ") failed: " + str(e), "Booking Email Error")


def _receipt_pdf(pe_name):
    """Jana PDF resit dari Payment Entry guna Print Format 'Rarecation Receipt'.
    Sumber SAMA dengan portal (get_document_pdf) — resit email & portal align.
    """
    pf = frappe.db.get_value("Print Format", PRINT_FORMAT_RECEIPT, ["html"], as_dict=True)
    if not pf or not pf.get("html"):
        return None
    doc  = frappe.get_doc("Payment Entry", pe_name)
    html = frappe.render_template(pf["html"], {"doc": doc, "frappe": frappe})
    full_html = ('<!DOCTYPE html><html><head><meta charset="utf-8">'
                 '<style>@page{margin:0}body{margin:0;padding:0}</style></head><body>'
                 + html + '</body></html>')
    return frappe.utils.pdf.get_pdf(full_html)


def _send_receipt_email(pe_doc):
    """Email resit untuk satu Payment Entry (setiap bayaran = satu resit).
    Kandungan (subject + HTML) ditarik dari Email Template "Payment Receipt"
    — boleh diedit terus di Frappe Desk tanpa perlu sentuh kod.
    """
    try:
        if pe_doc.party_type != "Customer" or not pe_doc.party:
            return
        email = get_customer_email(pe_doc.party)
        if not email:
            return
        full_name  = frappe.db.get_value("Customer", pe_doc.party, "customer_name") or "Customer"
        first_name = full_name.split()[0] if full_name else "Customer"
        amount_fmt = "RM {:,.2f}".format(float(pe_doc.paid_amount or 0))

        so_name = ""
        for ref in (pe_doc.references or []):
            if ref.reference_doctype == "Sales Order":
                so_name = ref.reference_name
                break
        booking_number = ""
        if so_name:
            booking_name = _resolve_booking_from_so(so_name)
            if booking_name:
                booking_number = frappe.db.get_value("Booking", booking_name, "booking_number") or ""

        if not booking_number:
            return  # PE bukan berkaitan booking — jangan hantar resit Rarecation

        context = {
            "booking_number": booking_number or pe_doc.name,
            "first_name":     first_name,
            "amount_fmt":     amount_fmt,
        }

        email_template = frappe.get_doc("Email Template", "Payment Receipt")
        message = email_template.get_formatted_response(context)
        subject = frappe.render_template(email_template.subject, context)

        attachments = []
        pdf = _receipt_pdf(pe_doc.name)
        if pdf:
            attachments = [{"fname": "Receipt-" + pe_doc.name.replace("/", "-") + ".pdf", "fcontent": pdf}]

        frappe.sendmail(
            recipients=[email],
            # Sender TIDAK di-hardcode — rujuk nota di _send_set_password_email().
            subject=subject,
            message=message,
            attachments=attachments,
            now=True
        )
    except Exception as e:
        frappe.log_error("Receipt email failed: " + str(e), "Booking Email Error")