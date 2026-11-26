# travel_booking/utils/featured_catalog.py
#
# Fasa 5A renovation — HIGHLIGHT HOMEPAGE.
#
# Dua lapis highlight:
#   1. FEATURED TRIPS — Trip.featured_trip dipakai sebenar: homepage
#      cruise/tour mengutamakan trip berbendera (fallback 6 teratas —
#      behavior lama dipelihara bila admin belum benderakan apa-apa).
#   2. FEATURED PACKAGES — Trip Package.featured (baru, patch v40):
#      tonjolkan PAKEJ tertentu pada group date yang mungkin dikongsi
#      merentasi beberapa pakej — keperluan operasi sebenar ("beberapa
#      pakej berbeza dijual pada tarikh cruise sama").
#
# Dua pengguna:
#   - Homepage Jinja sedia ada (www/cruise.py, tour.py) — context vars.
#   - Builder component (Fasa 5B) — API whitelisted yang sama.
#
# Semua pembacaan melalui trip_catalog (sumber kebenaran "ready" yang
# dikongsi dengan /trips, /cruises, /tours) supaya definisi siap-jual
# konsisten di mana-mana.

import frappe

from travel_booking.utils.trip_catalog import get_catalog_trips


def get_featured_trips(vertical="cruise", limit=6, currency=None):
	"""Trip berbendera featured_trip dahulu, kemudian isi baki dengan
	teratas ikut sort tarikh — jumlah `limit`.

	vertical: "cruise" | "tour" | "all".
	Return list trip dicts (struktur sama get_catalog_trips trips).
	"""
	cruise_flag = {"cruise": "1", "tour": "0", "all": ""}.get(vertical, "")
	filters = {"sort": "date"}
	if cruise_flag:
		filters["cruise"] = cruise_flag
	if currency:
		filters["currency"] = currency

	data = get_catalog_trips(filters)
	trips = data.get("trips") or []

	flagged = [t for t in trips if t.get("featured_trip")]
	others = [t for t in trips if not t.get("featured_trip")]
	return (flagged + others)[:limit], data


def get_featured_packages(vertical="cruise", limit=6, currency=None):
	"""Pakej berbendera Trip Package.featured yang READY dijual:
	trip aktif + group date aktif akan datang + pakej Active dalam
	currency terpilih.

	Beberapa pakej pada group date sama disokong penuh (setiap pakej
	dipaparkan sebagai kad sendiri — nama pakej + jenis + harga
	termurah kategori + tarikh).

	Return {packages: [{trip, trip_name, trip_package, package_title,
	package_type, currency, from_price, group_dates: [{name, label,
	departure_date, return_date}]}], currency, currency_symbol}.
	"""
	cruise_flag = {"cruise": "1", "tour": "0", "all": ""}.get(vertical, "")

	# Pakej berbendera + trip siap (aktif + ada group date ready)
	rows = frappe.db.sql("""
		SELECT tp.name AS trip_package, tp.package_title,
		       tp.package_type, tp.currency, tp.trip_link,
		       t.trip_name, t.is_a_cruise_trip, t.route,
		       t.trip_image
		FROM `tabTrip Package` tp
		JOIN `tabTrip` t ON t.name = tp.trip_link
		WHERE tp.featured = 1
		  AND tp.status = 'Active'
		  AND t.status = 'Active'
		  AND IFNULL(t.published, 0) = 1
		  {cruise_cond}
		ORDER BY t.trip_name, tp.package_title
	""".format(cruise_cond="AND t.is_a_cruise_trip = 1" if cruise_flag == "1"
	           else ("AND IFNULL(t.is_a_cruise_trip,0) = 0" if cruise_flag == "0" else "")),
		as_dict=True)

	if not rows:
		return {"packages": [], "currency": currency or "",
		        "currency_symbol": ""}

	# Filter currency: pakej mesti dalam currency terpilih (keputusan
	# product sama seperti katalog — filter, bukan badge).
	if currency:
		rows = [r for r in rows if (r.currency or "").upper() == currency.upper()]
	if not rows:
		return {"packages": [], "currency": currency or "",
		        "currency_symbol": ""}

	# Group dates ready setiap pakej (dari sumber kebenaran katalog).
	data = get_catalog_trips({
		"cruise": cruise_flag,
		**({"currency": currency} if currency else {}),
	})
	gds_by_trip = data.get("trip_group_dates") or {}
	pkgs_by_name = {
		p.get("name"): p for p in (data.get("trip_packages") or [])
	} if isinstance(data.get("trip_packages"), list) else {}

	out = []
	for r in rows:
		gds = []
		for g in (gds_by_trip.get(r.trip_link) or []):
			gds.append({
				"name":           g.get("name"),
				"label":          g.get("trip_group_name") or g.get("label") or "",
				"departure_date": g.get("departure_date"),
				"return_date":    g.get("return_date"),
			})
		if not gds:
			continue  # tiada group date ready — belum dijual

		# Harga termurah kategori pakej (dari pricing pakej). NULL per
		# lajur dikira kosong (COALESCE ke sentinel) — LEAST() dengan
		# NULL menghasilkan NULL dan menular ke seluruh MIN.
		from_price = frappe.db.sql("""
			SELECT MIN(LEAST(
			    COALESCE(NULLIF(price_adult, 0), 999999999),
			    COALESCE(NULLIF(price_children, 0), 999999999),
			    COALESCE(NULLIF(price_upperberth, 0), 999999999)))
			FROM `tabTrip Package Price`
			WHERE parent = %s AND parenttype = 'Trip Package'
		""", r.trip_package)[0][0]

		out.append({
			"trip":           r.trip_link,
			"trip_name":      r.trip_name,
			"trip_image":     r.trip_image or "",
			# Deep-link pakej (package-first): trip page baca ?trip_package=
			# melalui _wishPkg dan auto-pilih pakej + senarai tarikhnya.
			"trip_route":     _trip_route_with_package(r.route, r.trip_package),
			"trip_package":   r.trip_package,
			"package_title":  r.package_title or r.trip_name,
			"package_type":   r.package_type or "",
			"currency":       r.currency,
			"from_price":     float(from_price) if from_price and from_price != 999999999 else None,
			"group_dates":    gds[:3],
		})
		if len(out) >= limit:
			break

	return {
		"packages":       out,
		"currency":       data.get("company_currency") or currency or "",
		"currency_symbol": data.get("company_symbol") or "",
	}


def _trip_route_with_package(route, trip_package):
	"""URL trip page + param deep-link pakej. Trip published route
	("/trip2622" dsb.); pakej sebagai ?trip_package= supaya trip page
	package-first terus auto-pilih pakej berkenaan."""
	if not route:
		return ""
	base = "/" + route.lstrip("/")
	if not trip_package:
		return base
	return base + "?trip_package=" + trip_package


@frappe.whitelist(allow_guest=True)
def api_featured_packages(vertical: str = "cruise", currency: str = None,
                          limit: int = 6):
	"""API whitelisted untuk Builder component / frontend dinamik.

	Frappe v17 menguatkuasakan type annotation pada whitelisted method —
	semua parameter berannotation; limit diterima sebagai int ATAU string
	digital (form GET) — normalisasi dilakukan selepas binding.
	"""
	try:
		limit = min(int(limit or 6), 24)
	except (TypeError, ValueError):
		limit = 6
	if currency == "":
		currency = None
	return get_featured_packages(
		vertical=vertical, limit=limit, currency=currency)
