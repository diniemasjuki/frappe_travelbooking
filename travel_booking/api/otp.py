# travel_booking/api/otp.py
#
# Bahagian 2 & 3 dari booking.py asal: penghantaran & pengesahan OTP
# untuk booking tanpa login (guest). Endpoint-endpoint ni allow_guest=True
# jadi rate limiting adalah kritikal (rujuk komen di send_otp()).

import frappe
import secrets  # SECURITY: guna secrets, bukan random (CSPRNG)
import string
import hmac

from travel_booking.api._helpers import get_customer_by_email, get_customer_phone


# ══════════════════════════════════════════════
# 2. SEND OTP
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True, methods=["POST"])
def send_otp(email: str):
    email = (email or "").strip().lower()
    if not email:
        frappe.throw("Please enter your email address.")

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
        frappe.throw("Too many requests. Please try again shortly.")
    frappe.cache().set_value(ip_rate_key, str(int(ip_count or 0) + 1), expires_in_sec=60)

    # PENTING: check kewujudan "User" (akaun portal login), BUKAN
    # "Customer" (rekod pelanggan ERPNext). Docname User = alamat email
    # (rujuk _ensure_portal_user() di booking_engine.py, yang cipta User
    # dengan docname = email semasa booking pertama). User wujud = signal
    # yang LEBIH TEPAT untuk "orang ni dah pernah verify emel & ada akses
    # portal" berbanding sekadar Customer wujud — sebab Customer BOLEH
    # dicipta tanpa emel pernah disahkan langsung (cth admin cipta
    # Customer terus di Desk, atau import data pukal) — kes tu Customer
    # wujud tapi orang tu tak pernah verify email ni sendiri, jadi tak
    # patut skip OTP.
    if frappe.db.exists("User", email):
        # SECURITY FIX (v2): Jangan bocorkan PII (nama, telefon)
        # Return generic message — elak user enumeration
        return {
            "verified":  True,
            "message":   "Email already registered. Please sign in instead.",
            # PII fields REMOVED for security
        }

    # ── Rate limiting — elak spam/abuse hantar OTP berulang-ulang ──
    # Lapisan 1: cooldown 60 saat antara setiap request (elak klik
    # "Resend" berturut-turut serta-merta).
    cooldown_key = "booking_otp_cooldown_" + email
    if frappe.cache().get_value(cooldown_key):
        frappe.throw("Please wait a moment before requesting the OTP again.")

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
            frappe.throw("Too many OTP requests for this email. Please try again after 1 hour.")
    else:
        first_ts, count, remaining = now_ts, 0, 3600

    settings = frappe.get_cached_doc("Travel Settings")
    otp_expiry_minutes = int(settings.otp_expiry_minutes or 10)

    # SECURITY: guna secrets.choice (CSPRNG), bukan random.choices (Mersenne Twister)
    otp = ''.join(secrets.choice(string.digits) for _ in range(6))
    frappe.cache().set_value("booking_otp_" + email, otp,
                             expires_in_sec=otp_expiry_minutes * 60)

    try:
        frappe.sendmail(
            recipients=[email],
            # Sender TIDAK di-hardcode — biar Frappe guna default Outgoing
            # Email Account (Settings > Email Account) macam function email
            # lain dalam app ni. Hardcode domain lain dari domain sebenar
            # site punca email silently gagal/masuk spam (SPF/DKIM mismatch).
            subject="Rarecation Booking — Verification Code",
            message="""
            <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
                <h2 style="color: #B8860B;">Booking Verification Code</h2>
                <p>Use the following code to verify your email:</p>
                <div style="font-size: 36px; font-weight: bold; letter-spacing: 8px;
                            color: #B8860B; margin: 24px 0; text-align: center;">
                    """ + otp + """
                </div>
                <p style="color: #666;">This code will expire in """ + str(otp_expiry_minutes) + """ minutes.</p>
                <p style="color: #666; font-size: 12px;">
                    If you did not make this request, please ignore this email.
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
        frappe.throw("Failed to send OTP. Please try again shortly, or contact us.")

    # Emel berjaya dihantar — SEKARANG baru set cooldown & kemas kini counter
    # sejam (bukan sebelum sendmail), supaya kegagalan hantar emel tak
    # "gunakan" kuota rate-limit customer secara tak adil.
    frappe.cache().set_value(cooldown_key, "1", expires_in_sec=60)
    frappe.cache().set_value(hourly_key, str(first_ts) + "|" + str(count + 1),
                             expires_in_sec=int(remaining))

    return {"verified": False, "message": "OTP sent to your email."}


# ══════════════════════════════════════════════
# 3. VERIFY OTP
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True, methods=["POST"])
def verify_otp(email: str, otp: str):
    email     = email.strip().lower()
    cache_key = "booking_otp_" + email
    stored    = frappe.cache().get_value(cache_key)

    if not stored:
        frappe.throw("OTP has expired. Please request a new one.")

    # ══════════════════════════════════════════════
    # SECURITY FIX (v2): Rate limit verify attempts
    # ══════════════════════════════════════════════
    attempt_key = "otp_verify_attempts_" + email
    attempts = int(frappe.cache().get_value(attempt_key) or 0)
    MAX_ATTEMPTS = 5

    if attempts >= MAX_ATTEMPTS:
        # Padam OTP — lock out after max attempts
        frappe.cache().delete_value(cache_key)
        frappe.throw(
            "Too many failed attempts. Please request a new OTP.",
            title="OTP Locked"
        )

    # SECURITY: guna hmac.compare_digest (constant-time), bukan != (timing attack)
    if not hmac.compare_digest(stored.encode(), otp.strip().encode()):
        # Increment failed attempt counter
        frappe.cache().set_value(attempt_key, str(attempts + 1), expires_in_sec=600)  # 10 min lock
        frappe.throw("Invalid OTP. Please try again. ({0} of {1} attempts remaining)".format(
            MAX_ATTEMPTS - attempts - 1, MAX_ATTEMPTS
        ))

    # Success — padam attempt counter & OTP
    frappe.cache().delete_value(attempt_key)
    frappe.cache().delete_value(cache_key)

    settings = frappe.get_cached_doc("Travel Settings")
    session_minutes = int(settings.email_verified_session_minutes or 30)

    frappe.cache().set_value(
        "booking_email_verified_" + email, True, expires_in_sec=session_minutes * 60
    )
    return {"success": True, "message": "Email verified successfully."}
