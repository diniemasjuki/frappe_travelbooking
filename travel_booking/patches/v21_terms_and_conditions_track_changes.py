# travel_booking/patches/v21_terms_and_conditions_track_changes.py
#
# Aktifkan track_changes pada doctype standard "Terms and Conditions"
# (ERPNext Setup). Booking merakam Link ke dokumen T&C yang dipersetujui
# customer — tanpa version history, suntingan in-place kehilangan jejak
# kandungan lama yang pernah dipaparkan di wizard. Property Setter ni
# memastikan setiap suntingan dokumen T&C tercatat di Version history.

import frappe


def execute():
    if not frappe.db.exists(
        "Property Setter",
        {"doc_type": "Terms and Conditions", "property": "track_changes"},
    ):
        frappe.get_doc({
            "doctype": "Property Setter",
            "doctype_or_field": "DocType",
            "doc_type": "Terms and Conditions",
            "property": "track_changes",
            "property_type": "Check",
            "value": "1",
        }).insert(ignore_permissions=True)
        frappe.clear_cache(doctype="Terms and Conditions")
