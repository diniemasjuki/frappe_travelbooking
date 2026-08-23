# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class TravelWebsite(Document):
    def on_update(self):
        # Kosongkan cache konfigurasi supaya perubahan di Desk dipaparkan
        # serta-merta pada homepage awam. Key ditakrif di website_config.py.
        frappe.cache().delete_value("travel_website_config")
