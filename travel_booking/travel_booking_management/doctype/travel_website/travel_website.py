# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class TravelWebsite(Document):
    def on_update(self):
        # Kosongkan cache konfigurasi supaya perubahan di Desk dipaparkan
        # serta-merta pada homepage awam dan Trip Command Center.
        cache = frappe.cache()
        # Template rendering cache (used by website_config.py)
        cache.delete_value("travel_website_config")
        # Trip Command Center desk page cache
        cache.delete_value("tcc_website_settings")
