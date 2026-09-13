# travel_booking/patches/v3_b2b_partner_setup.py
#
# Setup fasa B2B (agen / reseller) untuk site SEDIA ADA:
#   1. Customer Group "B2B" — cadangan group untuk Customer bil partner
#      (Travel B2B Partner.validate() beri amaran kalau Customer bukan
#      group ni; laporan jualan ERPNext boleh asingkan runcit vs agen).
#   2. 5 template emel varian TRAVELLER (tanpa harga) untuk saluran B2B.
#
# Idempotent — semak kewujudan sebelum cipta. Skema doctype baru
# (Travel B2B Partner dll.) disync oleh migrate sendiri, BUKAN di sini.

import frappe


def execute():
    _create_b2b_customer_group()
    from travel_booking.install import _create_b2b_email_templates
    _create_b2b_email_templates()


def _create_b2b_customer_group():
    if frappe.db.exists("Customer Group", "B2B"):
        return
    if not frappe.db.exists("Customer Group", "All Customer Groups"):
        # Root luar jangka (site tak standard) — jangan paksa; admin boleh
        # cipta group manual. Travel B2B Partner tetap berfungsi tanpa ni.
        return
    frappe.get_doc({
        "doctype":               "Customer Group",
        "customer_group_name":   "B2B",
        "parent_customer_group": "All Customer Groups",
        "is_group":              0,
    }).insert(ignore_permissions=True)
