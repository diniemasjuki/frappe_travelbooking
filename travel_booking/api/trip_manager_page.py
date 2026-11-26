# travel_booking/api/trip_manager_page.py
#
# Trip Manager PAGE API — senarai ringkas empat domain pengurusan produk
# (page bacaan /app/trip-manager):
#
#   1. get_trips_overview   — Trip + elemen (TGD count, pakej aktif,
#                             cruise/flight schedule linkage, BOM rows).
#   2. get_flight_schedules — Flight Schedule + PNR rows ter-embed +
#                             PNR yatim (belum dalam mana2 schedule).
#   3. get_cruise_schedules — Trip Cruise Schedule + kelas kabin +
#                             allotment ringkas + TGD terpaut.
#   4. get_extras           — Trip Addon + Trip Addon Package jualan
#                             (rates per currency, scoping, qty caps).
#
# Semua GET sahaja — edit/CIPTA kekal melalui Desk (page sediakan butang
# New/Edit yang lompat ke form). Gate role selari Trip Command Center.
# NOTE: berasingan daripada api/trip_manager.py (CRUD form lama).

import frappe

_PAGE_ROLES = ("System Manager", "Tour Manager", "Tour Operator")


def _require_access():
	if not any(r in _PAGE_ROLES for r in frappe.get_roles()):
		frappe.throw(
			"You need the Tour Manager or Tour Operator role to access "
			"Trip Manager.", frappe.PermissionError)


@frappe.whitelist()
def get_trips_overview(search: str = "", limit: int = 50, offset: int = 0) -> dict:
	"""Senarai Trip + ringkasan elemen per trip."""
	_require_access()
	try:
		limit = min(max(int(limit or 50), 1), 200)
		offset = max(int(offset or 0), 0)
	except (TypeError, ValueError):
		limit, offset = 50, 0

	cond, vals = "", []
	if search:
		cond = "AND (t.trip_name LIKE %s OR t.name LIKE %s)"
		like = "%" + search + "%"
		vals = [like, like]

	rows = frappe.db.sql("""
		SELECT t.name, t.trip_name, t.is_a_cruise_trip, t.status, t.route,
		       (SELECT COUNT(*) FROM `tabTrip Group Date` g
		         WHERE g.trip = t.name AND g.status != 'Cancelled') AS tgd_count,
		       (SELECT COUNT(*) FROM `tabTrip Package` p
		         WHERE p.trip_link = t.name AND p.status = 'Active') AS active_pkgs,
		       (SELECT COUNT(DISTINCT g.cruise_schedule) FROM `tabTrip Group Date` g
		         WHERE g.trip = t.name AND g.cruise_schedule IS NOT NULL
		           AND g.cruise_schedule != '') AS cruise_scheds,
		       (SELECT COUNT(DISTINCT g.flight_schedule) FROM `tabTrip Group Date` g
		         WHERE g.trip = t.name AND g.flight_schedule IS NOT NULL
		           AND g.flight_schedule != '') AS flight_scheds,
		       (SELECT COUNT(*) FROM `tabTrip Package Component` c
		         JOIN `tabTrip Package` p ON p.name = c.parent
		         WHERE p.trip_link = t.name) AS bom_rows
		FROM `tabTrip` t
		WHERE t.status != 'Cancelled' {cond}
		ORDER BY t.modified DESC
		LIMIT %s OFFSET %s
	""".format(cond=cond), tuple(vals + [limit, offset]), as_dict=True)

	total = frappe.db.sql("""
		SELECT COUNT(*) FROM `tabTrip` t
		WHERE t.status != 'Cancelled' {cond}
	""".format(cond=cond), tuple(vals))[0][0]

	return {"trips": rows, "total": total, "limit": limit, "offset": offset}


@frappe.whitelist()
def get_flight_schedules(search: str = "", limit: int = 50, offset: int = 0) -> dict:
	"""Senarai Flight Schedule + PNR rows ter-embed + PNR yatim."""
	_require_access()
	try:
		limit = min(max(int(limit or 50), 1), 200)
		offset = max(int(offset or 0), 0)
	except (TypeError, ValueError):
		limit, offset = 50, 0

	cond, vals = "", []
	if search:
		cond = "AND (fs.schedule_code LIKE %s OR fs.name LIKE %s)"
		like = "%" + search + "%"
		vals = [like, like]

	rows = frappe.db.sql("""
		SELECT fs.name, fs.schedule_code, fs.status,
		       (SELECT COUNT(*) FROM `tabTrip Group Date` g
		         WHERE g.flight_schedule = fs.name) AS tgd_count,
		       (SELECT GROUP_CONCAT(g.name) FROM `tabTrip Group Date` g
		         WHERE g.flight_schedule = fs.name) AS tgds
		FROM `tabFlight Schedule` fs
		WHERE 1=1 {cond}
		ORDER BY fs.modified DESC
		LIMIT %s OFFSET %s
	""".format(cond=cond), tuple(vals + [limit, offset]), as_dict=True)

	pnr_map = {}
	if rows:
		names = [r.name for r in rows]
		for p in frappe.db.sql("""
			SELECT fsf.parent, fsf.role, f.name AS flight, f.pnr, f.airline,
			       f.home_airport, f.destination_airport,
			       f.departure_date, f.arrival_date, f.ticket_type,
			       f.flight_class, f.status, f.max_seat, f.seats_occupied
			FROM `tabFlight Schedule Flight` fsf
			JOIN `tabFlight` f ON f.name = fsf.flight
			WHERE fsf.parent IN %s AND fsf.parenttype = 'Flight Schedule'
			ORDER BY fsf.parent, fsf.idx
		""", (tuple(names),), as_dict=True):
			pnr_map.setdefault(p.parent, []).append(p)
	for r in rows:
		r["flights"] = pnr_map.get(r.name, [])
		r["tgds"] = (r.tgds or "").split(",") if r.tgds else []

	orphans = frappe.db.sql("""
		SELECT f.name, f.pnr, f.airline, f.home_airport, f.destination_airport,
		       f.departure_date, f.arrival_date, f.ticket_type,
		       f.flight_class, f.status, f.max_seat, f.seats_occupied
		FROM `tabFlight` f
		WHERE NOT EXISTS (
		    SELECT 1 FROM `tabFlight Schedule Flight` fsf
		    WHERE fsf.flight = f.name AND fsf.parenttype = 'Flight Schedule')
		ORDER BY f.modified DESC
		LIMIT 25
	""", as_dict=True)

	total = frappe.db.count("Flight Schedule")
	return {"schedules": rows, "orphans": orphans,
	        "total": total, "limit": limit, "offset": offset}


@frappe.whitelist()
def get_cruise_schedules(search: str = "", limit: int = 50, offset: int = 0) -> dict:
	"""Senarai Trip Cruise Schedule + kelas kabin + allotment ringkas."""
	_require_access()
	try:
		limit = min(max(int(limit or 50), 1), 200)
		offset = max(int(offset or 0), 0)
	except (TypeError, ValueError):
		limit, offset = 50, 0

	cond, vals = "", []
	if search:
		cond = "AND (tcs.schedule_code LIKE %s OR tcs.name LIKE %s OR tcs.ship_name LIKE %s)"
		like = "%" + search + "%"
		vals = [like, like, like]

	rows = frappe.db.sql("""
		SELECT tcs.name, tcs.schedule_code, tcs.ship_name, tcs.ship_code,
		       tcs.sail_start, tcs.sail_end, tcs.status, tcs.currency,
		       tcs.trip_link,
		       (SELECT COUNT(*) FROM `tabTrip Group Date` g
		         WHERE g.cruise_schedule = tcs.name) AS tgd_count,
		       (SELECT COUNT(*) FROM `tabTrip Package Price` tpp
		         WHERE tpp.parent = tcs.name
		           AND tpp.parenttype = 'Trip Cruise Schedule') AS cabin_classes
		FROM `tabTrip Cruise Schedule` tcs
		WHERE 1=1 {cond}
		ORDER BY tcs.sail_start DESC
		LIMIT %s OFFSET %s
	""".format(cond=cond), tuple(vals + [limit, offset]), as_dict=True)

	cabin_map = {}
	if rows:
		names = [r.name for r in rows]
		for c in frappe.db.sql("""
			SELECT parent, pricing_for_class, cabin_allotment,
			       cabin_occupancy, cabin_available
			FROM `tabTrip Package Price`
			WHERE parent IN %s AND parenttype = 'Trip Cruise Schedule'
			ORDER BY parent, idx
		""", (tuple(names),), as_dict=True):
			cabin_map.setdefault(c.parent, []).append(c)
	for r in rows:
		r["cabins"] = cabin_map.get(r.name, [])

	total = frappe.db.count("Trip Cruise Schedule")
	return {"schedules": rows, "total": total, "limit": limit, "offset": offset}


@frappe.whitelist()
def get_extras(search: str = "", limit: int = 50, offset: int = 0) -> dict:
	"""Senarai Trip Addon + pakej jualan ter-embed."""
	_require_access()
	try:
		limit = min(max(int(limit or 50), 1), 200)
		offset = max(int(offset or 0), 0)
	except (TypeError, ValueError):
		limit, offset = 50, 0

	cond, vals = "", []
	if search:
		cond = "AND (a.addon_title LIKE %s OR a.name LIKE %s)"
		like = "%" + search + "%"
		vals = [like, like]

	rows = frappe.db.sql("""
		SELECT a.name, a.addon_title, a.addon_type, a.disable,
		       (SELECT COUNT(*) FROM `tabTrip Addon Package` ap
		         WHERE ap.addon = a.name AND ap.status = 'Active') AS active_pkgs
		FROM `tabTrip Addon` a
		WHERE 1=1 {cond}
		ORDER BY a.addon_type, a.addon_title
		LIMIT %s OFFSET %s
	""".format(cond=cond), tuple(vals + [limit, offset]), as_dict=True)

	pkg_map = {}
	if rows:
		names = [r.name for r in rows]
		for p in frappe.db.sql("""
			SELECT ap.name, ap.addon, ap.addon_package_name, ap.status,
			       ap.scope, ap.applicable_to, ap.max_qty_per_booking,
			       ap.max_total_qty, ap.current_qty_sold,
			       IFNULL(ap.is_cabin_upgrade, 0) AS is_cabin_upgrade,
			       (SELECT GROUP_CONCAT(
			           CONCAT(r.currency, ' ', FORMAT(r.unit_price, 2))
			           SEPARATOR ' · ')
			        FROM `tabTrip Addon Package Rate` r
			        WHERE r.parent = ap.name AND r.parenttype = 'Trip Addon Package'
			          AND IFNULL(r.enabled, 1) = 1) AS rates
			FROM `tabTrip Addon Package` ap
			WHERE ap.addon IN %s
			ORDER BY ap.addon, ap.addon_package_name
		""", (tuple(names),), as_dict=True):
			pkg_map.setdefault(p.addon, []).append(p)
	for r in rows:
		r["packages"] = pkg_map.get(r.name, [])

	total = frappe.db.count("Trip Addon")
	return {"addons": rows, "total": total, "limit": limit, "offset": offset}


# ══════════════════════════════════════════════
# ROUTED PAGE (deeper directories) — tambahan
# ══════════════════════════════════════════════

@frappe.whitelist()
def get_overview_counts() -> dict:
	"""Landing hub Trip Manager — kiraan ringkas 4 domain untuk kad
	navigasi (trips aktif, flight schedules + PNR yatim, cruise
	schedules, extras aktif)."""
	_require_access()
	return {
		"trips": frappe.db.count("Trip", {"status": ["!=", "Cancelled"]}),
		"trip_dates": frappe.db.count("Trip Group Date",
			{"status": ["!=", "Cancelled"]}),
		"flight_schedules": frappe.db.count("Flight Schedule"),
		"flights_total": frappe.db.count("Flight"),
		"flights_orphan": frappe.db.sql("""
			SELECT COUNT(*) FROM `tabFlight` f
			WHERE NOT EXISTS (
			    SELECT 1 FROM `tabFlight Schedule Flight` fsf
			    WHERE fsf.flight = f.name AND fsf.parenttype = 'Flight Schedule')
		""")[0][0],
		"cruise_schedules": frappe.db.count("Trip Cruise Schedule"),
		"extras": frappe.db.count("Trip Addon", {"disable": 0}),
		"extra_packages": frappe.db.count("Trip Addon Package",
			{"status": "Active"}),
	}


@frappe.whitelist()
def get_trip_workspace(trip_name: str) -> dict:
	"""ONE-STOP CENTER trip — semua maklumat untuk urus satu trip:

	  trip      — header (nama, jenis, status, route)
	  tgd       — senarai Trip Group Date + cruise/flight schedule
	              linkage + seats + pakej pada tarikh itu
	  packages  — senarai Trip Package + tarikh terpaut + pricing ringkas
	              (kategori count, from-price, currencies) + BOM rows
	"""
	_require_access()
	trip = frappe.db.get_value(
		"Trip", trip_name,
		["name", "trip_name", "is_a_cruise_trip", "status", "route",
		 "trip_organizer"],
		as_dict=True)
	if not trip:
		frappe.throw("Trip not found: {0}".format(trip_name))

	# ── TGD + linkage schedule + pakej per tarikh ─────────────────────
	tgds = frappe.db.sql("""
		SELECT g.name, g.trip_group_name, g.departure_date, g.return_date,
		       g.sailing_start, g.sailing_end, g.status, g.is_cruise_only,
		       g.cruise_schedule, g.cruise_schedule_title,
		       g.flight_schedule, g.flight_schedule_title,
		       g.max_participants,
		       (SELECT COALESCE(SUM(b.booked_pax), 0) FROM `tabBooking` b
		         WHERE b.trip_date = g.name AND b.status != 'Cancelled') AS booked_pax
		FROM `tabTrip Group Date` g
		WHERE g.trip = %s AND g.status != 'Cancelled'
		ORDER BY g.departure_date ASC
	""", trip_name, as_dict=True)

	pkgs_by_gd = {}
	if tgds:
		for p in frappe.db.sql("""
			SELECT sel.trip_group_date AS gd, tp.name, tp.package_title,
			       tp.package_type, tp.currency, tp.status, tp.featured,
			       tp.airport_form
			FROM `tabTrip Package Group Date Select` sel
			JOIN `tabTrip Package` tp ON tp.name = sel.parent
			WHERE sel.parenttype = 'Trip Package'
			  AND sel.trip_group_date IN %s
			ORDER BY tp.package_type, tp.package_title
		""", (tuple(t.name for t in tgds),), as_dict=True):
			pkgs_by_gd.setdefault(p.gd, []).append(p)

	for t in tgds:
		t["packages"] = pkgs_by_gd.get(t.name, [])
		t["seats_left"] = (
			None if not t.max_participants
			else max(0, t.max_participants - t.booked_pax))

	# ── Pakej trip + tarikh + pricing ringkas + BOM ────────────────────
	pkgs = frappe.db.sql("""
		SELECT tp.name, tp.package_title, tp.package_type, tp.currency,
		       tp.status, tp.featured, tp.airport_form, tp.price_review_required,
		       (SELECT GROUP_CONCAT(sel.trip_group_date)
		        FROM `tabTrip Package Group Date Select` sel
		        WHERE sel.parent = tp.name AND sel.parenttype = 'Trip Package') AS gd_list,
		       (SELECT COUNT(*) FROM `tabTrip Package Price` tpp
		         WHERE tpp.parent = tp.name AND tpp.parenttype = 'Trip Package') AS price_rows,
		       (SELECT GROUP_CONCAT(DISTINCT IFNULL(tpp.currency, ''))
		        FROM `tabTrip Package Price` tpp
		         WHERE tpp.parent = tp.name AND tpp.parenttype = 'Trip Package') AS currencies,
		       (SELECT MIN(tpp.price_adult) FROM `tabTrip Package Price` tpp
		         WHERE tpp.parent = tp.name AND tpp.parenttype = 'Trip Package') AS from_price,
		       (SELECT COUNT(*) FROM `tabTrip Package Component` c
		         WHERE c.parent = tp.name AND c.parenttype = 'Trip Package') AS bom_rows
		FROM `tabTrip Package` tp
		WHERE tp.trip_link = %s
		ORDER BY tp.status, tp.package_type, tp.package_title
	""", trip_name, as_dict=True)

	bom_map = {}
	if pkgs:
		for c in frappe.db.sql("""
			SELECT parent, component_type, inclusion_mode, qty, per_pax,
			       trip_addon_package, merchandise_item, misc_description
			FROM `tabTrip Package Component`
			WHERE parent IN %s AND parenttype = 'Trip Package'
			ORDER BY parent, idx
		""", (tuple(p.name for p in pkgs),), as_dict=True):
			bom_map.setdefault(c.parent, []).append(c)
	for p in pkgs:
		p["gd_list"] = (p.gd_list or "").split(",") if p.gd_list else []
		p["currencies"] = sorted({
			x for x in ((p.currencies or "").split(",") + [p.currency or ""]) if x})
		p["bom"] = bom_map.get(p.name, [])

	return {"trip": trip, "tgd": tgds, "packages": pkgs}


# ══════════════════════════════════════════════
# FULL MANAGEMENT — write APIs (modal editor page)
# Prinsip sama api/trip_manager.py lama: SEMUA tulis
# melalui frappe.get_doc + save() supaya validate()
# controller berjalan (automation kekal aktif).
# ══════════════════════════════════════════════

def _payload_dict(data):
	"""Terima payload sebagai str JSON ATAU dict (frappe.call dengan
	use_json_request_body auto-parse str → dict sebelum sampai)."""
	import json
	if isinstance(data, str):
		return json.loads(data or "{}")
	return data or {}


def _save_doc(payload):
	"""Helper: bina/kemas dokumen melalui get_doc.save() — bukan
	frappe.db.set_value. payload = {doctype, name (optional), values...}."""
	payload = payload or {}
	doctype = payload.get("doctype")
	if not doctype:
		frappe.throw("doctype is required")
	if payload.get("name"):
		doc = frappe.get_doc(doctype, payload["name"])
	else:
		doc = frappe.new_doc(doctype)
	for k, v in payload.items():
		if k in ("doctype", "name"):
			continue
		doc.set(k, v)
	doc.flags.ignore_permissions = True
	doc.save()
	frappe.db.commit()
	return doc


# ── Kandungan Trip (description/highlights/faqs/galeri) ──────────────

@frappe.whitelist()
def save_trip_content(trip_name: str, payload: str = "{}") -> dict:
	"""Simpan kandungan Trip: description, video_url, highlights,
	features (included flag), faqs, facilities — child tables
	full-replace melalui get_doc.save() (validate on_update trip
	propagation kekal berjalan)."""
	_require_access()
	data = _payload_dict(payload)
	if not frappe.db.exists("Trip", trip_name):
		frappe.throw("Trip not found: {0}".format(trip_name))

	doc = frappe.get_doc("Trip", trip_name)

	if "description" in data:
		doc.description = data.get("description") or ""
	if "video_url" in data:
		doc.video_url = data.get("video_url") or ""

	# Child tables — full-replace dengan bentuk list-of-dict bersih.
	for field, fields in (
		("highlights", ("highlight",)),
		("features", ("feature", "included")),
		("faqs", ("question", "answer")),
		("facilities", ("facility", "icon")),
	):
		if field in data:
			rows = []
			for r in (data.get(field) or []):
				row = {f: r.get(f) for f in fields if f in r}
				if any(v for v in row.values() if v not in (None, "")):
					rows.append(row)
			doc.set(field, rows)

	doc.flags.ignore_permissions = True
	doc.save()
	frappe.db.commit()
	return {"ok": True, "name": trip_name}


@frappe.whitelist()
def upload_trip_image(trip_name: str, filedata: str, filename: str = "") -> dict:
	"""Attach gambar pada Trip (galeri) — File doc attached_to Trip,
	is_private=0 (galeri page detail baca fail public sahaja)."""
	_require_access()
	import base64
	import re
	if not frappe.db.exists("Trip", trip_name):
		frappe.throw("Trip not found: {0}".format(trip_name))

	# filedata: "data:image/png;base64,...."
	m = re.match(r"^data:[^;]+;base64,(.*)$", filedata or "", re.S)
	if not m:
		frappe.throw("filedata mesti data-URI base64")
	content = base64.b64decode(m.group(1))
	if len(content) > 8 * 1024 * 1024:
		frappe.throw("Image too large (max 8MB)")
	fname = filename or ("trip-" + frappe.generate_hash()[:8] + ".png")

	f = frappe.get_doc({
		"doctype":             "File",
		"file_name":           fname,
		"attached_to_doctype": "Trip",
		"attached_to_name":    trip_name,
		"attached_to_field":   "",
		"is_private":          0,
		"content":             content,
	})
	f.flags.ignore_permissions = True
	f.insert()
	frappe.db.commit()
	return {"ok": True, "file_url": f.file_url, "name": f.name}


@frappe.whitelist()
def remove_trip_image(file_name: str) -> dict:
	"""Buang gambar galeri Trip (padam File doc)."""
	_require_access()
	f = frappe.db.get_value("File", file_name,
		["name", "attached_to_doctype", "attached_to_name"], as_dict=True)
	if not f or f.attached_to_doctype != "Trip":
		frappe.throw("Bukan gambar galeri Trip")
	frappe.delete_doc("File", file_name, ignore_permissions=True)
	frappe.db.commit()
	return {"ok": True}


@frappe.whitelist()
def get_trip_content(trip_name: str) -> dict:
	"""Baca kandungan Trip + galeri (File public) untuk editor."""
	_require_access()
	doc = frappe.db.get_value("Trip", trip_name,
		["name", "description", "video_url"], as_dict=True)
	if not doc:
		frappe.throw("Trip not found")
	gallery = frappe.get_all("File",
		filters={"attached_to_doctype": "Trip", "attached_to_name": trip_name,
		         "is_private": 0, "is_folder": 0},
		fields=["name", "file_url", "file_name"], order_by="creation")
	tables = {}
	for field, fields in (
		("highlights", ("highlight",)),
		("features", ("feature", "included")),
		("faqs", ("question", "answer")),
		("facilities", ("facility", "icon")),
	):
		tables[field] = [
			{f: r.get(f) for f in fields}
			for r in frappe.get_all("Trip Highlight" if field == "highlights"
				else "Trip Feature" if field == "features"
				else "Trip FAQ" if field == "faqs" else "Trip Facility",
				filters={"parent": trip_name, "parenttype": "Trip"},
				fields=list(fields), order_by="idx")
		]
	return {"trip": doc, "gallery": gallery, **tables}


# ── Automasi: import harga cruise → pakej ────────────────────────────

@frappe.whitelist()
def import_cruise_rates(trip_package: str, overwrite: int = 0) -> dict:
	"""Import cabin_rates cruise schedule → package_pricing pakej
	(server-side port of import_from_cruise_rate button Desk).
	Source: TGD pertama pakej → cruise_schedule → cabin_rates.
	overwrite=0: kekalkan baris pricing sedia ada yang kategori sama
	tak ditimpa? TIDAK — selari Desk: replace penuh (pricing lama
	dibuang). overwrite param disimpan untuk keselarasan masa depan."""
	_require_access()
	pkg = frappe.get_doc("Trip Package", trip_package)

	# TGD pertama pakej → cruise_schedule
	gd = frappe.db.sql("""
		SELECT tgd.cruise_schedule
		FROM `tabTrip Package Group Date Select` sel
		JOIN `tabTrip Group Date` tgd ON tgd.name = sel.trip_group_date
		WHERE sel.parent = %s AND sel.parenttype = 'Trip Package'
		ORDER BY tgd.departure_date ASC LIMIT 1
	""", trip_package)
	schedule = gd[0][0] if gd and gd[0] else None
	if not schedule:
		frappe.throw(
			"Tiada Trip Group Date ber-cruise_schedule pada pakej ini — "
			"pautkan tarikh dahulu.", title="Import Cruise Rates")

	rates = frappe.get_all("Trip Package Price",
		filters={"parent": schedule, "parenttype": "Trip Cruise Schedule"},
		fields=["pricing_for_class", "price_adult_single", "price_adult",
		        "price_upperberth", "price_children", "price_toddler",
		        "price_infant", "currency"],
		order_by="idx")
	if not rates:
		frappe.throw(
			"Cruise schedule {0} tiada cabin rates — isi kadar di "
			"schedule dahulu.".format(schedule), title="Import Cruise Rates")

	pkg.set("package_pricing", [{
		"pricing_for_class":   r.pricing_for_class,
		"currency":            r.currency or None,
		"price_adult_single":  r.price_adult_single,
		"price_adult":         r.price_adult,
		"price_upperberth":    r.price_upperberth,
		"price_children":      r.price_children,
		"price_toddler":       r.price_toddler,
		"price_infant":        r.price_infant,
	} for r in rates])
	pkg.flags.ignore_permissions = True
	pkg.save()
	frappe.db.commit()
	return {"ok": True, "imported": len(rates), "schedule": schedule}


# ── BOM components pakej ─────────────────────────────────────────────

@frappe.whitelist()
def save_package_components(trip_package: str, components: str = "[]") -> dict:
	"""Simpan child BOM (Trip Package Component) — full-replace."""
	_require_access()
	rows = _payload_dict(components) if isinstance(_payload_dict(components), list) else []
	pkg = frappe.get_doc("Trip Package", trip_package)
	clean = []
	for r in rows:
		row = {
			"component_type": r.get("component_type"),
			"inclusion_mode": r.get("inclusion_mode") or "Included",
			"qty":            int(r.get("qty") or 1),
			"per_pax":        1 if r.get("per_pax") else 0,
		}
		for f in ("trip_addon_package", "merchandise_item",
		          "misc_description", "misc_amount", "item_code_override", "notes"):
			if r.get(f) not in (None, ""):
				row[f] = r.get(f)
		if row.get("component_type"):
			clean.append(row)
	pkg.set("components", clean)
	pkg.flags.ignore_permissions = True
	pkg.save()
	frappe.db.commit()
	return {"ok": True, "count": len(clean)}


# ── Flight Schedule CRUD ─────────────────────────────────────────────

@frappe.whitelist()
def save_flight_schedule(payload: str = "{}") -> dict:
	"""Cipta/kemas Flight Schedule + rows PNR (full-replace flights)."""
	_require_access()
	data = _payload_dict(payload)
	name = data.get("name")
	doc = frappe.get_doc("Flight Schedule", name) if name else frappe.new_doc("Flight Schedule")
	if "schedule_code" in data:
		doc.schedule_code = data.get("schedule_code")
	if "status" in data:
		doc.status = data.get("status")
	if "notes" in data:
		doc.notes = data.get("notes") or ""
	if "flights" in data:
		doc.set("flights", [{
			"flight": r.get("flight"),
			"role":   r.get("role") or "Outbound",
			"note":   r.get("note") or "",
		} for r in (data.get("flights") or []) if r.get("flight")])
	doc.flags.ignore_permissions = True
	doc.save()
	frappe.db.commit()
	return {"ok": True, "name": doc.name}


# ── Extras (Trip Addon / Trip Addon Package) CRUD ────────────────────

@frappe.whitelist()
def save_addon(payload: str = "{}") -> dict:
	"""Cipta/kemas Trip Addon (definasi extras)."""
	_require_access()
	data = _payload_dict(payload)
	data["doctype"] = "Trip Addon"
	doc = _save_doc(data)
	return {"ok": True, "name": doc.name}


@frappe.whitelist()
def save_addon_package(payload: str = "{}") -> dict:
	"""Cipta/kemas Trip Addon Package — termasuk rates per-currency
	(full-replace currency_rates)."""
	_require_access()
	data = _payload_dict(payload)
	name = data.pop("name", None)
	doc = frappe.get_doc("Trip Addon Package", name) if name else frappe.new_doc("Trip Addon Package")
	for k in ("addon", "addon_title", "addon_package_name", "status",
	          "scope", "applicable_to", "validity_mode", "valid_from_offset_days",
	          "valid_to_offset_days", "fixed_valid_from", "fixed_valid_to",
	          "max_qty_per_booking", "max_total_qty",
	          "sales_cutoff_enabled", "sales_cutoff_days_before_departure"):
		if k in data:
			doc.set(k, data.get(k))
	if "rates" in data:
		doc.set("currency_rates", [{
			"currency":   r.get("currency"),
			"unit_price": float(r.get("unit_price") or 0),
			"enabled":    1 if r.get("enabled", 1) else 0,
		} for r in (data.get("rates") or []) if r.get("currency")])
	doc.flags.ignore_permissions = True
	doc.save()
	frappe.db.commit()
	return {"ok": True, "name": doc.name}


# ── Cruise schedule helper ───────────────────────────────────────────

@frappe.whitelist()
def sync_cabin_availability(schedule: str) -> dict:
	"""Butang "Sync Availability" — kira semula occupancy/available
	semua kelas kabin schedule (fungsi controller sedia ada)."""
	_require_access()
	from travel_booking.module_travel_booking.doctype.trip_cruise_schedule.trip_cruise_schedule import (
		refresh_cabin_availability,
	)
	out = refresh_cabin_availability(schedule)
	frappe.db.commit()
	return {"ok": True, "classes": out}


# ── Website content (Travel Website) ─────────────────────────────────

# Scalar fields yang boleh diedit melalui seksyen website (whitelist).
_WEBSITE_SCALARS = {
	"common": [
		"footer_tagline", "support_email", "copyright_text",
		"social_facebook", "social_instagram", "social_whatsapp",
		"chat_widget_enabled", "chat_widget_title", "chat_widget_subtitle",
		"chat_widget_success_message", "date_display_format",
		"ga_enabled", "ga_measurement_id",
	],
	"cruise": [
		"cruise_nav_cta_label", "cruise_nav_cta_url",
		"cruise_hero_tag", "cruise_hero_title", "cruise_hero_intro",
		"cruise_hero_background", "cruise_hero_search_label",
		"cruise_featured_tag", "cruise_featured_title", "cruise_featured_subtitle",
		"cruise_featured_cta_label", "cruise_featured_cta_url",
		"cruise_whyus_tag", "cruise_whyus_title", "cruise_whyus_subtitle",
		"cruise_dest_tag", "cruise_dest_title", "cruise_dest_subtitle",
		"cruise_testi_tag", "cruise_testi_title", "cruise_testi_subtitle",
		"cruise_cta_icon", "cruise_cta_tag", "cruise_cta_title", "cruise_cta_body",
		"cruise_cta_primary_label", "cruise_cta_primary_url",
		"cruise_cta_secondary_label", "cruise_cta_secondary_url",
		"cruise_ga_enabled", "cruise_ga_measurement_id",
		"cruise_booking_terms",
	],
	"tour": [
		"tour_nav_cta_label", "tour_nav_cta_url",
		"tour_hero_tag", "tour_hero_title", "tour_hero_intro",
		"tour_hero_background", "tour_hero_search_label",
		"tour_featured_tag", "tour_featured_title", "tour_featured_subtitle",
		"tour_featured_cta_label", "tour_featured_cta_url",
		"tour_whyus_tag", "tour_whyus_title", "tour_whyus_subtitle",
		"tour_dest_tag", "tour_dest_title", "tour_dest_subtitle",
		"tour_testi_tag", "tour_testi_title", "tour_testi_subtitle",
		"tour_cta_icon", "tour_cta_tag", "tour_cta_title", "tour_cta_body",
		"tour_cta_primary_label", "tour_cta_primary_url",
		"tour_cta_secondary_label", "tour_cta_secondary_url",
		"tour_booking_terms",
	],
}

# Child tables: {section: [(fieldname, child_doctype, fields...)]}
_WEBSITE_TABLES = {
	"common": [
		("footer_links", "Website Footer Link", ("column_title", "label", "url", "is_active", "sort_order")),
		("cruise_menu", "Website Menu Item", ("label", "url", "active_nav_key", "open_in_new_tab", "is_active", "sort_order")),
		("tour_menu", "Website Menu Item", ("label", "url", "active_nav_key", "open_in_new_tab", "is_active", "sort_order")),
	],
	"cruise": [
		("cruise_hero_stats", "Website Stat", ("stat_value", "stat_label", "sort_order")),
		("cruise_benefits", "Website Benefit Card", ("icon", "title", "description", "is_active", "sort_order")),
		("cruise_testimonials", "Website Testimonial", ("rating", "quote", "author", "context_label", "sort_order")),
	],
	"tour": [
		("tour_hero_stats", "Website Stat", ("stat_value", "stat_label", "sort_order")),
		("tour_benefits", "Website Benefit Card", ("icon", "title", "description", "is_active", "sort_order")),
		("tour_testimonials", "Website Testimonial", ("rating", "quote", "author", "context_label", "sort_order")),
	],
}


@frappe.whitelist()
def save_website_section(section: str, payload: str = "{}") -> dict:
	"""Simpan seksyen kandungan Travel Website (scalar + child tables).
	on_update controller auto-clear cache (travel_website_config +
	tcc_website_settings) supaya laman public terus nampak perubahan."""
	_require_access()
	data = _payload_dict(payload)
	if section not in _WEBSITE_SCALARS:
		frappe.throw("Unknown website section: {0}".format(section))

	doc = frappe.get_doc("Travel Website", "Travel Website")

	allowed = set(_WEBSITE_SCALARS[section])
	for k, v in data.items():
		if k in allowed:
			doc.set(k, v)

	tables = _WEBSITE_TABLES.get(section, [])
	for field, _child, fields in tables:
		if field in data:
			rows = []
			for r in (data.get(field) or []):
				row = {f: r.get(f) for f in fields if f in r}
				if any(v for v in row.values() if v not in (None, "")):
					rows.append(row)
			doc.set(field, rows)

	doc.flags.ignore_permissions = True
	doc.save()
	# on_update Travel Website clear kedua-dua cache — pastikan juga
	# cache tcc website settings (cached 600s di trip_command_center).
	frappe.cache.delete_value("travel_website_config")
	frappe.cache.delete_value("tcc_website_settings")
	frappe.db.commit()
	return {"ok": True, "section": section}
