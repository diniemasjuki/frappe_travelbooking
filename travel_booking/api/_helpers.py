# travel_booking/api/_helpers.py
# Shared internal helpers — TIADA @frappe.whitelist() di sini (bukan
# endpoint, cuma fungsi bantu dalaman untuk fail api/*.py lain import).
#
# Konsolidasi: sebelum ni, SQL join Contact Email -> Contact -> Dynamic Link
# (untuk padan Customer <-> email) disalin kata-demi-kata di 11 tempat
# merentasi 5 fail (booking.py, portal_auth.py, portal_booking.py,
# portal_payment.py, stripe_checkout.py). Fungsi di sini jadi SATU sumber
# kebenaran untuk logic tu — ubah di sini sahaja bila perlu di masa depan.

import frappe


def get_customer_by_email(email):
    """Cari nama Customer (docname) dari alamat email, melalui
    Contact Email -> Contact -> Dynamic Link (link_doctype='Customer').
    Pulang None kalau tiada padanan.
    """
    if not email:
        return None
    result = frappe.db.sql("""
        SELECT dl.link_name
        FROM `tabContact Email` ce
        JOIN `tabContact` c ON c.name = ce.parent
        JOIN `tabDynamic Link` dl ON dl.parent = c.name
        WHERE ce.email_id = %s AND dl.link_doctype = 'Customer'
        LIMIT 1
    """, email, as_dict=True)
    return result[0].link_name if result else None


def get_customer_email(customer_name):
    """Cari email utama (primary) untuk satu Customer, melalui
    Contact Email -> Contact -> Dynamic Link (link_doctype='Customer').
    Pulang None kalau tiada.
    """
    if not customer_name:
        return None
    result = frappe.db.sql("""
        SELECT ce.email_id
        FROM `tabContact Email` ce
        JOIN `tabContact` c ON c.name = ce.parent
        JOIN `tabDynamic Link` dl ON dl.parent = c.name
        WHERE dl.link_doctype = 'Customer' AND dl.link_name = %s
        ORDER BY ce.is_primary DESC
        LIMIT 1
    """, customer_name, as_dict=True)
    return result[0].email_id if result else None


def get_customer_phone(customer_name):
    """Cari phone utama (primary) untuk satu Customer, melalui
    Contact Phone -> Contact -> Dynamic Link (link_doctype='Customer').
    Pulangkan None kalau tiada. Sama pattern dengan get_customer_email() —
    guna terus di sini (bukan salin SQL berulang) untuk Booking.cust_phone
    (virtual property) dan mana-mana tempat lain yang perlukan phone
    customer di masa depan.
    """
    if not customer_name:
        return None
    result = frappe.db.sql("""
        SELECT cp.phone
        FROM `tabContact Phone` cp
        JOIN `tabContact` c ON c.name = cp.parent
        JOIN `tabDynamic Link` dl ON dl.parent = c.name
        WHERE dl.link_doctype = 'Customer' AND dl.link_name = %s
        ORDER BY cp.is_primary_phone DESC
        LIMIT 1
    """, customer_name, as_dict=True)
    return result[0].phone if result else None


def sanitize_portal_return_path(path):
    """Validasi laluan pulangan portal untuk URL balik Stripe checkout.

    Hanya terima laluan relatif DALAM portal ("/traveller/...")
    — tolak apa-apa yang boleh jadi open redirect (domain luar, scheme,
    protocol-relative "//", backslash). Pulangkan "" kalau tidak sah.
    Digunakan oleh create_payment_request() -> create_payment_intent()
    -> checkout.py supaya customer dibawa balik ke page asal dia
    (cth /traveller/booking_billing?ref=RC-XXXX) selepas bayar.
    """
    if not path:
        return ""
    path = str(path).strip()
    if len(path) > 500:
        return ""
    if not (path.startswith("/traveller/") or path.startswith("/traveller/")):
        return ""
    if path.startswith("//") or "\\" in path or ":" in path:
        return ""
    if ".." in path:
        return ""
    return path


def get_on_behalf_role_rows():
    """Senarai baris mentah Travel Settings.on_behalf_roles —
    [{role, booking_channel, access_level}, ...] dalam susunan Desk.
    Sumber tunggal untuk semua resolver on-behalf di bawah.
    """
    ts = frappe.get_cached_doc("Travel Settings")
    rows = []
    for row in (ts.get("on_behalf_roles") or []):
        if row.role and row.booking_channel:
            rows.append({
                "role":           row.role,
                "booking_channel": row.booking_channel,
                "access_level":   row.access_level or "Full",
            })
    return rows


# Tahap akses urusan booking on-behalf (ikut keutamaan menaik). Tahap
# menentukan APA yang boleh dibuat oleh manager pada booking customer:
#   View = lihat status/trip/billing summary sahaja
#   Docs = + urus maklumat & dokumen traveller (passport, guest link)
#   Full = + bayaran (Pay Now/resit manual) & muat turun resit/invois
_ON_BEHALF_LEVEL_ORDER = {"View": 0, "Docs": 1, "Full": 2}


def get_on_behalf_role_map():
    """Map role → booking_channel dari Travel Settings.on_behalf_roles
    (Travel Settings > OTP and Security > On-Behalf Booking Roles).

    Ini SATU-SATUNYA sumber kebenaran senarai role yang dibenarkan buat
    tempahan bagi pihak customer (booking on-behalf) — menggantikan senarai
    hardcoded fasa 1 (Affiliate/Sales User). Dipakai oleh:
      - resolve_booking_actor() (gate OTP wizard + channel Booking)
      - has_on_behalf_role() (akses portal traveller — urus booking on-behalf)

    PENTING: senarai KOSONG = ciri on-behalf DIMATIKAN sepenuhnya (tiada
    role yang layak). Patch v2_seed_on_behalf_roles menjamin default
    (Affiliate → Affiliate, Sales User → Staff) wujud selepas migrate.

    Pulangkan dict {role: booking_channel} dalam susunan baris settings
    (dict Python preserve insertion order — padanan pertama menentukan
    channel bila user ada lebih dari satu role yang dikonfigurasi).
    """
    return {r["role"]: r["booking_channel"] for r in get_on_behalf_role_rows()}


# ══════════════════════════════════════════════
# B2B PARTNER (agen / reseller — saluran B2B)
# ══════════════════════════════════════════════
# Berbeza dari on-behalf role-based (Staff/Affiliate): kewibadaan B2B
# DIKONFIGUR PER-PARTNER melalui child table Travel B2B Partner User —
# bukan melalui role global. Ini menjamin isolasi data: staf partner A
# hanya nampak booking partner A. Satu user hanya boleh milik SATU
# partner Active (dikuatkuasakan di Travel B2B Partner.validate()).

def get_user_b2b_partner(user=None):
    """Partner B2B Active bagi session user ini, melalui child table
    Travel B2B Partner User. Pulang dict:

        {partner, partner_name, access_level, customer, contact_email,
         default_discount_percent}

    atau None kalau user bukan staf mana-mana partner Active. BUKAN
    endpoint — helper dalaman untuk resolve_booking_actor(), guard
    portal, dan _managed_booking_names().
    """
    user = user or frappe.session.user
    if not user or user == "Guest":
        return None
    rows = frappe.db.sql("""
        SELECT p.name              AS partner,
               p.partner_name      AS partner_name,
               pu.access_level     AS access_level,
               p.customer          AS customer,
               p.contact_email     AS contact_email,
               p.default_discount_percent AS default_discount_percent
        FROM `tabTravel B2B Partner User` pu
        JOIN `tabTravel B2B Partner` p ON p.name = pu.parent
        WHERE pu.user = %s AND p.status = 'Active'
    """, (user,), as_dict=True)
    if not rows:
        return None
    # Berbilang baris (konfigurasi luar jangka) — ambil tahap TERTINGGI;
    # partner dijamin tunggal oleh validation doctype.
    best = max(rows, key=lambda r: _ON_BEHALF_LEVEL_ORDER.get(r.access_level or "Full", 2))
    return {
        "partner":                  best.partner,
        "partner_name":             best.partner_name,
        "access_level":             best.access_level or "Full",
        "customer":                 best.customer,
        "contact_email":            best.contact_email,
        "default_discount_percent": best.default_discount_percent or 0,
    }


def has_on_behalf_role(user=None):
    """True jika user memiliki mana-mana role yang dikonfigurasi dalam
    Travel Settings.on_behalf_roles ATAU merupakan staf partner B2B
    Active (Travel B2B Partner User). Bukan endpoint — helper dalaman
    untuk guard portal & resolver wizard.
    """
    user = user or frappe.session.user
    if not user or user == "Guest":
        return False
    role_map = get_on_behalf_role_map()
    if role_map and (set(role_map.keys()) & set(frappe.get_roles(user))):
        return True
    return get_user_b2b_partner(user) is not None


def get_on_behalf_access_level(user=None):
    """Tahap akses on-behalf user (View/Docs/Full) — TERTINGGI antara
    semua sumber kewibadaan user: role yang dikonfigurasi (Travel
    Settings.on_behalf_roles) DAN barisan staf partner B2B (Travel B2B
    Partner User). Pulangkan None jika user tiada kewibadaan on-behalf.
    Bukan endpoint — helper dalaman untuk gate tindakan portal
    (traveller/payment) pada booking on-behalf.
    """
    user = user or frappe.session.user
    if not user or user == "Guest":
        return None
    best = None

    def _raise(lvl):
        nonlocal best
        if lvl not in _ON_BEHALF_LEVEL_ORDER:
            lvl = "Full"
        if best is None or _ON_BEHALF_LEVEL_ORDER[lvl] > _ON_BEHALF_LEVEL_ORDER[best]:
            best = lvl

    rows = get_on_behalf_role_rows()
    if rows:
        roles = set(frappe.get_roles(user))
        for row in rows:
            if row["role"] in roles:
                _raise(row["access_level"])

    b2b = get_user_b2b_partner(user)
    if b2b:
        _raise(b2b["access_level"])

    return best


def on_behalf_level_ok(required_level, user=None):
    """True jika tahap akses on-behalf user >= tahap yang diminta.
    Helper ringkas untuk gate tindakan endpoint portal.
    """
    level = get_on_behalf_access_level(user)
    if level is None:
        return False
    required = required_level if required_level in _ON_BEHALF_LEVEL_ORDER else "Full"
    return _ON_BEHALF_LEVEL_ORDER[level] >= _ON_BEHALF_LEVEL_ORDER[required]


def resolve_booking_actor():
    """Resolve SIAPA yang sedang buat booking dari session semasa — asas
    modul "booking on behalf" (3rd party tempah bagi pihak customer).

    Dipakai di DUA tempat (satu sumber kebenaran):
      1. www/booknow.py — render context supaya wizard tahu untuk papar
         checkbox "Booking on behalf".
      2. booking_engine.confirm_booking() — gate OTP: actor yang sah
         boleh langkau pengesahan email customer.

    Dua sumber kewibadaan (disemak mengikut keutamaan):
      1. B2B — staf partner Active dalam Travel B2B Partner User.
         channel = "B2B"; dict turut bawa `partner`, `partner_name`,
         `access_level`, `customer` (Customer BIL partner) dan
         `default_discount_percent` — sumber resolusi harga net.
      2. Role-based (Staff/Affiliate) — senarai role + channel
         dipaparkan admin dalam Travel Settings.on_behalf_roles
         (default seed: Affiliate → channel "Affiliate", Sales User →
         channel "Staff").

    User tanpa kewibadaan (termasuk Guest/customer biasa) → None —
    flow direct biasa, OTP kekal seperti sedia ada.

    Pulangkan dict {channel, user, full_name, ...} atau None. BUKAN
    endpoint — helper dalaman sahaja (tiada @whitelist).
    """
    user = frappe.session.user
    if not user or user == "Guest":
        return None

    # 1) B2B partner (spesifik kepada user — disemak lebih dahulu daripada
    # role global supaya staff dalaman yang juga staf partner dapat channel
    # B2B yang lebih spesifik).
    b2b = get_user_b2b_partner(user)
    if b2b:
        return {
            "channel":     "B2B",
            "user":        user,
            "full_name":   frappe.db.get_value("User", user, "full_name") or user,
            "partner":     b2b["partner"],
            "partner_name": b2b["partner_name"],
            "access_level": b2b["access_level"],
            "customer":    b2b["customer"],
            "default_discount_percent": b2b["default_discount_percent"],
        }

    # 2) Role-based Staff / Affiliate
    role_map = get_on_behalf_role_map()
    if not role_map:
        return None
    roles = set(frappe.get_roles(user))
    channel = None
    # Susunan ikut baris settings (bukan keutamaan hardcoded) — baris
    # pertama yang role-nya dimiliki user menentukan channel.
    for role, mapped_channel in role_map.items():
        if role in roles:
            channel = mapped_channel
            break
    if not channel:
        return None
    return {
        "channel":   channel,
        "user":      user,
        "full_name": frappe.db.get_value("User", user, "full_name") or user,
    }


def get_own_affiliate_code(user=None):
    """Kod referral SENDIRI session user — asas pre-aktivasi affiliate di
    wizard /booknow: user yang membuat order dan didapati ada profil
    affiliate yang SAH booking-nya di-attributkan kepada kod dia sendiri
    tanpa perlu taip kod itu manual.

    "Sah" bila SEMUA terpenuhi:
      - Affiliate Profile (app 'affiliate') milik user ini wujud;
      - status = "Verified" — referral_code & Sales Partner baru wujud
        semasa verification (rujuk AffiliateProfile.on_update());
      - referral_code DAN sales_partner berisi — kod untuk validasi,
        Sales Partner untuk attribution commission (SO.sales_partner /
        Booking.affiliate). Kedua-duanya wajib; profile Verified tanpa
        salah satu (data luar jangka) dianggap tidak sah.

    Pulangkan kod (uppercase, padanan format validate_affiliate_code())
    atau None. Bukan endpoint — helper dalaman untuk www/booknow.py
    (paparan wizard) dan booking_engine.confirm_booking() (enforcement
    server-side — nilai client tidak pernah dipercayai).
    """
    user = user or frappe.session.user
    if not user or user == "Guest":
        return None
    row = frappe.db.get_value(
        "Affiliate Profile",
        {"user": user, "status": "Verified"},
        ["referral_code", "sales_partner"],
        as_dict=True,
    )
    if row and row.referral_code and row.sales_partner:
        return (row.referral_code or "").strip().upper()
    return None


def _as_bool(value):
    """Normalize nilai boolean dari payload HTTP (form-encoded). Client JS
    menghantar boolean sebagai string "true"/"false" — Python bool("false")
    ialah True (bukan string kosong), jadi SEMAKAN `if value:` terus pada
    string sentiasa bernilai true. Guna helper ni untuk semua param boolean
    endpoint allow_guest supaya "false" betul-betul dikenali sebagai False.
    """
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def get_company_currency():
    """Currency asas company (dari Global Defaults.default_company ->
    Company.default_currency). SEMUA transaksi jualan/booking travel_booking
    disimpan & dicaj dalam company currency; currency lain cuma paparan
    (display converter frontend). Fallback "MYR" kalau company tiada/tak
    dikonfigur — elak crash pada pemasangan baru yang belum set default
    company.

    Diletakkan di _helpers.py (bukan pricing.py/so_helpers.py) kerana
    diperlukan oleh KEDUA-DUA modul berikut, dan pricing.py import dari
    so_helpers.py — kalau so_helpers pula import balik dari pricing untuk
    helper ni, ia jadi circular import. _helpers.py tidak import dari
    mana-mana modul app lain, jadi selamat sebagai sumber kongsi.
    """
    default_company = frappe.db.get_single_value("Global Defaults", "default_company")
    if not default_company:
        return "MYR"
    return frappe.get_cached_value("Company", default_company, "default_currency") or "MYR"