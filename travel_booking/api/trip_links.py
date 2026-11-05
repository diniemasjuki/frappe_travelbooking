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
	schedules = frappe.get_all(
		"Trip Cruise Schedule",
		filters={"trip_link": trip},
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

	packages = frappe.get_all("Travel Package", filters={"trip": trip}, pluck="name")
	components = []
	if packages:
		components = frappe.get_all(
			"Package Component",
			filters={"parent": ["in", packages], "parenttype": "Travel Package"},
			fields=["parent", "component_type", "trip", "flight",
					"component_item", "selection_mode", "mandatory"],
			order_by="sort_order asc",
		)

	return {
		"trip": trip,
		"cruise_schedule": cruise,
		"other_schedules": max(0, len(schedules) - 1),
		"flight_arrangement": fa,
		"packages": packages,
		"components": components,
	}


@frappe.whitelist()
def list_schedules() -> list:
	"""Pilihan cruise schedule untuk picker PAUTAN."""
	_gate()
	return frappe.get_all(
		"Trip Cruise Schedule",
		fields=["name", "schedule_code", "ship_name", "sail_start", "sail_end",
				"status", "trip_link"],
		order_by="sail_start desc",
		limit=200,
	)


@frappe.whitelist()
def set_trip_cruise_schedule(trip: str, schedule: str) -> dict:
	"""Pautkan SATU cruise schedule kepada trip. Schedule lain yang ketika
	ini menunjuk trip ini diletakkan tanpa pautan (1:1 — keputusan reka
	bentuk SSoT); perubahan direkod dalam log."""
	_gate()
	if not frappe.db.exists("Trip Cruise Schedule", schedule):
		frappe.throw(_("Schedule {0} not found.").format(schedule), frappe.DoesNotExistError)

	for other in frappe.get_all(
		"Trip Cruise Schedule", filters={"trip_link": trip}, pluck="name"
	):
		if other != schedule:
			frappe.db.set_value("Trip Cruise Schedule", other, "trip_link", None,
								update_modified=False)
			frappe.logger("trip_links").info(
				f"set_trip_cruise_schedule: {other} dilepaskan dari {trip}"
			)

	frappe.db.set_value("Trip Cruise Schedule", schedule, "trip_link", trip)
	return {"status": "ok", "schedule": schedule}


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
