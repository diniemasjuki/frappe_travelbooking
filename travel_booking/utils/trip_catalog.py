# travel_booking/utils/trip_catalog.py
#
# Lapisan data KONGSI untuk "ready trip" — sumber kebenaran tunggal
# antara wizard booking (www/booking.py) dan katalog awam (www/trips.py).
#
# "Ready" = Trip Active DAN ada sekurang-kurangnya SATU Trip Group Date
# yang juga Active, tarikh akan datang, DAN ada Trip Package Active untuk
# group date tu. Trip yang belum lengkap disetup SENGAJA tak dipapar —
# elak dead-end di step seterusnya (booking) / card kosong (katalog).
#
# booking.py guna get_ready_bundle() (medan MINIMUM — name, trip_name,
# is_a_cruise_trip — supaya payload wizard kekal ringkas). trips.py guna
# get_catalog_trips() (medan DIPERKAYA — image, kategori, destinasi, harga
# mula, tarikh seterusnya — untuk card katalog).

import frappe
from travel_booking.api._helpers import get_company_currency


def get_ready_bundle() -> tuple[list, dict, dict, dict]:
	"""Teras data "ready trip" yang dikongsi. KEMBALI tuple:

	    (trips, trip_group_dates, trip_packages, trip_is_cruise)

	- trips:             list[{name, trip_name, is_a_cruise_trip}]
	- trip_group_dates:  {trip_name: [group_date_dict, ...]}
	- trip_packages:     {group_date_name: [package_dict, ...]}
	- trip_is_cruise:    {trip_name: bool}

	Sebarang perubahan definisi "ready" di sini sekali gus berkesan untuk
	booking wizard DAN katalog. Jangan duplikasi SQL di tempat lain.
	"""
	# --- Trip (header) — wujud sekurang-kurangnya satu group date ready ---
	trips = frappe.db.sql(
		"""
		SELECT DISTINCT t.name, t.trip_name, t.is_a_cruise_trip
		FROM `tabTrip` t
		WHERE t.status = 'Active'
		  AND EXISTS (
		      SELECT 1
		      FROM `tabTrip Group Date` td
		      WHERE td.trip = t.name
		        AND td.status = 'Active'
		        AND td.departure_date >= CURDATE()
		        AND EXISTS (
		            SELECT 1
		            FROM `tabTrip Package Group Date Select` sel
		            JOIN `tabTrip Package` tp ON tp.name = sel.parent
		            WHERE sel.trip_group_date = td.name
		              AND tp.status = 'Active'
		        )
		  )
		ORDER BY t.trip_name
		""",
		as_dict=True,
	)

	trip_is_cruise = {t.name: bool(t.is_a_cruise_trip) for t in trips}

	trip_group_dates: dict = {}
	trip_packages: dict = {}
	if not trips:
		return trips, trip_group_dates, trip_packages, trip_is_cruise

	trip_names = [t.name for t in trips]

	# --- Group dates per-trip (dengan cascade "ready" + seats_left) ---
	dates = frappe.db.sql(
		"""
		SELECT td.name, td.trip, td.trip_group_name, td.trip_group_code,
		       td.departure_date, td.return_date, td.total_days, td.total_nights,
		       td.sailing_start, td.sailing_end, td.cruise_schedule,
		       td.max_participants, td.current_participants
		FROM `tabTrip Group Date` td
		WHERE td.trip IN %(trips)s
		  AND td.status = 'Active'
		  AND td.departure_date >= CURDATE()
		  AND EXISTS (
		      SELECT 1
		      FROM `tabTrip Package Group Date Select` sel
		      JOIN `tabTrip Package` tp ON tp.name = sel.parent
		      WHERE sel.trip_group_date = td.name
		        AND tp.status = 'Active'
		  )
		ORDER BY td.departure_date ASC
		""",
		{"trips": trip_names},
		as_dict=True,
	)

	# seats_left berasaskan SUM(booked_pax) merentasi SEMUA booking
	# tak-cancelled — SEPADAN dengan gate overbooking di confirm_booking
	# (yang juga guna booked_pax, bukan current_participants).
	booked_pax_by_date: dict = {}
	if dates:
		pax_rows = frappe.db.sql(
			"""
			SELECT b.trip_date, COALESCE(SUM(b.booked_pax), 0) AS pax
			FROM `tabBooking` b
			WHERE b.trip_date IN %(dates)s AND b.status != 'Cancelled'
			GROUP BY b.trip_date
			""",
			{"dates": [d.name for d in dates]},
			as_dict=True,
		)
		booked_pax_by_date = {r.trip_date: int(r.pax or 0) for r in pax_rows}

	for d in dates:
		trip_group_dates.setdefault(d.trip, [])
		max_pax = int(d.max_participants or 0)
		booked = int(booked_pax_by_date.get(d.name, 0))
		# max_participants == 0 -> UNLIMITED (None -> frontend "Available").
		seats_left = None if max_pax == 0 else max(0, max_pax - booked)
		trip_group_dates[d.trip].append(
			{
				"name": d.name,
				"trip_group_name": d.trip_group_name or "",
				"trip_group_code": d.trip_group_code or "",
				"departure_date": str(d.departure_date) if d.departure_date else "",
				"return_date": str(d.return_date) if d.return_date else "",
				"sailing_start": str(d.sailing_start) if d.sailing_start else "",
				"sailing_end": str(d.sailing_end) if d.sailing_end else "",
				"cruise_schedule": d.cruise_schedule or "",
				"total_days": d.total_days or 0,
				"total_nights": d.total_nights or 0,
				"max_participants": max_pax,
				"seats_left": seats_left,
			}
		)

	# Susun semula per-trip: cruise ikut SAILING date (sailing_start),
	# lain-lain ikut departure_date. Cruise cuma papar sailing terawal.
	for _trip_name, _groups in trip_group_dates.items():
		if trip_is_cruise.get(_trip_name):
			_groups.sort(key=lambda g: g["sailing_start"] or g["departure_date"])
		else:
			_groups.sort(key=lambda g: g["departure_date"])

	# --- Packages per group date ---
	if dates:
		date_names = [d.name for d in dates]
		pkgs = frappe.db.sql(
			"""
			SELECT tp.name, sel.trip_group_date, tp.package_title, tp.package_type,
			       tp.airport_form, ap.airport_name, tp.currency, cur.symbol AS currency_symbol
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

		for p in pkgs:
			trip_packages.setdefault(p.trip_group_date, [])
			flight_label = (p.airport_name or p.airport_form) if p.airport_form else "No Flight"
			trip_packages[p.trip_group_date].append(
				{
					"name": p.name,
					"trip_group_date": p.trip_group_date,
					"package_name": p.package_title or "",
					"package_type": p.package_type or "",
					"flight": p.airport_form or "",
					"flight_label": flight_label,
					"currency": p.currency or "MYR",
					"currency_symbol": p.currency_symbol or (p.currency or "MYR"),
				}
			)

	return trips, trip_group_dates, trip_packages, trip_is_cruise


def _enrich_trips(trips: list) -> None:
	"""Tambah medan paparan (in-place) ke setiap trip dict: trip_image,
	trip_categories, route, trip_organizer, destinations (nama + negara +
	bendera). Dipanggil get_catalog_trips() sahaja — bukan booking wizard."""
	if not trips:
		return
	names = [t.name for t in trips]
	meta = frappe.db.sql(
		"""
		SELECT name, trip_image, trip_categories, route, trip_organizer, published
		FROM `tabTrip`
		WHERE name IN %(names)s
		""",
		{"names": names},
		as_dict=True,
	)
	by_trip = {m.name: m for m in meta}
	for t in trips:
		m = by_trip.get(t.name, {})
		t["trip_image"] = m.get("trip_image") or "/assets/travel_booking/img/defaultaroyo.jpg"
		t["trip_categories"] = m.get("trip_categories") or ""
		t["route"] = m.get("route") or ""
		t["trip_organizer"] = m.get("trip_organizer") or ""
		t["published"] = bool(m.get("published"))

	# Destinasi per-trip: join child destination_list -> master Trip
	# Destination Point (nama + negara). Cruise turut sertakan port
	# start/end dari Trip Cruise Schedule aktif trip tu.
	dest_rows = frappe.db.sql(
		"""
		SELECT sel.parent AS trip, dp.name AS dest_name,
		       dp.destination_name, dp.destination_country
		FROM `tabTrip Destination Point Select` sel
		JOIN `tabTrip Destination Point` dp ON dp.name = sel.select_destination_point
		WHERE sel.parent IN %(names)s AND sel.parenttype = 'Trip'
		""",
		{"names": names},
		as_dict=True,
	)
	dest_map: dict = {}
	for r in dest_rows:
		dest_map.setdefault(r.trip, []).append(
			{
				"name": r.dest_name,
				"destination_name": r.destination_name or r.dest_name,
				"country": r.destination_country or "",
			}
		)
	for t in trips:
		t["destinations"] = dest_map.get(t.name, [])


def _add_starting_price(trips: list) -> None:
	"""Harga terendah "from" setiap trip = MIN price_adult merentasi SEMUA
	package Active trip tu. SEMUA harga dalam company currency (senibina
	sedia ada). None kalau tiada pricing."""
	if not trips:
		return
	rows = frappe.db.sql(
		"""
		SELECT tp.trip_link AS trip, MIN(pr.price_adult) AS min_price
		FROM `tabTrip Package` tp
		JOIN `tabTrip Package Price` pr ON pr.parent = tp.name
		WHERE tp.trip_link IN %(names)s AND tp.status = 'Active'
		GROUP BY tp.trip_link
		""",
		{"names": [t.name for t in trips]},
		as_dict=True,
	)
	price_map = {r.trip: (float(r.min_price) if r.min_price else None) for r in rows}
	for t in trips:
		t["starting_from_price"] = price_map.get(t.name)


def _add_next_departure(trips: list, trip_group_dates: dict) -> None:
	"""Tarikh keberangkatan terdekat setiap trip (group date pertama,
	ikut susunan cruise/non-cruise yang dah dibina di get_ready_bundle)."""
	for t in trips:
		groups = trip_group_dates.get(t.name) or []
		if not groups:
			t["next_departure"] = ""
			t["next_departure_label"] = ""
			continue
		g = groups[0]
		# Cruise papar sailing_start; lain-lain departure_date.
		base = g.get("sailing_start") or g.get("departure_date")
		t["next_departure"] = base or ""
		# label: sailing utk cruise, departure utk bukan.
		t["next_departure_label"] = (
			("Sail " if t.get("is_a_cruise_trip") else "Departs ") + (base or "")
		)


def get_catalog_trips(filters: dict | None = None) -> dict:
	"""Katalog awam: ready trips DIPERKAYA + ditapis ikut `filters`.

	KEMBALI dict:
	    {trips, trip_group_dates, trip_packages, trip_is_cruise,
	     company_currency, company_symbol}

	`filters` (semua opsyenal, dari query string /trips):
	    q            — carian teks atas trip_name
	    destination  — nama Trip Destination Point (filter destinasi)
	    item_group   — nama Item Group (filter kategori)
	    cruise       — "1" cruise-sahaja | "0" non-cruise-sahaja | "" semua
	    date_from    — tarikh mula (YYYY-MM-DD)
	    date_to      — tarikh tamat (YYYY-MM-DD)
	    sort         — "date" | "price" | "duration" (default "date")
	"""
	filters = filters or {}
	trips, trip_group_dates, trip_packages, trip_is_cruise = get_ready_bundle()
	_enrich_trips(trips)
	_add_starting_price(trips)
	_add_next_departure(trips, trip_group_dates)

	q = (filters.get("q") or "").strip()
	destination = (filters.get("destination") or "").strip()
	item_group = (filters.get("item_group") or "").strip()
	cruise = (filters.get("cruise") or "").strip()
	date_from = (filters.get("date_from") or "").strip()
	date_to = (filters.get("date_to") or "").strip()
	sort = (filters.get("sort") or "date").strip()

	# --- Penapis destinasi + item_group + carian + cruise/normal ---
	def _trip_matches(t: dict) -> bool:
		if q and q.lower() not in (t.get("trip_name") or "").lower():
			return False
		if item_group and t.get("trip_categories") != item_group:
			return False
		if cruise in ("1", "0") and str(int(t.get("is_a_cruise_trip") or 0)) != cruise:
			return False
		if destination:
			names = {d["name"] for d in t.get("destinations") or []}
			if destination not in names:
				return False
		return True

	# --- Penapis julat tarikh pada group dates setiap trip ---
	def _date_in_range(g: dict) -> bool:
		base = g.get("sailing_start") or g.get("departure_date")
		if not base:
			return True
		if date_from and base < date_from:
			return False
		if date_to and base > date_to:
			return False
		return True

	keep = []
	for t in trips:
		# Katalog awam: jangan papar trip tidak published — elak card link ke
		# detail 404. (Booking wizard guna get_ready_bundle terus, tak ditapis
		# di sini — operator masih boleh tempah trip pre-launch via wizard.)
		if not t.get("published"):
			trip_group_dates.pop(t.name, None)
			continue
		if not _trip_matches(t):
			trip_group_dates.pop(t.name, None)
			continue
		# tapis group dates ikut julat tarikh
		gs = [g for g in (trip_group_dates.get(t.name) or []) if _date_in_range(g)]
		if date_from or date_to:
			if not gs:
				# tiada group date dalam julat -> buang trip (elak dead-end)
				trip_group_dates.pop(t.name, None)
				continue
			trip_group_dates[t.name] = gs
		# next_departure ikut group dates yang tinggal
		if gs:
			g = gs[0]
			base = g.get("sailing_start") or g.get("departure_date")
			t["next_departure"] = base or ""
			t["next_departure_label"] = (
				("Sail " if t.get("is_a_cruise_trip") else "Departs ") + (base or "")
			)
		keep.append(t)
	trips = keep

	# --- Susunan ---
	if sort == "price":
		trips.sort(key=lambda t: (t.get("starting_from_price") is None, t.get("starting_from_price") or 0))
	elif sort == "duration":
		trips.sort(
			key=lambda t: -(
				((trip_group_dates.get(t.name) or [{}])[0]).get("total_days") or 0
			)
		)
	else:  # "date"
		trips.sort(key=lambda t: t.get("next_departure") or "9")

	company_currency = get_company_currency()
	company_symbol = (
		frappe.db.get_value("Currency", company_currency, "symbol") or company_currency
	)

	return {
		"trips": trips,
		"trip_group_dates": trip_group_dates,
		"trip_packages": trip_packages,
		"trip_is_cruise": trip_is_cruise,
		"company_currency": company_currency,
		"company_symbol": company_symbol,
	}


def get_filter_options() -> dict:
	"""Pilihan dropdown untuk bar penapis katalog: destinasi (master) +
	item group (yang dipakai oleh Trip) + senarai negara. Data kecil,
	dipanggil sekali setiap render /trips."""
	destinations = frappe.db.sql(
		"""
		SELECT DISTINCT dp.name, dp.destination_name, dp.destination_country
		FROM `tabTrip Destination Point` dp
		WHERE EXISTS (
		    SELECT 1 FROM `tabTrip Destination Point Select` sel
		    WHERE sel.select_destination_point = dp.name
		)
		ORDER BY dp.destination_name
		""",
		as_dict=True,
	)
	item_groups = frappe.db.sql(
		"""
		SELECT DISTINCT t.trip_categories AS name
		FROM `tabTrip` t
		WHERE t.trip_categories IS NOT NULL AND t.trip_categories != ''
		ORDER BY t.trip_categories
		""",
		as_dict=True,
	)
	return {
		"destinations": destinations,
		"item_groups": [g.name for g in item_groups if g.name],
	}


def get_trip_detail(trip_name: str) -> dict:
	"""Data untuk page DETAIL trip /trip/<slug>. SCOPE ke satu trip sahaja
	(jangan query semua ready trip macam get_ready_bundle — page detail
	dipanggil per-trip, jadi elak overhead merentasi trip lain).

	Definisi "ready" group date SEPADAN dengan get_ready_bundle: Trip Group
	Date Active + tarikh akan datang + ada Trip Package Active. seats_left
	dari SUM(booked_pax) booking tak-cancelled (sepadan gate overbooking).

	KEMBALI:
	    {group_dates, trip_packages, starting_from_price, destinations, is_cruise}

	- group_dates:        list[dict] ready group dates trip ni (cruise disusun
	                      ikut sailing_start)
	- trip_packages:      {group_date_name: [package_dict, ...]}
	- starting_from_price: MIN price_adult merentasi package Active trip ni
	                      (company currency), None kalau tiada pricing
	- destinations:       [{name, destination_name, country}]
	- is_cruise:         bool
	"""
	trip = frappe.db.get_value(
		"Trip", trip_name,
		["name", "trip_name", "is_a_cruise_trip"],
		as_dict=True,
	)
	if not trip:
		return {
			"group_dates": [],
			"trip_packages": {},
			"starting_from_price": None,
			"destinations": [],
			"is_cruise": False,
		}
	is_cruise = bool(trip.is_a_cruise_trip)

	# --- ready group dates untuk trip ni sahaja ---
	dates = frappe.db.sql(
		"""
		SELECT td.name, td.trip, td.trip_group_name, td.trip_group_code,
		       td.departure_date, td.return_date, td.total_days, td.total_nights,
		       td.sailing_start, td.sailing_end, td.cruise_schedule,
		       td.max_participants
		FROM `tabTrip Group Date` td
		WHERE td.trip = %(t)s
		  AND td.status = 'Active'
		  AND td.departure_date >= CURDATE()
		  AND EXISTS (
		      SELECT 1
		      FROM `tabTrip Package Group Date Select` sel
		      JOIN `tabTrip Package` tp ON tp.name = sel.parent
		      WHERE sel.trip_group_date = td.name
		        AND tp.status = 'Active'
		  )
		ORDER BY td.departure_date ASC
			""",
			{"t": trip_name},
			as_dict=True,
		)

		# --- info cruise_schedule (ship + sail date) untuk grouping cruise ---
	cruise_sched: dict = {}
	if is_cruise and dates:
		_cs = list({d.cruise_schedule for d in dates if d.cruise_schedule})
		if _cs:
			cruise_sched = {
				r.name: r for r in frappe.db.get_values(
					"Trip Cruise Schedule", _cs,
					["name", "ship_name", "sail_start", "sail_end"],
					as_dict=True,
				)
			}

	# seats_left: SUM(booked_pax) booking tak-cancelled per group date
	booked: dict = {}
	if dates:
		rows = frappe.db.sql(
			"""
			SELECT b.trip_date, COALESCE(SUM(b.booked_pax), 0) AS pax
			FROM `tabBooking` b
			WHERE b.trip_date IN %(ds)s AND b.status != 'Cancelled'
			GROUP BY b.trip_date
			""",
			{"ds": [d.name for d in dates]},
			as_dict=True,
		)
		booked = {r.trip_date: int(r.pax or 0) for r in rows}

	group_dates: list = []
	for d in dates:
		mx = int(d.max_participants or 0)
		bk = int(booked.get(d.name, 0))
		# max_participants == 0 -> UNLIMITED (None -> frontend "Available").
		# Cruise: tentukan kunci/label grouping sailing (cluster group date
		# yang kongsi cruise_schedule/sailing date sama) untuk <optgroup>.
		sailing_group = ""
		sailing_label = ""
		if is_cruise:
			cs = d.cruise_schedule
			info = cruise_sched.get(cs) if cs else None
			sail_date = (
				str(info.sail_start) if info and info.sail_start else ""
			) or (str(d.sailing_start) if d.sailing_start else "")
			sailing_group = (cs or ("sail:" + sail_date)) if sail_date else ""
			ship = info.ship_name if info else ""
			sailing_label = ("Sailing " + sail_date) if sail_date else ""
			if ship:
				sailing_label += " · " + ship
		group_dates.append(
			{
				"name": d.name,
				"trip_group_name": d.trip_group_name or "",
				"trip_group_code": d.trip_group_code or "",
				"departure_date": str(d.departure_date) if d.departure_date else "",
				"return_date": str(d.return_date) if d.return_date else "",
				"sailing_start": str(d.sailing_start) if d.sailing_start else "",
				"sailing_end": str(d.sailing_end) if d.sailing_end else "",
				"cruise_schedule": d.cruise_schedule or "",
				"total_days": d.total_days or 0,
				"total_nights": d.total_nights or 0,
				"max_participants": mx,
				"seats_left": None if mx == 0 else max(0, mx - bk),
				"sailing_group": sailing_group,
				"sailing_label": sailing_label,
			}
		)
	# Cruise disusun ikut sailing_start (sepadan get_ready_bundle).
	# Initialize merge tracker di sini supaya wujud scope function (untuk
	# code merge yang jalankan selepas ini, di luar if block).
	cruise_dedup_merge: dict = {}  # {kept_name: [removed_names...]}
	if is_cruise and group_dates:
		group_dates.sort(key=lambda g: g["sailing_start"] or g["departure_date"])

		# ── Cruise dedup: gabung group_dates yang sama sailing_start ──
		# Fly Cruise (RC2616) + Cruise Only (RC2618) yang sama sailing_start=2026-09-14
		# digabung jadi SATU option sahaja. Packages dari yang dibuang akan dimerge.
		_seen_sail: set = set()
		_deduped: list = []
		for gd in group_dates:
			sail_key = gd.get("sailing_start") or ""
			if sail_key and sail_key in _seen_sail:
				# Duplicate — simpan untuk merge packages nanti
				kept = _deduped[-1] if _deduped else None
				if kept:
					cruise_dedup_merge.setdefault(kept["name"], []).append(gd["name"])
				continue
			if sail_key:
				_seen_sail.add(sail_key)
			_deduped.append(gd)
		group_dates = _deduped

		# Cluster group date cruise mengikut sailing (cruise_schedule / sailing
	# date) untuk render <optgroup> per sailing di page detail. Bukan-cruise:
	# kosong -> template render flat (tiada optgroup).
	group_date_groups: list = []
	if is_cruise and group_dates:
		_seen: dict = {}
		for g in group_dates:
			key = g.get("sailing_group") or ("sail:" + (g.get("sailing_start") or ""))
			grp = _seen.get(key)
			if not grp:
				grp = {
					"key": key,
					"label": g.get("sailing_label")
					or ("Sailing " + (g.get("sailing_start") or "")),
					"dates": [],
				}
				_seen[key] = grp
				group_date_groups.append(grp)
			grp["dates"].append(g)

	# --- packages per group date (trip ni sahaja) ---
	trip_packages: dict = {}
	if dates:
		pkgs = frappe.db.sql(
			"""
			SELECT tp.name, sel.trip_group_date, tp.package_title, tp.package_type,
			       tp.airport_form, ap.airport_name, tp.currency, cur.symbol AS currency_symbol
			FROM `tabTrip Package` tp
			JOIN `tabTrip Package Group Date Select` sel ON sel.parent = tp.name
			LEFT JOIN `tabFlight Airport` ap ON ap.name = tp.airport_form
			LEFT JOIN `tabCurrency` cur ON cur.name = tp.currency
			WHERE sel.trip_group_date IN %(ds)s
			  AND tp.status = 'Active'
			ORDER BY tp.package_type ASC, tp.package_title ASC
			""",
			{"ds": [d.name for d in dates]},
			as_dict=True,
		)
		for p in pkgs:
			flight_label = (p.airport_name or p.airport_form) if p.airport_form else "No Flight"
			trip_packages.setdefault(p.trip_group_date, []).append(
				{
					"name": p.name,
					"trip_group_date": p.trip_group_date,
					"package_name": p.package_title or "",
					"package_type": p.package_type or "",
					"flight": p.airport_form or "",
					"flight_label": flight_label,
					"currency": p.currency or "MYR",
					"currency_symbol": p.currency_symbol or (p.currency or "MYR"),
				}
				)

	# ── Merge packages dari group dates yang dibuang (cruise dedup) ──
	if cruise_dedup_merge and trip_packages:
		for _kept_name, _removed_names in cruise_dedup_merge.items():
			_kept_pkgs = trip_packages.get(_kept_name, [])
			_seen_pkg: set = {p["name"] for p in _kept_pkgs}
			for _rm_name in _removed_names:
				_rm_pkgs = trip_packages.get(_rm_name, [])
				for _p in _rm_pkgs:
						if _p["name"] not in _seen_pkg:
							# Update trip_group_date supaya konsisten dengan key baru
							_p["trip_group_date"] = _kept_name
							_kept_pkgs.append(_p)
							_seen_pkg.add(_p["name"])
			# Buang entry untuk group date yang dah dibuang
				trip_packages.pop(_rm_name, None)

			# --- starting_from_price: MIN price_adult merentasi package Active trip ni ---
	sp = frappe.db.sql(
		"""
		SELECT MIN(pr.price_adult) AS mn
		FROM `tabTrip Package` tp
		JOIN `tabTrip Package Price` pr ON pr.parent = tp.name
		WHERE tp.trip_link = %(t)s AND tp.status = 'Active'
		""",
		{"t": trip_name},
	)
	starting_from_price = float(sp[0][0]) if sp and sp[0][0] else None

    # --- destinasi: join child destination_list -> master ---
	dest_rows = frappe.db.sql(
        """
        SELECT dp.name, dp.destination_name, dp.destination_country
        FROM `tabTrip Destination Point Select` sel
        JOIN `tabTrip Destination Point` dp ON dp.name = sel.select_destination_point
        WHERE sel.parent = %(t)s AND sel.parenttype = 'Trip'
        ORDER BY sel.idx
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

	return {
		"group_dates": group_dates,
		"group_date_groups": group_date_groups,
		"trip_packages": trip_packages,
		"starting_from_price": starting_from_price,
		"destinations": destinations,
		"is_cruise": is_cruise,
	}
