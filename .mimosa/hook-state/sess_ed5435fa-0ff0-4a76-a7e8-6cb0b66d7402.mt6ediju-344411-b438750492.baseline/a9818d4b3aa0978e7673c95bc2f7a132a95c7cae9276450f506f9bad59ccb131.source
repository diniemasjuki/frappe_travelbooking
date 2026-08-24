# Copyright (c) 2026, WargaPrihatin and contributors

import frappe


def _norm_trip_type(value):
	"""Normalize trip type token: 'Non-Cruise' / 'non_cruise' / ' non cruise '
	semuanya jadi 'non_cruise' — elak mismatch hyphen/underscore/space
	antara data DB, template JS dan query param."""
	return (value or "").strip().lower().replace("-", "_").replace(" ", "")


@frappe.whitelist(allow_guest=True)
def fetch_price_labels():
	"""
	Return price category labels. Pass trip_type as form param.
	Accepts 'cruise' / 'non-cruise' / 'non_cruise' (normalized).
	"""
	trip_type = _norm_trip_type(frappe.form_dict.get("trip_type", "non_cruise"))

	if trip_type == "cruise":
		defaults = [
			{"price_key": "price_adult", "display_label": "Main Adult", "display_note": "Main Guest must be adult at 12+ years old and above.", "sort_order": 0},
			{"price_key": "price_upperberth", "display_label": "Extra Bed", "display_note": "Extra bed such as sofa bed or upper-berth.", "sort_order": 1},
			{"price_key": "price_infant", "display_label": "Infant", "display_note": "Valid for 0-23 month on embarkation date.", "sort_order": 2},
		]
	else:
		defaults = [
			{"price_key": "price_adult", "display_label": "Adult", "display_note": "12 years old and above.", "sort_order": 0},
			{"price_key": "price_children", "display_label": "Children", "display_note": "2-11 years old on departure date.", "sort_order": 1},
			{"price_key": "price_infant", "display_label": "Infant", "display_note": "Valid for 0-23 month on embarkation date.", "sort_order": 2},
		]

	try:
		settings = frappe.get_doc("Travel Settings", "Travel Settings")
		result = []
		for row in (settings.price_category_labels or []):
			if not row.get("is_active"):
				continue
			applies = _norm_trip_type(row.get("applies_to"))
			if applies not in (trip_type, "both"):
				continue
			result.append({
				"price_key": str(row.get("price_key") or ""),
				"display_label": str(row.get("display_label") or ""),
				"display_note": str(row.get("display_note") or ""),
				"sort_order": int(row.get("sort_order") or 0),
			})
		if result:
			result.sort(key=lambda x: x.get("sort_order", 0))
			return result
	except Exception:
		pass

	return defaults
