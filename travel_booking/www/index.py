# travel_booking/www/index.py
#
# DOMAIN-BASED VIRTUAL HOSTING (Internal Rewrite)
# ------------------------------------------------
# Detect incoming domain dan REWRITE path secara internal.
# URL tetap sama di browser, tapi Frappe process seperti
# request ke page yang berbeza.
#
# Contoh:
#   cruise.rarecation.com/  → Frappe process sebagai /cruise
#   rarecation.com/        → Frappe process sebagai /tour
#   traveller.rpwp.my/    → Frappe process sebagai /traveller_portal

import frappe
from travel_booking.utils.website_config import get_website_config


def get_context(context):
    """
    Root path "/" handler - detect domain dan rewrite path secara internal.
    Menggunakan frappe.location.href untuk internal redirect yang
    tak mengubah URL dalam browser.
    """
    config = get_website_config()
    
    # Dapatkan current domain
    host = None
    if getattr(frappe.local, "request", None):
        host = frappe.local.request.host
    
    if not host:
        # Fallback: show cruise homepage
        _internal_redirect("/cruise")
    
    # Normalize domain (strip port)
    domain = host.split(":")[0].lower()
    
    # Default target
    target_path = "/cruise"
    
    # Cek jika multi-domain diaktifkan
    if config.get("multi_domain", {}).get("enabled"):
        # Cari matching domain dalam mappings
        for mapping in config["multi_domain"].get("mappings", []):
            map_domain = mapping.get("domain", "").lower()
            map_url = mapping.get("redirect_url", "/cruise")
            
            if map_domain == domain:
                # Domain matched!
                target_path = map_url
                break
    
    # Lakukan internal redirect ke target path
    # Ini akan menyebabkan Frappe memproses path tersebut
    # tetapi URL dalam browser KEKAL sama
    _internal_redirect(target_path)


def _internal_redirect(path):
    """
    Perform internal redirect ke path tertentu.
    URL tidak berubah dalam browser.
    """
    try:
        # Kaedah 1: Gunakan frappe.redirect (jika ada)
        if hasattr(frappe, 'redirect'):
            frappe.redirect(path)
            return
        
        # Kaedah 2: Set location header (client-side redirect - akan ubah URL)
        # Ini fallback sahaja - sepatutnya tak digunakan
        frappe.local.redirect_location = path
        raise frappe.Redirect
        
    except Exception as e:
        # Jika semua gagal, set context untuk default page
        frappe.logger().debug(f"🌐 VIRTUAL-HOST: Redirect error: {e}, fallback to /cruise")
        return {"title": "Rarecation", "page_type": "cruise"}
