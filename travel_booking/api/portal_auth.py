# travel_booking/api/portal_auth.py
# Portal Authentication — Frappe Native Session
# ─────────────────────────────────────────────

import frappe


# ══════════════════════════════════════════════
# HELPERS (internal)
# ══════════════════════════════════════════════

def _fetch_bookings(customer_name):
    """Fetch bookings untuk customer.
    - trip_name dari Trip Master (via Trip Date)
    - departure_date, return_date, sailing_no dari Trip Date
    - total_slots dan filled_count dari Reservation
    (Sales Order TIDAK lagi dipaparkan pada kad booking — 1 booking boleh ada
    banyak SO sekarang, jadi paparan dipindah ke tab Transactions/Payment &
    Invoice khusus booking, bukan diringkaskan ke satu field di sini.)
    """
    bookings = frappe.db.sql("""
        SELECT
            b.name,
            b.booking_number,
            b.status AS booking_status,
            tm.trip_name,
            tm.trip_type,
            td.sailing_no,
            td.departure_date,
            td.return_date
        FROM `tabBooking` b
        LEFT JOIN `tabTrip Date`   td ON td.name = b.trip_date
        LEFT JOIN `tabTrip Master` tm ON tm.name = td.trip_master
        WHERE b.customer = %s
        ORDER BY td.departure_date ASC
    """, customer_name, as_dict=True)

    for bk in bookings:
        total = frappe.db.count("Reservation", {"booking": bk["name"]})
        counts = frappe.db.sql("""
            SELECT
                COUNT(*) as filled,
                SUM(CASE WHEN document_status = 'Verified' THEN 1 ELSE 0 END) as verified
            FROM `tabReservation`
            WHERE booking = %s AND (traveller IS NOT NULL AND traveller != '')
        """, bk["name"], as_dict=True)
        filled_count   = counts[0].filled   if counts else 0
        verified_count = counts[0].verified if counts else 0
        bk["total_slots"]     = total
        bk["filled_count"]    = filled_count
        bk["verified_count"]  = int(verified_count or 0)
        bk["all_verified"]    = 1 if (total > 0 and int(verified_count or 0) >= total) else 0
        bk["pax_assigned"]    = 1 if (total > 0 and filled_count >= total) else 0
        bk["departure_date"]  = str(bk["departure_date"]) if bk["departure_date"] else ""
        bk["return_date"]     = str(bk["return_date"])    if bk["return_date"]    else ""
        bk["trip_name"]       = bk["trip_name"] or bk["name"]
        bk["sailing_no"]      = bk["sailing_no"] or ""

    return bookings


# ══════════════════════════════════════════════
# CHECK SESSION
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def check_session():
    """Check sama ada user dah login."""
    frappe.flags.ignore_permissions = True

    user_email = frappe.session.user
    if not user_email or user_email == "Guest":
        return {"status": "guest", "logged_in": False}

    result = frappe.db.sql("""
        SELECT dl.link_name as customer_name
        FROM `tabContact Email` ce
        JOIN `tabContact` c ON c.name = ce.parent
        JOIN `tabDynamic Link` dl ON dl.parent = c.name
        WHERE ce.email_id = %s
          AND dl.link_doctype = 'Customer'
        LIMIT 1
    """, user_email, as_dict=True)

    if not result:
        return {"status": "no_customer", "logged_in": False}

    customer = frappe.db.get_value(
        "Customer", result[0].customer_name,
        ["name", "customer_name"],
        as_dict=True
    )
    if not customer:
        return {"status": "no_customer", "logged_in": False}

    bookings = _fetch_bookings(customer.name)
    return {
        "status":        "ok",
        "logged_in":     True,
        "customer_name": customer.customer_name,
        "customer_id":   customer.name,
        "email":         user_email,
        "bookings":      bookings
    }


# ══════════════════════════════════════════════
# SET PASSWORD
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def set_password(key, email, new_password):
    if not key or not email or not new_password:
        frappe.throw("Maklumat tidak lengkap.")

    if len(new_password) < 8:
        frappe.throw("Password mestilah sekurang-kurangnya 8 aksara.")

    user = frappe.db.get_value(
        "User",
        {"email": email, "reset_password_key": key},
        "name"
    )
    if not user:
        frappe.throw("Link telah tamat tempoh atau tidak sah. Sila minta link baru.")

    from frappe.utils.password import update_password
    update_password(user, new_password)
    frappe.db.set_value("User", user, "reset_password_key", "")
    frappe.db.commit()
    return {"status": "ok", "message": "Password berjaya ditetapkan. Sila log in."}


# ══════════════════════════════════════════════
# FORGOT PASSWORD
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def forgot_password(email):
    if not email:
        frappe.throw("Sila masukkan alamat email.")

    user = frappe.db.get_value("User", {"email": email}, "name")
    if not user:
        return {"status": "ok", "message": "Jika email ini berdaftar, link akan dihantar."}

    customer_check = frappe.db.sql("""
        SELECT dl.link_name
        FROM `tabContact Email` ce
        JOIN `tabContact` c ON c.name = ce.parent
        JOIN `tabDynamic Link` dl ON dl.parent = c.name
        WHERE ce.email_id = %s AND dl.link_doctype = 'Customer'
        LIMIT 1
    """, email, as_dict=True)
    if not customer_check:
        return {"status": "ok", "message": "Jika email ini berdaftar, link akan dihantar."}

    reset_key = frappe.generate_hash(length=32)
    frappe.db.set_value("User", user, "reset_password_key", reset_key)

    from travel_booking.api.booking import get_site_url
    site_url   = get_site_url()
    reset_link = site_url + "/set-password?key=" + reset_key + "&email=" + email + "&mode=reset"

    frappe.sendmail(
        recipients=[email],
        sender="no-reply@rarecruise.com",
        subject="Rarecation Portal — Reset Password Anda",
        message="""
            <p>Anda telah meminta untuk reset password portal Rarecation.</p>
            <p>Klik link di bawah untuk set password baru:</p>
            <p><a href=\"""" + reset_link + """\" style="background:#D4A312;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;">Reset Password &rarr;</a></p>
            <p style="color:#888;font-size:12px;">Link ini sah selama 24 jam.</p>
            <p style="color:#888;font-size:12px;">Jika anda tidak meminta reset ini, abaikan email ini.</p>
        """,
        now=True
    )

    frappe.db.commit()
    return {"status": "ok", "message": "Jika email ini berdaftar, link akan dihantar."}


@frappe.whitelist(allow_guest=True)
def send_magic_link_by_email(email):
    """Portal login — hantar magic link ke email registered.
    User portal kini SENTIASA dicipta serentak dengan Booking (rujuk
    _ensure_portal_user() di api/booking.py) — jadi function ni tak perlu
    auto-create User lagi, cukup cari User sedia ada. Kalau email tak
    berdaftar (jarang — cth customer taip salah email), return mesej
    generic sahaja (elak bocor maklumat sama ada email tu wujud)."""
    email = (email or "").strip().lower()
    if not email:
        frappe.throw("Sila masukkan alamat email.")

    generic_msg = "Jika email ini berdaftar, anda akan menerima link log masuk."

    user = frappe.db.get_value("User", {"email": email, "enabled": 1}, "name")
    if not user:
        return {"status": "ok", "message": generic_msg}

    customer_check = frappe.db.sql("""
        SELECT dl.link_name
        FROM `tabContact Email` ce
        JOIN `tabContact` c ON c.name = ce.parent
        JOIN `tabDynamic Link` dl ON dl.parent = c.name
        WHERE ce.email_id = %s AND dl.link_doctype = 'Customer'
        LIMIT 1
    """, email, as_dict=True)

    if not customer_check:
        return {"status": "ok", "message": generic_msg}

    expiry_minutes = 30
    key = frappe.generate_hash(length=32)
    # Cache key custom kita SENDIRI (bukan "one_time_login_key:" Frappe) —
    # sengaja berasingan, sebab endpoint kita (login_via_portal_key,
    # di bawah) TIDAK delete key selepas guna (boleh reuse dalam tempoh
    # sah), berbeza dari Frappe punya frappe.www.login.login_via_key
    # yang one-time by design (delete-after-use, hardcoded dalam
    # framework core — tak boleh kita ubah dari sini). Guna endpoint
    # Frappe punya juga bermasalah sebab ia TIDAK baca parameter
    # redirect-to untuk destinasi Website User — ia ikut Website
    # Settings > Home Page sahaja (redirect_post_login()).
    frappe.cache().set_value(
        "portal_login_key:" + key,
        email,
        expires_in_sec=expiry_minutes * 60
    )

    magic_url = frappe.utils.get_url(
        "/api/method/travel_booking.api.portal_auth.login_via_portal_key?key=" + key
    )

    first_name = frappe.db.get_value("User", user, "first_name") or "Customer"

    frappe.sendmail(
        recipients=[email],
        sender="no-reply@rarecruise.com",
        subject="Rarecation Portal — Log Masuk",
        message="""
            <div style="font-family:'DM Sans',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
                <p style="font-size:15px;font-weight:500;color:#1E1C18;margin-bottom:8px">
                    Hi """ + first_name + """,
                </p>
                <p style="font-size:14px;color:#5C5850;margin-bottom:24px;line-height:1.6">
                    Klik butang di bawah untuk log masuk ke portal Rarecation anda.
                    Link ini sah selama <strong>""" + str(expiry_minutes) + """ minit</strong>.
                </p>
                <p style="margin-bottom:32px">
                    <a href=\"""" + magic_url + """\"
                       style="display:inline-block;background:#D4A312;color:#1E1C18;
                              font-weight:600;font-size:14px;padding:12px 28px;
                              border-radius:8px;text-decoration:none">
                        Log Masuk ke Portal &rarr;
                    </a>
                </p>
                <p style="font-size:12px;color:#B0AC9F;line-height:1.6">
                    Jika anda tidak membuat permintaan ini, abaikan email ini.<br>
                    Link ini akan tamat dalam """ + str(expiry_minutes) + """ minit.
                </p>
            </div>
        """,
        now=True
    )

    parts  = email.split("@")
    masked = parts[0][:2] + "***@" + parts[1] if len(parts) == 2 else "***"

    return {
        "status":  "ok",
        "masked":  masked,
        "message": "Link log masuk dihantar ke " + masked + "."
    }


@frappe.whitelist(allow_guest=True)
def login_via_portal_key(key):
    """Custom magic-link login — pengganti frappe.www.login.login_via_key.
    Dua sebab kenapa perlu custom (bukan guna Frappe punya built-in):
      1. Expiry-only, BUKAN one-time — key TIDAK dipadam selepas guna,
         jadi boleh diguna berkali-kali sehingga tamat tempoh (30 minit).
      2. Redirect terus ke /traveller_portal — Frappe punya login_via_key
         mengabaikan sebarang parameter redirect-to untuk destinasi
         Website User (guna redirect_post_login() -> Website Settings
         Home Page sahaja), jadi customer akan tersasar ke home page
         default site (bukan portal kita) kalau guna endpoint asal.
    """
    cache_key = "portal_login_key:" + key
    email = frappe.cache().get_value(cache_key)

    if not email:
        frappe.respond_as_web_page(
            "Link Expired",
            "This login link is invalid or has expired. Please request a new link.",
            http_status_code=403,
            indicator_color="red"
        )
        return

    frappe.local.login_manager.login_as(email)
    frappe.local.response["type"]     = "redirect"
    frappe.local.response["location"] = "/traveller_portal"