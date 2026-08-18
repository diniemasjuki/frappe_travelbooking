# travel_booking/.../doctype/trip/web_data.py
#
# Query layer READ-SAHJA untuk halaman web Trip:
#   - get_trip_detail(trip)       → data penuh halaman detail Trip
#     (tarikh + pakej + harga + organizer + galeri)
#   - get_published_trips()       → ringkasan Trip published untuk list page
#   - get_upcoming_departures()   → SEMUA tarikh perlepasan akan datang
#     (trip published) untuk bahagian "All Departure Dates" di /trips
#
# Kenapa modul berasingan (bukan terus dalam trip.py controller): logik
# query yang sama dipakai oleh DUA pengguna — controller Trip (halaman
# detail) dan www/trips.py (list page). Satu tempat sahaja supaya syarat
# "ready" tak drif antara dua halaman (peraturan sama seperti
# www/booking.py: Trip Active + Trip Group Date Active + Trip Package
# Active + tarikh belum lepas).
#
# Semua akses guna frappe.db.sql terus — halaman ni render untuk Guest,
# dan Guest tiada role permission atas doctype2 ni (tabla Trip hanya
# beri read kepada Tour Manager/Tour Operator; akses Guest dikawal
# oleh allow_guest_to_view + flag published sahaja).

import frappe
from frappe.utils import cint

from travel_booking.api._helpers import get_company_currency


def _company_symbol() -> str:
	"""Symbol company currency — SEMUA harga pakej disimpan & dipaparkan
	dalam company currency sekarang (currency Trip Package cuma hint
	paparan converter). Cache pendek dalam redis elak lookup berulang."""
	cc = get_company_currency()
	key = "travel_booking:company_symbol:" + cc
	sym = frappe.cache().get(key)
	if not sym:
		sym = frappe.db.get_value("Currency", cc, "symbol") or cc
		frappe.cache().set(key, sym)
	return sym

# Status Trip Group Date yang masih patut dipapar pada website.
# 'Full' dipapar tetapi butang booking dilumpuhkan (sold out) —
# customer boleh nampak pakej tu dah penuh, bukan hilang senyap.
WEBSITE_DATE_STATUSES = ("Active", "Full")

_IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif")


def _fmt_price(symbol: str, amount) -> str:
	"""'RM' + 1234.5 → 'RM 1,234.50'. Guna format sendiri (bukan fmt_money)
	kerana fmt_money ikut number format System Settings — kita mahu format
	tetap yang konsisten pada halaman marketing."""
	try:
		return f"{symbol or ''} {float(amount or 0):,.2f}".strip()
	except (TypeError, ValueError):
		return f"{symbol or ''} 0.00".strip()


def _fmt_date(d) -> str:
	"""'2026-09-30' → '30 Sep 2026'. Kosong kalau tiada tarikh."""
	return frappe.utils.formatdate(d, "d MMM YYYY") if d else ""


def _month_key(d) -> str:
	"""Kunci kelompok bulan untuk bahagian All Departure Dates ('2026-09')."""
	return str(d)[:7] if d else ""


def fmt_month(key: str) -> str:
	"""'2026-09' → 'September 2026'."""
	if not key or len(key) < 7:
		return ""
	return frappe.utils.formatdate(f"{key}-01", "MMMM YYYY")


def _duration_display(days, nights) -> str:
	"""(8, 7) → '8D7N'; (4, 0) → '4D'."""
	d, n = cint(days), cint(nights)
	if d and n:
		return f"{d}D{n}N"
	if d:
		return f"{d}D"
	if n:
		return f"{n}N"
	return ""


def get_support_contacts() -> dict:
	settings = frappe.get_cached_doc("Travel Settings")
	return {
		"support_email": getattr(settings, "support_email", "") or "",
		"support_phone": getattr(settings, "support_phone", "") or "",
	}


def get_trip_detail(trip_name: str) -> dict:
	"""Data penuh untuk halaman detail Trip (templates/trip.html)."""
	trip = frappe.db.get_value(
		"Trip",
		trip_name,
		[
			"name", "trip_name", "status", "route", "trip_image",
			"is_a_cruise_trip", "trip_organizer", "description",
		],
		as_dict=True,
	)
	if not trip:
		return {}

	organizer = None
	if trip.trip_organizer:
		organizer = frappe.db.get_value(
			"Trip Organizer", trip.trip_organizer,
			["name", "org_name", "website", "org_logo", "is_a_cruise_line"],
			as_dict=True,
		)

	destinations = [
		r.select_destination_point
		for r in frappe.db.sql(
			"""
			SELECT sel.select_destination_point
			FROM `tabTrip Destination Point Select` sel
			WHERE sel.parent = %s AND sel.parenttype = 'Trip'
			ORDER BY sel.idx
			""",
			trip.name,
			as_dict=True,
		)
		if r.select_destination_point
	]

	gallery = [
		r.file_url
		for r in frappe.db.sql(
			"""
			SELECT file_url
			FROM `tabFile`
			WHERE attached_to_doctype = 'Trip'
			  AND attached_to_name = %s
			  AND is_private = 0
			  AND (attached_to_field IS NULL OR attached_to_field = 'attachment_gallery_okqc')
			ORDER BY creation
			LIMIT 12
			""",
			trip.name,
			as_dict=True,
		)
		if r.file_url and r.file_url.lower().split("?")[0].endswith(_IMAGE_EXT)
	]

	dates = _get_trip_dates(trip.name)

	# Harga paling murah bagi keseluruhan trip (sidebar "From") — ambil
	# dari package akan-datang pertama yang paling murah, SEKALI dengan
	# currency package itu (jangan banding nilai antara currency berbeza).
	from_price = None
	for d in dates:
		if d.get("sold_out"):
			continue
		for p in d.get("packages") or []:
			if p.get("from_price_value") is not None:
				if from_price is None or p["from_price_value"] < from_price["amount"]:
					from_price = {
						"amount": p["from_price_value"],
						"display": p["from_price"],
					}

	next_departure = dates[0] if dates else None

	return {
		"trip": trip,
		"organizer": organizer,
		"destinations": destinations,
		"gallery": gallery,
		"dates": dates,
		"from_price": from_price,
		"next_departure": next_departure,
		"support": get_support_contacts(),
		"current_year": frappe.utils.now_datetime().year,
	}


def _get_trip_dates(trip_name: str, published_only: bool = False) -> list:
	"""Senarai Trip Group Date akan datang untuk satu Trip, setiap satu
	dengan senarai Trip Package (dan harga per kategori kabin).

	Syarat sama seperti www/booking.py (cascade "ready"): date berstatus
	Active/Full, tarikh belum lepas, dan ADA package Active untuk date
	tersebut. Date tanpa package Active tak dipapar — bukan dead-end.
	"""
	dates = frappe.db.sql(
		"""
		SELECT
			td.name, td.trip, td.trip_group_name, td.status,
			td.departure_date, td.return_date,
			td.total_days, td.total_nights,
			td.ship_name, td.embarkation_port, td.disembarkation_port,
			td.sailing_start, td.sailing_end,
			td.max_participants, td.current_participants,
			td.trip_group_description
		FROM `tabTrip Group Date` td
		WHERE td.trip = %(trip)s
		  AND td.status IN %(statuses)s
		  AND td.departure_date >= CURDATE()
		  AND EXISTS (
		      SELECT 1
		      FROM `tabTrip Package Group Date Select` sel
		      JOIN `tabTrip Package` tp ON tp.name = sel.parent
		      WHERE sel.trip_group_date = td.name
		        AND tp.status = 'Active'
		  )
		ORDER BY td.departure_date ASC, td.name ASC
		""",
		{"trip": trip_name, "statuses": WEBSITE_DATE_STATUSES},
		as_dict=True,
	)

	if not dates:
		return []

	date_names = [d.name for d in dates]
	packages = _get_packages_for_dates(date_names)

	for d in dates:
		d["packages"] = packages.get(d.name, [])
		d["sold_out"] = d.status == "Full" or (
			cint(d.max_participants) > 0
			and cint(d.current_participants) >= cint(d.max_participants)
		)
		d["seats_left"] = (
			cint(d.max_participants) - cint(d.current_participants)
			if cint(d.max_participants) > 0
			else None
		)
		d["departure_display"] = _fmt_date(d.departure_date)
		d["return_display"] = _fmt_date(d.return_date)
		# Badge kalendar (kotak hitam pada date card): "30" / "SEP"
		d["cal_day"] = frappe.utils.formatdate(d.departure_date, "d") if d.departure_date else ""
		d["cal_month"] = frappe.utils.formatdate(d.departure_date, "MMM") if d.departure_date else ""
		d["duration_display"] = _duration_display(d.total_days, d.total_nights)
		if d.departure_date and d.return_date:
			start = frappe.utils.formatdate(d.departure_date, "d MMM")
			end = frappe.utils.formatdate(d.return_date, "d MMM YYYY")
			d["date_range_display"] = f"{start} – {end}"
		else:
			d["date_range_display"] = d["departure_display"]

	return dates


def _get_packages_for_dates(date_names: list) -> dict:
	"""Trip Package Active (dengan harga) untuk setiap Trip Group Date.
	Pulangkan dict {trip_group_date: [package, ...]}."""
	pkgs = frappe.db.sql(
		"""
		SELECT
			tp.name, sel.trip_group_date, tp.package_title, tp.package_type,
			tp.airport_form, ap.airport_name, ap.airport_city,
			tp.currency, cur.symbol AS currency_symbol,
			tp.package_description
		FROM `tabTrip Package` tp
		JOIN `tabTrip Package Group Date Select` sel ON sel.parent = tp.name
		LEFT JOIN `tabFlight Airport` ap ON ap.name = tp.airport_form
		LEFT JOIN `tabCurrency` cur ON cur.name = tp.currency
		WHERE sel.trip_group_date IN %(dates)s
		  AND tp.status = 'Active'
		ORDER BY tp.package_type ASC, tp.package_title ASC
		""",
		{"dates": date_names},
		as_dict=True,
	)
	if not pkgs:
		return {}

	# Harga per kategori kabin (Trip Package Price) untuk semua package
	# sekali gus — elak N+1 query per package.
	pkg_names = [p.name for p in pkgs]
	prices = frappe.db.sql(
		"""
		SELECT parent, pricing_for_class,
		       price_adult, price_children, price_toddler, price_infant
		FROM `tabTrip Package Price`
		WHERE parent IN %(pkgs)s
		ORDER BY price_adult ASC, idx ASC
		""",
		{"pkgs": pkg_names},
		as_dict=True,
	)

	prices_by_pkg = {}
	for pr in prices:
		prices_by_pkg.setdefault(pr.parent, []).append({
			"category": pr.pricing_for_class or "",
			"adult": _fmt_price(None, pr.price_adult),
			"children": _fmt_price(None, pr.price_children),
			"infant": _fmt_price(None, pr.price_infant),
			# nilai mentah untuk kira "from price" (banding numerik) dan
			# untuk converter currency paparan frontend (JS tukar display).
			"adult_value": float(pr.price_adult or 0),
			"children_value": float(pr.price_children or 0),
			"infant_value": float(pr.price_infant or 0),
		})

	out = {}
	company_symbol = _company_symbol()
	for p in pkgs:
		symbol = p.currency_symbol or p.currency or ""
		rows = prices_by_pkg.get(p.name, [])
		# "From" price = harga adult termurah; abaikan nilai 0 (kategori yang
		# harga belum diisi) selagi ada nilai positif — elak paparan "RM 0.00".
		positive = [r["adult_value"] for r in rows if r["adult_value"] > 0]
		from_value = min(positive, default=None)
		if from_value is None and rows:
			from_value = min(r["adult_value"] for r in rows)
		pkg = {
			"name": p.name,
			"package_title": p.package_title or p.package_type or p.name,
			"package_type": p.package_type or "",
			# currency package = hint paparan converter (bukan currency harga).
			# Harga sebenar (from_price_value, from_price) dalam COMPANY currency.
			"currency": p.currency or "MYR",
			"currency_symbol": symbol,
			# Label lapangan terbang pergi ("KUL — Kuala Lumpur Intl") atau
			# "Cruise Only" untuk pakej tanpa flight.
			"depart_label": (
				f"{p.airport_form} — {p.airport_name or p.airport_city or ''}".strip(" —")
				if p.airport_form
				else ("Cruise Only" if p.package_type == "Cruise Only" else "No Flight")
			),
			"prices": rows,
			"from_price_value": from_value,
			# Paparan guna COMPANY symbol (harga disimpan company currency).
			# Converter frontend (JS) boleh tukar ke display currency lain.
			"from_price": _fmt_price(company_symbol, from_value) if from_value is not None else None,
			"description": p.package_description or "",
		}
		out.setdefault(p.trip_group_date, []).append(pkg)
	return out


def get_published_trips() -> list:
	"""Ringkasan Trip published (untuk grid di /trips).

	Published + status Active sahaja — Trip Completed/Cancelled yang
	tersimpan published=1 tetap tak dipapar (setting tertinggal lama).
	setiap card: trip, next departure, kiraan tarikh, harga "from".
	"""
	trips = frappe.db.sql(
		"""
		SELECT t.name, t.trip_name, t.route, t.trip_image,
		       t.is_a_cruise_trip, t.trip_organizer, t.description
		FROM `tabTrip` t
		WHERE t.published = 1
		  AND t.status = 'Active'
		ORDER BY t.trip_name ASC
		""",
		as_dict=True,
	)

	out = []
	for t in trips:
		dates = _get_trip_dates(t.name)
		from_price = None
		for d in dates:
			for p in d.get("packages") or []:
				if p.get("from_price_value") is None or d.get("sold_out"):
					continue
				if from_price is None or p["from_price_value"] < from_price["amount"]:
					from_price = {"amount": p["from_price_value"], "display": p["from_price"]}
		out.append({
			"name": t.name,
			"trip_name": t.trip_name,
			"route": t.route,
			"image": t.trip_image or "/assets/travel_booking/img/defaultaroya.jpg",
			"is_cruise": bool(t.is_a_cruise_trip),
			"organizer": t.trip_organizer or "",
			"dates": dates,
			"dates_count": len(dates),
			"next_departure": dates[0] if dates else None,
			"from_price": from_price,
			"has_dates": bool(dates),
		})
	return out


def get_upcoming_departures() -> list:
	"""SEMUA tarikh perlepasan akan datang merentasi semua Trip published,
	diurut kronologi dan dikumpulkan per bulan (untuk senarai "All
	Departure Dates" di /trips)."""
	rows = frappe.db.sql(
		"""
		SELECT
			td.name, td.trip, td.status,
			td.departure_date, td.return_date,
			td.total_days, td.total_nights,
			td.ship_name, td.embarkation_port, td.disembarkation_port,
			td.max_participants, td.current_participants,
			t.trip_name, t.route AS trip_route, t.is_a_cruise_trip
		FROM `tabTrip Group Date` td
		JOIN `tabTrip` t ON t.name = td.trip
		WHERE t.published = 1
		  AND t.status = 'Active'
		  AND td.status IN %(statuses)s
		  AND td.departure_date >= CURDATE()
		  AND EXISTS (
		      SELECT 1
		      FROM `tabTrip Package Group Date Select` sel
		      JOIN `tabTrip Package` tp ON tp.name = sel.parent
		      WHERE sel.trip_group_date = td.name
		        AND tp.status = 'Active'
		  )
		ORDER BY td.departure_date ASC, t.trip_name ASC
		""",
		{"statuses": WEBSITE_DATE_STATUSES},
		as_dict=True,
	)
	if not rows:
		return []

	pkgs = _get_packages_for_dates([r.name for r in rows])

	out = []
	for r in rows:
		packages = pkgs.get(r.name, [])
		from_price = None
		for p in packages:
			if p.get("from_price_value") is None:
				continue
			if from_price is None or p["from_price_value"] < from_price["amount"]:
				from_price = {"amount": p["from_price_value"], "display": p["from_price"]}
		out.append({
			"name": r.name,
			"trip": r.trip,
			"trip_name": r.trip_name,
			"trip_route": r.trip_route,
			"status": r.status,
			"departure_date": str(r.departure_date or ""),
			"departure_display": _fmt_date(r.departure_date),
			"return_display": _fmt_date(r.return_date),
			"cal_day": frappe.utils.formatdate(r.departure_date, "d") if r.departure_date else "",
			"cal_month": frappe.utils.formatdate(r.departure_date, "MMM") if r.departure_date else "",
			"duration_display": _duration_display(r.total_days, r.total_nights),
			"ship_name": r.ship_name or "",
			"embarkation_port": r.embarkation_port or "",
			"disembarkation_port": r.disembarkation_port or "",
			"seats_left": (
				cint(r.max_participants) - cint(r.current_participants)
				if cint(r.max_participants) > 0
				else None
			),
			"sold_out": r.status == "Full" or (
				cint(r.max_participants) > 0
				and cint(r.current_participants) >= cint(r.max_participants)
			),
			"packages_count": len(packages),
			"from_price": from_price,
			"month_key": _month_key(r.departure_date),
		})
	return out
