# travel_booking/api/voucher.py
#
# Bahagian 5 & 5b dari booking.py asal, plus helper voucher lifecycle
# (_use_voucher, _release_voucher_for_booking) yang sebelum ni tersiar
# jauh di hujung file. Semua fungsi voucher/affiliate dikumpulkan di sini
# supaya senang untuk kemas kini/audit logik diskaun & referral.

import frappe
import json
from frappe import _

from travel_booking.api._helpers import get_customer_by_email
from travel_booking.api.pricing import fmt_currency, _get_pricing_map, _price_selection


# ══════════════════════════════════════════════
# 5. VOUCHER VALIDATION
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def validate_voucher(code: str, trip_group_date: str, grand_total: float, email: str = "",
                     selections: str = "", trip_package: str = None, is_cruise: bool = True):
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

    # MULTI-CURRENCY: currency package (kalau dihantar) untuk paparan
    # mesej "You save {amount}" ikut currency booking sebenar, bukan
    # "RM" hardcode — rujuk fmt_currency() di pricing.py.
    voucher_currency = None
    if trip_package:
        voucher_currency = frappe.db.get_value("Trip Package", trip_package, "currency")

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

        # MULTI-CURRENCY GUARD (fixed-amount sahaja): Voucher doctype tiada
        # field currency (constraint schema), jadi currency voucher di-DERIVE
        # dari pakej yang di-scope-kan — voucher scoped pada pakej SGD =
        # nilai fixed dia dalam SGD. Tanpa guard ni, "50 off" bermaksud
        # 50 unit APA-APA currency booking — customer MYR dapat RM50,
        # customer SGD dapat S$50, untuk voucher yang sama (nilai berbeza
        # beza ikut market). Percentage voucher tak terkesan (relatif).
        # Unscoped fixed voucher kekal currency-agnostic (backward-compat).
        if voucher.discount_type != "Percentage" and scope_packages:
            scoped_currencies = {
                (c or "MYR")
                for c in frappe.get_all(
                    "Trip Package",
                    filters={"name": ["in", scope_packages]},
                    pluck="currency",
                )
            }
            if len(scoped_currencies) == 1:
                voucher_currency_expected = scoped_currencies.pop()
                booking_currency = voucher_currency or "MYR"
                if booking_currency != voucher_currency_expected:
                    return {
                        "valid": False,
                        "message": (
                            "This voucher is only valid for " + voucher_currency_expected +
                            " bookings."
                        ),
                    }

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
                is_cruise,
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
        "message":         "Voucher applied! You save " + fmt_currency(discount_amount, voucher_currency) + ".",
    }


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
# VOUCHER LIFECYCLE (usage tracking + release)
# ══════════════════════════════════════════════

def _release_voucher_for_booking(booking_name):
    """Lepaskan voucher yang diguna booking ni — padam rekod Voucher Usage
    terus (doctype STANDALONE sekarang, bukan child table lagi — rujuk
    field 'voucher' Link, bukan 'parent'). usage_count dikira live dari
    bilangan rekod Voucher Usage yang wujud, jadi cukup padam rekod sahaja
    — tiada field counter berasingan untuk decrement, dan TIADA perlu
    load/lock/save Voucher induk (tiada child table untuk disegerakkan
    lagi — jauh lebih ringkas dari pendekatan lama). Turut kosongkan
    Booking.voucher (field rujukan cepat) supaya tak tinggal rujukan ke
    rekod yang dah dipadam. (Booking.voucher_usage TIDAK wujud dalam
    schema — dibuang semasa restructuring, jangan tambah balik di sini.)
    """
    for u in frappe.db.get_all("Voucher Usage",
                               filters={"booking": booking_name},
                               pluck="name"):
        try:
            frappe.delete_doc("Voucher Usage", u, ignore_permissions=True)
        except Exception:
            pass
    frappe.db.set_value("Booking", booking_name, {"voucher": None})


def _use_voucher(code, customer_name, booking_name, discount_amount=0):
    """Rekod penggunaan voucher — cipta rekod BAHARU di doctype standalone
    'Voucher Usage' (bukan append ke child table lagi).

    SECURITY FIX (v2): Re-check max_usage INSIDE the FOR UPDATE lock.
    Sebelum ni, check max_usage berlaku di validate_voucher() SEBELUM lock —
    dua concurrent booking boleh lulus check serentak, kemudian both insert
    → over-redemption. Sekarang recount INSIDE lock sebelum insert.
    """
    try:
        code = (code or "").strip().upper()
        voucher_name = frappe.db.get_value("Voucher", {"voucher_code": code}, "name")
        if not voucher_name:
            return None, None

        # Lock Voucher row untuk serialize concurrent usage
        frappe.db.sql("SELECT name FROM `tabVoucher` WHERE name = %s FOR UPDATE", voucher_name)

        # ══════════════════════════════════════════════
        # SECURITY: Re-check limits INSIDE the lock (TOCTOU fix)
        # ══════════════════════════════════════════════
        voucher = frappe.db.get_value(
            "Voucher", voucher_name,
            ["max_usage", "max_usage_per_customer"], as_dict=True
        )

        # Check global max_usage
        if voucher and voucher.max_usage:
            current_usage = frappe.db.count("Voucher Usage", {"voucher": voucher_name})
            if current_usage >= int(voucher.max_usage):
                frappe.throw(_("This voucher has reached its maximum usage. Please try another."))

        # Check per-customer limit
        if voucher and voucher.max_usage_per_customer and customer_name:
            customer_usage = frappe.db.count(
                "Voucher Usage", {"voucher": voucher_name, "customer": customer_name}
            )
            if customer_usage >= int(voucher.max_usage_per_customer):
                frappe.throw(_("You have already used this voucher. Please try another."))

        # All checks passed — insert usage record
        usage_doc = frappe.get_doc({
            "doctype":         "Voucher Usage",
            "voucher":         voucher_name,
            "customer":        customer_name,
            "booking":         booking_name,
            "discount_amount": discount_amount,
        })
        usage_doc.insert(ignore_permissions=True)
        return voucher_name, usage_doc.name
    except frappe.exceptions.ValidationError:
        # Re-throw validation errors (max_usage exceeded)
        raise
    except Exception as e:
        frappe.log_error("Voucher usage tracking failed: " + str(e), "Voucher Error")
        return None, None
