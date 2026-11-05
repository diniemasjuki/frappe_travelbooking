# travel_booking/utils/new_catalog.py
#
# F5 dwi-baca katalog — bentuk IDENTIK dengan get_ready_bundle()
# (trip_catalog.py) tetapi dibina daripada struktur baharu:
#   Travel Package (Active) + Package Offer (Active, hadapan)
#
# KUNCI KESERASIAN: item `name` kekal NAMA WARISAN
#   - tarikh: legacy_tgd   (get_booking_details + confirm_booking + harga
#     warisan terus berfungsi tanpa diubah)
#   - pakej:  legacy_trip_package
# Tambahan pada setiap item pakej (laluan tulis F5):
#   - `offer`           → nama Package Offer (confirm_booking @flag ON)
#   - `travel_package`  → nama Travel Package
#
# seats_left: jika ada inventori offer ber-allotment > 0 → jumlah available;
# jika SEMUA allotment == 0 (staf belum konfigur) → None (papar "Available")
# — PINTU KAPASITI SEBENAR ialah check_offer_capacity() di confirm_booking.

import frappe


def get_bundle_new() -> tuple:
	"""Kembalikan (trips, trip_group_dates, trip_packages, trip_is_cruise)
	— bentuk sama dengan get_ready_bundle()."""
	today = frappe.utils.today()

	offers = frappe.db.sql(
		"""
		SELECT o.name, o.package, o.offer_name, o.departure_date, o.return_date,
		       o.sailing_start, o.sailing_end, o.total_days, o.total_nights,
		       o.embarkation_port, o.disembarkation_port, o.cruise_schedule,
		       o.max_pax, o.current_pax, o.legacy_tgd, tp.legacy_trip_package,
		       tp.package_name, tp.package_template, tp.default_currency,
		       t.name AS trip, t.trip_name, t.is_a_cruise_trip
		FROM `tabPackage Offer` o
		JOIN `tabTravel Package` tp ON tp.name = o.package
		JOIN `tabTrip` t ON t.name = tp.trip
		WHERE o.status_editorial = 'Active'
		  AND o.departure_date >= %(today)s
		  AND tp.status = 'Active'
		  AND t.status = 'Active'
		ORDER BY o.departure_date ASC
		""",
		{"today": today},
		as_dict=True,
	)
	if not offers:
		return [], {}, {}, {}

	names = [o.name for o in offers]
	inv = frappe.db.sql(
		"""
		SELECT parent,
		       SUM(GREATEST(allotment - sold, 0)) AS avail,
		       MAX(allotment) AS max_allot
		FROM `tabOffer Inventory`
		WHERE parent IN %(n)s
		GROUP BY parent
		""",
		{"n": names},
		as_dict=True,
	)
	inv_map = {r.parent: r for r in inv}
	symbols = {
		c.name: c.symbol
		for c in frappe.get_all("Currency", fields=["name", "symbol"])
	}

	trips: dict = {}
	tgd: dict = {}
	pkgs: dict = {}
	cruise: dict = {}
	seen_tgd: set = set()

	for o in offers:
		trip = o.trip
		trips.setdefault(trip, {
			"name": trip, "trip_name": o.trip_name,
			"is_a_cruise_trip": bool(o.is_a_cruise_trip),
		})
		cruise[trip] = bool(o.is_a_cruise_trip)

		legacy_tgd = o.legacy_tgd
		if not legacy_tgd:
			continue  # offer tanpa provenance — luar skrip migrasi, skip

		if legacy_tgd not in seen_tgd:
			seen_tgd.add(legacy_tgd)
			ir = inv_map.get(o.name)
			maxpax = int(o.max_pax or 0)
			if ir and int(ir.max_allot or 0) > 0:
				seats = max(0, int(ir.avail or 0))
			else:
				seats = None
			tgd.setdefault(trip, []).append({
				"name": legacy_tgd,
				"trip_group_name": o.offer_name or "",
				"trip_group_code": "",
				"departure_date": str(o.departure_date or ""),
				"return_date": str(o.return_date or ""),
				"sailing_start": str(o.sailing_start or ""),
				"sailing_end": str(o.sailing_end or ""),
				"cruise_schedule": o.cruise_schedule or "",
				"embarkation_port": o.embarkation_port or "",
				"disembarkation_port": o.disembarkation_port or "",
				"total_days": o.total_days or 0,
				"total_nights": o.total_nights or 0,
				"is_cruise_only": (o.package_template == "Cruise Only"),
				"max_participants": maxpax,
				"seats_left": seats,
			})

		pkgs.setdefault(legacy_tgd, []).append({
			"name": o.legacy_trip_package,
			"trip_group_date": legacy_tgd,
			"package_name": o.package_name or "",
			"package_type": o.package_template or "",
			"flight": "",
			"flight_label": "No Flight",
			"currency": o.default_currency or "MYR",
			"currency_symbol": symbols.get(
				o.default_currency, o.default_currency or "MYR"),
			"departure_date": str(o.departure_date or ""),
			"return_date": str(o.return_date or ""),
			"sailing_start": str(o.sailing_start or ""),
			"sailing_end": str(o.sailing_end or ""),
			"total_days": o.total_days or 0,
			"total_nights": o.total_nights or 0,
			"is_cruise_only": (o.package_template == "Cruise Only"),
			"ground_arrangement": False,
			# ── F5 tambahan — laluan tulis struktur baharu ──
			"offer": o.name,
			"travel_package": o.package,
		})

	# susunan sama dengan legacy: cruise ikut sailing, lain ikut departure
	for trip_name, groups in tgd.items():
		if cruise.get(trip_name):
			groups.sort(key=lambda g: (
				g["sailing_start"] or g["departure_date"],
				not g["is_cruise_only"],
			))
		else:
			groups.sort(key=lambda g: g["departure_date"])

	return list(trips.values()), tgd, pkgs, cruise
