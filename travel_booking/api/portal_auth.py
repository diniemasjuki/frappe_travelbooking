# travel_booking/api/portal_auth.py
# Portal Authentication — Frappe Native Session
# ─────────────────────────────────────────────

import frappe
from travel_booking.api._helpers import get_customer_by_email


@frappe.whitelist(allow_guest=True)
def get_google_login_url(redirect_to: str = "/traveller_portal/bookings") -> str:
    """Returns the fully-formed Google OAuth authorize URL (client_id,
    redirect_uri, scope, and a CSRF state token all included), so the
    portal's "Sign in with Google" button can redirect straight to
    Google — instead of stopping at Frappe's own generic /login page
    first (yang mana perlukan state token yang dijana server-side,
    tak boleh hardcode selamat di frontend).

    Sama pattern dengan affiliate app punya get_google_login_url()
    (affiliate/api/portal_api.py) — reuse Social Login Key Google yang
    SAMA (config sekali di Desk, dua-dua app boleh guna).

    Jalan sebagai Guest (belum login) sebab ini dipanggil SEBELUM
    authentication berlaku — itu tujuan Sign in with Google.
    """
    from frappe.utils.oauth import get_oauth2_authorize_url

    return get_oauth2_authorize_url("google", redirect_to)


# ══════════════════════════════════════════════
# HELPERS (internal)
# ══════════════════════════════════════════════

def _fetch_bookings(customer_name):
    """Fetch bookings untuk customer.
    - trip_name dari Trip (via Trip Group Date)
    - departure_date, return_date, sailing_no dari Trip Group Date
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
            td.trip_group_name,
            td.departure_date,
            td.return_date
        FROM `tabBooking` b
        LEFT JOIN `tabTrip Group Date`   td ON td.name = b.trip_date
        LEFT JOIN `tabTrip` tm ON tm.name = td.trip
        WHERE b.customer = %s
        ORDER BY td.departure_date ASC
    """, customer_name, as_dict=True)

    for bk in bookings:
        total = frappe.db.count("Booking Reservation", {"booking": bk["name"]})
        counts = frappe.db.sql("""
            SELECT
                COUNT(*) as filled,
                SUM(CASE WHEN document_status = 'Verified' THEN 1 ELSE 0 END) as verified
            FROM `tabBooking Reservation`
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
        bk["sailing_no"]      = bk["trip_group_name"] or ""

    return bookings


def _email_has_booking(email):
    """True kalau ada rekod Booking dengan cust_email = email ni.
    Guna cust_email snapshot field (ditulis semasa booking dicipta oleh
    confirm_booking). Ini jadi kelayakan utama utk assign role Customer
    pada signup — bukan kewujudan Customer (yang mungkin belum dicipta).
    """
    if not email:
        return False
    return bool(frappe.db.exists("Booking", {"cust_email": email}))


# ══════════════════════════════════════════════
# CHECK SESSION
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def check_session():
    """Check sama ada user dah login DAN patut dapat akses portal.

    Akses dibenarkan dalam DUA keadaan:
      1. Ada rekod Customer link kepada email ni (customer sebenar,
         biasa datang dari booking pertama — rujuk _ensure_portal_user()
         dalam booking.py) — keadaan paling biasa untuk customer tulen.
      2. TIADA Customer, tapi User ada role "Customer" — cth staff/admin
         yang sengaja diberi role ni secara manual di Desk untuk tujuan
         testing/akses dalaman, tanpa perlu 'booking palsu' semata-mata
         untuk cipta rekod Customer (yang boleh mengotorkan data
         accounting/CRM ERPNext sebenar). Portal papar dashboard KOSONG
         (0 booking) untuk kes ni — bukan skrin 'please login' yang
         mengelirukan — sebab dari segi Frappe session, mereka MEMANG
         dah authenticated dengan sah.

    NOTA: untuk customer SEBENAR, role "Customer" dan rekod Customer
    SENTIASA dicipta serentak dalam SATU transaksi confirm_booking() —
    jadi keadaan "ada role tapi tiada Customer" hanya berlaku untuk
    akaun yang role-nya diberi terus di Desk (staff/testing), bukan
    customer yang betul-betul buat booking.

    DIAGNOSTIC: jika user AUTHENTICATED (bukan Guest) tetapi tiada rekod
    Customer link (cth Contact putus, admin edit di Desk, data migrate)
    pulang status "no_customer_link" BUKAN no_customer. no_customer
    (logged_in: False) HANYA untuk user yang TIADA role Customer dan
    TIADA Customer — kemungkinan akaun separuh jadi. Sebelum ni, customer
    yang login sah tapi Contact putus dapat skrin login berulang
    (logged_in: False) — mengelirukan sebab mereka MEMANG dah login,
    cuba login semula tetap gagal sebab punca sebenar ialah link data,
    bukan authentication.
    """
    frappe.flags.ignore_permissions = True

    user_email = frappe.session.user
    if not user_email or user_email == "Guest":
        return {"status": "guest", "logged_in": False}

    # Profile photo (User.user_image) — dipakai oleh nav avatar dropdown.
    user_image = frappe.db.get_value("User", user_email, "user_image") or ""

    # Gatekeeper: hanya role "Customer" dibenarkan akses portal.
    # Tiada role = akaun "under review" (signup tanpa booking). Customer
    # record bukan syarat utama lagi — role adalah satu-satunya pintu
    # masuk. Sebelum ni, Customer jadi gatekeeper; sekarang role.
    if "Customer" not in frappe.get_roles(user_email):
        return {
            "status":     "under_review",
            "logged_in":  True,
            "email":      user_email,
            "user_image": user_image,
            "message":    (
                "Your account is under review. "
                "Portal access is granted after your first booking."
            ),
        }

    customer_name = get_customer_by_email(user_email)

    if not customer_name:
        # Ada role Customer tapi tiada Customer (cth staff/testing, atau
        # user yang role-nya diberi manual di Desk). Dashboard kosong —
        # bukan redirect ke login, sebab session mereka sah.
        full_name = frappe.db.get_value("User", user_email, "full_name") or user_email
        return {
            "status":        "ok",
            "logged_in":     True,
            "customer_name": full_name,
            "customer_id":   None,
            "email":         user_email,
            "user_image":    user_image,
            "bookings":      [],
        }

    customer = frappe.db.get_value(
        "Customer", customer_name,
        ["name", "customer_name"],
        as_dict=True
    )
    if not customer:
        # Rekod Customer wujud pada link tapi docname tak jumpa (data
        # integrity issue). Sama — diagnostic, bukan login screen.
        return {
            "status":    "no_customer_link",
            "logged_in": True,
            "email":     user_email,
            "user_image": user_image,
            "message":   "No customer record found. Please contact support.",
        }

    bookings = _fetch_bookings(customer.name)
    return {
        "status":        "ok",
        "logged_in":     True,
        "customer_name": customer.customer_name,
        "customer_id":   customer.name,
        "email":         user_email,
        "user_image":    user_image,
        "bookings":      bookings
    }


# ══════════════════════════════════════════════
# SET PASSWORD
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def set_password(key: str, email: str, new_password: str):
    if not key or not email or not new_password:
        frappe.throw("Incomplete information.")

    if len(new_password) < 8:
        frappe.throw("Password must be at least 8 characters.")

    user = frappe.db.get_value(
        "User",
        {"email": email, "reset_password_key": key},
        "name"
    )
    if not user:
        frappe.throw("This link has expired or is invalid. Please request a new link.")

    # ══════════════════════════════════════════════
    # SECURITY FIX (v2): Check token expiry (24 jam)
    # ══════════════════════════════════════════════
    key_issued = frappe.db.get_value("User", user, "reset_password_key_issued_at")
    if key_issued:
        from datetime import datetime, timedelta
        issued_time = isinstance(key_issued, datetime) and key_issued or frappe.utils.get_datetime(key_issued)
        if (frappe.utils.now() - issued_time) > timedelta(hours=24):
            frappe.db.set_value("User", user, {"reset_password_key": "", "reset_password_key_issued_at": None})
            frappe.throw(
                "This link has expired (24-hour limit). Please request a new link.",
                title="Link Expired"
            )

    from frappe.utils.password import update_password
    update_password(user, new_password)
    frappe.db.set_value("User", user, {"reset_password_key": "", "reset_password_key_issued_at": None})
    frappe.db.commit()
    return {"status": "ok", "message": "Password set successfully. Please log in."}


# ══════════════════════════════════════════════
# FORGOT PASSWORD
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def forgot_password(email: str):
    if not email:
        frappe.throw("Please enter your email address.")

    user = frappe.db.get_value("User", {"email": email, "enabled": 1}, "name")
    if not user:
        return {"status": "ok", "message": "If this email is registered, a link will be sent."}

    # Benarkan reset jika user ada Customer link ATAU ada role "Traveller"
    # (staff/admin yang diberi role secara manual). Sebelum ni, hanya user
    # dgn Customer link dibenarkan reset — user dgn role Traveller tapi
    # tiada Customer (path staff, rujuk check_session()) TERKUNCI tanpa
    # cara reset password (dpt mesej "jika email ini berdaftar" tapi tiada
    # link dihantar). Ini bug: user authenticated sah tak boleh reset.
    is_customer   = bool(get_customer_by_email(email))
    is_customer_role  = "Customer" in frappe.get_roles(user)
    if not is_customer and not is_customer_role:
        return {"status": "ok", "message": "If this email is registered, a link will be sent."}

    reset_key = frappe.generate_hash(length=32)
    # Store timestamp for expiry check (24 jam)
    frappe.db.set_value("User", user, {
        "reset_password_key": reset_key,
        "reset_password_key_issued_at": frappe.utils.now()
    })

    from travel_booking.api.booking import get_site_url
    site_url   = get_site_url()
    reset_link = site_url + "/set-password?key=" + reset_key + "&email=" + email + "&mode=reset"

    frappe.sendmail(
        recipients=[email],
        # Sender TIDAK di-hardcode — biar Frappe guna default Outgoing
        # Email Account. Hardcode domain lain dari domain sebenar site
        # punca email silently gagal/masuk spam (SPF/DKIM mismatch).
        subject="Rarecation Portal — Reset Your Password",
        message="""
            <p>You requested to reset your Rarecation portal password.</p>
            <p>Click the link below to set a new password:</p>
            <p><a href=\"""" + reset_link + """\" style="background:#D4A312;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;">Reset Password &rarr;</a></p>
            <p style="color:#888;font-size:12px;">This link is valid for 24 hours.</p>
            <p style="color:#888;font-size:12px;">If you did not request this reset, please ignore this email.</p>
        """,
        now=True
    )

    frappe.db.commit()
    return {"status": "ok", "message": "If this email is registered, a link will be sent."}


@frappe.whitelist(allow_guest=True)
def send_magic_link_by_email(email: str):
    """Portal login — hantar magic link ke email registered.
    User portal kini SENTIASA dicipta serentak dengan Booking (rujuk
    _ensure_portal_user() di api/booking.py) — jadi function ni tak perlu
    auto-create User lagi, cukup cari User sedia ada. Kalau email tak
    berdaftar (jarang — cth customer taip salah email), return mesej
    generic sahaja (elak bocor maklumat sama ada email tu wujud)."""
    email = (email or "").strip().lower()
    if not email:
        frappe.throw("Please enter your email address.")

    generic_msg = "If this email is registered, you will receive a login link."

    user = frappe.db.get_value("User", {"email": email, "enabled": 1}, "name")
    if not user:
        return {"status": "ok", "message": generic_msg}

    # Sama macam forgot_password(): benarkan magic link kalau ada Customer
    # link ATAU ada role "Traveller" — jangan kunci staff/testing user.
    is_customer  = bool(get_customer_by_email(email))
    is_customer_role = "Customer" in frappe.get_roles(user)
    if not is_customer and not is_customer_role:
        return {"status": "ok", "message": generic_msg}

    expiry_minutes = 30
    key = frappe.generate_hash(length=32)
    # Cache key custom kita SENDIRI (bukan "one_time_login_key:" Frappe) —
    # sengaja berasingan supaya redirect selepas login pergi ke
    # /traveller_portal (bukan Website Settings Home Page macam Frappe
    # punya login_via_key). Sekarang ONE-TIME: login_via_portal_key
    # delete key selepas guna (sebelum ni ia reusable selama 30 minit —
    # risiko: sesiapa capai link boleh login semula). Expiry 30 minit
    # kekal sebagai had TAMAT TEMPOH (sebelum link pertama di klik).
    frappe.cache().set_value(
        "portal_login_key:" + key,
        email,
        expires_in_sec=expiry_minutes * 60
    )

    magic_url = frappe.utils.get_url(
        "/api/method/travel_booking.api.portal_auth.login_via_portal_key?key=" + key
    )

    first_name = frappe.db.get_value("User", user, "first_name") or "Customer"

    # SECURITY: Escape HTML entities — elak injection melalui nama pengguna
    safe_first_name = frappe.utils.escape_html(first_name)

    frappe.sendmail(
        recipients=[email],
        # Sender TIDAK di-hardcode — rujuk nota di forgot_password().
        subject="Rarecation Portal — Sign In",
        message="""
            <div style="font-family:'DM Sans',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
                <p style="font-size:15px;font-weight:500;color:#1E1C18;margin-bottom:8px">
                    Hi """ + safe_first_name + """,
                </p>
                <p style="font-size:14px;color:#5C5850;margin-bottom:24px;line-height:1.6">
                    Click the button below to sign in to your Rarecation portal.
                    This link is valid for <strong>""" + str(expiry_minutes) + """ minutes</strong>.
                </p>
                <p style="margin-bottom:32px">
                    <a href=\"""" + magic_url + """\"
                       style="display:inline-block;background:#D4A312;color:#1E1C18;
                              font-weight:600;font-size:14px;padding:12px 28px;
                              border-radius:8px;text-decoration:none">
                        Sign In to Portal &rarr;
                    </a>
                </p>
                <p style="font-size:12px;color:#B0AC9F;line-height:1.6">
                    If you did not make this request, please ignore this email.<br>
                    This link is valid for a single use and expires in """ + str(expiry_minutes) + """ minutes.
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
        "message": "Login link sent to " + masked + "."
    }


@frappe.whitelist(allow_guest=True)
def login_via_portal_key(key: str):
    """Custom magic-link login — pengganti frappe.www.login.login_via_key.
    Sebab kenapa perlu custom (bukan guna Frappe punya built-in):
      Redirect terus ke /traveller_portal — Frappe punya login_via_key
      mengabaikan sebarang parameter redirect-to untuk destinasi
      Website User (guna redirect_post_login() -> Website Settings
      Home Page sahaja), jadi customer akan tersasar ke home page
      default site (bukan portal kita) kalau guna endpoint asal.

    KESELAMATAN (pembetulan): key kini ONE-TIME — dipadam SEGERA selepas
    login berjaya. Sebelum ni key kekal reusable selama 30 minit, yang
    bermaksud sesiapa yang capai link (email diforward, screenshot,
    history browser) boleh login semula sebagai customer berulang kali.
    Frappe punya login_via_key juga one-time (delete-after-use) atas
    sebab keselamatan sama — kita ikut pattern tu sekarang.

    AUDIT TRAIL: berbeza dari login_as() polos, kita juga rekod info
    login standard (last_login, login time, IP) supaya admin nampak
    customer login via magic-link dalam sejarah User dan Active Sessions
    — sebelum ni login magic-link tiada jejak sama sekali.
    """
    cache_key = "portal_login_key:" + key
    email = frappe.cache().get_value(cache_key)

    if not email:
        frappe.respond_as_web_page(
            "Link Expired",
            "This login link is invalid, has expired, or has already been used. "
            "Please request a new link.",
            http_status_code=403,
            indicator_color="red"
        )
        return

    # Padam key SEKARANG (one-time) — sebelum login_as, supaya kalau
    # login_as throw (cth User disabled), key tetap dah dibuang dan tidak
    # boleh dipakai semula. Lebih selamat: gagal-gagal pun, attacker tak
    # dapat reuse.
    frappe.cache().delete_value(cache_key)

    # Sahkan User masih enabled SEBELUM login — elak login_as() silently
    # cipta session untuk User yang baru dilumpuhkan admin di Desk.
    if not frappe.db.get_value("User", email, "enabled", cache=True):
        frappe.respond_as_web_page(
            "Account Disabled",
            "Your account has been disabled. Please contact support.",
            http_status_code=403,
            indicator_color="red"
        )
        return

    frappe.local.login_manager.login_as(email)

    # Rekod audit trail — login_as() polos TIDAK rekod last_login/IP,
    # jadi admin tidak nampak bila/how customer masuk. Kita lengkapkan
    # secara manual (pattern sama dengan frappe.login_manager.post_login,
    # tanpa percubaan brute-force tracking yang tak relevan untuk magic
    # link yang sudah verified via email ownership).
    _record_login_audit(email)

    frappe.local.response["type"]     = "redirect"
    # Multi-page portal: magic link login terus ke My Bookings (default page).
    frappe.local.response["location"] = "/traveller_portal/bookings"


def _record_login_audit(email: str):
    """Rekod info login standard supaya magic-link login nampak dalam
    User history dan Active Sessions (login_as() polos skip semua ni).

    Kita TIDAK boleh pakai login_manager.post_login() penuh sebab ia
    expect full credential flow (termasuk check_consecutive_failed).
    Sebaliknya rekod field penting sahaja — konsisten dengan apa yang
    Frappe rekod untuk login normal.
    """
    try:
        user_doc = frappe.get_doc("User", email)
        login_time = frappe.utils.now()

        # last_login + last_active — sama field yang Frappe update untuk
        # login biasa, jadi Active Sessions / User list konsisten.
        user_doc.last_login = login_time
        user_doc.last_ip    = frappe.local.request_ip if getattr(frappe.local, "request_ip", None) else None
        user_doc.db_update()

        # Session entry (tabSessions) diurus Frappe sendiri lepas
        # login_as(), jadi customer muncul dalam "Active Sessions" —
        # kita cuma lengkapkan metadata User di atas.
    except Exception as e:
        # Audit recording tak boleh gagalkan login — log sahaja.
        frappe.log_error(
            "Magic-link audit record failed for {0}: {1}".format(email, str(e)),
            "Portal Login Audit"
        )


# ══════════════════════════════════════════════
# SIGNUP
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def signup(full_name: str, email: str, password: str):
    """Self-serve signup untuk portal /traveller.

    SECURITY FIX (v2): Akaun dicipta sebagai DISABLED dahulu.
    Role Customer HANYA diberi selepas pengesahan email (verification link).
    Ini mencegah account takeover — attacker tak boleh daftar dengan email
    orang lain dan dapat akses portal serta-merta.

    Aliran baru:
      1. Cipta User (enabled=0, tiada role)
      2. Hantar verification link ke email
      3. User klik link → verify_signup() mengaktifkan akaun + assign role (jika ada booking)
    """
    frappe.flags.ignore_permissions = True

    email = (email or "").strip().lower()
    full_name = (full_name or "").strip()
    password = password or ""

    if not email or not full_name or not password:
        frappe.throw("Please fill in all fields.")
    if len(password) < 8:
        frappe.throw("Password must be at least 8 characters.")

    # SECURITY: Jangan bocorkan sama ada email sudah berdaftar (user enumeration)
    if frappe.db.exists("User", email):
        # Return generic message seolah-olah berjaya — elak enumeration
        return {
            "status":        "verification_pending",
            "email":         email,
            "message":       (
                "If this email is registered, you will receive a verification link. "
                "Please check your inbox (and spam folder)."
            ),
        }

    name_parts = full_name.split()
    first_name = name_parts[0] if name_parts else "Customer"
    last_name = " ".join(name_parts[1:]) if len(name_parts) > 1 else ""

    # Cipta User DISABLED — belum boleh login lagi
    new_user = frappe.get_doc({
        "doctype":            "User",
        "email":              email,
        "first_name":         first_name,
        "last_name":          last_name,
        "enabled":            0,  # DISABLED sehingga email disahkan
        "user_type":          "Website User",
        "send_welcome_email": 0,
        "new_password":       password,
    })
    new_user.flags.ignore_permissions = True
    new_user.insert()

    # Jana verification token dan hantar email
    verification_key = frappe.generate_hash(length=40)
    frappe.db.set_value("User", email, "reset_password_key", verification_key)

    from travel_booking.api.booking import get_site_url
    site_url = get_site_url()
    verify_link = (
        site_url
        + "/api/method/travel_booking.api.portal_auth.verify_signup?"
        + "key=" + verification_key
        + "&email=" + email
    )

    # Hantar verification email
    frappe.sendmail(
        recipients=[email],
        subject="Rarecation Portal — Verify Your Email",
        message="""
            <div style="font-family:'DM Sans',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
                <p style="font-size:15px;font-weight:500;color:#1E1C18;margin-bottom:8px">
                    Welcome to Rarecation, """ + frappe.utils.escape_html(first_name) + """!
                </p>
                <p style="font-size:14px;color:#5C5850;margin-bottom:24px;line-height:1.6">
                    Please verify your email address to activate your account.
                </p>
                <p style="margin-bottom:32px">
                    <a href=\"""" + verify_link + """\"
                       style="display:inline-block;background:#D4A312;color:#1E1C18;
                              font-weight:600;font-size:14px;padding:12px 28px;
                              border-radius:8px;text-decoration:none">
                        Verify Email &rarr;
                    </a>
                </p>
                <p style="font-size:12px;color:#B0AC9F;line-height:1.6">
                    If you did not create an account, please ignore this email.<br>
                    This link expires in 24 hours.
                </p>
            </div>
        """,
        now=True
    )

    frappe.db.commit()

    return {
        "status":        "verification_pending",
        "email":         email,
        "message":       (
            "Account created! Please check your email to verify and activate your account. "
            "(Check spam folder if not received within 5 minutes.)"
        ),
    }


@frappe.whitelist(allow_guest=True)
def verify_signup(key: str, email: str):
    """Verify email ownership dan aktifkan akaun signup.

    Dipanggil bila user klik verification link dalam email.
    - Enable User
    - Assign role Customer JIKA ada booking dengan cust_email ini
    - Padam verification key (one-time use)
    """
    if not key or not email:
        frappe.throw("Invalid verification link.")

    email = email.strip().lower()

    user = frappe.db.get_value(
        "User",
        {"email": email, "reset_password_key": key},
        "name"
    )
    if not user:
        frappe.throw(
            "This verification link has expired or is invalid. "
            "Please sign up again.",
            title="Verification Failed"
        )

    # Aktifkan akaun
    frappe.db.set_value("User", user, "enabled", 1)

    # Padam verification key (one-time use)
    frappe.db.set_value("User", user, "reset_password_key", "")

    # Assign role Customer jika ada booking
    role_assigned = False
    if _email_has_booking(email):
        user_doc = frappe.get_doc("User", user)
        user_doc.append("roles", {"role": "Customer"})
        user_doc.flags.ignore_permissions = True
        user_doc.save()
        role_assigned = True

    frappe.db.commit()

    return {
        "status":        "ok",
        "role_assigned": role_assigned,
        "email":         email,
        "message":       (
            "Email verified! Your account is now active. "
            ("You can now log in to the portal." if not role_assigned else
             "Welcome! Redirecting to your bookings...")
        ),
    }