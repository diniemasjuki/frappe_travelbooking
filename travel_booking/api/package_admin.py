# travel_booking/api/package_admin.py
# API pengurusan Travel Package / Package Offer (F2) — STAF SAHAJA.
# Ciptaan offer guna offer_factory (satu laluan dengan patch migrasi).

import frappe
from frappe import _
from frappe.utils import cint

from travel_booking.api.trip_command_center import (
	TRIP_COMMAND_CENTER_ROLES,
	_check_command_center_roles,
)


def _require_product_admin():
	_check_command_center_roles(TRIP_COMMAND_CENTER_ROLES, "Package Management")


@frappe.whitelist()
def generate_offer_from_template(package: str, departure_date: str, return_date: str = None) -> dict:
	"""Cipta Package Offer baharu daripada templat pakej (harga disalin,
	inventori kosong — staf isi allotment). Offer tercipta status Draft;
	Active perlu kelulusan Tour Manager (workflow).

	Note: kerana nama offer berjujukan, JANGAN dedahkan nama ini ke URL awam
	— guna public_slug (pelajaran audit F9).
	"""
	_require_product_admin()
	from travel_booking.utils.offer_factory import create_offer

	if not departure_date:
		frappe.throw(_("Departure date is required."))

	offer_name = create_offer(package, {
		"departure_date": departure_date,
		"return_date": return_date,
	})
	return {"status": "ok", "offer": offer_name}


@frappe.whitelist()
def cross_check_structure(limit: int = 500) -> dict:
	"""Cross-check struktur baharu vs sumber lama (harga/allotment/sold)
	melalui provenance legacy_* — bukti migrasi tak drift (F3)."""
	_require_product_admin()
	from travel_booking.utils.product_readiness import cross_check_legacy
	return cross_check_legacy(cint(limit) or 500)


# ══════════════════════════════════════════════
# TRAVEL MANAGER PAGE (UI mudah — tanpa akses DocType terus)
# ══════════════════════════════════════════════

# Status yang perlukan kelulusan pengurusan (keputusan reka bentuk:
# "Tour Manager meluluskan")
_MANAGER_ONLY = {"System Manager", "Tour Manager"}


def _gate_status_change(status: str):
	if status in ("Active", "Retired", "Cancelled"):
		if not (_MANAGER_ONLY & set(frappe.get_roles())):
			frappe.throw(
				_("Only Tour Manager / System Manager can set status to {0}.").format(status),
				frappe.PermissionError,
			)


@frappe.whitelist()
def get_packages_list(search: str = None, status: str = None, limit: int = 50, trip: str = None) -> dict:
	"""Senarai pakej untuk Travel Manager — ringkas, dengan metrik jualan.
	`trip` = tapis ikut trip (hierarki Trip-first)."""
	_require_product_admin()
	limit = max(1, min(cint(limit) or 50, 200))
	filters = {}
	if status:
		filters["status"] = status
	if trip:
		filters["trip"] = trip
	if search:
		filters["package_name"] = ["like", "%" + search + "%"]

	packages = frappe.get_all(
		"Travel Package", filters=filters,
		fields=["name", "package_name", "status", "package_template",
				"default_currency", "trip", "item", "public_slug",
				"price_review_required"],
		order_by="modified desc", limit=limit,
	)
	names = [p.name for p in packages]
	offer_counts: dict = {}
	min_prices: dict = {}
	if names:
		for r in frappe.db.sql(
			"""SELECT package, COUNT(*) AS c FROM `tabPackage Offer`
			WHERE package IN %(n)s GROUP BY package""",
			{"n": names}, as_dict=True,
		):
			offer_counts[r.package] = r.c
		for r in frappe.db.sql(
			"""SELECT parent, MIN(price) AS p FROM `tabPackage Price Template`
			WHERE parent IN %(n)s AND active = 1 AND price > 0 GROUP BY parent""",
			{"n": names}, as_dict=True,
		):
			min_prices[r.parent] = float(r.p)
	for p in packages:
		p["offer_count"] = offer_counts.get(p.name, 0)
		p["min_price"] = min_prices.get(p.name)
	return {"packages": packages}


@frappe.whitelist()
def get_package_detail(package: str) -> dict:
	"""Detail pakej + komposisi + paksi/pilihan + templat harga + offers."""
	_require_product_admin()
	doc = frappe.get_doc("Travel Package", package)
	return {
		"name": doc.name,
		"package_name": doc.package_name,
		"status": doc.status,
		"package_template": doc.package_template,
		"trip": doc.trip,
		"default_currency": doc.default_currency,
		"item": doc.item,
		"public_slug": doc.public_slug,
		"package_description": doc.package_description,
		"components": [r.as_dict() for r in (doc.components or [])],
		"axes": [r.as_dict() for r in (doc.variant_axes or [])],
		"options": [r.as_dict() for r in (doc.variant_options or [])],
		"price_template": [r.as_dict() for r in (doc.price_template or [])],
		"offers": frappe.get_all(
			"Package Offer", filters={"package": doc.name},
			fields=["name", "offer_name", "departure_date", "return_date",
					"status_editorial", "status_operational",
					"max_pax", "current_pax", "public_slug"],
			order_by="departure_date asc",
		),
	}


@frappe.whitelist()
def save_package(values: str) -> dict:
	"""Cipta/kemas kini pakej (medan teras sahaja) melalui Travel Manager.
	Perubahan status ke Active/Retired perlukan Tour Manager."""
	_require_product_admin()
	import json as _json
	data = _json.loads(values or "{}")
	if not isinstance(data, dict):
		frappe.throw(_("Invalid values."))

	allowed = ["package_name", "package_template", "trip",
			   "default_currency", "package_description"]
	name = data.get("name")
	if name and frappe.db.exists("Travel Package", name):
		doc = frappe.get_doc("Travel Package", name)
		for f in allowed:
			if f in data:
				doc.set(f, data.get(f))
		new_status = data.get("status")
		if new_status and new_status != doc.status:
			_gate_status_change(new_status)
			doc.status = new_status
			if new_status == "Active":
				doc.price_review_required = 0
		doc.save()
		return {"status": "ok", "name": doc.name, "action": "updated"}

	if not data.get("package_name"):
		frappe.throw(_("Package Name is required."))
	doc = frappe.get_doc({"doctype": "Travel Package", "status": "Draft"})
	for f in allowed:
		if f in data:
			doc.set(f, data.get(f))
	doc.insert()
	return {"status": "ok", "name": doc.name, "action": "created"}


@frappe.whitelist()
def set_package_status(package: str, status: str) -> dict:
	"""Tukar status editorial pakej (Draft / Pending Review / Active / Retired)."""
	_require_product_admin()
	_gate_status_change(status)
	doc = frappe.get_doc("Travel Package", package)
	doc.status = status
	if status == "Active":
		doc.price_review_required = 0
	doc.save()
	return {"status": "ok", "name": doc.name, "status_now": doc.status}


@frappe.whitelist()
def get_offers_list(package: str = None, upcoming: int = 1, limit: int = 100, trip: str = None) -> dict:
	"""Senarai offer — semua/satu pakej/ikut trip; dengan % occupy.
	`trip` = offers semua pakej yang link trip tersebut."""
	_require_product_admin()
	limit = max(1, min(cint(limit) or 100, 500))
	filters = {}
	if package:
		filters["package"] = package
	if trip:
		trip_packages = frappe.get_all("Travel Package", filters={"trip": trip}, pluck="name")
		filters["package"] = ["in", trip_packages] if trip_packages else ["", ""]
	if cint(upcoming):
		filters["departure_date"] = [">=", frappe.utils.today()]
	offers = frappe.get_all(
		"Package Offer", filters=filters,
		fields=["name", "package", "offer_name", "departure_date", "return_date",
				"status_editorial", "status_operational", "max_pax", "current_pax"],
		order_by="departure_date asc", limit=limit,
	)
	pkg_names = list({o.package for o in offers})
	pkg_names_map = {}
	if pkg_names:
		pkg_names_map = {
			p.name: p.package_name
			for p in frappe.get_all("Travel Package",
				filters={"name": ["in", pkg_names]},
				fields=["name", "package_name"])
		}
	out = []
	for o in offers:
		mx = int(o.max_pax or 0)
		o["package_name"] = pkg_names_map.get(o.package, o.package)
		o["occupancy_pct"] = (round(100 * int(o.current_pax or 0) / mx) if mx else None)
		out.append(o)
	return {"offers": out}


@frappe.whitelist()
def set_offer_status(offer: str, status: str) -> dict:
	"""Tukar status EDITORIAL offer (Draft / Active / Cancelled).
	Active/Cancelled perlukan Tour Manager; operational kekal auto-job."""
	_require_product_admin()
	if status not in ("Draft", "Active", "Cancelled"):
		frappe.throw(_("Invalid editorial status."))
	_gate_status_change(status)
	doc = frappe.get_doc("Package Offer", offer)
	doc.status_editorial = status
	doc.save()
	return {"status": "ok", "name": doc.name, "status_now": doc.status_editorial}


@frappe.whitelist()
def get_offer_commercial(offer: str) -> dict:
	"""Inventori + harga offer untuk dialog Kuota & Harga (Travel Manager)."""
	_require_product_admin()
	if not frappe.db.exists("Package Offer", offer):
		frappe.throw(_("Offer not found."), frappe.DoesNotExistError)
	inventory = frappe.get_all(
		"Offer Inventory", filters={"parent": offer},
		fields=["name", "inventory_key", "allotment", "sold", "available"],
		order_by="inventory_key asc",
	)
	prices = frappe.get_all(
		"Offer Price", filters={"parent": offer},
		fields=["name", "price_key", "opt1", "opt2", "opt3", "age_option",
				"currency", "price", "active"],
		order_by="price_key asc",
	)
	return {"inventory": inventory, "prices": prices}


@frappe.whitelist()
def save_offer_inventory(offer: str, rows: str) -> dict:
	"""Kemaskini allotment per baris inventori — prasyarat utama flag
	use_package_offers (staf isi kuota tanpa buka DocType).
	Lock baris offer; validasi allotment >= sold; available dikira semula."""
	_require_product_admin()
	import json as _json
	data = _json.loads(rows or "[]")
	if not isinstance(data, list):
		frappe.throw(_("Invalid rows."))

	# LOCK baris offer — sama susunan dengan gate booking (P1/C3)
	frappe.db.sql("SELECT name FROM `tabPackage Offer` WHERE name = %s FOR UPDATE",
				  (offer,))
	updated = 0
	for r in data:
		name = r.get("name")
		if not name or not frappe.db.exists(
				"Offer Inventory", {"name": name, "parent": offer}):
			continue
		allot = int(r.get("allotment") or 0)
		row = frappe.db.get_value("Offer Inventory", name,
								  ["sold", "allotment"], as_dict=True)
		sold = int(row.sold or 0)
		if allot < sold:
			frappe.throw(
				_("Allotment for {0} cannot be less than sold ({1}).").format(
					r.get("inventory_key") or name, sold)
			)
		frappe.db.set_value("Offer Inventory", name,
			{"allotment": allot, "available": allot - sold},
			update_modified=False)
		updated += 1
	return {"status": "ok", "updated": updated}


@frappe.whitelist()
def save_offer_prices(offer: str, rows: str) -> dict:
	"""Kemaskini harga matriks offer (price per baris; active toggle)."""
	_require_product_admin()
	import json as _json
	data = _json.loads(rows or "[]")
	if not isinstance(data, list):
		frappe.throw(_("Invalid rows."))
	updated = 0
	for r in data:
		name = r.get("name")
		if not name or not frappe.db.exists(
				"Offer Price", {"name": name, "parent": offer}):
			continue
		price = float(r.get("price") or 0)
		if price < 0:
			frappe.throw(_("Price cannot be negative."))
		active = 1 if r.get("active", 1) else 0
		frappe.db.set_value("Offer Price", name,
			{"price": price, "active": active}, update_modified=False)
		updated += 1
	return {"status": "ok", "updated": updated}
