"""Fasa 5A renovation — highlight pakej di homepage.

1. Trip Package.featured (Check) — bendera pakej di-highlight di
   homepage vertical masing-masing (cruise/tour). Berbeza dari
   Trip.featured_trip (highlight per KESELURUHAN trip); featured
   pakej membolehkan beberapa pakej pada group date sama
   (trip group date dikongsi merentasi pakej — keperluan sebenar
   operasi: "beberapa pakej berbeza dijual pada tarikh cruise sama")
   ditonjolkan berasingan.

2. Trip.featured_trip mula DIGUNA sebenar oleh homepage: trip
   berbendera diutamakan dalam senarai "featured cruises/tours"
   (fallback ke 6 teratas bila tiada bendera — behavior lama).

Idempoten — selamat dijalankan berulang.
"""

import frappe


def _ensure_custom_field(spec):
	if frappe.db.exists("Custom Field", {"dt": spec["dt"], "fieldname": spec["fieldname"]}):
		return
	frappe.get_doc(dict(doctype="Custom Field", **spec)).insert(ignore_permissions=True)


def execute():
	_ensure_custom_field({
		"dt":          "Trip Package",
		"fieldname":   "featured",
		"label":       "Featured",
		"fieldtype":   "Check",
		"default":     "0",
		"insert_after": "price_review_required",
		"description": (
			"Highlight pakej ini di homepage vertical (cruise/tour) — "
			"senarai 'Featured Packages'. Berbeza dari Trip.featured_trip "
			"(highlight keseluruhan trip)."
		),
	})
