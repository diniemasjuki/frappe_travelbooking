# travel_booking/api/booking.py
# Booking Wizard API — Public Landing Page
# ─────────────────────────────────────────

import frappe
import json
import random
import string


# ══════════════════════════════════════════════
# 0. GET PAYMENT SETTINGS (Bank Account + Cashback)
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def get_payment_settings():
    """Bank account & cashback info untuk papar di booking.html —
    ganti nilai hardcoded (Maybank / 5% cashback) dengan Travel Settings."""
    settings = frappe.get_cached_doc("Travel Settings")
    return {
        "bank_name":                        settings.bank_name,
        "account_name":                     settings.account_name,
        "account_number":                   settings.account_number,
        "cashback_enabled":                 bool(settings.manual_transfer_cashback_enabled),
        "cashback_percent":                 float(settings.manual_transfer_cashback_percent or 0),
        "default_deposit_percent":          float(settings.default_deposit_percent or 20),
        "support_email":                    settings.support_email,
        "support_phone":                    settings.support_phone,
    }


# ══════════════════════════════════════════════
# 1. GET BOOKING DETAILS
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def get_wizard_confirmation(booking_number, pr=None):
    """Data ringan untuk papar step Confirm selepas redirect dari checkout (Stripe).
    Tiada data sensitif traveller — hanya untuk paparan status booking.
    Loose-token check via 'pr' (Payment Request) untuk elak sesiapa teka booking_number.
    """
    booking = frappe.db.sql("""
        SELECT
            b.name, b.booking_number, b.status,
            tm.trip_name, td.sailing_no, td.departure_date, td.return_date
        FROM `tabBooking` b
        LEFT JOIN `tabTrip Date`   td ON td.name = b.trip_date
        LEFT JOIN `tabTrip Master` tm ON tm.name = td.trip_master
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
        "group_name":      booking.sailing_no or "",
        "departure_date":  str(booking.departure_date) if booking.departure_date else "",
        "return_date":     str(booking.return_date) if booking.return_date else "",
        "grand_total":     grand_total,
        "advance_paid":    advance_paid,
        "payment_status":  _compute_payment_status(advance_paid, grand_total),
    }


@frappe.whitelist(allow_guest=True)
def get_booking_details(trip_date, trip_package=None):
    """Return trip + sailing info + cabin categories with pricing.
    Pricing dibaca dari Room Pricing (child Trip Date).
    Room Availability dibuang — inventori bilik diurus manual oleh admin.
    """
    td = frappe.db.get_value(
        "Trip Date", trip_date,
        ["name", "trip_master", "sailing_no", "status",
         "departure_date", "return_date", "sailing_start", "sailing_end",
         "ship_name", "cruise_line", "embarkation_port", "disembarkation_port"],
        as_dict=True
    )
    if not td:
        frappe.throw("Trip Date tidak ditemui.")

    trip = frappe.db.get_value(
        "Trip Master", td.trip_master,
        ["name", "trip_name", "trip_type", "trip_code",
         "duration_days", "duration_nights", "description"],
        as_dict=True
    )
    if not trip:
        frappe.throw("Trip tidak ditemui.")

    # Pricing rows dari Room Pricing child table
    pricing_rows = frappe.db.sql("""
        SELECT
            rp.room_category,
            rc.room_type,
            rc.capacity,
            rc.description,
            rp.price_twin,
            rp.price_single,
            rp.price_third,
            rp.price_child,
            rp.price_infant
        FROM `tabRoom Pricing` rp
        JOIN `tabRoom Category` rc ON rc.name = rp.room_category
        WHERE rp.parent = %s AND rp.parenttype = 'Trip Package'
        ORDER BY rp.idx ASC
    """, trip_package, as_dict=True)

    cabins = []
    for row in pricing_rows:
        # Room Availability doctype dibuang — semua kategori dianggap available.
        # Kawalan bilik sebenar diurus admin (order batch dari Aroya).
        available = 1

        cabins.append({
            "room_category": row.room_category,
            "room_name":     row.room_category,
            "room_type":     row.room_type,
            "capacity":      row.capacity or 2,
            "description":   row.description or "",
            "pricing": {
                "price_twin":   float(row.price_twin   or 0),
                "price_single": float(row.price_single or 0),
                "price_third":  float(row.price_third  or 0),
                "price_child":  float(row.price_child  or 0),
                "price_infant": float(row.price_infant or 0),
            },
            "available":    available,
            "is_available": available > 0,
        })

    return {
        "trip": {
            "name":            trip.name,
            "trip_name":       trip.trip_name,
            "trip_type":       trip.trip_type,
            "trip_code":       trip.trip_code,
            "duration_days":   trip.duration_days,
            "duration_nights": trip.duration_nights,
            "description":     trip.description or "",
        },
        "trip_date": {
            "name":           td.name,
            "sailing_no":     td.sailing_no,
            "departure_date": str(td.departure_date) if td.departure_date else "",
            "return_date":    str(td.return_date)    if td.return_date    else "",
            "ship_name":      td.ship_name or "",
            "cruise_line":    td.cruise_line or "",
        },
        "cabins": cabins,
    }


# ══════════════════════════════════════════════
# 2. SEND OTP
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True, methods=["POST"])
def send_otp(email):
    email = (email or "").strip().lower()
    if not email:
        frappe.throw("Sila masukkan alamat email.")

    existing = frappe.db.sql("""
        SELECT dl.link_name
        FROM `tabContact Email` ce
        JOIN `tabContact` c ON c.name = ce.parent
        JOIN `tabDynamic Link` dl ON dl.parent = c.name
        WHERE ce.email_id = %s AND dl.link_doctype = 'Customer'
        LIMIT 1
    """, email, as_dict=True)

    if existing:
        return {"verified": True, "message": "Email disahkan."}

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
def verify_otp(email, otp):
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
def validate_voucher(code, trip_date, grand_total, email=""):
    """Validate voucher + return discount. Scope: trip / trip_date / room_category."""
    code        = (code or "").strip().upper()
    grand_total = float(grand_total or 0)

    if not code:
        return {"valid": False, "message": "Please enter a voucher code."}

    voucher = frappe.db.get_value(
        "Voucher", {"voucher_code": code},
        ["name", "status", "voucher_type", "discount_value",
         "valid_from", "valid_to", "max_uses", "used_count",
         "trip", "trip_date", "room_category"],
        as_dict=True
    )

    if not voucher:
        return {"valid": False, "message": "Invalid voucher code."}
    if voucher.status != "Active":
        return {"valid": False, "message": "This voucher is no longer active."}

    now = frappe.utils.now_datetime()
    if voucher.valid_from and frappe.utils.get_datetime(voucher.valid_from) > now:
        return {"valid": False, "message": "This voucher is not yet valid."}
    if voucher.valid_to and frappe.utils.get_datetime(voucher.valid_to) < now:
        return {"valid": False, "message": "This voucher has expired."}

    if voucher.max_uses and (voucher.used_count or 0) >= voucher.max_uses:
        return {"valid": False, "message": "This voucher has reached its maximum usage."}

    # Scope check: trip_date
    if voucher.trip_date and voucher.trip_date != trip_date:
        return {"valid": False, "message": "This voucher is not valid for this sailing."}

    # Scope check: trip (via trip_date.trip_master)
    if voucher.trip:
        td_trip = frappe.db.get_value("Trip Date", trip_date, "trip_master")
        if voucher.trip != td_trip:
            return {"valid": False, "message": "This voucher is not valid for this trip."}

    # Once per customer
    if email:
        customer = _get_customer_by_email(email.strip().lower())
        if customer:
            already = frappe.db.exists(
                "Voucher Usage", {"parent": voucher.name, "customer": customer}
            )
            if already:
                return {"valid": False, "message": "You have already used this voucher."}

    if voucher.voucher_type == "Percentage":
        discount_amount = round(grand_total * (voucher.discount_value / 100), 2)
    else:
        discount_amount = min(float(voucher.discount_value), grand_total)

    return {
        "valid":           True,
        "discount_amount": discount_amount,
        "voucher_type":    voucher.voucher_type,
        "discount_value":  voucher.discount_value,
        "message":         "Voucher applied! You save " + fmt_currency(discount_amount) + ".",
    }


def fmt_currency(amount):
    return "RM {:,.2f}".format(float(amount))


# ══════════════════════════════════════════════
# 5b. REFERRAL / AFFILIATE CODE VALIDATION
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def validate_affiliate_code(code, trip_date=None):
    """Validate referral/affiliate code. Discount % tetap sama untuk semua
    trip — diambil dari Travel Settings.default_referral_discount_percent
    (bukan dari Affliate atau Trip Date), ikut keputusan admin.
    """
    code = (code or "").strip().upper()
    if not code:
        return {"valid": False, "message": "Please enter a referral code."}

    affiliate = frappe.db.get_value(
        "Affliate", {"referral_code": code},
        ["name", "affiliate_name", "status"], as_dict=True
    )
    if not affiliate:
        return {"valid": False, "message": "Invalid referral code."}
    if affiliate.status != "Active":
        return {"valid": False, "message": "This referral code is no longer active."}

    settings = frappe.get_cached_doc("Travel Settings")
    discount_percent = float(settings.default_referral_discount_percent or 0)

    if discount_percent <= 0:
        return {"valid": False, "message": "Referral discount is not currently configured."}

    return {
        "valid":            True,
        "discount_percent": discount_percent,
        "affiliate_name":   affiliate.affiliate_name,
        "message":          "Referral code applied! You get " + str(discount_percent) + "% off.",
    }


# ══════════════════════════════════════════════
# 6. PRICING — BACKEND CALCULATION
# ══════════════════════════════════════════════

def _get_pricing_map(trip_package):
    """Return {room_category: {...}} dari Room Pricing (child Trip Package)."""
    rows = frappe.db.sql("""
        SELECT room_category, price_twin, price_single,
               price_third, price_child, price_infant
        FROM `tabRoom Pricing`
        WHERE parent = %s AND parenttype = 'Trip Package'
    """, trip_package, as_dict=True)
    return {r.room_category: r for r in rows}


def _price_selection(price, adults, children, infants):
    """Kira harga satu selection ikut peraturan B.
    1 adult = single; 2 adult = twin x2; adult ke-3+ = third.
    """
    total = 0.0
    a = int(adults or 0)
    c = int(children or 0)
    i = int(infants or 0)

    if a == 1:
        total += float(price.price_single or price.price_twin or 0)
    elif a >= 2:
        total += float(price.price_twin or 0) * 2
        if a > 2:
            total += float(price.price_third or 0) * (a - 2)

    total += float(price.price_child  or 0) * c
    total += float(price.price_infant or 0) * i
    return round(total, 2)


# ══════════════════════════════════════════════
# 7. CONFIRM BOOKING
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def confirm_booking(trip_date, selections, billing,
                    payment_type="Full Payment", payment_method="Online Payment",
                    receipt=None, voucher_code="", affiliate_code="", amount_paid=None,
                    trip_package=None):
    if isinstance(selections, str):
        selections = json.loads(selections)
    if isinstance(billing, str):
        billing = json.loads(billing)

    email = billing.get("email", "").strip().lower()

    is_verified       = frappe.cache().get_value("booking_email_verified_" + email)
    existing_customer = _get_customer_by_email(email)

    if not existing_customer and not is_verified:
        frappe.throw("Email belum disahkan. Sila verify OTP dahulu.")

    customer_name = existing_customer or _create_customer(billing)

    # Trip info
    td = frappe.db.get_value("Trip Date", trip_date,
                             ["trip_master", "sailing_no", "departure_date"], as_dict=True)
    if not td:
        frappe.throw("Trip Date tidak ditemui.")
    trip_name = frappe.db.get_value("Trip Master", td.trip_master, "trip_name") or ""

    if not trip_package:
        frappe.throw("Sila pilih pakej terlebih dahulu.")

    # Backend pricing (dari Trip Package yang dipilih)
    pricing_map = _get_pricing_map(trip_package)
    so_items    = _build_so_items(selections, pricing_map, trip_name, td.sailing_no)
    grand_total = sum(float(it["rate"]) * int(it["qty"]) for it in so_items)
    pre_discount_total = grand_total  # snapshot BEFORE any voucher/referral discount — used for affiliate commission calc later

    # Voucher
    voucher_discount = 0
    if voucher_code:
        vr = validate_voucher(voucher_code, trip_date, grand_total, billing.get("email", ""))
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
    # dengan UI). Discount % tetap sama untuk semua trip (Travel Settings).
    referral_discount = 0
    affiliate_name    = None
    if affiliate_code:
        ar = validate_affiliate_code(affiliate_code, trip_date)
        if ar.get("valid"):
            affiliate_name    = frappe.db.get_value("Affliate", {"referral_code": affiliate_code.strip().upper()}, "name")
            referral_percent  = float(ar.get("discount_percent", 0))
            referral_discount = round(grand_total * (referral_percent / 100), 2)
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
        }
        if cashback_percent > 0:
            if not settings.cashback_discount_account:
                frappe.throw("Cashback Discount Account belum ditetapkan dalam Travel Settings.")
            so_payload.update({
                "apply_discount_on":              "Grand Total",
                "additional_discount_percentage": cashback_percent,
                "additional_discount_account":    settings.cashback_discount_account,
            })

        so = frappe.get_doc(so_payload)
        so.insert(ignore_permissions=True)
        so.flags.ignore_permissions = True
        so.submit()
    finally:
        frappe.set_user(_original_user)

    # Guna grand_total SEBENAR dari SO (selepas additional discount, jika ada)
    # supaya deposit/full-payment dikira dari jumlah yang betul-betul perlu dibayar.
    grand_total = so.grand_total

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
        "trip_date":      trip_date,
        "trip_package":   trip_package,
        "customer":       customer_name,
        "status":         "Pending",
        "payment_status": "Pending",
        "payment_method": payment_method,
        "payment_type":   payment_type,
        "deposit_amount": deposit_amount if payment_type == "Deposit" else 0,
        "booking_number": _generate_booking_number(),
        "affiliate":            affiliate_name if referral_discount > 0 else None,
        "referral_code_used":   affiliate_code.strip().upper() if referral_discount > 0 else "",
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
        _use_voucher(voucher_code, customer_name, booking.name)

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
        )

    frappe.db.commit()

    if payment_method == "Manual Transfer":
        # Manual Transfer — booking betul-betul "Pending" (menunggu admin
        # verify resit), jadi emel "Pending" dihantar terus di sini. (Wizard
        # memaksa upload resit sebelum submit, tapi check ni tak bergantung
        # pada 'receipt' supaya tetap selamat kalau dipanggil terus via API.)
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



def _create_manual_payment_entry(so_name, customer_name, amount, receipt_data="", label="receipt"):
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
        pe.reference_no    = so_name
        pe.reference_date  = frappe.utils.today()
        pe.append("references", {
            "reference_doctype": "Sales Order",
            "reference_name":    so_name,
            "allocated_amount":  float(amount),
        })
        pe.remarks = "Manual transfer (booking) untuk " + so_name + ". Pending verification."
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


def _get_customer_email_by_name(customer_name):
    result = frappe.db.sql("""
        SELECT ce.email_id
        FROM `tabContact Email` ce
        JOIN `tabContact` c ON c.name = ce.parent
        JOIN `tabDynamic Link` dl ON dl.parent = c.name
        WHERE dl.link_doctype = 'Customer' AND dl.link_name = %s
        ORDER BY ce.is_primary DESC LIMIT 1
    """, customer_name, as_dict=True)
    return result[0].email_id if result else None


def _get_customer_by_email(email):
    result = frappe.db.sql("""
        SELECT dl.link_name
        FROM `tabContact Email` ce
        JOIN `tabContact` c ON c.name = ce.parent
        JOIN `tabDynamic Link` dl ON dl.parent = c.name
        WHERE ce.email_id = %s AND dl.link_doctype = 'Customer'
        LIMIT 1
    """, email, as_dict=True)
    return result[0].link_name if result else None


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


def _build_so_items(selections, pricing_map, trip_name="", sailing_no=""):
    """Bina SO items dengan harga dari backend pricing_map."""
    items        = []
    default_item = _get_or_create_travel_item()

    for cabin_no, sel in enumerate(selections, start=1):
        room_category = sel.get("room_category")
        adults        = int(sel.get("adults", 0))
        children      = int(sel.get("children", 0))
        infants       = int(sel.get("infants", 0))

        price = pricing_map.get(room_category)
        if not price:
            frappe.throw("Harga tidak ditemui untuk kategori: " + str(room_category))

        # Adult
        if adults == 1:
            items.append(_so_line(default_item, room_category, "Adult (Single)",
                                  1, float(price.price_single or price.price_twin or 0),
                                  trip_name, sailing_no, cabin_no))
        elif adults >= 2:
            items.append(_so_line(default_item, room_category, "Adult (Twin)",
                                  2, float(price.price_twin or 0),
                                  trip_name, sailing_no, cabin_no))
            if adults > 2:
                items.append(_so_line(default_item, room_category, "Adult (3rd Pax)",
                                      adults - 2, float(price.price_third or 0),
                                      trip_name, sailing_no, cabin_no))
        # Child
        if children > 0:
            items.append(_so_line(default_item, room_category, "Child",
                                  children, float(price.price_child or 0),
                                  trip_name, sailing_no, cabin_no))
        # Infant
        if infants > 0:
            items.append(_so_line(default_item, room_category, "Infant",
                                  infants, float(price.price_infant or 0),
                                  trip_name, sailing_no, cabin_no))
    return items


def _so_line(item_code, room_category, pax_type, qty, rate, trip_name, sailing_no, cabin_no=1):
    cabin_tag = "Cabin " + str(cabin_no)
    return {
        "item_code":   item_code,
        "item_name":   room_category + " (" + cabin_tag + ") \u2014 " + pax_type,
        "qty":         qty,
        "rate":        rate,
        "uom":         "Nos",
        "description": trip_name + " | " + sailing_no + " | " + room_category + " | " + cabin_tag + " | " + pax_type,
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
    description: 'Trip | Sailing | Room Category | Cabin N | Pax Type'.
    Return: [{cabin_no, room_category, pax}] disusun ikut cabin_no.
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
        try:
            cabin_no = int(cabin_tag.lower().replace("cabin", "").strip())
        except Exception:
            continue
        if cabin_no not in layout:
            layout[cabin_no] = {"cabin_no": cabin_no, "room_category": room_category, "pax": 0}
        layout[cabin_no]["pax"] += int(it.qty or 0)
    return [layout[n] for n in sorted(layout.keys())]


def _activate_booking(booking_name):
    """Cipta Reservation (status Active) bila booking Confirmed. Idempotent.
    Reservation dicipta dengan room_category sahaja; flight & stateroom admin assign.
    Cabin layout diambil dari SO UTAMA (cabin booking asal), bukan addon SO.
    """
    if frappe.db.count("Reservation", {"booking": booking_name}):
        return 0
    so_name = _get_primary_so(booking_name)
    if not so_name:
        return 0
    count = 0
    for cabin in _cabin_layout_from_so(so_name):
        for _ in range(int(cabin.get("pax", 0))):
            frappe.get_doc({
                "doctype":         "Reservation",
                "booking":         booking_name,
                "room_category":   cabin.get("room_category"),
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

    total = 0
    paid  = 0
    for name in all_so_names:
        so = frappe.db.get_value("Sales Order", name, ["grand_total", "advance_paid"], as_dict=True)
        if so:
            total += so.grand_total  or 0
            paid  += so.advance_paid or 0

    new_payment_status = _compute_payment_status(paid, total)

    b = frappe.db.get_value("Booking", booking_name, ["name", "status", "payment_status"], as_dict=True)
    if not b:
        return

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
        JOIN `tabTrip Date` td ON td.name = b.trip_date
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
    """Lepaskan voucher yang diguna booking ni (decrement used_count + buang usage row)."""
    for u in frappe.db.get_all("Voucher Usage",
                               filters={"booking": booking_name},
                               fields=["parent"]):
        try:
            v = frappe.get_doc("Voucher", u.parent)
            v.usage = [row for row in v.usage if row.booking != booking_name]
            v.used_count = max(0, (v.used_count or 0) - 1)
            v.save(ignore_permissions=True)
        except Exception:
            pass


def _cancel_booking_cascade(booking_doc):
    """Bila booking Cancelled: reservation -> Inactive, lepas voucher,
    cancel SEMUA SO berkaitan (utama + addon) yang belum bayar (kalau dah
    bayar, log utk refund manual — SO tu KEKAL, tak di-cancel). Kalau ada
    bayaran sedia ada, payment_status ditukar ke "Request Refund" supaya
    admin nampak booking ni perlukan proses refund (Pending Refund/Refunded
    ditetapkan admin secara manual selepas refund diproses melalui bank/Stripe).
    """
    for r in frappe.get_all("Reservation",
                            filters={"booking": booking_doc.name, "status": "Confirmed"},
                            fields=["name"]):
        res = frappe.get_doc("Reservation", r.name)
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


def _use_voucher(code, customer_name, booking_name):
    """Increment used_count + record usage."""
    try:
        code = (code or "").strip().upper()
        voucher_name = frappe.db.get_value("Voucher", {"voucher_code": code}, "name")
        if not voucher_name:
            return
        voucher_doc = frappe.get_doc("Voucher", voucher_name)
        voucher_doc.append("usage", {
            "customer":  customer_name,
            "booking":   booking_name,
            "used_date": frappe.utils.now_datetime(),
        })
        voucher_doc.used_count = (voucher_doc.used_count or 0) + 1
        voucher_doc.save(ignore_permissions=True)
    except Exception as e:
        frappe.log_error("Voucher usage tracking failed: " + str(e), "Voucher Error")


def _generate_booking_number():
    while True:
        suffix = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        booking_number = "RC-" + suffix
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
            sender="no-reply@rarecruise.com",
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
        td = frappe.db.get_value("Trip Date", b.trip_date, ["trip_master", "sailing_no"], as_dict=True)
        if td:
            group_name = td.sailing_no or ""
            trip_name = frappe.db.get_value("Trip Master", td.trip_master, "trip_name") or ""
    grand_total   = 0
    advance_paid  = 0
    for so_name in _get_all_booking_sales_orders(booking_name):
        so_vals = frappe.db.get_value("Sales Order", so_name,
                                      ["grand_total", "advance_paid"], as_dict=True)
        if so_vals:
            grand_total  += so_vals.grand_total  or 0
            advance_paid += so_vals.advance_paid or 0
    return {
        "email":           _get_customer_email_by_name(b.customer),
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
            sender="no-reply@rarecruise.com",
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
        email = _get_customer_email_by_name(pe_doc.party)
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
            sender="no-reply@rarecruise.com",
            subject=subject,
            message=message,
            attachments=attachments,
            now=True
        )
    except Exception as e:
        frappe.log_error("Receipt email failed: " + str(e), "Booking Email Error")