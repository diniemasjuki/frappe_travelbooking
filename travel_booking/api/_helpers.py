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
    Pulang None kalau tiada. Sama pattern dengan get_customer_email() —
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