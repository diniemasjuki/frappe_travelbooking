# travel_booking/www/__domain_redirect.py
#
# Endpoint untuk handle multi-domain redirect.
# Dipanggil oleh nginx selepas intercept root path "/".
# Membaca konfigurasi dari Travel Website doctype (dynamic!).
#
# Flow:
#   User access: https://test.rpwp.my/
#     ↓
#   Nginx intercept "/", redirect ke /__domain_redirect
#     ↓
#   File ini dibaca, detect domain, baca Travel Website config
#     ↓
#   Redirect ke URL yang dikonfigurasi (e.g., /cruise, /tour, /promosi)

import frappe
from travel_booking.utils.website_config import get_website_config


def get_context(context):
    """
    Detect domain dan redirect ke URL yang ditetapkan dalam Travel Website.
    """
    config = get_website_config()

    # Dapatkan current domain
    host = None
    if getattr(frappe.local, "request", None):
        host = frappe.local.request.host

    if not host:
        # No host info - fallback to /cruise
        if hasattr(frappe, 'redirect'):
            frappe.redirect("/cruise")
        else:
            frappe.local.redirect_location = "/cruise"
            raise frappe.Redirect

    # Normalize domain
    domain = host.split(":")[0].lower()

    # Default target URL
    target_url = "/cruise"

    # Cek jika multi-domain diaktifkan
    if config.get("multi_domain", {}).get("enabled"):
        # Cari matching domain dalam mappings
        for mapping in config["multi_domain"].get("mappings", []):
            map_domain = mapping.get("domain", "").lower()
            map_url = mapping.get("redirect_url", "/cruise")

            if map_domain == domain:
                # MATCH FOUND!
                target_url = map_url
                break  # Stop at first match

    # Redirect ke target URL
    if hasattr(frappe, 'redirect'):
        frappe.redirect(target_url)
    else:
        frappe.local.redirect_location = target_url
        raise frappe.Redirect
