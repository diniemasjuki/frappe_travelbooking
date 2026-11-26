# travel_booking/utils/new_catalog.py
#
# F5 dwi-baca katalog — bentuk IDENTIK dengan get_ready_bundle()
# (trip_catalog.py) tetapi dibina daripada struktur baharu:
#   Travel Date (hadapan) + Package Offer (Active)
#
# SUMBER (Stage 2, Nov 2026): tarikh/sailing/ship/port/schedule + trip
# dibaca DARIPADA Travel Date (satu sumber kebenaran) — BUKAN salinan
# medan offer. Travel Package hanya rujukan legacy (nama templat,
# package_template, currency warisan) untuk item pakej compat; offer
# identiti-sendiri tiada pautan itu. total_days/total_nights dikira
# daripada tarikh (formula TGD: nights = return - departure).
#
# KUNCI KESERASIAN: item `name` kekal NAMA WARISAN bila provenance wujud
#   - tarikh: legacy_tgd ATAU nama Travel Date (TD-...) untuk offer
#     identiti-sendiri (standalone) — get_booking_details offer-mode +
#     confirm_booking cabang offer tak perlukan nama warisan
#   - pakej:  legacy_trip_package ATAU nama Package Offer (standalone)
# Tambahan pada setiap item pakej (laluan tulis F5):
#   - `offer`           → nama Package Offer (confirm_booking @flag ON)
#   - `travel_package`  → nama Travel Package (legacy; null pada offer
#                         identiti-sendiri)
# Offer yang tiada baris Price Matrix (belum diisi staf) tidak dijual —
# disaring keluar di sini supaya wizard tidak bawa pakej mati (confirm
# akan throw "configure its Price Matrix before selling").
#
# seats_left: jika ada inventori offer ber-allotment > 0 → jumlah available;
# jika SEMUA allotment == 0 (staf belum konfigur) → None (papar "Available")
# — PINTU KAPASITI SEBENAR ialah check_offer_capacity() di confirm_booking.

import frappe
from frappe.utils import date_diff


def _days_nights(departure_date, return_date):
	"""Formula TGD (trip_group_date.validate): nights = selisih tarikh,
	days = nights + 1. Tiada return → 0/0 (paparan dilangkau)."""
	if departure_date and return_date:
		nights = date_diff(return_date, departure_date)
		return nights + 1, nights
	return 0, 0


def get_bundle_new() -> tuple:
	"""Kembalikan (trips, trip_group_dates, trip_packages, trip_is_cruise)
	— bentuk sama dengan get_ready_bundle()."""
	today = frappe.utils.today()

	# Tarikh & ops DARIPADA Travel Date; trip melalui Travel Date.trip
	# (bukan salinan offer / pautan Travel Package). Offer tanpa Travel
	# Date (stray legacy) tergugur — ia tiada provenance legacy_tgd dan
	# tidak boleh ditempah melalui aliran compat pun.
	offers = frappe.db.sql(
		"""
		SELECT o.name, o.package, o.offer_name, o.currency,
		       o.legacy_tgd, o.legacy_trip_package, o.travel_date,
		       td.trip_category,
		       td.departure_date, td.return_date,
		       td.sailing_start, td.sailing_end,
		       td.embarkation_port, td.disembarkation_port,
		       td.cruise_schedule,
		       t.name AS trip, t.trip_name, t.is_a_cruise_trip,
		       tp.package_name, tp.package_template, tp.default_currency
		FROM `tabPackage Offer` o
		JOIN `tabTravel Date` td ON td.name = o.travel_date
		JOIN `tabTrip` t ON t.name = td.trip
		LEFT JOIN `tabTravel Package` tp ON tp.name = o.package
		WHERE o.status_editorial = 'Active'
		  AND td.status_editorial = 'Active'
		  AND td.departure_date >= %(today)s
		  AND t.status = 'Active'
		  AND EXISTS (
		      SELECT 1 FROM `tabTrip Package Price` pm
		      WHERE pm.parent = o.name
		        AND pm.parenttype = 'Package Offer' AND pm.parentfield = 'price_matrix'
		  )
		ORDER BY td.departure_date ASC, o.name ASC
		""",
		{"today": today},
		as_dict=True,
	)
	if not offers:
		return [], {}, {}, {}

	# seats_left daripada kolam cabin_rates schedule (dikongsi semua offer
	# satu sailing) — allotment kontrak − occupancy live reservasi.
	# Offer tanpa schedule (darat) → seats None ("Available").
	scheds = list({o.cruise_schedule for o in offers if o.cruise_schedule})
	pool: dict = {}
	if scheds:
		for r in frappe.db.sql(
			"""
			SELECT parent AS cruise_schedule,
			       SUM(GREATEST(cabin_allotment - cabin_occupancy, 0)) AS avail,
			       MAX(cabin_allotment) AS max_allot
			FROM `tabTrip Package Price`
			WHERE parenttype = 'Trip Cruise Schedule'
			  AND parent IN %(s)s
			GROUP BY parent
			""",
			{"s": scheds},
			as_dict=True,
		):
			pool[r.cruise_schedule] = r
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

		# Kunci tarikh: nama WARISAN (legacy_tgd) bila wujud — padan
		# resolusi legacy confirm_booking; offer IDENTITI-SENDIRI
		# (standalone, ciptaan Travel Manager/wizard baharu tanpa
		# provenance) guna nama Travel Date (TD-...). Kedua-dua page
		# detail (get_trip_detail_new) dan bundle ni MESTI guna kunci
		# yang sama supaya cart Book Now terus sah di wizard.
		date_key = o.legacy_tgd or o.travel_date

		# Currency: identiti offer dahulu (kontrak offer-mode), fallback
		# templat legacy.
		currency = o.currency or o.default_currency or "MYR"
		total_days, total_nights = _days_nights(
			o.departure_date, o.return_date)

		if date_key not in seen_tgd:
			seen_tgd.add(date_key)
			pr = pool.get(o.cruise_schedule)
			if pr and int(pr.max_allot or 0) > 0:
				seats = max(0, int(pr.avail or 0))
			else:
				seats = None
			tgd.setdefault(trip, []).append({
				"name": date_key,
				"trip_group_name": o.offer_name or "",
				"trip_group_code": "",
				"departure_date": str(o.departure_date or ""),
				"return_date": str(o.return_date or ""),
				"sailing_start": str(o.sailing_start or ""),
				"sailing_end": str(o.sailing_end or ""),
				"cruise_schedule": o.cruise_schedule or "",
				"embarkation_port": o.embarkation_port or "",
				"disembarkation_port": o.disembarkation_port or "",
				"total_days": total_days,
				"total_nights": total_nights,
				"is_cruise_only": (o.package_template == "Cruise Only"),
				# Kategori trip tarikh (Travel Date.trip_category) — badge
				# kad katalog + grouping homepage /cruise.
				"trip_category": o.trip_category or "",
				# [Nov 2026] tiada had per offer — penghad = kolam schedule.
				"max_participants": 0,
				"seats_left": seats,
			})

		pkgs.setdefault(date_key, []).append({
			# Offer identiti-sendiri: guna nama offer sebagai identiti
			# pakej (tiada legacy_trip_package). get_booking_details
			# offer-mode (package_offer) yang membaca harga sebenar.
			"name": o.legacy_trip_package or o.name,
			"trip_group_date": date_key,
			"package_name": o.package_name or o.offer_name or "",
			"package_type": o.package_template or o.offer_name or "",
			"flight": "",
			"flight_label": "No Flight",
			"currency": currency,
			"currency_symbol": symbols.get(currency, currency),
			"departure_date": str(o.departure_date or ""),
			"return_date": str(o.return_date or ""),
			"sailing_start": str(o.sailing_start or ""),
			"sailing_end": str(o.sailing_end or ""),
			"total_days": total_days,
			"total_nights": total_nights,
			"is_cruise_only": (o.package_template == "Cruise Only"),
			# ── F5 tambahan — laluan tulis struktur baharu ──
			"offer": o.name,
			"travel_package": o.package,
		})

	# susunan ikut departure date untuk SEMUA jenis trip — grouping
	# departure date (cruise dah tak ikut sailing)
	for trip_name, groups in tgd.items():
		groups.sort(key=lambda g: (
			g["departure_date"] or g["sailing_start"],
			not g["is_cruise_only"],
		))

	return list(trips.values()), tgd, pkgs, cruise


# ══════════════════════════════════════════════
# PAGE DETAIL — dwi-baca struktur baharu (flag ON)
# ══════════════════════════════════════════════

def _sellable_offers_for_trip(trip_name: str) -> list:
	"""Offer editorial-Active (Travel Date Active + future) untuk SATU trip
	yang ada baris Price Matrix — sah untuk dijual. Susun ikut tarikh."""
	return frappe.db.sql(
		"""
		SELECT o.name, o.package, o.offer_name, o.currency,
		       o.legacy_tgd, o.legacy_trip_package, o.travel_date,
		       td.travel_date_name, td.trip_category,
		       td.departure_date, td.return_date,
		       td.sailing_start, td.sailing_end, td.ship_name,
		       td.embarkation_port, td.disembarkation_port,
		       td.cruise_schedule,
		       tp.package_name, tp.package_template, tp.default_currency
		FROM `tabPackage Offer` o
		JOIN `tabTravel Date` td ON td.name = o.travel_date
		LEFT JOIN `tabTravel Package` tp ON tp.name = o.package
		WHERE o.status_editorial = 'Active'
		  AND td.status_editorial = 'Active'
		  AND td.departure_date >= CURDATE()
		  AND td.trip = %(t)s
		  AND EXISTS (
		      SELECT 1 FROM `tabTrip Package Price` pm
		      WHERE pm.parent = o.name
		        AND pm.parenttype = 'Package Offer' AND pm.parentfield = 'price_matrix'
		  )
		ORDER BY td.departure_date ASC, o.name ASC
		""",
		{"t": trip_name},
		as_dict=True,
	)


def _cabin_pool(schedules: list) -> dict:
	"""Kolam cabin_rates schedule → {schedule: {avail, max_allot}} (kongsi
	sama dengan get_bundle_new)."""
	pool: dict = {}
	scheds = [s for s in (schedules or []) if s]
	if not scheds:
		return pool
	for r in frappe.db.sql(
		"""
		SELECT parent AS cruise_schedule,
		       SUM(GREATEST(cabin_allotment - cabin_occupancy, 0)) AS avail,
		       MAX(cabin_allotment) AS max_allot
		FROM `tabTrip Package Price`
		WHERE parenttype = 'Trip Cruise Schedule'
		  AND parent IN %(s)s
		GROUP BY parent
		""",
		{"s": scheds},
		as_dict=True,
	):
		pool[r.cruise_schedule] = r
	return pool


def get_trip_detail_new(trip_name: str, currency: str | None = None) -> dict:
	"""Data page DETAIL trip daripada struktur baharu (Trip >> Travel Date
	>> Package Offer) — KONTRAK PULANGAN SERASI 100% dengan
	trip_catalog.get_trip_detail() supaya trip.py get_context, trip.html
	dan trip_detail.js tidak perlu diubah:

    {group_dates, group_date_groups, trip_packages, departure_tgds,
     starting_from_price, original_starting_from_price, promo_label,
     destinations, is_cruise, currency, currency_native_only,
     starting_from_currency, starting_from_symbol}

	Sumber: tarikh/sailing/ship = Travel Date (satu sumber kebenaran);
	harga = Price Matrix offer (child Trip Package Price parenttype=
	'Package Offer'); kuota = kolam cabin_rates schedule. Kosong
	(group_dates == []) bila trip tiada offer sah — caller fallback ke
	bacaan legacy."""
	trip = frappe.db.get_value(
		"Trip", trip_name,
		["name", "trip_name", "is_a_cruise_trip"],
		as_dict=True,
	)
	_empty = {
		"group_dates": [],
		"group_date_groups": [],
		"trip_packages": {},
		"departure_tgds": {},
		"starting_from_price": None,
		"original_starting_from_price": None,
		"promo_label": None,
		"destinations": [],
		"is_cruise": bool(trip.is_a_cruise_trip) if trip else False,
		"currency": currency,
		"currency_native_only": False,
		"starting_from_currency": currency,
		"starting_from_symbol": None,
	}
	if not trip:
		return _empty
	is_cruise = bool(trip.is_a_cruise_trip)

	from travel_booking.api.currency_axis import get_default_currency
	if not currency:
		currency = get_default_currency()

	offers = _sellable_offers_for_trip(trip_name)
	if not offers:
		return _empty

	# Polisi currency SAMA dengan legacy: trip ada offer dalam currency
	# listing → hanya offer currency itu; tiada → papar SEMUA (native_only,
	# template papar badge currency setiap pakej).
	has_in_currency = any(o.currency == currency for o in offers)
	currency_native_only = not has_in_currency
	if has_in_currency:
		offers = [o for o in offers if o.currency == currency]

	pool = _cabin_pool(list({o.cruise_schedule for o in offers}))

	symbols = {
		c.name: c.symbol
		for c in frappe.get_all("Currency", fields=["name", "symbol"])
	}

	# --- date items + packages per date_key (kunci = legacy_tgd ATAU nama
	# Travel Date — SAMA dengan get_bundle_new supaya cart Book Now terus
	# sah dalam wizard). ---
	by_date: dict = {}
	trip_packages: dict = {}
	for o in offers:
		date_key = o.legacy_tgd or o.travel_date
		if date_key not in by_date:
			total_days, total_nights = _days_nights(
				o.departure_date, o.return_date)
			pr = pool.get(o.cruise_schedule)
			if pr and int(pr.max_allot or 0) > 0:
				seats = max(0, int(pr.avail or 0))
			else:
				seats = None
			by_date[date_key] = {
				"name": date_key,
				# Nama Travel Date sebenar (date_key mungkin legacy_tgd) —
				# dipakai trip_detail.js untuk fetch itinerary efektif
				# (package_catalog.get_effective_itinerary).
				"travel_date": o.travel_date or "",
				# Kategori trip tarikh ini (Travel Date.trip_category) —
				# trip_detail.js guna untuk tapis pilihan "Change Date"
				# pada deep-link ?date= (cruise): senarai tarikh LEBIH
				# KECIL kategori tarikh terpilih sahaja.
				"trip_category": o.trip_category or "",
				"trip_group_name": o.travel_date_name or "",
				"trip_group_code": "",
				"departure_date": str(o.departure_date or ""),
				"return_date": str(o.return_date or ""),
				"sailing_start": str(o.sailing_start or ""),
				"sailing_end": str(o.sailing_end or ""),
				# Port embarkasi/disembarkasi — info sailing page detail
				# (section sailing information card).
				"embarkation_port": o.embarkation_port or "",
				"disembarkation_port": o.disembarkation_port or "",
				"cruise_schedule": o.cruise_schedule or "",
				"total_days": total_days,
				"total_nights": total_nights,
				"max_participants": 0,
				"seats_left": seats,
				# label grouping sailing (cruise) — SAMA bentuk legacy
				"sailing_group": "",
				"sailing_label": "",
			}
			if is_cruise:
				sail_date = str(o.sailing_start or "")
				sailing_group = (o.cruise_schedule or ("sail:" + sail_date)) if sail_date else ""
				sailing_label = ("Sailing " + sail_date) if sail_date else ""
				if o.ship_name:
					sailing_label += " · " + o.ship_name
				by_date[date_key]["sailing_group"] = sailing_group
				by_date[date_key]["sailing_label"] = sailing_label

		trip_packages.setdefault(date_key, []).append({
			"name": o.legacy_trip_package or o.name,
			"trip_group_date": date_key,
			"package_name": o.package_name or o.offer_name or "",
			"package_type": o.package_template or o.offer_name or "",
			"flight": "",
			"flight_label": "No Flight",
			"currency": o.currency or o.default_currency or "MYR",
			"currency_symbol": symbols.get(
				(o.currency or o.default_currency or "MYR"), ""),
			"departure_date": str(o.departure_date or ""),
			"return_date": str(o.return_date or ""),
			"sailing_start": str(o.sailing_start or ""),
			"sailing_end": str(o.sailing_end or ""),
			"total_days": by_date[date_key]["total_days"],
			"total_nights": by_date[date_key]["total_nights"],
			"is_cruise_only": (o.package_template == "Cruise Only"),
			# laluan tulis struktur baharu (confirm_booking @flag ON)
			"offer": o.name,
			"travel_package": o.package,
		})

	# ── SATU pilihan tarikh per TRAVEL DATE (kunci = ID dokumen) ──
	# Grouping ikut departure date bermaksud setiap Travel Date — kumpulan
	# berlepas tersendiri — muncul sebagai pilihan tarikh sendiri, WALAUPUN
	# dua Travel Date berkongsi tarikh berlepas yang sama (cth dua sailing
	# durasi berbeza berlepas hari yang sama). TIADA dedupe merentasi
	# Travel Date: dedupe sailing lama menyembunyikan varian begini, dan
	# dedupe departure pula mencampurkan Travel Date berlainan durasi
	# bawah satu radio (paparan julat tarikh jadi bercanggah dengan pakej).
	# Susunan ikut departure_date (fallback sailing_start bila kosong).
	group_dates = list(by_date.values())
	group_dates.sort(key=lambda g: g["departure_date"] or g["sailing_start"])

	# Peta departure date → Travel Date (maklumat sahaja — frontend baca
	# pakej terus ikut kunci Travel Date; map kekal untuk debug/consumer
	# masa depan).
	departure_tgds: dict = {}
	if is_cruise:
		for gd in group_dates:
			dep = gd["departure_date"] or gd["sailing_start"]
			if dep:
				departure_tgds.setdefault(dep, []).append({
					"name": gd["name"],
					"departure_date": gd["departure_date"],
					"trip_group_name": gd["trip_group_name"],
					"is_cruise_only": any(
						p["is_cruise_only"]
						for p in trip_packages.get(gd["name"], [])
					),
				})

	# Satu kumpulan per Travel Date (kontrak optgroup lama — kini 1:1;
	# tiada consumer aktif, kekal untuk keserasian bentuk. Bukan-cruise: []).
	group_date_groups: list = []
	if is_cruise:
		group_date_groups = [
			{
				"key": g["name"],
				"label": "Departure "
					+ (g["departure_date"] or g["sailing_start"]),
				"dates": [g],
			}
			for g in group_dates
		]

	# --- starting_from_price: TOTAL pakej termurah = MIN(price_adult)
	# Price Matrix base + Σ(price_adult) addon_price_matrix (offer khas
	# dengan Flight/Hotel/Transport/Meal). Fallback native merentasi
	# currency offer bila native_only. Travel Price Rule: dikira atas
	# harga PROMO base sahaja (surcaj addon tetap, ditambah selepas). ---
	from travel_booking.api.price_rule import (
		effective_unit_price, get_active_price_rules,
	)

	original_starting_from_price = None
	promo_label = None
	best = None  # (total, currency, original, label)
	_cond = "" if currency_native_only else "AND o.currency = %(cur)s"
	if not get_active_price_rules():
		sp = frappe.db.sql(
			"""
			SELECT o.currency AS cur,
			       MIN(CASE WHEN pm.parentfield = 'price_matrix'
			           THEN pm.price_adult END)
			         + COALESCE(SUM(CASE WHEN pm.parentfield = 'addon_price_matrix'
			             THEN pm.price_adult ELSE 0 END), 0) AS total
			FROM `tabPackage Offer` o
			JOIN `tabTravel Date` td ON td.name = o.travel_date
			JOIN `tabTrip Package Price` pm
			  ON pm.parent = o.name AND pm.parenttype = 'Package Offer'
			WHERE td.trip = %(t)s
			  AND o.status_editorial = 'Active'
			  AND td.status_editorial = 'Active'
			  AND td.departure_date >= CURDATE()
			  {cond}
			  AND pm.price_adult > 0
			GROUP BY o.name, o.currency
			ORDER BY total
			LIMIT 1
			""".format(cond=_cond),
			{"t": trip_name, "cur": currency},
			as_dict=True,
		)
		starting_from_price = float(sp[0].total) if sp and sp[0].total else None
		starting_from_currency = (sp[0].cur if sp else None) or currency
	else:
		sp_rows = frappe.db.sql(
			"""
			SELECT o.name AS offer, o.currency AS cur,
			       td.departure_date,
			       pm.pricing_for_class AS room_category, pm.price_adult
			FROM `tabPackage Offer` o
			JOIN `tabTravel Date` td ON td.name = o.travel_date
			JOIN `tabTrip Package Price` pm
			  ON pm.parent = o.name AND pm.parenttype = 'Package Offer' AND pm.parentfield = 'price_matrix'
			WHERE td.trip = %(t)s
			  AND o.status_editorial = 'Active'
			  AND td.status_editorial = 'Active'
			  AND td.departure_date >= CURDATE()
			  {cond}
			""".format(cond=_cond),
			{"t": trip_name, "cur": currency},
			as_dict=True,
		)
		addon_sums = _addon_adult_sums([r.offer for r in sp_rows])
		for r in sp_rows:
			base = float(r.price_adult or 0)
			if base <= 0:
				continue
			_surcaj = addon_sums.get(r.offer, 0)
			ctx = {
				"trip": trip_name,
				"trip_group_date": None,
				"trip_package": None,
				"currency": r.cur,
				"departure_date": r.departure_date,
			}
			eff, label = effective_unit_price(
				base, ctx, r.room_category, "price_adult")
			if eff is None or eff <= 0:
				continue
			total = eff + _surcaj
			if best is None or total < best[0]:
				best = (total, r.cur, (base + _surcaj) if label else None, label)
		starting_from_price = best[0] if best else None
		starting_from_currency = (best[1] if best else None) or currency
		if best:
			original_starting_from_price = best[2]
			promo_label = best[3]
	starting_from_symbol = (
		frappe.db.get_value("Currency", starting_from_currency, "symbol")
		or starting_from_currency
	)

	# --- Harga "from" per tarikh (price_adult termurah offer tarikh itu)
	# — untuk senarai tarikh dalam modal Change Date (trip_detail.js).
	# Pola kiraan SAMA dengan starting_from di atas: baris price_matrix
	# termurah (effective — Travel Price Rule promo → label) + surcaj
	# addon; harga asal untuk strikethrough bila promo. date_key =
	# COALESCE(o.legacy_tgd, td.name) — SAMA dengan kunci by_date. Medan
	# TAMBAHAN pada group_dates (kontrak aditif; legacy fallback tiada
	# medan → frontend sembunyikan baris harga). ---
	date_prices: dict = {}
	dp_rows = frappe.db.sql(
		"""
		SELECT o.name AS offer, o.currency AS cur,
		       COALESCE(o.legacy_tgd, td.name) AS date_key,
		       td.departure_date,
		       pm.pricing_for_class AS room_category, pm.price_adult
		FROM `tabPackage Offer` o
		JOIN `tabTravel Date` td ON td.name = o.travel_date
		JOIN `tabTrip Package Price` pm
		  ON pm.parent = o.name AND pm.parenttype = 'Package Offer' AND pm.parentfield = 'price_matrix'
		WHERE td.trip = %(t)s
		  AND o.status_editorial = 'Active'
		  AND td.status_editorial = 'Active'
		  AND td.departure_date >= CURDATE()
		  {cond}
		""".format(cond=_cond),
		{"t": trip_name, "cur": currency},
		as_dict=True,
	)
	if dp_rows:
		addon_sums_d = _addon_adult_sums([r.offer for r in dp_rows])
		for r in dp_rows:
			base = float(r.price_adult or 0)
			if base <= 0:
				continue
			surcaj = float(addon_sums_d.get(r.offer, 0) or 0)
			ctx = {
				"trip": trip_name,
				"trip_group_date": None,
				"trip_package": None,
				"currency": r.cur,
				"departure_date": r.departure_date,
			}
			eff, label = effective_unit_price(
				base, ctx, r.room_category, "price_adult")
			if eff is None or eff <= 0:
				continue
			total = round(float(eff) + surcaj, 2)
			prev = date_prices.get(r.date_key)
			if prev is None or total < prev["price"]:
				date_prices[r.date_key] = {
					"price": total,
					"original": round(base + surcaj, 2) if label else None,
					"label": label,
					"currency": r.cur,
				}
	for g in group_dates:
		p = date_prices.get(g["name"])
		g["price_from"] = p["price"] if p else None
		g["price_from_original"] = p["original"] if p else None
		g["price_from_currency"] = p["currency"] if p else None
		g["price_from_symbol"] = (
			symbols.get(p["currency"], p["currency"]) if p else None)
		g["price_from_promo_label"] = p["label"] if p else None

	# --- destinasi — sumber & bentuk SAMA dengan legacy get_trip_detail ---
	dest_rows = frappe.db.sql(
		"""
		SELECT dp.name, dp.destination_name, dp.destination_country,
		       MIN(it.day) AS first_day
		FROM `tabTrip Itinerary` it
		JOIN `tabTrip Destination Point` dp ON dp.name = it.destination_point
		WHERE it.parent = %(t)s AND it.parenttype = 'Trip'
		  AND it.destination_point IS NOT NULL AND it.destination_point != ''
		GROUP BY dp.name, dp.destination_name, dp.destination_country
		ORDER BY first_day
		""",
		{"t": trip_name},
		as_dict=True,
	)
	destinations = [
		{
			"name": r.name,
			"destination_name": r.destination_name or r.name,
			"country": r.destination_country or "",
		}
		for r in dest_rows
	]

	# Flag pakej khas per tarikh (auto-derive addon matrix offer) — medan
	# TAMBAHAN pada kontrak (is_special + inclusions); caller lama tidak
	# terjejas. offer memang berada dalam trip_packages, jadi derivasi
	# boleh lakukan terus di sini tanpa peta legacy_tgd.
	detail = {
		"group_dates": group_dates,
		"group_date_groups": group_date_groups,
		"trip_packages": trip_packages,
		"departure_tgds": departure_tgds,
		"starting_from_price": starting_from_price,
		"original_starting_from_price": original_starting_from_price,
		"promo_label": promo_label,
		"destinations": destinations,
		"is_cruise": is_cruise,
		"currency": currency,
		"currency_native_only": currency_native_only,
		"starting_from_currency": starting_from_currency,
		"starting_from_symbol": starting_from_symbol,
	}
	from travel_booking.utils.catalog_extras import attach_special_flags
	return attach_special_flags(detail)


def _addon_adult_sums(offer_names):
	"""Σ(price_adult) addon_price_matrix per offer — surcaj komponen tetap
	(Flight/Hotel/Transport/Meal) untuk harga "from". Kontrak harga:
	Total pakej = base + Σ addon (rujuk description addon_price_matrix).
	{} bila offer tiada addon."""
	if not offer_names:
		return {}
	rows = frappe.db.sql(
		"""
		SELECT parent, COALESCE(SUM(price_adult), 0) AS s
		FROM `tabTrip Package Price`
		WHERE parenttype = 'Package Offer'
		  AND parentfield = 'addon_price_matrix'
		  AND parent IN %(offers)s
		GROUP BY parent
		""",
		{"offers": list(set(offer_names))},
		as_dict=True,
	)
	return {r.parent: float(r.s or 0) for r in rows}


def _add_starting_price_from_offers(trips: list, currency: str | None = None) -> None:
	"""Harga "from" listing (katalog cruise/tours) daripada Price Matrix
	offer — padanan _add_starting_price() legacy untuk mod struktur baharu.
	TOTAL pakej = MIN(price_adult) base + Σ(price_adult) addon (offer khas).
	In-place pada setiap trip dict: starting_from_price /
	original_starting_from_price / promo_label."""
	if not trips:
		return
	names = [t.name for t in trips]
	_cond = "AND o.currency = %(cur)s" if currency else ""
	from travel_booking.api.price_rule import (
		effective_unit_price, get_active_price_rules,
	)

	if not get_active_price_rules():
		# Per-offer total (base min + Σ addon), kemudian MIN per trip.
		rows = frappe.db.sql(
			"""
			SELECT td.trip AS trip,
			       MIN(CASE WHEN pm.parentfield = 'price_matrix'
			           THEN pm.price_adult END)
			         + COALESCE(SUM(CASE WHEN pm.parentfield = 'addon_price_matrix'
			             THEN pm.price_adult ELSE 0 END), 0) AS total
			FROM `tabPackage Offer` o
			JOIN `tabTravel Date` td ON td.name = o.travel_date
			JOIN `tabTrip Package Price` pm
			  ON pm.parent = o.name AND pm.parenttype = 'Package Offer'
			WHERE td.trip IN %(names)s
			  AND o.status_editorial = 'Active'
			  AND td.status_editorial = 'Active'
			  AND td.departure_date >= CURDATE()
			  {cond}
			  AND pm.price_adult > 0
			GROUP BY o.name, td.trip
			""".format(cond=_cond),
			{"names": names, "cur": currency},
			as_dict=True,
		)
		price_map: dict = {}
		for r in rows:
			if not r.total:
				continue
			cur = price_map.get(r.trip)
			if cur is None or float(r.total) < cur:
				price_map[r.trip] = float(r.total)
		for t in trips:
			t["starting_from_price"] = price_map.get(t.name)
			t["original_starting_from_price"] = None
			t["promo_label"] = None
		return

	rows = frappe.db.sql(
		"""
		SELECT o.name AS offer, td.trip AS trip, o.currency, td.departure_date,
		       pm.pricing_for_class AS room_category, pm.price_adult
		FROM `tabPackage Offer` o
		JOIN `tabTravel Date` td ON td.name = o.travel_date
		JOIN `tabTrip Package Price` pm
		  ON pm.parent = o.name AND pm.parenttype = 'Package Offer' AND pm.parentfield = 'price_matrix'
		WHERE td.trip IN %(names)s
		  AND o.status_editorial = 'Active'
		  AND td.status_editorial = 'Active'
		  AND td.departure_date >= CURDATE()
		{cond}
		""".format(cond=_cond),
		{"names": names, "cur": currency},
		as_dict=True,
	)
	addon_sums = _addon_adult_sums([r.offer for r in rows])
	best_map: dict = {}
	for r in rows:
		base = float(r.price_adult or 0)
		if base <= 0:
			continue
		_surcaj = addon_sums.get(r.offer, 0)
		ctx = {
			"trip": r.trip,
			"trip_group_date": None,
			"trip_package": None,
			"currency": r.currency,
			"departure_date": r.departure_date,
		}
		eff, label = effective_unit_price(base, ctx, r.room_category, "price_adult")
		if eff is None or eff <= 0:
			continue
		total = eff + _surcaj
		cur_best = best_map.get(r.trip)
		if cur_best is None or total < cur_best[0]:
			best_map[r.trip] = (total, (base + _surcaj) if label else None, label)
	for t in trips:
		best = best_map.get(t.name)
		t["starting_from_price"] = best[0] if best else None
		t["original_starting_from_price"] = best[1] if best else None
		t["promo_label"] = best[2] if best else None
