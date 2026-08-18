# travel_booking/api/portal_profile.py
# Profile — Portal (multi-page)
#
# Page /traveller_portal/profile:
#   get_profile()        — maklumat asas (email read-only v1, nama, phone)
#   update_phone()       — kemas kini nombor telefon Contact utama
#   change_password()    — tukar password semasa LOGIN (verify password lama)
#   request_data_action() — PDPA: permintaan pembetulan/pemadaman data
#
# NOTA EMAIL (keputusan reka bentuk v1): email customer READ-ONLY — tukar
# email = rename docname User dalam Frappe, yang berisiko putuskan link
# Customer/Contact dan sejarah emel. Customer yang nak tukar email
# diarahkan hubungi support (dinyatakan pada page Profile).

import frappe

from travel_booking.api._helpers import get_customer_by_email, get_customer_phone
from travel_booking.api.portal_booking import _get_customer


def _format_phone(phone):
    """Sama normalizer dengan portal_traveller.py — "+ISD-nombor" supaya
    konsisten dengan fieldtype Phone Frappe (widget Desk render betul)."""
    if not phone:
        return ""
    phone = phone.strip()
    if "-" in phone:
        return phone
    try:
        from phonenumbers import parse as phonenumbers_parse
        parsed = phonenumbers_parse(phone)
        return f"+{parsed.country_code}-{parsed.national_number}"
    except Exception:
        return phone


@frappe.whitelist()
def get_profile():
    """Maklumat profil customer untuk page Profile."""
    frappe.flags.ignore_permissions = True
    customer_name = _get_customer()

    email = frappe.session.user
    customer_label = frappe.db.get_value("Customer", customer_name, "customer_name") or customer_name

    return {
        "email":          email,
        "customer_name":  customer_label,
        "phone":          get_customer_phone(customer_name) or "",
    }


@frappe.whitelist()
def update_phone(phone: str):
    """Kemas kini nombor telefon utama Contact customer.

    Update Contact Phone row sedia ada (is_primary_phone=1) atau append
    baris baharu kalau Contact tiada phone lagi. Contact ialah sumber
    tunggal telefon customer (sama sumber yang wizard booking guna untuk
    auto-fill — rujuk _helpers.get_customer_phone).
    """
    frappe.flags.ignore_permissions = True
    customer_name = _get_customer()

    phone = _format_phone(phone)
    if not phone:
        frappe.throw("Please enter a phone number.")

    # Validasi kesahihan SEBENAR guna library yang sama dengan Frappe
    # (fieldtype Phone) — elak simpan nombor yang akan ditolak Desk nanti.
    try:
        from phonenumbers import parse as phonenumbers_parse, is_valid_number
        if not is_valid_number(phonenumbers_parse(phone)):
            frappe.throw("The phone number is not valid. Please check and try again.")
    except frappe.throw:
        raise
    except Exception:
        frappe.throw("The phone number is not valid. Please check and try again.")

    # Cari Contact utama customer (via Dynamic Link — corak sama _helpers).
    contact_name = frappe.db.sql("""
        SELECT dl.parent
        FROM `tabDynamic Link` dl
        JOIN `tabContact` c ON c.name = dl.parent
        WHERE dl.link_doctype = 'Customer' AND dl.link_name = %s
        ORDER BY c.creation ASC
        LIMIT 1
    """, customer_name, as_dict=True)
    contact_name = contact_name[0].parent if contact_name else None
    if not contact_name:
        frappe.throw("No contact record found. Please contact support to update your phone number.")

    contact = frappe.get_doc("Contact", contact_name)
    normalized = phone  # dah dalam format +ISD-nombor

    existing_primary = None
    for row in contact.phone_nos:
        if row.is_primary_phone:
            existing_primary = row
            break

    if existing_primary:
        existing_primary.phone = normalized
    else:
        contact.append("phone_nos", {
            "phone":            normalized,
            "is_primary_phone": 1,
        })

    contact.flags.ignore_permissions = True
    contact.save()

    return {
        "status": "ok",
        "phone":  normalized,
        "message": "Phone number updated.",
    }


@frappe.whitelist()
def change_password(old_password: str, new_password: str):
    """Tukar password SEMASA LOGIN — verify password lama dulu.

    Guna frappe.auth.check_password (sama mekanisme login) untuk verify;
    kemudian update via User doc (before_update hook Frappe meng-hash
    new_password secara automatik). Bukan reset-key flow (tu untuk
    forgot_password — rujuk portal_auth.set_password).
    """
    user_email = frappe.session.user
    if not user_email or user_email == "Guest":
        frappe.throw("Please log in to continue.", frappe.AuthenticationError)

    new_password = new_password or ""
    if len(new_password) < 8:
        frappe.throw("New password must be at least 8 characters.")

    if old_password == new_password:
        frappe.throw("New password must be different from your current password.")

    # Verify password semasa — GAGAL = tolak terus (elak orang yang jumpa
    # session terbuka tukar password tanpa milik akaun).
    from frappe.auth import check_password
    try:
        check_password(user_email, old_password)
    except Exception:
        frappe.throw("Your current password is incorrect. Please try again.")

    user = frappe.get_doc("User", user_email)
    user.new_password = new_password
    user.flags.ignore_permissions = True
    user.flags.ignore_password_policy = False  # policy standard Frappe DIENFORCE
    user.save()

    # Nota keselamatan melalui emel standard Frappe (jika dihidupkan) —
    # frappe.sendmail password-change notice di-handle oleh hook User.
    return {"status": "ok", "message": "Password updated successfully."}


@frappe.whitelist()
def request_data_action(action: str, details: str = ""):
    """PDPA — hak data subject (Malaysia Personal Data Protection Act):
    customer boleh mohon PEMBETULAN (correction) atau PEMADAMAN (deletion)
    data peribadi mereka.

    Implementasi v1: create ToDo berkeutamaan Tinggi untuk admin semak &
    proses manual (padam penuh melibatkan Booking/SO berstatus accounting —
    TIDAK boleh auto-padam tanpa semakan). Rekod permintaan = audit trail
    PDPA (bukti hak customer dilaksanakan dalam tempoh yang sepatutnya).
    """
    frappe.flags.ignore_permissions = True
    customer_name = _get_customer()

    action = (action or "").strip().lower()
    if action not in ("correction", "deletion"):
        frappe.throw("Invalid request type.")

    email = frappe.session.user
    label = "Data CORRECTION" if action == "correction" else "Data DELETION"

    todo = frappe.get_doc({
        "doctype":     "ToDo",
        "status":      "Open",
        "priority":    "High",
        "subject":     "PDPA {0} request — {1}".format(label, customer_name),
        "description": (
            "A customer submitted a PDPA data {0} request from the portal.\n\n"
            "Customer: {1}\nEmail: {2}\nRequested: {3}\n\n"
            "Details from customer:\n{4}\n\n"
            "Action: Review the request and respond to the customer within a "
            "reasonable period (PDPA data subject rights). For deletions, check "
            "accounting/retention obligations before purging records; passport "
            "images on Traveller records can be removed independently."
        ).format(
            action,
            customer_name,
            email,
            frappe.utils.now(),
            (details or "-"),
        ),
        "allocated_to": "Administrator",
    })
    todo.flags.ignore_permissions = True
    todo.insert()

    return {
        "status": "ok",
        "message": (
            "Your request has been submitted. Our team will contact you at "
            "{0} regarding your data {1} request.".format(email, action)
        ),
    }
