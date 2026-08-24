# travel_booking/www/_redirect.py
#
# Route handler untuk multi-domain DNS directory.
# Detect incoming domain dan redirect ke URL yang ditetapkan.
#
# Digunakan dalam hooks.py:
#   website_route_rules = [
#       {"from": "/", "to": "travel_booking.www._redirect.homepage_redirect"},
#   ]

import frappe
from travel_booking.utils.website_config import get_website_config


def homepage_redirect(context):
    """
    Detect incoming domain dan redirect ke URL yang dikonfigurasi.

    Aliran:
    1. Jika multi-domain tidak diaktifkan → redirect ke /cruise (default)
    2. Dapatkan current domain dari request
    3. Cari match dalam domain_mappings
    4. Jika match → redirect ke URL yang ditetapkan (fleksibel!)
    5. Jika tiada match → fallback ke /cruise
    """
    import frappe

    config = get_website_config()

    # DEBUG: Log info untuk troubleshooting
    frappe.logger().debug(f"🌐 MULTI-DOMAIN: homepage_redirect called")
    frappe.logger().debug(f"🌐 MULTI-DOMAIN: enabled = {config.get('multi_domain', {}).get('enabled')}")
    frappe.logger().debug(f"🌐 MULTI-DOMAIN: mappings count = {len(config.get('multi_domain', {}).get('mappings', []))}")

    # Jika multi-domain tidak diaktifkan, gunakan default (/cruise)
    if not config.get("multi_domain", {}).get("enabled"):
        frappe.logger().debug(f"🌐 MULTI-DOMAIN: NOT ENABLED → fallback to /cruise")
        frappe.local.redirect_location = "/cruise"
        raise frappe.Redirect

    # Dapatkan current domain dari incoming request
    host = None
    if getattr(frappe.local, "request", None):
        host = frappe.local.request.host

    frappe.logger().debug(f"🌐 MULTI-DOMAIN: detected host = {host}")

    if not host:
        # Fallback jika tiada request context
        frappe.logger().debug(f"🌐 MULTI-DOMAIN: NO HOST → fallback to /cruise")
        frappe.local.redirect_location = "/cruise"
        raise frappe.Redirect

    # Strip port number jika ada (e.g., localhost:8000 → localhost)
    domain = host.split(":")[0].lower()
    frappe.logger().debug(f"🌐 MULTI-DOMAIN: normalized domain = {domain}")

    # Cari matching domain dalam mappings
    for idx, mapping in enumerate(config["multi_domain"].get("mappings", [])):
        map_domain = mapping.get("domain", "").lower()
        map_url = mapping.get("redirect_url", "/cruise")
        frappe.logger().debug(f"🌐 MULTI-DOMAIN: checking mapping[{idx}] {map_domain} → {map_url}")

        if map_domain == domain:
            # Redirect terus ke URL yang dikonfigurasi (fleksibel!)
            frappe.logger().debug(f"🌐 MULTI-DOMAIN: ✅ MATCH FOUND! Redirecting to {map_url}")
            frappe.local.redirect_location = map_url
            raise frappe.Redirect

    # Tiada match ditemui → fallback ke cruise (default)
    frappe.logger().debug(f"🌐 MULTI-DOMAIN: ❌ NO MATCH → fallback to /cruise")
    frappe.local.redirect_location = "/cruise"
    raise frappe.Redirect
