# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe

MARKER = "booking-trip-details"
ANCHOR = "Your official receipt is attached to this email.</p>"

# Blok maklumat pembelian — context disediakan oleh
# _booking_trip_context() (email_service.py). Guard {% if trip_title %}
# supaya resit tanpa info trip kekal seperti sediakan.
BLOCK = """\
{% if trip_title %}
<!-- booking-trip-details -->
<div style="background:#F5F3EE;border-radius:12px;padding:20px 24px;margin-bottom:24px">
  <div style="font-size:11px;color:#7D7A70;margin-bottom:10px">Booking Details</div>
  <table style="width:100%;font-size:13px;color:#1E1C18;border-collapse:collapse">
    <tr><td style="padding:4px 0;color:#7D7A70">Trip</td><td style="text-align:right;font-weight:600">{{ trip_title }}</td></tr>
    {% if package_title %}<tr><td style="padding:4px 0;color:#7D7A70">Package</td><td style="text-align:right;font-weight:600">{{ package_title }}</td></tr>{% endif %}
    {% if group_date_name %}<tr><td style="padding:4px 0;color:#7D7A70">Group Date</td><td style="text-align:right;font-weight:600">{{ group_date_name }}</td></tr>{% endif %}
    {% if departure_fmt %}<tr><td style="padding:4px 0;color:#7D7A70">Departure</td><td style="text-align:right;font-weight:600">{{ departure_fmt }}{% if return_fmt %} &ndash; {{ return_fmt }}{% endif %}</td></tr>{% endif %}
    {% if total_fmt %}<tr><td style="padding:4px 0;color:#7D7A70">Total</td><td style="text-align:right;font-weight:600">{{ total_fmt }}</td></tr>{% endif %}
    {% if balance_fmt %}<tr><td style="padding:4px 0;color:#7D7A70">Outstanding Balance</td><td style="text-align:right;font-weight:600">{{ balance_fmt }}</td></tr>{% endif %}
  </table>
</div>
{% endif %}
"""


def _receipt_template_names():
    """Template yang sedang digunakan untuk resit: pilihan Travel Settings
    (baris payment_receipt) dahulu, fallback nama default "Payment Receipt"."""
    names = []
    if frappe.db.exists("Travel Settings", "Travel Settings"):
        custom = frappe.get_all(
            "Travel Email Notification",
            filters={
                "parent": "Travel Settings",
                "parenttype": "Travel Settings",
                "notification_key": "payment_receipt",
            },
            fields=["email_template"],
            limit=1,
        )
        if custom and custom[0].email_template:
            names.append(custom[0].email_template)
    names.append("Payment Receipt")
    return list(dict.fromkeys(names))


def execute():
    """Suntik blok "Booking Details" (trip/pakej/group date/jumlah/baki)
    ke dalam Email Template resit site. TIDAK menimpa HTML admin: hanya
    insert selepas anchor jika marker belum wujud; jika anchor tak ditemui
    (template diubah jauh), print nota supaya admin boleh edit manual di
    Desk — context variables tetap tersedia untuk template itu."""
    for name in _receipt_template_names():
        if not frappe.db.exists("Email Template", name):
            continue
        html = frappe.db.get_value("Email Template", name, "response_html") or ""
        if MARKER in html:
            continue
        if ANCHOR not in html:
            print(f"v27_receipt_trip_info: anchor tidak ditemui dalam '{name}' "
                  "- template diubah manual; tambah blok Booking Details "
                  "(rujuk patches/v27_receipt_trip_info.py) di Desk.")
            continue
        new_html = html.replace(ANCHOR, ANCHOR + BLOCK, 1)
        frappe.db.set_value("Email Template", name, "response_html", new_html)
        print(f"v27_receipt_trip_info: blok Booking Details disuntik ke '{name}'.")
