"""Pindahkan GA4 Measurement ID yang dahulu hardcoded ke Travel Website.

Sebelum ni snippet gtag.js di-hardcode dalam templates/base_travel.html
dengan ID `G-NZ2WLPC597` untuk SEMUA page (tour & cruise). GA kini
dikonfigurasi per-site melalui Travel Website (tab Cruise/Tour Homepage →
section Google Analytics).

Keputusan bisnes: ID sedia ada dipindah ke site CRUISE sahaja — site tour
berhenti di-track sehingga admin isi Measurement ID baharu di tab Tour
Homepage. Patch idempotent: hanya isi jika field masih kosong.
"""

import frappe

# ID yang dahulu hardcoded dalam base_travel.html
_LEGACY_GA_ID = "G-NZ2WLPC597"


def execute():
	if not frappe.db.exists("DocType", "Travel Website"):
		return

	values = {}
	if not frappe.db.get_single_value("Travel Website", "cruise_ga_measurement_id"):
		values["cruise_ga_measurement_id"] = _LEGACY_GA_ID
		values["cruise_ga_enabled"] = 1

	if not values:
		return

	frappe.db.set_single_value("Travel Website", values, update_modified=False)
