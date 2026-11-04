# travel_booking/api/package_catalog.py
# Katalog awam struktur baharu (F3) — GUEST, READ-ONLY, rate-limited.
#
# SECURITY:
# - Detail offer WAJIB bawa public_slug (token rawak) — nama berjujukan
#   (OFF-/PKG-) TIDAK diterima pada endpoint detail (ajaran audit F9).
# - Nama pakej adalah kandungan marketing awam (dah published hari ini
#   melalui katalog lama) — jadi nama pakej diterima sebagai parameter.
# - Semua respons not-found SERAGAM ("Not found.") — tiada oracle.

import frappe
from frappe.rate_limiter import rate_limit
from frappe.utils import cint, today


@frappe.whitelist(allow_guest=True)
@rate_limit(key="pkg_catalog", limit=30, seconds=60)
def get_package_catalog(search: str = None, limit: int = 20) -> dict:
	"""Senarai pakej Active + kiraan offer hadapan + harga minimum (templat)."""
	limit = max(1, min(cint(limit) or 20, 50))
	filters = {"status": "Active"}
	if search:
		filters["package_name"] = ["like", "%" + search + "%"]

	packages = frappe.get_all(
		"Travel Package",
		filters=filters,
		fields=["name", "package_name", "package_template", "default_currency",
				"public_slug", "trip"],
		order_by="package_name asc",
		limit=limit,
	)

	offer_counts: dict = {}
	min_prices: dict = {}
	names = [p.name for p in packages]
	if names:
		for r in frappe.db.sql(
			"""SELECT package, COUNT(*) AS c
			FROM `tabPackage Offer`
			WHERE package IN %(n)s AND status_editorial = 'Active'
			  AND departure_date >= CURDATE()
			GROUP BY package""",
			{"n": names}, as_dict=True,
		):
			offer_counts[r.package] = r.c
		for r in frappe.db.sql(
			"""SELECT parent, MIN(price) AS p
			FROM `tabPackage Price Template`
			WHERE parent IN %(n)s AND active = 1 AND price > 0
			GROUP BY parent""",
			{"n": names}, as_dict=True,
		):
			min_prices[r.parent] = float(r.p)

	for p in packages:
		p["upcoming_offers"] = offer_counts.get(p.name, 0)
		p["min_price"] = min_prices.get(p.name)

	return {"packages": packages}


@frappe.whitelist(allow_guest=True)
@rate_limit(key="pkg_offers", limit=30, seconds=60)
def get_package_offers(package: str = None, public_slug: str = None) -> list:
	"""Offers Active hadapan untuk satu pakej (ikut nama ATAU slug pakej)."""
	name = _resolve_package(package, public_slug)
	if not name:
		frappe.throw("Not found.")

	return frappe.get_all(
		"Package Offer",
		filters={
			"package": name,
			"status_editorial": "Active",
			"departure_date": [">=", today()],
		},
		fields=["public_slug", "offer_name", "departure_date", "return_date",
				"total_days", "total_nights", "sailing_start", "sailing_end",
				"ship_name", "embarkation_port", "disembarkation_port",
				"max_pax", "days_before_closure"],
		order_by="departure_date asc",
	)


@frappe.whitelist(allow_guest=True)
@rate_limit(key="pkg_offer_detail", limit=30, seconds=60)
def get_offer_detail(public_slug: str) -> dict:
	"""Detail offer + inventori tersedia + matriks harga.

	SLUG WAJIB — nama dokumen berjujukan tidak pernah diterima di sini."""
	if not public_slug:
		frappe.throw("Not found.")

	offer = frappe.db.get_value(
		"Package Offer",
		{"public_slug": public_slug, "status_editorial": "Active"},
		["name", "offer_name", "package", "departure_date", "return_date",
		 "total_days", "total_nights", "sailing_start", "sailing_end",
		 "ship_name", "ship_code", "embarkation_port", "disembarkation_port",
		 "max_pax", "current_pax", "days_before_closure", "status_operational"],
		as_dict=True,
	)
	if not offer:
		frappe.throw("Not found.")  # seragam — slug salah / offer tak aktif

	prices = frappe.get_all(
		"Offer Price",
		filters={"parent": offer.name, "active": 1},
		fields=["price_key", "opt1", "opt2", "opt3", "age_option",
				"currency", "price"],
		order_by="price_key asc",
	)
	inventory = frappe.get_all(
		"Offer Inventory",
		filters={"parent": offer.name},
		fields=["inventory_key", "allotment", "sold", "available"],
		order_by="inventory_key asc",
	)
	pkg = frappe.db.get_value(
		"Travel Package", offer.package,
		["package_name", "public_slug", "package_template", "default_currency"],
		as_dict=True,
	)

	return {"offer": offer, "package": pkg, "prices": prices, "inventory": inventory}


def _resolve_package(package: str = None, public_slug: str = None):
	"""Resolve pakej Active — slug diutamakan; nama dibenarkan (kandungan awam)."""
	if public_slug:
		return frappe.db.get_value("Travel Package", {"public_slug": public_slug}, "name")
	if package:
		return frappe.db.get_value(
			"Travel Package", {"name": package, "status": "Active"}, "name"
		)
	return None
