# travel_booking/api/trip_links.py
# Pautan produk per-Trip untuk page Travel Manager (hierarki Trip-first):
#   Trip → 1 cruise schedule / 1 flight arrangement / komponen produk
# Semua endpoint gated role ops (corak trip_command_center).

import frappe
from frappe import _

from travel_booking.api.trip_command_center import (
	TRIP_COMMAND_CENTER_ROLES,
	_check_command_center_roles,
)


def _gate():
	_check_command_center_roles(TRIP_COMMAND_CENTER_ROLES, "Trip Links")


@frappe.whitelist()
def get_trip_links(trip: str) -> dict:
	"""Semua pautan produk satu Trip — satu call untuk panel expand.

	- cruise schedule (paling relevan) + varian kabin + harga + currency
	- flight arrangement (1:1, kalau ada)
	- komponen produk (daripada Travel Package pakej-pakej trip ni)
	"""
	_gate()
	if not frappe.db.exists("Trip", trip):
		frappe.throw(_("Trip {0} not found.").format(trip), frappe.DoesNotExistError)

	cruise = None
	other_schedules = 0
	# Pautan baharu (Nov 2026): schedule dikesan melalui Travel Date trip
	# ini (Travel Date.cruise_schedule) — schedule tidak lagi link Trip
	# secara langsung. Paling relevan = sailing terkini.
	td_schedules = list(dict.fromkeys(frappe.get_all(
		"Travel Date",
		filters={"trip": trip, "cruise_schedule": ["is", "set"]},
		pluck="cruise_schedule",
	)))
	if td_schedules:
		other_schedules = len(td_schedules) - 1
		schedules = frappe.get_all(
			"Trip Cruise Schedule",
			filters={"name": ["in", td_schedules]},
			fields=["name", "schedule_code", "ship_name", "ship_code",
					"sail_start", "sail_end", "total_days", "total_nights",
					"port_start", "port_end", "status", "currency"],
			order_by="sail_start desc",
			limit=1,
		)
		if schedules:
			cruise = schedules[0]
			cruise["cabin_rates"] = frappe.get_all(
				"Trip Package Price",
				filters={"parent": cruise.name},
				fields=["pricing_for_class", "price_adult", "price_adult_single",
						"cabin_allotment", "cabin_occupancy"],
				order_by="idx asc",
			)

	fa = frappe.db.get_value(
		"Flight Arrangement", {"trip": trip},
		["name", "flight_mode", "home_airport", "final_destination",
		 "preferred_airline", "notes"],
		as_dict=True,
	)
	if fa:
		fa["via_airports"] = [
			r.airport
			for r in frappe.get_all(
				"Flight Arrangement Via",
				filters={"parent": fa.name, "parenttype": "Flight Arrangement"},
				fields=["airport"], order_by="sort_order asc",
			)
		]

	# Hierarki ERD (Nov 2026): Default Products & Components di peringkat
	# TRIP — pra-isi pakej baharu trip ini (Trip.default_components child
	# table, guna semula Package Component). Dipaparkan pada kad utama trip.
	default_components = frappe.get_all(
		"Package Component",
		filters={"parent": trip, "parenttype": "Trip"},
		fields=["name", "component_type", "trip", "flight",
				"component_item", "age_option", "selection_mode",
				"qty", "mandatory"],
		order_by="sort_order asc",
	)

	return {
		"trip": trip,
		"cruise_schedule": cruise,
		"other_schedules": other_schedules,
		"flight_arrangement": fa,
		"default_components": default_components,
	}


@frappe.whitelist()
def save_trip_default_components(trip: str, components: str) -> dict:
	"""Simpan senarai Default Products & Components peringkat TRIP
	(hierarki ERD). `components` = JSON array baris Package Component:
	[{component_type, trip, flight, component_item, age_option,
	  selection_mode, qty, mandatory}]. Ganti penuh (full-replace) —
	corak sama save_trip destinations/itinerary. Pakej sedia ada TIDAK
	diubah; senarai ini hanya pra-isi wizard pakej baharu."""
	_gate()
	import json as _json
	if not frappe.db.exists("Trip", trip):
		frappe.throw(_("Trip {0} not found.").format(trip), frappe.DoesNotExistError)
	rows = _json.loads(components or "[]")
	if not isinstance(rows, list):
		frappe.throw(_("Invalid components."))
	valid_types = {"cruise_tour", "flight", "activity", "merchandise"}
	doc = frappe.get_doc("Trip", trip)
	doc.set("default_components", [])
	for i, r in enumerate(rows):
		ctype = (r.get("component_type") or "").strip()
		if not ctype:
			continue
		if ctype not in valid_types:
			frappe.throw(_("Invalid component type: {0}").format(ctype))
		doc.append("default_components", {
			"component_type": ctype,
			"trip": r.get("trip") or (trip if ctype == "cruise_tour" else None),
			"flight": r.get("flight") or None,
			"component_item": r.get("component_item") or None,
			"age_option": r.get("age_option") or "",
			"selection_mode": r.get("selection_mode") or "customer_pick",
			"qty": int(r.get("qty") or 1),
			"mandatory": 1 if r.get("mandatory") else 0,
			"sort_order": int(r.get("sort_order") or (10 * (i + 1))),
		})
	doc.save(ignore_permissions=True)
	return {"status": "ok", "count": len(doc.default_components)}


@frappe.whitelist()
def list_component_items(search: str = None, limit: int = 100) -> list:
	"""Cadangan Item (produk) untuk komponen activity/merchandise pada
	dialog Default Products & Components / komponen pakej. Item jualan
	aktif sahaja; rujukan cepat Travel Manager."""
	_gate()
	filters = {"disabled": 0, "is_sales_item": 1}
	if search:
		filters["name"] = ["like", f"%{search}%"]
	return frappe.get_all(
		"Item", filters=filters,
		fields=["name", "item_name"], order_by="name asc",
		limit=max(1, min(limit or 100, 200)),
	)


@frappe.whitelist()
def list_schedules() -> list:
	"""Pilihan cruise schedule untuk picker PAUTAN (Travel Date /
	komponen cruise_tour)."""
	_gate()
	return frappe.get_all(
		"Trip Cruise Schedule",
		fields=["name", "schedule_code", "ship_name", "ship_code",
				"sail_start", "sail_end", "status"],
		order_by="sail_start desc",
		limit=200,
	)


# [BUANG Nov 2026] set_trip_cruise_schedule — pautan per-TRIP dibuang;
# schedule kini dipaut pada peringkat TRAVEL DATE (Travel
# Date.cruise_schedule, diurus pada halaman tarikh Travel Manager).


@frappe.whitelist()
def get_flight_arrangement(trip: str) -> dict:
	_gate()
	fa = frappe.db.get_value(
		"Flight Arrangement", {"trip": trip}, "name", as_dict=True
	)
	if not fa:
		return None
	doc = frappe.get_doc("Flight Arrangement", fa.name)
	return {
		"name": doc.name,
		"trip": doc.trip,
		"flight_mode": doc.flight_mode,
		"home_airport": doc.home_airport,
		"final_destination": doc.final_destination,
		"preferred_airline": doc.preferred_airline,
		"notes": doc.notes,
		"via_airports": [r.airport for r in (doc.via_airports or [])],
	}


@frappe.whitelist()
def save_flight_arrangement(values: str) -> dict:
	"""Cipta/kemas kini Flight Arrangement (1:1 per Trip)."""
	_gate()
	import json as _json
	data = _json.loads(values or "{}")
	trip = data.get("trip")
	if not trip or not frappe.db.exists("Trip", trip):
		frappe.throw(_("Valid Trip is required."))

	allowed = ["flight_mode", "home_airport", "final_destination",
			   "preferred_airline", "notes"]

	existing = frappe.db.get_value("Flight Arrangement", {"trip": trip}, "name")
	if existing:
		doc = frappe.get_doc("Flight Arrangement", existing)
		for f in allowed:
			if f in data:
				doc.set(f, data.get(f))
		if "via_airports" in data:
			doc.set("via_airports", [])
			for i, airport in enumerate(data.get("via_airports") or []):
				doc.append("via_airports", {"airport": airport, "sort_order": i})
		doc.save()
		action = "updated"
	else:
		doc = frappe.get_doc({"doctype": "Flight Arrangement", "trip": trip})
		for f in allowed:
			if f in data:
				doc.set(f, data.get(f))
		for i, airport in enumerate(data.get("via_airports") or []):
			doc.append("via_airports", {"airport": airport, "sort_order": i})
		doc.insert()
		action = "created"

	return {"status": "ok", "name": doc.name, "action": action}
