# travel_booking/api/package_admin.py
# API pengurusan Package Offer / Travel Date (Travel Manager) — STAF SAHAJA.
# [Nov 2026 — PURGE] endpoint legacy Travel Package dibuang sepenuhnya.
# Ciptaan offer guna offer_factory (satu laluan dengan patch migrasi).

import json
import math

import frappe
from frappe import _
from frappe.utils import cint, flt

from travel_booking.api.trip_command_center import (
	TRIP_COMMAND_CENTER_ROLES,
	_check_command_center_roles,
)


def _require_product_admin():
	_check_command_center_roles(TRIP_COMMAND_CENTER_ROLES, "Package Management")


@frappe.whitelist()
def generate_offer_from_template(package: str, travel_date: str = None) -> dict:
	"""Cipta Package Offer baharu daripada templat pakej (harga disalin,
	inventori kosong — staf isi allotment). Offer tercipta status Draft;
	Active perlu kelulusan Tour Manager (workflow).

	Hierarki ERD: offer WAJIB anak kepada satu Travel Date — tarikh/
	sailing/ship/schedule diambil daripadanya (satu sumber kebenaran).
	Mod `departure_date` terus dibuang (Stage 2, Nov 2026) — ia menjanakan
	offer stray tanpa induk; guna add_offer_to_date
	untuk pendaftaran offer pada tarikh.

	Note: kerana nama offer berjujukan, JANGAN dedahkan nama ini ke URL awam
	— guna public_slug (pelajaran audit F9).
	"""
	_require_product_admin()
	from travel_booking.utils.offer_factory import create_offer

	if not travel_date:
		frappe.throw(_(
			"Travel Date is required — offer mesti anak kepada satu tarikh "
			"(hierarki Trip >> Travel Date >> Package Offer)."))
	if not frappe.db.exists("Travel Date", travel_date):
		frappe.throw(_("Travel Date {0} not found.").format(travel_date))

	offer_name = create_offer(package, {"travel_date": travel_date})
	return {"status": "ok", "offer": offer_name}


@frappe.whitelist()
def delete_trip_archive(trip: str) -> dict:
	"""Padam TRIP + seluruh rantaian produknya (Nov 2026 — hierarki
	Trip >> Travel Date >> Package Offer; Travel Package deprecated):

	  1. Package Offer anak setiap Travel Date (harga/komponen/inventori
	     shadow ikut terpadam sebagai child) — TOLAK bila ada booking
	     aktif memegang offer (link integrity + jualan).
	  2. Travel Date anak trip.
	  3. Flight Arrangement template trip.
	  4. Trip.default_components + itinerary (child Trip).
	  5. Trip itu sendiri.

	Guard keras SEBELUM sebarang padam:
	  - Booking aktif merujuk trip (legacy TGD atau package_offer).
	  - Offer mempunyai jualan (Booking aktif/live-count > 0).
	Semua dalam SATU transaksi — kegagalan mana-mana = rollback penuh.
	Hanya Tour Manager / System Manager."""
	_require_product_admin()
	if not (_MANAGER_ONLY & set(frappe.get_roles())):
		frappe.throw(_("Only Tour Manager / System Manager can delete a trip."),
					frappe.PermissionError)
	if not frappe.db.exists("Trip", trip):
		frappe.throw(_("Trip {0} not found.").format(trip), frappe.DoesNotExistError)

	# ── Guard 1: booking aktif (semua saluran rujukan) ──
	# [Nov 2026 — PURGE Travel Package] cabuan guard legacy
	# b.travel_package dibuang — booking kini rujuk trip_date (legacy
	# TGD) / package_offer sahaja.
	booked = frappe.db.sql("""
		SELECT DISTINCT b.name FROM `tabBooking` b
		WHERE b.status NOT IN ('Cancelled', 'Abandoned')
		  AND (
		    b.trip_date IN (SELECT name FROM `tabTrip Group Date` WHERE trip = %(trip)s)
		    OR b.package_offer IN (
		        SELECT o.name FROM `tabPackage Offer` o
		        JOIN `tabTravel Date` td ON td.name = o.travel_date
		        WHERE td.trip = %(trip)s)
		  )
		LIMIT 1
	""", {"trip": trip})
	if booked:
		frappe.throw(_(
			"Trip {0} cannot be deleted: booking {1} is still active. "
			"Cancel the bookings first.").format(trip, booked[0][0]))

	# ── Guard 2: offer dengan jualan ──
	# [Nov 2026] jualan dikira live daripada Booking (bukan kaunter offer).
	sold = frappe.db.sql("""
		SELECT o.name FROM `tabPackage Offer` o
		JOIN `tabTravel Date` td ON td.name = o.travel_date
		WHERE td.trip = %(trip)s
		  AND EXISTS (SELECT 1 FROM `tabBooking` b
		              WHERE b.package_offer = o.name
		                AND b.status NOT IN ('Cancelled', 'Abandoned'))
		LIMIT 1
	""", {"trip": trip})
	if sold:
		frappe.throw(_(
			"Trip {0} cannot be deleted: offer {1} has sold pax. "
			"Resolve the sales first.").format(trip, sold[0][0]))

	# ── Kira apa yang akan dipadam (untuk mesej + log) ──
	td_names = frappe.get_all("Travel Date", filters={"trip": trip}, pluck="name")
	offer_names = []
	if td_names:
		offer_names = frappe.get_all("Package Offer",
			filters={"travel_date": ["in", td_names]}, pluck="name")
	fa_names = frappe.get_all("Flight Arrangement",
		filters={"trip": trip}, pluck="name")

	deleted = {"travel_dates": 0, "offers": 0, "flight_arrangements": 0}
	try:
		for name in offer_names:
			frappe.delete_doc("Package Offer", name,
							  ignore_permissions=True, force=True)
			deleted["offers"] += 1
		for name in td_names:
			frappe.delete_doc("Travel Date", name,
							  ignore_permissions=True, force=True)
			deleted["travel_dates"] += 1
		for name in fa_names:
			frappe.delete_doc("Flight Arrangement", name,
							  ignore_permissions=True, force=True)
			deleted["flight_arrangements"] += 1
		frappe.delete_doc("Trip", trip, ignore_permissions=True, force=True)
		frappe.db.commit()
	except Exception:
		frappe.db.rollback()
		raise

	frappe.logger("travel_booking").info({
		"action": "delete_trip_archive", "trip": trip, **deleted})
	return {"status": "ok", "trip": trip, "deleted": deleted}


def _date_delete_block_reason(date: str) -> str | None:
	"""Sebab Travel Date TIDAK boleh dipadam (None = selamat dipadam) —
	guard kongsi delete_travel_date (throw) & bulk_delete_dates (skip +
	sebab): rekod wujud, tiada booking aktif pada offer anaknya & jualan
	live 0."""
	if not frappe.db.exists("Travel Date", date):
		return _("Travel Date not found.")
	booked = frappe.db.sql("""
		SELECT name FROM `tabBooking`
		WHERE status NOT IN ('Cancelled', 'Abandoned')
		  AND package_offer IN (
		      SELECT name FROM `tabPackage Offer` WHERE travel_date = %(td)s)
		LIMIT 1
	""", {"td": date})
	if booked:
		return _("Travel date cannot be deleted: booking {0} is still "
			"active on its offers.").format(booked[0][0])
	sold = frappe.db.sql("""
		SELECT o.name FROM `tabPackage Offer` o
		WHERE o.travel_date = %(td)s
		  AND EXISTS (SELECT 1 FROM `tabBooking` b
		              WHERE b.package_offer = o.name
		                AND b.status NOT IN ('Cancelled', 'Abandoned'))
		LIMIT 1
	""", {"td": date})
	if sold:
		return _("Travel date cannot be deleted: offer {0} has sold pax.").format(
			sold[0][0])
	return None


@frappe.whitelist()
def delete_travel_date(travel_date: str) -> dict:
	"""Padam SATU Travel Date (group date) + offer anaknya (Nov 2026):
	  1. Package Offer anak tarikh — TOLAK bila booking aktif / pax terjual.
	  2. Travel Date itu sendiri.
	Trip + tarikh lain + Flight Arrangement tidak tersentuh. Satu transaksi;
	Tour Manager / System Manager sahaja."""
	_require_product_admin()
	if not (_MANAGER_ONLY & set(frappe.get_roles())):
		frappe.throw(_("Only Tour Manager / System Manager can delete a travel date."),
					frappe.PermissionError)
	if not frappe.db.exists("Travel Date", travel_date):
		frappe.throw(_("Travel Date not found."), frappe.DoesNotExistError)

	# Guard: booking aktif / pax terjual pada offer tarikh ini.
	reason = _date_delete_block_reason(travel_date)
	if reason:
		frappe.throw(reason)

	offers = frappe.get_all("Package Offer",
		filters={"travel_date": travel_date}, pluck="name")
	deleted = {"offers": 0}
	try:
		for name in offers:
			frappe.delete_doc("Package Offer", name,
							  ignore_permissions=True, force=True)
			deleted["offers"] += 1
		frappe.delete_doc("Travel Date", travel_date,
						  ignore_permissions=True, force=True)
		frappe.db.commit()
	except Exception:
		frappe.db.rollback()
		raise
	frappe.logger("travel_booking").info({
		"action": "delete_travel_date", "travel_date": travel_date, **deleted})
	return {"status": "ok", "travel_date": travel_date, "deleted": deleted}


def _require_offer_delete_manager():
	"""Padam offer = keputusan pengurusan — Tour Manager / System Manager
	sahaja (corak sama dgn delete endpoints package_admin)."""
	if not (_MANAGER_ONLY & set(frappe.get_roles())):
		frappe.throw(_("Only Tour Manager / System Manager can delete an offer."),
					frappe.PermissionError)


def _offer_delete_block_reason(offer: str) -> str | None:
	"""Sebab offer TIDAK boleh dipadam (None = selamat dipadam) — guard
	kongsi delete_package_offer (throw) & bulk_delete_offers (skip + sebab):
	rekod wujud, tiada booking aktif memegangnya & jualan live ialah 0."""
	if not frappe.db.exists("Package Offer", offer):
		return _("Offer not found.")
	booked = frappe.db.sql("""
		SELECT name FROM `tabBooking`
		WHERE status NOT IN ('Cancelled', 'Abandoned')
		  AND package_offer = %(offer)s LIMIT 1
	""", {"offer": offer})
	if booked:
		return _("Offer cannot be deleted: booking {0} is still active.").format(
			booked[0][0])
	# [Nov 2026] jualan live daripada Booking (bukan kaunter offer).
	pax = frappe.db.sql("""
		SELECT COALESCE(SUM(booked_pax), 0) FROM `tabBooking`
		WHERE package_offer = %s
		  AND status NOT IN ('Cancelled', 'Abandoned')
	""", offer)[0][0]
	if int(pax or 0) > 0:
		return _("Offer cannot be deleted: {0} pax already sold.").format(pax)
	return None


@frappe.whitelist()
def delete_package_offer(offer: str) -> dict:
	"""Padam SATU Package Offer (pakej pada satu tarikh) — Nov 2026.
	Guard: booking aktif memegang offer / jualan live > 0. Travel Date +
	sibling offers tidak tersentuh. Satu transaksi; Tour Manager /
	System Manager sahaja."""
	_require_product_admin()
	_require_offer_delete_manager()
	reason = _offer_delete_block_reason(offer)
	if reason:
		frappe.throw(reason)

	try:
		frappe.delete_doc("Package Offer", offer,
						  ignore_permissions=True, force=True)
		frappe.db.commit()
	except Exception:
		frappe.db.rollback()
		raise
	frappe.logger("travel_booking").info({
		"action": "delete_package_offer", "offer": offer})
	return {"status": "ok", "offer": offer}


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


def _sold_pax_map(offer_names) -> dict:
	"""[Nov 2026] Jualan live per offer — SUM(booked_pax) Booking tidak
	dibatalkan/ditinggalkan. Corak "kiraan semula dari rekod sebenar"
	(sama doktrin dengan refresh_cabin_availability)."""
	if not offer_names:
		return {}
	return {
		r.package_offer: int(r.pax or 0)
		for r in frappe.db.sql("""
			SELECT package_offer, SUM(booked_pax) AS pax
			FROM `tabBooking`
			WHERE package_offer IN %(n)s
			  AND status NOT IN ('Cancelled', 'Abandoned')
			GROUP BY package_offer
		""", {"n": list(offer_names)}, as_dict=True)
	}


@frappe.whitelist()
def get_offers_list(package: str = None, upcoming: int = 1, limit: int = 100,
					trip: str = None, travel_date: str = None) -> dict:
	"""Senarai offer — semua/satu pakej/ikut trip/ikut travel date; dengan
	% occupy. `trip` = offer anak tarikh-trip tersebut (hierarki Trip >> Travel Date);
	`travel_date` = offer anak satu tarikh (hierarki ERD)."""
	_require_product_admin()
	limit = max(1, min(cint(limit) or 100, 500))
	filters = {}
	if package:
		filters["package"] = package
	if travel_date:
		filters["travel_date"] = travel_date
	if trip:
		# [Nov 2026 — PURGE Travel Package] penapis trip melalui Travel
		# Date (hierarki Trip >> Travel Date >> Package Offer) — tiada
		# lagi resolusi pakej legacy.
		tds = frappe.get_all("Travel Date", filters={"trip": trip}, pluck="name")
		filters["travel_date"] = ["in", tds] if tds else ["", ""]
	if cint(upcoming):
		filters["departure_date"] = [">=", frappe.utils.today()]
	offers = frappe.get_all(
		"Package Offer", filters=filters,
		fields=["name", "package", "travel_date", "offer_name", "departure_date", "return_date",
				"status_editorial", "status_operational"],
		order_by="departure_date asc", limit=limit,
	)
	# [Nov 2026] jualan live daripada Booking (kaunter max/current_pax
	# ditanggalkan daripada Package Offer).
	sold_map = _sold_pax_map([o.name for o in offers])
	out = []
	for o in offers:
		o["package_name"] = (o.offer_name or o.package or "")
		o["sold_pax"] = sold_map.get(o.name, 0)
		out.append(o)
	return {"offers": out}


@frappe.whitelist()
def get_offers_directory(limit: int = 1000) -> dict:
	"""Direktori SEMUA Package Offer aras-trip — halaman Package Offers
	(Travel Manager, Nov 2026): offer DIKUMPUL ikut trip (klien kumpulkan;
	Trip dipaparkan sbg header kumpulan, bukan kolum) — Travel Date |
	Offer | Currency | Status editorial (+ jualan live) utk pantau & urus
	beramai-ramai.

	Nama trip, flag cruise & tarikh berkuatkuasa disertai melalui JOIN
	Travel Date/Trip (tarikh berkuatkuasa = COALESCE(td, offer) — doktrin
	sama dgn auto-job status & katalog awam). Cap 1000 — klien diberi
	`total` utk amaran pemotongan; carian/penapis/pagination/kumpulan
	diurus client-side (corak tmDataTable)."""
	_require_product_admin()
	limit = max(1, min(cint(limit) or 1000, 1000))
	offers = frappe.db.sql("""
		SELECT o.name, o.trip, o.travel_date, o.offer_name, o.currency,
			   o.status_editorial, o.sale_mode, t.is_a_cruise_trip,
			   COALESCE(td.departure_date, o.departure_date) AS departure_date,
			   COALESCE(td.return_date, o.return_date) AS return_date,
			   t.trip_name
		FROM `tabPackage Offer` o
		LEFT JOIN `tabTravel Date` td ON td.name = o.travel_date
		LEFT JOIN `tabTrip` t ON t.name = o.trip
		ORDER BY departure_date ASC, o.name ASC
		LIMIT %(limit)s
	""", {"limit": limit}, as_dict=True)
	sold_map = _sold_pax_map([o.name for o in offers])
	for o in offers:
		o["sold_pax"] = sold_map.get(o.name, 0)
		o["trip_label"] = o.trip_name or o.trip or ""
	total = frappe.db.sql("SELECT COUNT(*) FROM `tabPackage Offer`")[0][0]
	return {"offers": offers, "total": cint(total)}


# ══════════════════════════════════════════════
# TRAVEL DATE (hierarki ERD: Trip >> Travel Date >> Packages)
# ══════════════════════════════════════════════

@frappe.whitelist()
def get_travel_dates_list(trip: str, limit: int = 200) -> dict:
	"""Senarai Travel Date satu trip + metrik: bilangan pakej (offer anak)
	dan jumlah pax. Untuk kad TRAVEL DATES di trip directory."""
	_require_product_admin()
	if not trip or not frappe.db.exists("Trip", trip):
		frappe.throw(_("Trip is required."))
	limit = max(1, min(cint(limit) or 200, 500))
	dates = frappe.get_all(
		"Travel Date", filters={"trip": trip},
		fields=["name", "travel_date_name", "departure_date", "return_date",
				"status_editorial", "cruise_schedule", "ship_name", "ship_code",
				"sailing_start", "sailing_end", "embarkation_port",
				"disembarkation_port", "days_before_closure", "trip_category",
				"total_days", "total_nights", "destination"],
		order_by="departure_date asc", limit=limit,
	)
	# Agregat offer anak sekali panggil (bukan per-tarikh).
	agg = {}
	for r in frappe.db.sql("""
		SELECT o.travel_date, COUNT(*) AS offers,
		       SUM(status_editorial = 'Active') AS active_offers
		FROM `tabPackage Offer` o
		WHERE o.travel_date IN %(dates)s
		GROUP BY o.travel_date
	""", {"dates": [d.name for d in dates] or ["__none__"]}, as_dict=True):
		agg[r.travel_date] = r
	# [Nov 2026] pax live daripada Booking (bukan kaunter offer).
	for r in frappe.db.sql("""
		SELECT o.travel_date, SUM(b.booked_pax) AS pax
		FROM `tabBooking` b
		JOIN `tabPackage Offer` o ON o.name = b.package_offer
		WHERE o.travel_date IN %(dates)s
		  AND b.status NOT IN ('Cancelled', 'Abandoned')
		GROUP BY o.travel_date
	""", {"dates": [d.name for d in dates] or ["__none__"]}, as_dict=True):
		if r.travel_date in agg:
			agg[r.travel_date].pax = r.pax
	schedule_labels = {}
	sched_names = {d.cruise_schedule for d in dates if d.cruise_schedule}
	if sched_names:
		for s in frappe.get_all("Trip Cruise Schedule",
				filters={"name": ["in", list(sched_names)]},
				fields=["name", "schedule_code", "ship_name", "ship_code",
						"sail_start", "sail_end", "status"]):
			schedule_labels[s.name] = s
	out = []
	for d in dates:
		a = agg.get(d.name)
		s = schedule_labels.get(d.cruise_schedule)
		out.append({
			"name": d.name,
			"departure_date": d.departure_date,
			"return_date": d.return_date,
			"status": d.status_editorial,
			# days_before_closure — pra-isi medan Closure borang Edit
			# Travel Date (dipaparkan semula Nov 2026).
			"days_before_closure": d.days_before_closure,
			# [Nov 2026] trip_category — pra-isi dropdown borang Edit Date
			# (dahulu tiada dalam baris → dropdown reset & save memadam
			# kategori tersimpan).
			"trip_category": d.trip_category or "",
			# [Nov 2026] durasi + destinasi — pra-isi dialog Edit Date.
			"total_days": d.total_days or 0,
			"total_nights": d.total_nights or 0,
			"destination": d.destination or "",
			"cruise_schedule": d.cruise_schedule or "",
			"ship_name": s.ship_name if s else (d.ship_name or ""),
			"ship_code": s.ship_code if s else (d.ship_code or ""),
			# [Nov 2026] Kolum Cruise Schedule datatable trip directory —
			# papar schedule_code (lingkungan sailing + kod kapal; ganti
			# ship_code — arahan pemilik).
			"schedule_code": (s.schedule_code if s else "") or "",
			"sailing_window": (
				"{} → {}".format(s.sail_start, s.sail_end) if s else
				("{} → {}".format(d.sailing_start, d.sailing_end)
				 if d.sailing_start else "")),
			"schedule_status": s.status if s else "",
			"packages_count": int(a.offers) if a else 0,
			"active_packages": int(a.active_offers or 0) if a else 0,
			"sold_pax": int(a.pax or 0) if a else 0,
		})
	return {"dates": out}


@frappe.whitelist()
def get_dates_directory(limit: int = 1000) -> dict:
	"""Direktori SEMUA Travel Date aras-trip — halaman Travel Dates
	(Travel Manager, Nov 2026): date group DIKUMPUL ikut trip (klien
	kumpulkan; Trip dipaparkan sbg header kumpulan COLLAPSIBLE, bukan
	kolum) — Departure | Return | Trip Category | Status (+ jumlah offer
	& pax terjual) utk pantau & urus beramai-ramai.

	Nama trip & flag cruise disertai melalui JOIN Trip; jumlah offer/active
	dan pax live diagregat SEKALI panggilan (bukan per-tarikh; corak
	get_travel_dates_list). Cap 1000 — klien diberi `total` utk amaran
	pemotongan; carian/penapis/pagination/kumpulan diurus client-side
	(corak tmDataTable)."""
	_require_product_admin()
	limit = max(1, min(cint(limit) or 1000, 1000))
	dates = frappe.db.sql("""
		SELECT td.name, td.trip, td.travel_date_name, td.departure_date,
			   td.return_date, td.trip_category, td.status_editorial AS status,
			   t.trip_name, t.is_a_cruise_trip
		FROM `tabTravel Date` td
		LEFT JOIN `tabTrip` t ON t.name = td.trip
		ORDER BY td.departure_date ASC, td.name ASC
		LIMIT %(limit)s
	""", {"limit": limit}, as_dict=True)
	# Agregat offer anak + pax live sekali panggilan (mirror
	# get_travel_dates_list — jualan daripada Booking, bukan kaunter).
	agg = {}
	td_names = [d.name for d in dates] or ["__none__"]
	for r in frappe.db.sql("""
		SELECT o.travel_date, COUNT(*) AS offers,
		       SUM(o.status_editorial = 'Active') AS active_offers
		FROM `tabPackage Offer` o
		WHERE o.travel_date IN %(dates)s
		GROUP BY o.travel_date
	""", {"dates": td_names}, as_dict=True):
		agg[r.travel_date] = r
	for r in frappe.db.sql("""
		SELECT o.travel_date, SUM(b.booked_pax) AS pax
		FROM `tabBooking` b
		JOIN `tabPackage Offer` o ON o.name = b.package_offer
		WHERE o.travel_date IN %(dates)s
		  AND b.status NOT IN ('Cancelled', 'Abandoned')
		GROUP BY o.travel_date
	""", {"dates": td_names}, as_dict=True):
		if r.travel_date in agg:
			agg[r.travel_date].pax = r.pax
	for d in dates:
		a = agg.get(d.name)
		d["packages_count"] = int(a.offers) if a else 0
		d["active_packages"] = int(a.active_offers or 0) if a else 0
		d["sold_pax"] = int(a.pax or 0) if a else 0
		d["trip_label"] = d.trip_name or d.trip or ""
	total = frappe.db.sql("SELECT COUNT(*) FROM `tabTravel Date`")[0][0]
	return {"dates": dates, "total": cint(total)}


@frappe.whitelist()
def get_date_display_format() -> str:
	"""Format paparan tarikh daripada Travel Website.date_display_format
	(single doctype) — rujukan parse/papar tarikh dialog Travel Date.
	BUKAN System Settings.date_format (arahan pemilik; default laman
	'dd MMM yyyy')."""
	_require_product_admin()
	fmt = None
	if frappe.db.exists("DocType", "Travel Website"):
		fmt = frappe.db.get_single_value("Travel Website", "date_display_format")
	return fmt or "dd MMM yyyy"


@frappe.whitelist()
def save_travel_date(values: str) -> dict:
	"""Cipta/kemaskini Travel Date. `values` JSON: name (edit), trip,
	cruise_schedule, departure_date, return_date, days_before_closure,
	total_days, total_nights, destination, description, status_editorial.

	total_days/total_nights kosong/0 → auto kira oleh controller validate
	(daripada Departure/Return — formula TGD).

	Status Active/Cancelled manager-gated (corak set_offer_status).
Controller Travel Date menyinkronkan maklumat sailing ke semua offer
anak (kolam kabin = cabin_rates schedule)."""
	_require_product_admin()
	import json as _json
	data = _json.loads(values or "{}")
	if not isinstance(data, dict):
		frappe.throw(_("Invalid values."))

	name = data.get("name")
	if name:
		if not frappe.db.exists("Travel Date", name):
			frappe.throw(_("Travel Date {0} not found.").format(name))
		doc = frappe.get_doc("Travel Date", name)
	else:
		for f in ("trip", "departure_date"):
			if not data.get(f):
				frappe.throw(_("{0} is required.").format(f))
		doc = frappe.get_doc({"doctype": "Travel Date"})

	for f in ("trip", "cruise_schedule", "departure_date", "return_date",
			  "days_before_closure", "total_days", "total_nights",
			  "destination", "description", "travel_date_name",
			  "trip_category"):
		if data.get(f) is not None:
			doc.set(f, data.get(f))
	if data.get("status_editorial"):
		_gate_status_change(data["status_editorial"])
		doc.status_editorial = data["status_editorial"]

	doc.save(ignore_permissions=True)
	return {"status": "ok", "name": doc.name, "action": "updated" if name else "created"}


@frappe.whitelist()
def list_trip_categories() -> list:
	"""Senarai master Trip Category — dropdown Trip Category (wizard New
	Trip & dialog Edit Date, Travel Manager). is_cruise_trip ([Nov 2026])
	= tanda dedikasi cruise — klien menapis dropdown ikut jenis trip.
	Master ringkas; penyelenggaraan penuh di Desk (/app/trip-category)."""
	_require_product_admin()
	return frappe.get_all("Trip Category",
		fields=["name", "category_name", "description", "is_cruise_trip"],
		order_by="category_name asc")


@frappe.whitelist()
def save_date_info(date: str, departure_date: str = None,
				   return_date: str = None, trip_category: str = None,
				   status_editorial: str = None) -> dict:
	"""Kemaskini SEGERA SATU Travel Date daripada direktori Travel Dates
	(halaman baris-demi-baris, corak save_offer_info): departure/return,
	trip category & status editorial. Nama trip TIDAK boleh diubah di
	sini (grouping header — padam/cipta tarikh di halaman trip).

	Status Active/Cancelled manager-gated (_gate_status_change — hanya
	dihantar bila berubah, elak gate gagal utk Operator). Simpan melalui
	doc.save() penuh — controller Travel Date mengira semula durasi &
	menyinkronkan tarikh/sailing ke SEMUA offer anak (satu sumber)."""
	_require_product_admin()
	if not date or not frappe.db.exists("Travel Date", date):
		frappe.throw(_("Travel Date {0} not found.").format(date or ""),
					frappe.DoesNotExistError)
	doc = frappe.get_doc("Travel Date", date)
	if trip_category is not None:
		v = (trip_category or "").strip()
		if v and not frappe.db.exists("Trip Category", v):
			frappe.throw(_("Unknown Trip Category {0}.").format(v))
		doc.trip_category = v or None
	if departure_date:
		doc.departure_date = departure_date
	if return_date:
		doc.return_date = return_date
	if status_editorial and status_editorial != doc.status_editorial:
		_gate_status_change(status_editorial)
		doc.status_editorial = status_editorial
	doc.save(ignore_permissions=True)
	return {"status": "ok", "name": doc.name,
			"departure_date": doc.departure_date,
			"return_date": doc.return_date,
			"trip_category": doc.trip_category or "",
			"status_editorial": doc.status_editorial}


@frappe.whitelist()
def save_itinerary(parenttype: str, name: str, overwrite_itinerary: int = 0,
				   itinerary: str = "[]") -> dict:
	"""Simpan ITINERARY OVERRIDE Travel Date / Package Offer (model
	"reuse + checkbox overwrite" — hierarki Trip << Travel Date <<
	Package Offer).

	- overwrite_itinerary=1 → baris milik dokumen ini diguna (mengatasi
	  warisan aras atas); 0 → waris (baris kekal tersimpan sebagai draf).
	- `itinerary` = JSON array baris, FULL-REPLACE melalui doc.set()
	  (corak save_trip_website) — kolum ditapis ITINERARY_CHILD_FIELDS;
	  baris tanpa kolum itu diabaikan.

	Semua bacaan warisan lalui utils/itinerary_resolver (satu pintu)."""
	_require_product_admin()
	import json as _json

	if parenttype not in ("Travel Date", "Package Offer"):
		frappe.throw(_("parenttype mesti Travel Date atau Package Offer."))
	if not frappe.db.exists(parenttype, name):
		frappe.throw(_("{0} {1} not found.").format(parenttype, name))

	rows = _json.loads(itinerary or "[]")
	if not isinstance(rows, list):
		frappe.throw(_("itinerary mesti array JSON."))

	from travel_booking.utils.itinerary_resolver import ITINERARY_CHILD_FIELDS

	clean = [{f: r.get(f) for f in ITINERARY_CHILD_FIELDS}
			 for r in rows if isinstance(r, dict)]

	doc = frappe.get_doc(parenttype, name)
	doc.set("itinerary", clean)
	doc.overwrite_itinerary = cint(overwrite_itinerary)
	doc.save(ignore_permissions=True)
	return {"status": "ok", "name": doc.name, "rows": len(clean),
			"overwrite_itinerary": cint(overwrite_itinerary)}


@frappe.whitelist()
def get_travel_date_detail(travel_date: str) -> dict:
	"""SATU payload untuk view Travel Date (Travel Manager):

	- date       — medan Travel Date + label schedule
	- rooming    — baris cabin_rates schedule tarikh ini (kabin
	              fizikal dikongsi semua pakej) — TANPA medan B2B partner
	              (Fasa C quota partner dikeluarkan daripada UI ini)
	- offers     — offer anak (pakej dijual tarikh ini): status, occupancy,
	              price_from (min harga ADULT aktif)
	"""
	_require_product_admin()
	td = frappe.db.get_value(
		"Travel Date", travel_date,
		["name", "trip", "is_a_cruise_trip", "travel_date_name",
		 "status_editorial",
		 "departure_date", "return_date", "cruise_schedule", "ship_name",
		 "ship_code", "sailing_start", "sailing_end", "embarkation_port",
		 "disembarkation_port", "days_before_closure", "description",
		 "trip_category", "total_days", "total_nights", "destination"],
		as_dict=True)
	if not td:
		frappe.throw(_("Travel Date not found."), frappe.DoesNotExistError)
	trip_name = frappe.db.get_value("Trip", td.trip, "trip_name") or td.trip

	rooming = []
	schedule_label = ""
	if td.cruise_schedule:
		sch = frappe.db.get_value(
			"Trip Cruise Schedule", td.cruise_schedule,
			["ship_name", "sail_start", "sail_end", "status"], as_dict=True)
		if sch:
			schedule_label = "{} ({} → {}) · {}".format(
				sch.ship_name or td.cruise_schedule, sch.sail_start,
				sch.sail_end, sch.status)

	# SUMBER ROOMING (arahan pemilik Nov 2026):
	#   Berpaut cruise schedule → TERUS dari cabin_rates schedule
	#     (Trip Package Price child: kategori, allotment, occupancy —
	#     live-sync legasi refresh_cabin_availability). KADAR TIDAK
	#     DIHANTAR — kad Rooming papar kapasiti sahaja (Sold/Available);
	#     harga jualan hidup pada Price Matrix per-offer.
	#   Tidak berpaut (non-cruise) → senarai Trip Price Category
	#     price_category 'Tour' — pilihan kategori umum, tiada inventori.
	rooming = []
	if td.cruise_schedule:
		for r in frappe.get_all(
				"Trip Package Price",
				filters={"parent": td.cruise_schedule,
						 "parenttype": "Trip Cruise Schedule"},
				fields=["name", "pricing_for_class",
						"cabin_allotment", "cabin_occupancy"],
				order_by="idx asc"):
			cat = frappe.db.get_value(
				"Trip Price Category", r.pricing_for_class,
				["name", "category_name", "category_code"], as_dict=True)
			code = (cat.category_code if cat else None) \
				or r.pricing_for_class
			allot = int(r.cabin_allotment or 0)
			sold = int(r.cabin_occupancy or 0)
			rooming.append({
				"name": r.name,
				"room_category": r.pricing_for_class,
				"category_name": (cat.category_name if cat else None)
					or r.pricing_for_class,
				"category_code": code,
				"allotment": allot,
				"sold": sold,
				"available": allot - sold,
			})
	else:
		for cat in frappe.get_all(
				"Trip Price Category", filters={"price_category": "Tour"},
				fields=["name", "category_name", "category_code"],
				order_by="gred desc, name"):
			rooming.append({
				"name": cat.name,
				"room_category": cat.name,
				"category_name": cat.category_name or cat.name,
				"category_code": cat.category_code or cat.name,
				"allotment": 0, "sold": 0, "available": None,
				"price_adult": None,
			})

	offers = frappe.get_all(
		"Package Offer", filters={"travel_date": travel_date},
		fields=["name", "package", "offer_name", "currency",
				"status_editorial", "status_operational",
				"deposit_percent", "final_payment_days", "sale_mode"],
		order_by="name asc",
	)
	# price_from: min harga slot (>0) daripada PRICE MATRIX BASE
	# (parentfield price_matrix — Room Category sahaja; addons tidak
	# termasuk kerana harga asas pakej). Trip Package Price tiada kolum
	# `price` tunggal — enam lajur slot di-UNION (0 = tak dijual).
	price_from = {}
	if offers:
		for r in frappe.db.sql("""
			SELECT parent, MIN(v) AS min_price FROM (
				SELECT parent, price_adult AS v
					FROM `tabTrip Package Price`
					WHERE parenttype = 'Package Offer'
					  AND parentfield = 'price_matrix' AND price_adult > 0
				UNION ALL
				SELECT parent, price_adult_single
					FROM `tabTrip Package Price`
					WHERE parenttype = 'Package Offer'
					  AND parentfield = 'price_matrix' AND price_adult_single > 0
				UNION ALL
				SELECT parent, price_upperberth
					FROM `tabTrip Package Price`
					WHERE parenttype = 'Package Offer'
					  AND parentfield = 'price_matrix' AND price_upperberth > 0
				UNION ALL
				SELECT parent, price_children
					FROM `tabTrip Package Price`
					WHERE parenttype = 'Package Offer'
					  AND parentfield = 'price_matrix' AND price_children > 0
				UNION ALL
				SELECT parent, price_toddler
					FROM `tabTrip Package Price`
					WHERE parenttype = 'Package Offer'
					  AND parentfield = 'price_matrix' AND price_toddler > 0
				UNION ALL
				SELECT parent, price_infant
					FROM `tabTrip Package Price`
					WHERE parenttype = 'Package Offer'
					  AND parentfield = 'price_matrix' AND price_infant > 0
			) slots
			WHERE parent IN %(offers)s
			GROUP BY parent
		""", {"offers": [o.name for o in offers]}, as_dict=True):
			price_from[r.parent] = r

	sold_map = _sold_pax_map([o.name for o in offers])

	# Kiraan baris ADDITIONAL ELEMENTS per offer (child Trip Package Price,
	# parentfield addon_price_matrix — Flight/Hotel/Transport/Meal) — kolum
	# Type senarai offers Travel Manager: 0 → BASIC, ≥1 → MIXED (Nov 2026).
	addon_count_map = ({r.parent: r.n for r in frappe.db.sql("""
		SELECT parent, COUNT(*) AS n
		FROM `tabTrip Package Price`
		WHERE parenttype = 'Package Offer'
		  AND parentfield = 'addon_price_matrix'
		  AND parent IN %(offers)s
		GROUP BY parent
	""", {"offers": [o.name for o in offers]}, as_dict=True)}
		if offers else {})

	out_offers = []
	for o in offers:
		pf = price_from.get(o.name)
		out_offers.append({
			"name": o.name,
			"package": o.package,
			# [Nov 2026 — PURGE Travel Package] Label offer = identiti
			# sendiri (offer_name); tiada lagi bacaan Travel Package.
			"package_name": (o.offer_name or o.package or ""),
			"offer_name": o.offer_name or "",
			"currency": o.currency or "",
			# Jenis offer ikut ADDITIONAL ELEMENTS: tiada baris → BASIC,
			# ada → MIXED.
			"addon_count": addon_count_map.get(o.name, 0),
			"offer_type": "Mixed" if addon_count_map.get(o.name, 0) else "Basic",
			"status_editorial": o.status_editorial,
			"status_operational": o.status_operational,
			# [Nov 2026] jualan live (kaunter max/current_pax ditanggalkan).
			"sold_pax": sold_map.get(o.name, 0),
			"price_from": (float(pf.min_price) if pf else None),
			"deposit_percent": flt(o.deposit_percent or 0),
			"final_payment_days": cint(o.final_payment_days or 0),
			"sale_mode": o.sale_mode or "Public",
		})

	# Itinerary efektif (warisan Trip ← TD) + baris sendiri untuk editor
	# override (Travel Manager) — resolver satu pintu.
	from travel_booking.utils.itinerary_resolver import get_itinerary_payload
	itin_payload = get_itinerary_payload(td.trip, travel_date=travel_date)

	return {
		"date": {
			"name": td.name, "trip": td.trip, "trip_name": trip_name,
			"travel_date_name": td.travel_date_name or "",
			"is_a_cruise_trip": td.is_a_cruise_trip,
			"status": td.status_editorial,
			"departure_date": td.departure_date, "return_date": td.return_date,
			"cruise_schedule": td.cruise_schedule or "",
			"schedule_label": schedule_label,
			"ship_name": td.ship_name or "", "ship_code": td.ship_code or "",
			"sailing_start": td.sailing_start, "sailing_end": td.sailing_end,
			"embarkation_port": td.embarkation_port or "",
			"disembarkation_port": td.disembarkation_port or "",
			"days_before_closure": td.days_before_closure,
			"description": td.description or "",
			# Kategori perjalanan (master Trip Category) — kad GROUP INFO.
			"trip_category": td.trip_category or "",
			# Durasi + destinasi — kad GROUP INFO & dialog Edit Date.
			"total_days": td.total_days or 0,
			"total_nights": td.total_nights or 0,
			"destination": td.destination or "",
		},
		"rooming": rooming,
		"offers": out_offers,
		"itinerary": itin_payload,
	}


def _date_booking_scope(travel_date: str) -> list:
	"""Nama rujukan tarikh untuk skop Booking/Reservation — dikongsi
	get_date_bookings & get_date_travellers.

	Pemetaan struktur (cutover F4/F5): Booking.trip_date & Booking
	Reservation.date_selection memegang nama Trip Group Date LEGASI;
	Travel Date baharu dipetakan melalui legacy_tgd (booking_engine.py —
	"NORMALISASI trip_group_date kepada anchor warisan"). Booking yang
	ditulis terus ke nama Travel Date turut disertakan (mudah alih masa
	depan). Return list unik — kosong bila tarikh tiada rujukan."""
	legacy = frappe.db.get_value("Travel Date", travel_date, "legacy_tgd") or ""
	return [s for s in {legacy, travel_date} if s]


@frappe.whitelist()
def get_date_bookings(travel_date: str) -> list:
	"""Senarai Booking berkaitan SATU Travel Date (kad Booking, Travel
	Manager — adaptasi senarai booking page Manage Booking App).

	Nilai wang DISALIN corak get_booking_profile (manage_trip_booking):
	total/paid/balance DARIPADA Sales Order submitted (agregat SO
	berdaftar pada registri Booking.sales_orders)
	— kolum Booking.total_amount/balance_amount/currency TIADA dalam DB
	(jadual Booking penuh — kolum tidak dapat dicipta), jadi get_doc juga
	memulangkan kosong. Currency = SO pertama booking (utama) fallback
	currency paksi. Semua status dipaparkan (page admin — badge status
	diberi klien); PII ringkas — gate wajib product admin."""
	_require_product_admin()
	scope = _date_booking_scope(travel_date)
	if not scope:
		return []
	try:
		from travel_booking.api.currency_axis import get_default_currency
		def_cur = get_default_currency() or "MYR"
	except Exception:
		def_cur = "MYR"
	return frappe.db.sql("""
		SELECT b.name, b.booking_number, b.customer, c.customer_name,
		       b.status, b.payment_status, b.prog_payment,
		       b.booked_pax, b.trip_package, b.package_offer,
		       b.booking_channel, b.checkout_method, b.creation,
		       b.departure_date, b.return_date,
		       COALESCE(NULLIF((SELECT so2.currency FROM `tabSales Order` so2
		           INNER JOIN `tabBooking Sales Order` reg2
		               ON reg2.sales_order = so2.name AND reg2.parenttype = 'Booking'
		           WHERE reg2.parent = b.name AND so2.docstatus = 1
		           ORDER BY so2.creation ASC, so2.name ASC LIMIT 1), ''),
		           %(def_cur)s) AS currency,
		       COALESCE((SELECT SUM(so3.grand_total) FROM `tabSales Order` so3
		           INNER JOIN `tabBooking Sales Order` reg3
		               ON reg3.sales_order = so3.name AND reg3.parenttype = 'Booking'
		           WHERE reg3.parent = b.name AND so3.docstatus = 1), 0)
		           AS gross,
		       COALESCE((SELECT SUM(so4.advance_paid) FROM `tabSales Order` so4
		           INNER JOIN `tabBooking Sales Order` reg4
		               ON reg4.sales_order = so4.name AND reg4.parenttype = 'Booking'
		           WHERE reg4.parent = b.name AND so4.docstatus = 1), 0)
		           AS paid,
		       ROUND(COALESCE((SELECT SUM(so5.grand_total) FROM `tabSales Order` so5
		           INNER JOIN `tabBooking Sales Order` reg5
		               ON reg5.sales_order = so5.name AND reg5.parenttype = 'Booking'
		           WHERE reg5.parent = b.name AND so5.docstatus = 1), 0)
		             - COALESCE((SELECT SUM(so6.advance_paid) FROM `tabSales Order` so6
		           INNER JOIN `tabBooking Sales Order` reg6
		               ON reg6.sales_order = so6.name AND reg6.parenttype = 'Booking'
		           WHERE reg6.parent = b.name AND so6.docstatus = 1), 0), 2)
		           AS balance
		FROM `tabBooking` b
		LEFT JOIN `tabCustomer` c ON c.name = b.customer
		WHERE b.trip_date IN %(scope)s
		ORDER BY b.creation DESC
	""", {"scope": scope, "def_cur": def_cur}, as_dict=True)


@frappe.whitelist()
def get_date_travellers(travel_date: str) -> list:
	"""Senarai traveller + Booking Reservation berkaitan SATU Travel Date
	(kad Travellers, Travel Manager — adaptasi get_group_travellers
	manage_trip_booking.py, dipangkas untuk kad tarikh).

	Skor data disalin daripada get_group_travellers: rekod doctype
	Traveller DIUTAMAKAN, snapshot Booking Reservation fallback; kontak
	fallback customer booking. Semantik "akan berangkat" — reservation
	Cancelled & booking Cancelled/Abandoned diketepikan (_tv_scope);
	susunan ikut no booking → guest sequence. Gate PII: product admin."""
	_require_product_admin()
	scope = _date_booking_scope(travel_date)
	if not scope:
		return []
	return frappe.db.sql("""
		SELECT br.name AS reservation, br.status AS reservation_status,
		       br.booking, br.booking_number,
		       br.guest_sequence, br.pax_type, br.guest_label,
		       IFNULL(NULLIF(br.room_category, ''), 'Unassigned') AS room_category,
		       br.stateroom_no, br.cabin_no, br.room_id,
		       COALESCE(NULLIF(t.full_name, ''), NULLIF(br.traveller_full_name, ''),
		                br.traveller, '') AS traveller_name,
		       br.traveller,
		       COALESCE(NULLIF(t.gender, ''), NULLIF(br.traveller_gender, ''), '') AS gender,
		       COALESCE(NULLIF(t.nationality, ''),
		                NULLIF(br.traveller_nationality, ''), '') AS nationality,
		       COALESCE(NULLIF(t.passport_no, ''),
		                NULLIF(br.traveller_passportno, ''), '') AS passport_no,
		       COALESCE(NULLIF(t.email, ''), NULLIF(br.traveller_email, ''),
		                NULLIF(br.customer_email, ''), '') AS email,
		       COALESCE(NULLIF(t.phone, ''), NULLIF(br.traveller_phone, ''),
		                NULLIF(br.customer_phone, ''), '') AS phone,
		       COALESCE(NULLIF(t.status, ''),
		                IFNULL(br.document_status, 'Incomplete')) AS document_status,
		       b.status AS booking_status, b.payment_status,
		       b.package_offer, b.trip_package
		FROM `tabBooking Reservation` br
		INNER JOIN `tabBooking` b ON b.name = br.booking
		LEFT JOIN `tabTraveller` t ON t.name = br.traveller
		WHERE (b.trip_date IN %(scope)s OR br.date_selection IN %(scope)s)
		  AND br.status != 'Cancelled'
		  AND b.status NOT IN %(excl)s
		ORDER BY b.booking_number, br.guest_sequence, br.name
	""", {"scope": scope, "excl": ("Cancelled", "Abandoned")}, as_dict=True)


# [BUANG Nov 2026] save_date_inventory (edit Sailing Inventory)
# — tiada pemanggil; kuota ditulis melalui save_offer_inventory
# (cabin_rates schedule).


# [BUANG Nov 2026] link_travel_date_schedule — butang Change/Link
# Cruise Schedule pada kad GROUP INFO dibuang (arahan pemilik;
# tiada pemanggil lain). Sambungan schedule kini diurus semata-mata
# melalui save_travel_date (dialog Edit Date — Selected Cruise
# Schedule) yang menyimpan via controller Travel Date.


# [BUANG Nov 2026] get_rooming_availability_export — butang Download
# Latest Availability pada kad Rooming Categories dibuang (arahan
# pemilik); kadar & availabiliti dipaparkan terus pada jadual rooming.


@frappe.whitelist()
def get_offer_package_admin(travel_date: str, offer: str) -> dict:
	"""Payload halaman admin PAKEJ (Trip > Date > Package) — Seksyen 2:

	- offer          — terma bayaran + harga semasa + status
	- price_matrix   — Price Matrix offer (sumber harga utama, child
	                   Trip Package Price)
	- price_sources  — sumber IMPORT harga (kategori kadar schedule =
	                   cabin_rates LAJUR PENUH). [BUANG Nov 2026] sumber
	                   package_template — Trip Price Category hanya pegang
	                   definisi & profil rooming, bukan harga pakej.
	TIADA inventori di sini — kuota kabin diurus di peringkat tarikh
	(kolam cabin_rates schedule dikongsi)."""
	_require_product_admin()
	o = frappe.db.get_value(
		"Package Offer", offer,
		["name", "package", "trip", "travel_date", "status_editorial",
		 "status_operational", "deposit_percent", "final_payment_days",
		 "sale_mode", "cruise_schedule", "offer_name", "currency",
		 "matrix_room", "matrix_flight", "matrix_hotel",
		 "matrix_transport", "matrix_meal"],
		as_dict=True)
	if not o or o.travel_date != travel_date:
		frappe.throw(_("Offer not found on this travel date."),
					 frappe.DoesNotExistError)
	# [Nov 2026 — PURGE Travel Package] Identiti offer = identiti sendiri
	# (offer_name + currency); komponen daripada Trip.default_components —
	# SATU laluan untuk semua offer (legacy package link diabaikan).
	td_trip = frappe.db.get_value("Travel Date", travel_date, "trip")
	pkg = frappe._dict(
		package_name=o.offer_name or offer,
		package_template="",
		default_currency=o.currency or "MYR",
		components=frappe.get_all(
			"Package Component",
			filters={"parent": td_trip, "parenttype": "Trip"},
			fields=["component_type", "trip", "flight",
					"component_item", "age_option", "selection_mode",
					"qty", "mandatory", "price_adjust_type",
					"price_adjust_value", "sort_order"],
			order_by="sort_order asc",
		) or [],
	)

	# Harga semasa offer — SUMBER UTAMA = Price Matrix (child Trip
	# Package Price, 1 baris per kategori, lajur slot penuh).
	# [BUANG Nov 2026] payload "prices" (Offer Price legacy) — medan
	# ditanggalkan daripada Package Offer.
	price_matrix = _offer_price_matrix_payload(offer)
	addon_matrix = _offer_price_matrix_payload(offer, "addon_price_matrix")
	# Map perbandingan import: (category_code, column) -> harga semasa.
	current_matrix = {}
	for r in price_matrix:
		for col in ("price_adult", "price_adult_single", "price_upperberth",
					"price_children", "price_toddler", "price_infant"):
			if r.get(col) is not None:
				current_matrix[(r.category_code, col)] = float(r.get(col) or 0)

	# ── Sumber IMPORT ──
	# [BUANG Nov 2026] sumber "package_template" (Package Price Template) —
	# Trip Price Category hanya pegang DEFINISI & PROFIL rooming, bukan
	# harga pakej; satu-satunya sumber import ialah kadar schedule.
	# Kategori kadar schedule (Trip Cruise Schedule.cabin_rates) —
	# LAJUR PENUH (adult/single/upper/child/toddler/infant). Child Trip
	# Package Price tiada kolum currency sendiri — currency diwarisi
	# daripada parent Trip Cruise Schedule.
	schedule_rates = []
	if o.cruise_schedule:
		sched_currency = frappe.db.get_value(
			"Trip Cruise Schedule", o.cruise_schedule, "currency")
		for cat in frappe.get_all(
				"Trip Package Price",
				filters={"parent": o.cruise_schedule,
						 "parenttype": "Trip Cruise Schedule"},
				fields=["pricing_for_class", "price_adult",
						"price_adult_single", "price_upperberth",
						"price_children", "price_toddler", "price_infant",
						"cabin_allotment"],
				order_by="idx asc"):
			# pricing_for_class = docname/nama Trip Price Category → kod.
			code = frappe.db.get_value(
				"Trip Price Category", cat.pricing_for_class, "category_code") \
				or cat.pricing_for_class
			schedule_rates.append({
				"category_code": code,
				"category_name": cat.pricing_for_class,
				"price_adult": float(cat.price_adult or 0),
				"price_adult_single": float(cat.price_adult_single or 0),
				"price_upperberth": float(cat.price_upperberth or 0),
				"price_children": float(cat.price_children or 0),
				"price_toddler": float(cat.price_toddler or 0),
				"price_infant": float(cat.price_infant or 0),
				"currency": sched_currency or "",
				"allotment": int(cat.cabin_allotment or 0),
			})

	# Komponen produk pakej + nilai harga adjust (impact harga).
	components = [
		{
			"component_type": c.component_type,
			"trip": c.trip or "",
			"flight": c.flight or "",
			"component_item": c.component_item or "",
			"age_option": c.age_option or "",
			"selection_mode": c.selection_mode,
			"qty": c.qty,
			"mandatory": c.mandatory,
			"price_adjust_type": c.price_adjust_type or "none",
			"price_adjust_value": float(c.price_adjust_value or 0),
			"sort_order": c.sort_order,
		}
		for c in (pkg.components or [])
	]

	# (BUANG Nov 2026) _mark/template_source — banding import template
	# dibuang bersama sumber package_template.

	# Panel TRIP INFORMATION + GROUP INFO (dikongsi merentasi directory
	# — Nov 2026). Bentuk `date` = sama seperti get_travel_date_detail;
	# `trip` = maklumat asas trip (nama, organizer, jenis, status…).
	date_info = None
	trip_info = None
	date_rows = frappe.get_all("Travel Date", filters={"name": travel_date},
		fields=["name", "trip", "is_a_cruise_trip", "travel_date_name",
				"status_editorial", "departure_date", "return_date",
				"cruise_schedule", "ship_name", "sailing_start",
				"sailing_end", "embarkation_port", "disembarkation_port",
				"days_before_closure", "trip_category"])
	if date_rows:
		td = date_rows[0]
		date_info = {
			"name": td.name, "trip": td.trip, "trip_name": td.trip,
			"travel_date_name": td.travel_date_name or "",
			"is_a_cruise_trip": td.is_a_cruise_trip,
			"status": td.status_editorial,
			"departure_date": td.departure_date,
			"return_date": td.return_date,
			"cruise_schedule": td.cruise_schedule or "",
			"ship_name": td.ship_name or "",
			"sailing_start": td.sailing_start, "sailing_end": td.sailing_end,
			"embarkation_port": td.embarkation_port or "",
			"disembarkation_port": td.disembarkation_port or "",
			"days_before_closure": td.days_before_closure,
			"trip_category": td.trip_category or "",
		}
		trip_info = frappe.db.get_value(
			"Trip", td.trip,
			["name", "trip_name", "trip_organizer", "route", "published",
			 "featured_trip", "status", "is_a_cruise_trip", "creation"],
			as_dict=True)
		if trip_info is not None:
			# trip_name SEBENAR (resolusi Trip, fallback ID) — kad GROUP
			# INFO papar baris Trip Name daripada nilai ini (Nov 2026).
			date_info["trip_name"] = trip_info.trip_name or td.trip
			trip_info["featured"] = int(trip_info.pop("featured_trip") or 0)

	# Itinerary efektif (warisan Trip ← Travel Date ← offer) + baris
	# sendiri untuk editor override (Travel Manager).
	from travel_booking.utils.itinerary_resolver import get_itinerary_payload
	trip_ref = o.trip or frappe.db.get_value("Travel Date", travel_date, "trip")
	itin_payload = get_itinerary_payload(
		trip_ref, travel_date=travel_date, offer=offer)

	return {
		"offer": {
			"name": o.name, "package": o.package,
			"package_name": pkg.package_name,
			"package_template": pkg.package_template or "",
			"currency": pkg.default_currency or "",
			"status_editorial": o.status_editorial,
			"status_operational": o.status_operational,
			"deposit_percent": flt(o.deposit_percent or 0),
			"final_payment_days": cint(o.final_payment_days or 0),
			"sale_mode": o.sale_mode or "Public",
			"travel_date": o.travel_date,
			# NILAI BERKESAN: 0 pada offer = fallback Travel Settings —
			# pulangkan kedua-dua (offer + default) supaya UI papar
			# "guna default" dan enjin bayaran sepadan (_effective_payment_terms).
			"deposit_percent_effective": (
				flt(o.deposit_percent) if flt(o.deposit_percent or 0) > 0
				else flt(frappe.db.get_single_value(
					"Travel Settings", "default_deposit_percent") or 0)),
			"final_payment_days_effective": (
				cint(o.final_payment_days) if cint(o.final_payment_days or 0) > 0
				else cint(frappe.db.get_single_value(
					"Travel Settings", "default_final_payment_days") or 0)),
			"deposit_percent_default": flt(frappe.db.get_single_value(
				"Travel Settings", "default_deposit_percent") or 0),
			"final_payment_days_default": cint(frappe.db.get_single_value(
				"Travel Settings", "default_final_payment_days") or 0),
			# Flag seksi PRICE MATRIX aktif (Nov 2026) — kawal tab + checkout.
			"matrix_room": cint(o.matrix_room or 1),
			"matrix_flight": cint(o.matrix_flight or 0),
			"matrix_hotel": cint(o.matrix_hotel or 0),
			"matrix_transport": cint(o.matrix_transport or 0),
			"matrix_meal": cint(o.matrix_meal or 0),
			# Cruise marker — UI: tab Cabin (matrix Room Category) hanya
			# untuk offer cruise; panel Extract rate schedule bernaung di bawahnya.
			"cruise_schedule": o.cruise_schedule or "",
		},
		"price_matrix": price_matrix,
		"addon_matrix": addon_matrix,
		"components": components,
		"itinerary": itin_payload,
		"price_sources": {
			"schedule_rates": schedule_rates,
		},
	# Master kategori per SEKSI utk tambah baris kosong pada grid —
	# "Room Category" mengumpul Cruise+Tour; yang lain ikut jenis.
	"category_options": _category_options_payload(),
	# Panel TRIP INFORMATION + GROUP INFO (dikira di atas).
	"trip": trip_info,
	"date": date_info,
}


@frappe.whitelist()
def import_offer_prices(offer: str, rows: str,
						markup_percent: str = None) -> dict:
	"""IMPORT harga ke PRICE MATRIX offer (Nov 2026 — sumber harga utama)
	daripada sumber pilihan (Seksyen 2 — extract & import). `rows` = JSON
	array pilihan pengguna daripada get_offer_package_admin.price_sources.
	Dua bentuk diterima:
	  - PENUH (schedule_rates baharu): {category_code, currency,
	    price_adult, price_adult_single, price_upperberth, price_children,
	    price_toddler, price_infant, ...} — semua lajur slot disalin.
	  - LEGACY (template pakej): {category_code, age_option, currency,
	    price} — age dipetakan ke lajur slot (ADULT/CHILD/INFANT/TODDLER).

	PENUKARAN KURS: jika currency sumber berbeza daripada currency offer,
	setiap nilai didarabkan dengan kadar Currency Exchange (ERPNext, hari
	ini) — nilai tersimpan sentiasa dalam currency offer.
	MARKUP: `markup_percent` (cth. "5" = +5%) digunakan selepas penukaran
	kurs — kosong/0 = harga terus.

	Upsert ikut category_code (kod kanonik v47 → docname kategori); baris
	kategori baharu DITAMBAH. TIADA sentuhan inventori."""
	_require_product_admin()
	import json as _json
	data = _json.loads(rows or "[]")
	if not isinstance(data, list) or not data:
		frappe.throw(_("No rows to import."))
	if not frappe.db.exists("Package Offer", offer):
		frappe.throw(_("Offer not found."), frappe.DoesNotExistError)

	cat_by_code, cat_by_name = {}, {}
	for c in frappe.get_all("Trip Price Category",
			fields=["name", "category_code"]):
		if c.category_code:
			cat_by_code[c.category_code] = c.name
		cat_by_name[c.name] = c.name

	def _canon(code):
		"""Normalkan docname ATAU category_code ke docname — baris matrix
		lama boleh simpan mana-mana bentuk; import mesti OVERWRITE baris
		kategori yang sama, bukan tambah pendua."""
		return cat_by_code.get(code) or cat_by_name.get(code) or code

	_age_col = {"ADULT": "price_adult", "CHILD": "price_children",
				"INFANT": "price_infant", "TODDLER": "price_toddler"}
	_slot_cols = ("price_adult", "price_adult_single", "price_upperberth",
				  "price_children", "price_toddler", "price_infant")

	doc = frappe.get_doc("Package Offer", offer)
	offer_currency = (doc.currency or "").strip()
	markup = flt(markup_percent)

	# [Nov 2026] Lebur pendua sedia ada (simpanan lama code vs docname)
	# sebelum import — satu kategori = SATU baris.
	seen_canon: set = set()
	uniq_rows = []
	for row in (doc.price_matrix or []):
		key = _canon((row.pricing_for_class or "").strip())
		if key in seen_canon:
			continue
		seen_canon.add(key)
		uniq_rows.append(row)
	doc.price_matrix = uniq_rows

	# Kurs cache per pasangan (satu permintaan import = satu set kadar).
	rate_cache: dict = {}
	rates_used: dict = {}

	def _rate(from_cur: str) -> float:
		if not offer_currency or from_cur == offer_currency:
			return 1.0
		key = (from_cur, offer_currency)
		if key not in rate_cache:
			try:
				from erpnext.setup.utils import get_exchange_rate
				rate_cache[key] = float(
					get_exchange_rate(from_cur, offer_currency))
			except Exception:
				frappe.throw(_(
					"Tiada kadar tukaran {0} → {1} dalam Currency Exchange "
					"— tambah kadar hari ini dahulu sebelum import."
				).format(from_cur, offer_currency))
			rates_used["{0} → {1}".format(*key)] = rate_cache[key]
		return rate_cache[key]

	updated, added = 0, 0
	for r in data:
		code = (r.get("category_code") or r.get("opt1") or "").strip()
		if not code:
			continue
		cat = cat_by_code.get(code) or cat_by_name.get(code) or code

		# Bentuk penuh → semua lajur; bentuk legacy → satu lajur ikut age.
		vals = {}
		if any(r.get(col) is not None for col in _slot_cols):
			for col in _slot_cols:
				if r.get(col) is not None:
					vals[col] = flt(r.get(col))
		else:
			age = (r.get("age_option") or "").strip() or "ADULT"
			col = _age_col.get(age)
			price = flt(r.get("price"))
			if not col or price <= 0:
				continue
			vals[col] = price
		if not vals:
			continue

		# Penukaran kurs (sumber ≠ offer) + markup % — nilai tersimpan
		# sentiasa dalam currency offer. BILA FAKTOR DIGUNAKAN (kurs dan/atau
		# markup), hasil diBUNDAR KE ATAS ke integer — tiada perpuluhan
		# (arahan pemilik Nov 2026); factor 1.0 (salinan terus) kekal mentah.
		src_cur = (r.get("currency") or "").strip()
		factor = _rate(src_cur) if src_cur else 1.0
		if markup:
			factor *= (1 + markup / 100.0)
		if factor != 1.0:
			# round(...,6) buang epsilon float (100×3.2×1.1 = 352.00000006
			# mesti jadi 352, bukan 353) sebelum bundar ke atas.
			vals = {col: math.ceil(round(v * factor, 6))
					for col, v in vals.items()}

		match = next((row for row in (doc.price_matrix or [])
					  if _canon((row.pricing_for_class or "").strip()) == cat),
					 None)
		if match:
			for col, v in vals.items():
				setattr(match, col, v)
			updated += 1
		else:
			doc.append("price_matrix", {"pricing_for_class": cat, **vals})
			added += 1
	doc.save(ignore_permissions=True)
	return {"status": "ok", "updated": updated, "added": added,
			"rates": rates_used, "markup_percent": markup or None}


@frappe.whitelist()
def add_offer_to_date(travel_date: str, values: str) -> dict:
	"""MODEL BAHARU (Nov 2026 — Travel Package deprecated): tambah OFFER
	baharu ke tarikh ini — identiti sendiri (offer_name + currency),
	komponen disalin Trip.default_components, inventori dari Rooming
	Categories, HARGA KOSONG (isi melalui Price Matrix / import).
	`values` JSON: {offer_name, currency}."""
	_require_product_admin()
	import json as _json
	data = _json.loads(values or "{}")
	from travel_booking.utils.offer_factory import create_offer
	if not frappe.db.exists("Travel Date", travel_date):
		frappe.throw(_("Travel Date not found."), frappe.DoesNotExistError)
	offer_name = create_offer(None, {
		"travel_date": travel_date,
		"offer_name": (data.get("offer_name") or "").strip(),
		"currency": (data.get("currency") or "").strip(),
	})
	return {"status": "ok", "offer": offer_name}


@frappe.whitelist()
def save_offer_info(offer: str, offer_name: str = None,
					currency: str = None, status_editorial: str = None) -> dict:
	"""Edit identiti PACKAGE INFO (Nov 2026): nama pakej (offer_name),
	currency jualan & status editorial. Status Active/Cancelled di-gate
	Tour Manager (corak set_offer_status)."""
	_require_product_admin()
	if not frappe.db.exists("Package Offer", offer):
		frappe.throw(_("Offer not found."), frappe.DoesNotExistError)
	values = {}
	if (offer_name or "").strip():
		values["offer_name"] = offer_name.strip()
	if (currency or "").strip():
		cur = currency.strip()
		if not frappe.db.exists("Currency", cur):
			frappe.throw(_("Unknown currency {0}.").format(cur))
		values["currency"] = cur
	if status_editorial:
		if status_editorial not in ("Draft", "Active", "Cancelled"):
			frappe.throw(_("Invalid editorial status."))
		_gate_status_change(status_editorial)
		values["status_editorial"] = status_editorial
	if not values:
		frappe.throw(_("Nothing to update."))
	frappe.db.set_value("Package Offer", offer, values, update_modified=False)
	return {"status": "ok", **values}


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


# ══════════════════════════════════════════════
# DIREKTORI PACKAGE OFFERS — BULK (halaman Package Offers, Nov 2026)
# ══════════════════════════════════════════════

# Katalog medan BULK edit senarai offers — key unik klien → fieldname
# (arahan pemilik: editorial status, offer_name, currency, flight;
# sale_mode kekal). offer_name = nama SAMA diletak pada semua offer
# dipilih — menggantikan nama auto-jana "{trip} : {tarikh}".
OFFER_BULK_EDIT_FIELDS = {
	"currency": "currency",
	"status_editorial": "status_editorial",
	"sale_mode": "sale_mode",
	"offer_name": "offer_name",
	"flight": "flight",
}


def _parse_bulk_names(names: "list | str") -> list:
	"""Terima list atau JSON string — dedupe kekalkan susunan
	(mirror bulk_update_bookings / bulk_delete_bookings)."""
	if isinstance(names, str):
		try:
			names = json.loads(names)
		except ValueError:
			frappe.throw(_("Invalid offers payload"))
	return list(dict.fromkeys(n for n in (names or []) if n))


def _validate_bulk_offer_value(field: str, value: str) -> str:
	"""Semak nilai bulk mengikut medan — mirror save_offer_info: currency
	& flight mesti wujud; status editorial disemak & di-gate Tour Manager
	(_gate_status_change — SEKALI utk seluruh batch); sale_mode mesti
	opsyen sah doctype; offer_name diterima apa adanya (tak kosong)."""
	if field == "currency":
		if not frappe.db.exists("Currency", value):
			frappe.throw(_("Unknown currency {0}.").format(value))
	elif field == "status_editorial":
		if value not in ("Draft", "Active", "Cancelled"):
			frappe.throw(_("Invalid editorial status."))
		_gate_status_change(value)
	elif field == "sale_mode":
		if value not in ("Public", "Group Block", "Full Charter", "Private"):
			frappe.throw(_("Invalid sale mode."))
	elif field == "flight":
		if not frappe.db.exists("Flight", value):
			frappe.throw(_("Unknown flight {0}.").format(value))
	return value


@frappe.whitelist()
def bulk_update_offers(offers: "list | str" = None, field: str = "",
					   value: str = "") -> dict:
	"""Bulk kemaskini medan pilihan user pada senarai offers (halaman
	Package Offers) — mirror bulk_update_bookings.

	`field` mesti key dalam OFFER_BULK_EDIT_FIELDS. Setiap offer diproses
	berasingan — kegagalan satu TIDAK menghentikan yang lain; rekod tidak
	wujud dilangkau; nilai kosong DITOLAK (elak padam/melar secara
	tak sengaja). Nilai disimpan melalui frappe.db.set_value dengan
	update_modified=False — corak sama dgn save_offer_info (edit identiti
	offer tidak perlu hook validate penuh). Pulangkan ringkasan
	updated / skipped / failed (+ sebab) utk kemaskini cache klien."""
	_require_product_admin()
	if (field or "").strip() not in OFFER_BULK_EDIT_FIELDS:
		frappe.throw(_("Invalid field: {0}").format(field))
	field = field.strip()
	value = "" if value is None else str(value).strip()
	if not value:
		frappe.throw(_("Please enter a value to apply"))
	_validate_bulk_offer_value(field, value)
	names = _parse_bulk_names(offers)
	if not names:
		frappe.throw(_("No offers selected"))

	updated, skipped, failed = [], [], []
	for name in names:
		if not frappe.db.exists("Package Offer", name):
			skipped.append({"name": name, "reason": "no Package Offer record"})
			continue
		try:
			current = frappe.db.get_value("Package Offer", name, field)
			if str(current or "") == value:
				updated.append(name)  # nilai sudah sama — tiada penulisan
				continue
			frappe.db.set_value("Package Offer", name, {field: value},
								update_modified=False)
			updated.append(name)
		except Exception as e:
			failed.append({"name": name, "reason": str(e)[:120]})

	return {"updated": updated, "skipped": skipped, "failed": failed,
		"doctype": "Package Offer", "fieldname": field, "value": value}


@frappe.whitelist()
def bulk_delete_offers(offers: "list | str" = None) -> dict:
	"""Bulk padam senarai offers (halaman Package Offers) — butang trash
	sebelah Bulk Edit. Tour Manager / System Manager sahaja. Setiap offer
	diproses berasingan (savepoint — padam gagal tidak meninggalkan
	separuh padam) dengan guard sama dgn delete_package_offer: rekod
	wujud, tiada booking aktif & jualan live 0 — guard gagal dilaporkan
	sebagai skipped (+ sebab). Dilaporkan: deleted / skipped / failed."""
	_require_product_admin()
	_require_offer_delete_manager()
	names = _parse_bulk_names(offers)
	if not names:
		frappe.throw(_("No offers selected"))

	deleted, skipped, failed = [], [], []
	for name in names:
		reason = _offer_delete_block_reason(name)
		if reason:
			skipped.append({"name": name, "reason": reason})
			continue
		# Savepoint per rekod — nama savepoint mesti identifier SQL sah
		# (nama offer mengandungi noktah/dsbg. — sanitasi penuh).
		sp = "bulk_del_" + "".join(c if c.isalnum() else "_" for c in name)
		frappe.db.savepoint(sp)
		try:
			frappe.delete_doc("Package Offer", name,
							  ignore_permissions=True, force=True)
			deleted.append(name)
		except Exception as e:
			frappe.db.rollback(save_point=sp)
			failed.append({"name": name, "reason": str(e)[:120]})

	frappe.logger("travel_booking").info({
		"action": "bulk_delete_offers", "deleted": deleted,
		"skipped": skipped, "failed": failed})
	return {"deleted": deleted, "skipped": skipped, "failed": failed}


# ══════════════════════════════════════════════
# TRAVEL DATES DIREKTORI — bulk (halaman Travel Dates, Nov 2026)
# ══════════════════════════════════════════════

# Medan yang boleh di-bulk edit pada direktori Travel Dates — mirror
# OFFER_BULK_EDIT_FIELDS. Tarikh berlepas/pulang SENGAJA TIDak ditawarkan:
# bulk shift tarikh menular ke durasi & sinkronisasi offer — ubah suai
# tarikh melalui dialog ✏️ per baris (save_date_info — doc.save penuh).
DATE_BULK_EDIT_FIELDS = {"trip_category", "status_editorial"}


def _validate_bulk_date_value(field: str, value: str) -> str:
	"""Semak nilai bulk mengikut medan — mirror _validate_bulk_offer_value:
	trip category mesti wujud; status editorial disemak & di-gate Tour
	Manager (_gate_status_change — SEKALI utk seluruh batch)."""
	if field == "trip_category":
		if not frappe.db.exists("Trip Category", value):
			frappe.throw(_("Unknown Trip Category {0}.").format(value))
	elif field == "status_editorial":
		if value not in ("Draft", "Active", "Cancelled"):
			frappe.throw(_("Invalid editorial status."))
		_gate_status_change(value)
	return value


@frappe.whitelist()
def bulk_update_dates(dates: "list | str" = None, field: str = "",
					  value: str = "") -> dict:
	"""Bulk kemaskini medan pilihan user pada senarai Travel Date
	(halaman Travel Dates) — mirror bulk_update_offers.

	`field` mesti key dalam DATE_BULK_EDIT_FIELDS. Setiap tarikh diproses
	berasingan — kegagalan satu TIDAK menghentikan yang lain; rekod tidak
	wujud dilangkau; nilai kosong DITOLAK. Nilai disimpan melalui
	frappe.db.set_value dengan update_modified=False (kategori/status
	tidak memerlukan validate penuh — tarikh diubah melalui save_date_info
	yang mengira semula durasi & sync offer). Pulangkan ringkasan
	updated / skipped / failed (+ sebab) utk kemaskini cache klien."""
	_require_product_admin()
	if (field or "").strip() not in DATE_BULK_EDIT_FIELDS:
		frappe.throw(_("Invalid field: {0}").format(field))
	field = field.strip()
	value = "" if value is None else str(value).strip()
	if not value:
		frappe.throw(_("Please enter a value to apply"))
	_validate_bulk_date_value(field, value)
	names = _parse_bulk_names(dates)
	if not names:
		frappe.throw(_("No travel dates selected"))

	updated, skipped, failed = [], [], []
	for name in names:
		if not frappe.db.exists("Travel Date", name):
			skipped.append({"name": name, "reason": "no Travel Date record"})
			continue
		try:
			current = frappe.db.get_value("Travel Date", name, field)
			if str(current or "") == value:
				updated.append(name)  # nilai sudah sama — tiada penulisan
				continue
			frappe.db.set_value("Travel Date", name, {field: value},
								update_modified=False)
			updated.append(name)
		except Exception as e:
			failed.append({"name": name, "reason": str(e)[:120]})

	return {"updated": updated, "skipped": skipped, "failed": failed,
			"doctype": "Travel Date", "fieldname": field, "value": value}


@frappe.whitelist()
def bulk_delete_dates(dates: "list | str" = None) -> dict:
	"""Bulk padam senarai Travel Date + offer anak masing-masing (halaman
	Travel Dates) — butang trash sebelah Bulk Edit. Tour Manager /
	System Manager sahaja. Setiap tarikh diproses berasingan (savepoint —
	padam gagal tidak meninggalkan separuh padam) dengan guard sama dgn
	delete_travel_date (_date_delete_block_reason: rekod wujud, tiada
	booking aktif & jualan live 0 pada offer anaknya) — guard gagal
	dilaporkan sebagai skipped (+ sebab). Dilaporkan: deleted / skipped /
	failed (+ jumlah offer yang terpadam sekali)."""
	_require_product_admin()
	if not (_MANAGER_ONLY & set(frappe.get_roles())):
		frappe.throw(_("Only Tour Manager / System Manager can delete a travel date."),
					frappe.PermissionError)
	names = _parse_bulk_names(dates)
	if not names:
		frappe.throw(_("No travel dates selected"))

	deleted, skipped, failed = [], [], []
	offers_deleted = 0
	for name in names:
		reason = _date_delete_block_reason(name)
		if reason:
			skipped.append({"name": name, "reason": reason})
			continue
		# Savepoint per rekod — nama savepoint mesti identifier SQL sah
		# (nama tarikh mengandungi noktah/dsbg. — sanitasi penuh).
		sp = "bulk_del_td_" + "".join(c if c.isalnum() else "_" for c in name)
		frappe.db.savepoint(sp)
		try:
			child_offers = frappe.get_all("Package Offer",
				filters={"travel_date": name}, pluck="name")
			for offer in child_offers:
				frappe.delete_doc("Package Offer", offer,
								  ignore_permissions=True, force=True)
			frappe.delete_doc("Travel Date", name,
							  ignore_permissions=True, force=True)
			deleted.append(name)
			offers_deleted += len(child_offers)
		except Exception as e:
			frappe.db.rollback(save_point=sp)
			failed.append({"name": name, "reason": str(e)[:120]})

	frappe.logger("travel_booking").info({
		"action": "bulk_delete_dates", "deleted": deleted,
		"offers_deleted": offers_deleted, "skipped": skipped,
		"failed": failed})
	return {"deleted": deleted, "offers_deleted": offers_deleted,
			"skipped": skipped, "failed": failed}


def _category_options_payload() -> dict:
	"""Master Trip Price Category dikelaskan per seksi PRICE MATRIX:
	Room Category (Cruise+Tour) / Flight / Hotel / Transport / Meal.
	Bentuk: {seksi: [{name, category_code, category_name}]}."""
	out: dict = {k: [] for k in
				 ("Room Category", "Flight", "Hotel", "Transport", "Meal")}
	for c in frappe.get_all(
			"Trip Price Category",
			filters={"price_category": ["in",
					["Cruise", "Tour", "Hotel", "Transport", "Meal", "Flight"]]},
			fields=["name", "category_name", "category_code",
					"price_category", "category_group"],
			order_by="price_category asc, category_name asc"):
		seksi = ("Room Category" if c.price_category in ("Cruise", "Tour")
				 else c.price_category)
		out.setdefault(seksi, []).append({
			"name": c.name,
			"category_code": c.category_code or c.name,
			"category_name": c.category_name or c.name,
			"price_category": c.price_category,
			"category_group": c.category_group or "",
		})
	return out


def _offer_price_matrix_payload(offer: str,
								parentfield: str = "price_matrix") -> list:
	"""Baris matrix offer (child Trip Package Price) + nama/kod/
	price_category kategori — paparan UI berseksyen.

	parentfield (Nov 2026 rombakan konsep):
	  - "price_matrix"       → BASE (Room Category — harga asas)
	  - "addon_price_matrix" → ADDONS (Flight/Hotel/Transport/Meal)
	Dikongsi get_offer_package_admin & get_offer_commercial."""
	rows = frappe.get_all(
		"Trip Package Price",
		filters={"parent": offer, "parenttype": "Package Offer",
				 "parentfield": parentfield},
		fields=["name", "pricing_for_class", "price_adult",
				"price_adult_single", "price_upperberth", "price_children",
				"price_toddler", "price_infant"],
		order_by="idx asc",
	)
	info_map = {c.name: c for c in frappe.get_all(
		"Trip Price Category",
		fields=["name", "category_name", "category_code", "price_category"])}
	for r in rows:
		info = info_map.get(r.pricing_for_class)
		r["category_code"] = (info.category_code if info else None) \
			or r.pricing_for_class
		r["category_name"] = (info.category_name if info else None) \
			or r.pricing_for_class
		# Seksi matrix: Cruise/Tour → Room Category; selain itu ikut jenis.
		pcat = (info.price_category if info else None) or "Tour"
		r["price_category"] = "Room Category" if pcat in ("Cruise", "Tour") \
			else pcat
	return rows


@frappe.whitelist()
def get_offer_commercial(offer: str) -> dict:
	"""Inventori + terma bayaran + grouping offer untuk dialog Kuota &
	Harga (Travel Manager). payment_terms (Fasa A/G1) dipakai oleh
	confirm_booking semasa bina baris payment_schedule SO (Deposit +
	Balance); sale_mode/allotment_partner (Fasa C) mengawal distribusi
	kuota group block / charter.

	FIX relationship: offer yang merujuk Trip Cruise Schedule membaca
	inventori dari SAILING (dikongsi semua offer sailing itu — kabin
	ialah aset fizikal kapal); flag inventory_source memberitahu UI.
	[BUANG Nov 2026] Offer Inventory + Offer Price (medan ditanggalkan
	daripada Package Offer) — offer darat: inventori kosong (jualan
	terbuka); harga = Price Matrix."""
	_require_product_admin()
	if not frappe.db.exists("Package Offer", offer):
		frappe.throw(_("Offer not found."), frappe.DoesNotExistError)
	# [Nov 2026] kolam tunggal = cabin_rates schedule (allotment kontrak −
	# occupancy live Booking Reservation). Bentuk payload kekal untuk UI
	# (inventory_key/allotment/sold/available).
	schedule = frappe.db.get_value("Package Offer", offer, "cruise_schedule")
	if isinstance(schedule, dict):
		schedule = schedule.get("cruise_schedule")
	inventory = []
	if schedule:
		for r in frappe.get_all(
				"Trip Package Price",
				filters={"parent": schedule,
						 "parenttype": "Trip Cruise Schedule"},
				fields=["name", "pricing_for_class", "cabin_allotment",
						"cabin_occupancy", "cabin_available"],
				order_by="idx asc"):
			inventory.append({
				"name": r.name,
				"inventory_key": "cabin:" + (r.pricing_for_class or ""),
				"allotment": int(r.cabin_allotment or 0),
				"sold": int(r.cabin_occupancy or 0),
				"available": int(r.cabin_available or 0)
					if r.cabin_available is not None
					else int(r.cabin_allotment or 0) - int(r.cabin_occupancy or 0),
			})
	terms = frappe.db.get_value("Package Offer", offer,
		["deposit_percent", "final_payment_days", "sale_mode",
		 "group_block_code"], as_dict=True) or frappe._dict()
	schedule_label = ""
	if schedule:
		schedule_label = frappe.db.get_value(
			"Trip Cruise Schedule", schedule,
			["ship_name", "sail_start", "sail_end"], as_dict=True)
		schedule_label = "{} ({} → {})".format(
			schedule_label.ship_name or schedule,
			schedule_label.sail_start or "", schedule_label.sail_end or "")
	return {
		"inventory": inventory,
		# [Nov 2026] kolam tunggal cabin_rates schedule — UI papar banner
		# kolam kongsi bila offer berpaut schedule.
		"inventory_source": "cabin_rates" if schedule else "open",
		"sailing_label": schedule_label,
		"price_matrix": _offer_price_matrix_payload(offer),
		"addon_matrix": _offer_price_matrix_payload(
			offer, "addon_price_matrix"),
		# Fasa A (G1): 0 = fallback ke Travel Settings (default_deposit_percent
		# / default_final_payment_days) — offer ialah override, bukan pintu mati.
		"payment_terms": {
			"deposit_percent": flt(terms.deposit_percent or 0),
			"final_payment_days": cint(terms.final_payment_days or 0),
		},
		# Fasa C: mod jualan + senarai partner untuk dropdown reserve kuota.
		"sale_mode": terms.sale_mode or "Public",
		"group_block_code": terms.group_block_code or "",
		"partners": frappe.get_all(
			"Travel B2B Partner",
			fields=["name", "partner_name"], order_by="partner_name asc", limit=200,
		),
	}


@frappe.whitelist()
def save_offer_grouping(offer: str, sale_mode: str = None,
						group_block_code: str = None) -> dict:
	"""Fasa C: mod jualan offer — Public / Group Block / Full Charter /
	Private (+ kod blok kontrak kumpulan). Metadata komersial sahaja —
	kapasiti & harga kekal di inventory/prices; kuota eksklusif partner
	diurus per-baris melalui save_offer_inventory (allotment_partner)."""
	_require_product_admin()
	if not frappe.db.exists("Package Offer", offer):
		frappe.throw(_("Offer not found."), frappe.DoesNotExistError)
	values = {}
	if sale_mode is not None:
		if sale_mode not in ("Public", "Group Block", "Full Charter", "Private"):
			frappe.throw(_("Invalid sale mode."))
		values["sale_mode"] = sale_mode
	if group_block_code is not None:
		values["group_block_code"] = (group_block_code or "").strip()[:60]
	if values:
		frappe.db.set_value("Package Offer", offer, values)
	return {"status": "ok", "updated": bool(values)}


@frappe.whitelist()
def save_offer_payment_terms(offer: str, deposit_percent: float | None = None,
							 final_payment_days: int | None = None) -> dict:
	"""Fasa A (G1): simpan terma bayaran offer — Deposit % + Final Payment
	(hari sebelum berlepas). Nilai 0/kosong = guna default global Travel
	Settings. Kesannya: baris payment_schedule SO semasa booking, dan
	peringatan T-30/T-7/T-1 scheduler. Kedua-dua argumen opsional —
	hantar satu sahaja untuk kemaskini separa."""
	_require_product_admin()
	if not frappe.db.exists("Package Offer", offer):
		frappe.throw(_("Offer not found."), frappe.DoesNotExistError)
	values = {}
	if deposit_percent not in (None, ""):
		pct = flt(deposit_percent)
		if pct < 0 or pct > 100:
			frappe.throw(_("Deposit percent must be between 0 and 100."))
		values["deposit_percent"] = pct
	if final_payment_days not in (None, ""):
		days = cint(final_payment_days)
		if days < 0:
			frappe.throw(_("Final payment days cannot be negative."))
		values["final_payment_days"] = days
	if values:
		frappe.db.set_value("Package Offer", offer, values)
	return {"status": "ok", "updated": bool(values)}


@frappe.whitelist()
def save_offer_inventory(offer: str, rows: str) -> dict:
	"""Kemaskini allotment kolam kabin — [Nov 2026] kolam TUNGGAL = cabin_rates
	pada Trip Cruise Schedule (child Trip Package Price: cabin_allotment
	kontrak; occupancy live dari Booking Reservation via hooks — TIDAK
	disentuh di sini; cabin_available dikira semula). Lock baris schedule;
	validasi allotment >= occupancy. Staf isi kuota SEKALI per sailing —
	dikongsi semua offer sailing itu. Offer darat (tanpa schedule) → throw
	(tiada stok per-variant; jualan terbuka)."""
	_require_product_admin()
	import json as _json
	data = _json.loads(rows or "[]")
	if not isinstance(data, list):
		frappe.throw(_("Invalid rows."))

	schedule = frappe.db.get_value("Package Offer", offer, "cruise_schedule")
	if isinstance(schedule, dict):
		schedule = schedule.get("cruise_schedule")
	if not schedule:
		frappe.throw(_(
			"Offer ini tiada Cruise Schedule — kuota per-variant tidak "
			"terpakai (jualan darat terbuka)."))

	# LOCK baris induk schedule — serialise dengan gate booking.
	frappe.db.sql(
		"SELECT name FROM `tabTrip Cruise Schedule` WHERE name = %s FOR UPDATE",
		(schedule,))

	updated = 0
	for r in data:
		name = r.get("name")
		if not name or not frappe.db.exists("Trip Package Price", {
				"name": name, "parent": schedule,
				"parenttype": "Trip Cruise Schedule"}):
			continue
		allot = int(r.get("allotment") or 0)
		row = frappe.db.get_value("Trip Package Price", name,
								  ["cabin_occupancy", "pricing_for_class"],
								  as_dict=True)
		occupancy = int(row.cabin_occupancy or 0)
		if allot < occupancy:
			frappe.throw(
				_("Allotment for {0} cannot be less than sold ({1}).").format(
					row.pricing_for_class or name, occupancy)
			)
		frappe.db.set_value("Trip Package Price", name,
			{"cabin_allotment": allot,
			 "cabin_available": allot - occupancy},
			update_modified=False)
		updated += 1
	return {"status": "ok", "updated": updated}


@frappe.whitelist()
def save_offer_matrix_components(offer: str, flight: int = None,
								  hotel: int = None, transport: int = None,
								  meal: int = None) -> dict:
	"""Aktif/matikan seksi PRICE MATRIX komponen offer (Nov 2026).
	Room Category TIDAK boleh dimatikan (harga asas — parameter diabaikan).
	Flag mengawal: tab dipapar pada halaman pakej & seksi matrix yang
	dibentangkan pada checkout (fasa wiring komponen). Aktif + 0 baris
	harga = amaran readiness (bukan sekatan — setup berperingkat)."""
	_require_product_admin()
	if not frappe.db.exists("Package Offer", offer):
		frappe.throw(_("Offer not found."), frappe.DoesNotExistError)
	values = {}
	for field, incoming in (("matrix_flight", flight),
							("matrix_hotel", hotel),
							("matrix_transport", transport),
							("matrix_meal", meal)):
		if incoming is not None:
			values[field] = 1 if cint(incoming) else 0
	if values:
		frappe.db.set_value("Package Offer", offer, values,
							update_modified=False)
	return {"status": "ok", **{k: v for k, v in values.items()}}


@frappe.whitelist()
def save_offer_price_matrix(offer: str, rows: str,
							addon: int = None) -> dict:
	"""Simpan Price Matrix offer (Nov 2026) — child Trip Package Price:
	1 baris per kategori, lajur slot penuh (adult/single/upper/child/
	toddler/infant).

	ROUTING (rombakan konsep Nov 2026):
	  - addon=0/kosong → BASE `price_matrix` (Room Category — harga asas)
	  - addon=1        → `addon_price_matrix` (Flight/Hotel/Transport/Meal
	    — total pakej = base + Σ addons)

	`rows` JSON array:
	  {pricing_for_class, price_adult, price_adult_single, price_upperberth,
	   price_children, price_toddler, price_infant, [remove: 1]}
	- Upsert ikut pricing_for_class (docname ATAU category_code — kod
	  kanonik v47 di-resolve ke docname).
	- remove:1 → baris kategori itu dipadam.
	- Kolum allotment/availability SENGAJA tidak disentuh — kapasiti offer
	  cruise ialah kolam cabin_rates schedule kongsi.

	AUTO-SYNC MATRIX COMPONENTS (Nov 2026 arahan pemilik): bila ADDON
	table tersentuh, checkbox matrix_flight/hotel/transport/meal pada
	doctype di-set ikut jenis kategori yang wujud dalam jadual (aktif ⇔
	ada baris). Respons memasukkan `matrix_components` (dict nilai baharu;
	null bila mutasi base).
	"""
	_require_product_admin()
	import json as _json
	data = _json.loads(rows or "[]")
	if not isinstance(data, list):
		frappe.throw(_("Invalid rows."))

	cat_by_code, cat_by_name, cat_pcat = {}, {}, {}
	for c in frappe.get_all("Trip Price Category",
			fields=["name", "category_code", "price_category"]):
		if c.category_code:
			cat_by_code[c.category_code] = c.name
		cat_by_name[c.name] = c.name
		cat_pcat[c.name] = c.price_category or ""

	# Jenis kategori → jadual sahnya. Cruise/Tour = base (Room Category);
	# Flight/Hotel/Transport/Meal = addon. Jenis tak dikenali → kedua-duanya
	# dibenarkan (kes legacy kategori master tanpa price_category).
	_BASE_TYPES = ("Cruise", "Tour")
	_ADDON_TYPES = ("Flight", "Hotel", "Transport", "Meal")

	def _belongs_to_addon(cat: str) -> bool:
		pcat = cat_pcat.get(cat)
		if pcat in _BASE_TYPES:
			return False
		if pcat in _ADDON_TYPES:
			return True
		return None  # tak dikenali — biar lulus

	def _resolve(code):
		return cat_by_code.get(code) or cat_by_name.get(code)

	doc = frappe.get_doc("Package Offer", offer)
	# Routing base vs addon (rombakan konsep Nov 2026).
	table_field = ("addon_price_matrix" if cint(addon) else "price_matrix")

	def _canon(code):
		"""Normalkan docname ATAU category_code ke docname — baris lama
		boleh simpan mana-mana bentuk, padanan mesti konsisten."""
		return cat_by_code.get(code) or cat_by_name.get(code) or code

	upserted, removed = 0, 0
	skipped = []
	# [Nov 2026] LARANG DUPLIKASI: baris sedia ada yang canonical-nya sama
	# (simpanan lama code vs docname baharu) dilebur — kekalkan baris
	# pertama. Satu kategori = SATU baris dalam senarai.
	seen_canon: set = set()
	uniq_rows = []
	for row in (getattr(doc, table_field) or []):
		key = _canon((row.pricing_for_class or "").strip())
		if key in seen_canon:
			continue
		seen_canon.add(key)
		uniq_rows.append(row)
	setattr(doc, table_field, uniq_rows)
	for r in data:
		raw_code = (r.get("pricing_for_class") or "").strip()
		if not raw_code:
			continue
		cat = _resolve(raw_code) or raw_code
		if r.get("remove"):
			# remove sentiasa dibenarkan — termasuk membuang baris
			# contaminant yang tersalah jadual (pembersihan data).
			setattr(doc, table_field,
				[row for row in (getattr(doc, table_field) or [])
				 if _canon((row.pricing_for_class or "").strip()) != cat])
			removed += 1
			continue
		# [FIX Nov 2026] GUARD contamination silang (upsert sahaja):
		# kategori jenis addon (Flight/Hotel/Transport/Meal) ditolak
		# daripada BASE dan sebaliknya (Cruise/Tour ditolak daripada
		# addon) — simpanan silang panel tidak lagi menyusup ke jadual
		# yang salah.
		if _belongs_to_addon(cat) is not bool(cint(addon)):
			skipped.append(cat)
			continue
		vals = {col: (flt(r.get(col)) if r.get(col) is not None else None)
				for col in ("price_adult", "price_adult_single",
							"price_upperberth", "price_children",
							"price_toddler", "price_infant")}
		match = next((row for row in (getattr(doc, table_field) or [])
					  if _canon((row.pricing_for_class or "").strip()) == cat),
					 None)
		if match:
			for col, v in vals.items():
				setattr(match, col, v)
			upserted += 1
		else:
			doc.append(table_field,
				{"pricing_for_class": cat, **vals})
			upserted += 1
	doc.save(ignore_permissions=True)

	# [Nov 2026 arahan pemilik] AUTO-SYNC MATRIX COMPONENTS — checkbox
	# `matrix_flight/hotel/transport/meal` pada doctype Package Offer
	# mengikut kandungan SEBENAR jadual `addon_price_matrix`: seksi aktif
	# ⇔ wujud baris kategori jenis itu. Tambah element → enable; buang
	# baris TERAKHIR jenis itu → disable. Hanya bila ADDON table
	# tersentuh (mutasi base tidak mengubah addon). Toggle manual
	# (save_offer_matrix_components) kekal, tapi auto-sync menang pada
	# mutasi addon seterusnya — flag sentiasa jujur dengan data.
	matrix_components = None
	if cint(addon):
		matrix_components = _sync_matrix_component_flags(offer)
	return {"status": "ok", "upserted": upserted, "removed": removed,
			"skipped": skipped, "table": table_field,
			"matrix_components": matrix_components}


def _sync_matrix_component_flags(offer: str) -> dict:
	"""Auto-sync checkbox MATRIX COMPONENTS doctype Package Offer dengan
	kandungan sebenar `addon_price_matrix` (helper kongsi).

	Dipakai: (1) save_offer_price_matrix — selepas setiap mutasi addon;
	(2) data-fix retroaktif — baris yang ditambah SEBELUM ciri ini wujud
	(pemilik: checkbox tidak enable sendiri — ditemui Nov 2026).

	Matrix Room terkunci (harga asas — sentiasa aktif, tidak disentuh).
	pricing_for_class baris legacy boleh simpan docname ATAU category_code
	— kedua-duanya di-resolve ke price_category kategori."""
	cat_by_code, cat_pcat = {}, {}
	for c in frappe.get_all("Trip Price Category",
			fields=["name", "category_code", "price_category"]):
		if c.category_code:
			cat_by_code[c.category_code] = c.name
		cat_pcat[c.name] = c.price_category or ""
	active = set()
	for row in frappe.get_all("Trip Package Price",
			filters={"parent": offer, "parenttype": "Package Offer",
					 "parentfield": "addon_price_matrix"},
			fields=["pricing_for_class"]):
		key = (row.pricing_for_class or "").strip()
		pcat = cat_pcat.get(cat_by_code.get(key) or key, "")
		if pcat in ("Flight", "Hotel", "Transport", "Meal"):
			active.add(pcat)
	values = {f"matrix_{t.lower()}": (1 if t in active else 0)
			  for t in ("Flight", "Hotel", "Transport", "Meal")}
	frappe.db.set_value("Package Offer", offer, values, update_modified=False)
	return values
