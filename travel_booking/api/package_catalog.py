# travel_booking/api/package_catalog.py
# Katalog awam struktur baharu (F3) — GUEST, READ-ONLY, rate-limited.
#
# SECURITY:
# - Detail offer WAJIB bawa public_slug (token rawak) — nama berjujukan
#   (OFF-/PKG-) TIDAK diterima pada endpoint detail (ajaran audit F9).
# - Nama pakej adalah kandungan marketing awam (dah published hari ini
#   melalui katalog lama) — jadi nama pakej diterima sebagai parameter.
# - Semua respons not-found SERAGAM ("Not found.") — tiada oracle.
#
# SUMBER (Stage 2, Nov 2026): tarikh/sailing/ship/port dibaca DARIPADA
# Travel Date induk offer (satu sumber kebenaran) — bukan salinan medan
# offer. total_days/total_nights dikira daripada tarikh (formula TGD:
# nights = return - departure, days = nights + 1).

import frappe
from frappe.rate_limiter import rate_limit
from frappe.utils import cint, date_diff, today


def _days_nights(departure_date, return_date):
	"""Formula TGD (trip_group_date.validate). Tiada return → 0/0."""
	if departure_date and return_date:
		nights = date_diff(return_date, departure_date)
		return nights + 1, nights
	return 0, 0


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
		# Offer hadapan = anak Travel Date yang hadapan (bukan salinan
		# tarikh offer).
		for r in frappe.db.sql(
			"""SELECT o.package, COUNT(*) AS c
			FROM `tabPackage Offer` o
			JOIN `tabTravel Date` td ON td.name = o.travel_date
			WHERE o.package IN %(n)s AND o.status_editorial = 'Active'
			  AND td.departure_date >= CURDATE()
			GROUP BY o.package""",
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
	"""Offers Active hadapan untuk satu pakej (ikut nama ATAU slug pakej).
	Tarikh & maklumat sailing daripada Travel Date induk setiap offer."""
	name = _resolve_package(package, public_slug)
	if not name:
		frappe.throw("Not found.")

	rows = frappe.db.sql(
		"""
		SELECT o.public_slug, o.offer_name, o.max_pax,
		       td.departure_date, td.return_date,
		       td.sailing_start, td.sailing_end,
		       td.ship_name, td.embarkation_port,
		       td.disembarkation_port, td.days_before_closure
		FROM `tabPackage Offer` o
		JOIN `tabTravel Date` td ON td.name = o.travel_date
		WHERE o.package = %(pkg)s
		  AND o.status_editorial = 'Active'
		  AND td.departure_date >= %(today)s
		ORDER BY td.departure_date ASC, o.name ASC
		""",
		{"pkg": name, "today": today()},
		as_dict=True,
	)
	for r in rows:
		r["total_days"], r["total_nights"] = _days_nights(
			r.departure_date, r.return_date)
	return rows


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
		["name", "offer_name", "package", "travel_date", "cruise_schedule",
		 "status_operational"],
		as_dict=True,
	)
	if not offer:
		frappe.throw("Not found.")  # seragam — slug salah / offer tak aktif

	# Maklumat ops DARIPADA Travel Date induk (satu sumber kebenaran).
	td = frappe.db.get_value(
		"Travel Date", offer.travel_date,
		["departure_date", "return_date", "sailing_start", "sailing_end",
		 "ship_name", "ship_code", "embarkation_port",
		 "disembarkation_port", "days_before_closure"],
		as_dict=True,
	) or frappe._dict()
	offer.update({
		"departure_date": td.get("departure_date"),
		"return_date": td.get("return_date"),
		"sailing_start": td.get("sailing_start"),
		"sailing_end": td.get("sailing_end"),
		"ship_name": td.get("ship_name"),
		"ship_code": td.get("ship_code"),
		"embarkation_port": td.get("embarkation_port"),
		"disembarkation_port": td.get("disembarkation_port"),
		"days_before_closure": td.get("days_before_closure"),
	})
	offer["total_days"], offer["total_nights"] = _days_nights(
		offer.departure_date, offer.return_date)

	# Harga = PRICE MATRIX offer (child Trip Package Price — sumber utama).
	# [TUKAR Nov 2026] Offer Price → price_matrix; Offer Inventory →
	# Sailing Inventory (kolam kongsi sailing).
	prices = frappe.get_all(
		"Trip Package Price",
		filters={"parent": offer.name, "parenttype": "Package Offer",
				 "parentfield": "price_matrix"},
		fields=["pricing_for_class", "price_adult", "price_adult_single",
				"price_upperberth", "price_children", "price_toddler",
				"price_infant"],
		order_by="idx asc",
	)
	inventory = []
	if offer.cruise_schedule:
		# [Nov 2026] kolam tunggal = cabin_rates schedule.
		for r in frappe.get_all(
				"Trip Package Price",
				filters={"parent": offer.cruise_schedule,
						 "parenttype": "Trip Cruise Schedule"},
				fields=["pricing_for_class", "cabin_allotment",
						"cabin_occupancy", "cabin_available"],
				order_by="idx asc"):
			inventory.append({
				"inventory_key": "cabin:" + (r.pricing_for_class or ""),
				"allotment": int(r.cabin_allotment or 0),
				"sold": int(r.cabin_occupancy or 0),
				"available": int(r.cabin_available or 0)
					if r.cabin_available is not None
					else int(r.cabin_allotment or 0) - int(r.cabin_occupancy or 0),
			})
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


@frappe.whitelist(allow_guest=True)
@rate_limit(key="itin_effective", limit=30, seconds=60)
def get_effective_itinerary(trip: str, travel_date: str = None,
							offer: str = None) -> dict:
	"""Itinerary efektif bagi pilihan tarikh/pakej pada page detail trip.

	Warisan (model "reuse + checkbox overwrite", Nov 2026):
	Trip ← Travel Date ← Package Offer — resolver utils/itinerary_resolver.
	Dipanggil trip_detail.js bila pengunjung memilih tarikh/pakej pada
	widget booking; render awal page kekal itinerary Trip (SEO). Respons
	`html` dirender dengan include YANG SAMA dengan trip.html
	(includes/itinerary_list.html) supaya swap bertukar 1:1.

	SECURITY: trip WAJIB published; travel_date mesti anak trip berstatus
	Active; offer mesti anak travel_date berstatus Active. Sebarang
	kegagalan → "Not found." seragam (tiada oracle).
	"""
	if not trip or not frappe.db.get_value("Trip", trip, "published"):
		frappe.throw("Not found.")
	td = None
	if travel_date:
		td = frappe.db.get_value(
			"Travel Date", travel_date,
			["trip", "status_editorial", "departure_date"],
			as_dict=True)
		if not td or td.trip != trip or td.status_editorial != "Active":
			frappe.throw("Not found.")
	if offer:
		o = frappe.db.get_value(
			"Package Offer", offer, ["travel_date", "status_editorial"],
			as_dict=True)
		if (not travel_date or not o or o.travel_date != travel_date
				or o.status_editorial != "Active"):
			frappe.throw("Not found.")

	from travel_booking.utils import itinerary_resolver
	out = itinerary_resolver.get_effective_itinerary(
		trip, travel_date=travel_date, offer=offer)
	# [Nov 2026] Tarikh pada Day number — anchor Day 1 = departure
	# Travel Date pilihan; trip-level (tiada travel_date) → departure
	# terawal Travel Date Active trip ini.
	anchor = td.departure_date if td else frappe.db.get_value(
		"Travel Date",
		filters={"trip": trip, "status_editorial": "Active"},
		fieldname="departure_date", order_by="departure_date asc")
	rows = itinerary_resolver.enrich_itinerary_rows(out["rows"], anchor_date=anchor)
	html = frappe.render_template(
		"travel_booking/module_travel_booking/doctype/trip/templates/includes/itinerary_list.html",
		{
			"itinerary": rows,
		},
	)
	return {"source": out["source"], "html": html}
