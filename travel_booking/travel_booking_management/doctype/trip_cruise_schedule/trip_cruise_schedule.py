# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe

import re
from frappe.utils import getdate
from frappe.utils import date_diff

from frappe.model.document import Document


class TripCruiseSchedule(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.travel_booking_management.doctype.trip_package_price.trip_package_price import TripPackagePrice

		cabin_rates: DF.Table[TripPackagePrice]
		cruise_line_company: DF.Link | None
		currency: DF.Link | None
		naming_series: DF.Literal[".ship_code.YY.#"]
		port_end: DF.Link
		port_start: DF.Link
		sail_end: DF.Date
		sail_start: DF.Date
		schedule_code: DF.Data | None
		ship_code: DF.Literal["AC01", "HV01"]
		ship_name: DF.Data | None
		status: DF.Literal["Pending Review", "Active", "Running", "Sailing", "Full", "Closed", "Completed", "Cancelled"]
		total_days: DF.Int
		total_nights: DF.Int
		trip_code: DF.Data | None
		trip_link: DF.Link | None
		trip_name: DF.Data | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Cruise Schedule"

	def validate(self):

			# jangan usik - start

			if self.trip_code:
				self.trip_code = self.trip_code.upper().strip()
				code = self.trip_code

			if self.sail_start and self.sail_end:
				self.schedule_code = ( frappe.utils.getdate(self.sail_start).strftime("%Y %m %d") + " - " + frappe.utils.getdate(self.sail_end).strftime("%Y %m %d") + " : " +  self.ship_code ).upper().strip()

				if self.sail_start > self.sail_end:
					frappe.throw("SAILING START DATE must earlier then SAILING END DATE")

				days = date_diff(self.sail_end, self.sail_start)

				if not self.total_days:
					self.total_days = days + 1

				if not self.total_nights:
					self.total_nights = days


				if self.total_days < (days -2) or self.total_days > (days +2):
					self.total_days = days + 1

				if self.total_nights < (days -2) or self.total_nights > (days +2):
					self.total_nights = days
     
				self._auto_update_status()

				# jangan usik - end

			# AUTO-STATUS: Update status on save based on dates
			self._auto_update_status()

	def _auto_update_status(self):
		"""AUTO-STATUS HOOK: Update status berdasarkan business rules pada save."""
		try:
			new_status = self._compute_auto_status()
			if new_status and new_status != self.status:
				self.status = new_status
		except Exception:
			frappe.log_error(
				frappe.get_traceback(),
				f'CruiseSchedule: Auto-status error for {self.name}'
			)

	def _compute_auto_status(self):
		"""Kira status automatik ikut rules.

		Returns:
			str or None: New status jika perlu diubah, None jika tidak.
		"""
		# Respect manual final states
		if self.status in ['Cancelled', 'Completed']:
			return None

		today = getdate()

		if self.sail_start and self.sail_end:
			# Rule 1: After sailing end date → Completed
			if today > getdate(self.sail_end):
				return 'Completed'
			# Rule 2: Within sailing period → sailing
			elif getdate(self.sail_start) <= today <= getdate(self.sail_end):
				return 'Sailing'

		return None


def sync_cruise_only_group_date(doc, method=None) -> str | None:
	"""doc_events on_update (berjalan selepas insert & setiap save) —
	sync Trip Group Date "Cruise Only" dengan data Trip Cruise Schedule.

	Syarat berjalan:
	- trip_link wujud & rekod Trip sah (linked data ada)
	- sail_start & sail_end ada (asas tarikh group)

	Kelakuan:
	- Group date untuk schedule ini SUDAH ADA → update trip link &
	  info berkaitan schedule (ship, tarikh pelayaran, port, kod).
	  Field set_only_once (is_cruise_only, is_a_cruise_trip,
	  naming_series, group_organizer) TIDAK disentuh — Frappe throw
	  jika diubah pada doc sedia ada. departure/return hanya di-sync
	  jika group date itu cruise only.
	- BELUM ADA → cipta baru dengan cruise_only enabled.

	Field dipetakan ikut konvensyen _apply_cruise_fetch() dalam
	api/trip_manager.py. Gagal (cth. validasi group date) di-log
	sahaja — jangan block save schedule.
	"""
	try:
		# Syarat 1: linked Trip mesti wujud
		if not doc.trip_link or not frappe.db.exists("Trip", doc.trip_link):
			return None

		# Syarat 2: tarikh pelayaran diperlukan untuk bina/sync group
		if not doc.sail_start or not doc.sail_end:
			return None

		trip = frappe.db.get_value(
			"Trip", doc.trip_link, ("trip_name", "trip_organizer"), as_dict=True
		)
		schedule_values = {
			"trip": doc.trip_link,
			"trip_name": trip.trip_name,
			"cruise_trip": doc.trip_link,
			"cruise_code": doc.trip_code,
			"cruise_schedule_title": doc.schedule_code,
			"ship_name": doc.ship_name,
			"ship_code": doc.ship_code,
			"sailing_start": doc.sail_start,
			"sailing_end": doc.sail_end,
			"embarkation_port": doc.port_start,
			"disembarkation_port": doc.port_end,
			"cruise_days": doc.total_days,
			"cruise_nights": doc.total_nights,
			# options status kedua-dua doctype diseragamkan — nilai boleh
			# di-sync terus (Cancelled/Completed di-maintain oleh auto-status
			# validate() Trip Group Date jika tarikh kata sebaliknya)
			"status": doc.status,
		}

		existing = frappe.get_all(
			"Trip Group Date",
			filters={"cruise_schedule": doc.name},
			order_by="creation asc",
			pluck="name",
			limit=1,
		)

		if existing:
			return _update_linked_group_date(existing[0], doc, schedule_values)

		return _create_cruise_only_group_date(doc, trip, schedule_values)
	except Exception:
		frappe.log_error(
			frappe.get_traceback(),
			f"CruiseSchedule: Auto-sync Cruise Only group date failed for {doc.name}",
		)
		return None


def _update_linked_group_date(group_date_name, doc, schedule_values) -> str:
	"""Update group date sedia ada dengan nilai terkini schedule.
	Save hanya jika ada nilai berubah — elak modified bergerak pada
	setiap save schedule walaupun tiada perubahan."""
	group_date = frappe.get_doc("Trip Group Date", group_date_name)

	if group_date.is_cruise_only:
		# cruise only: departure/return ikut sailing (sama seperti
		# sync dalam validate() Trip Group Date)
		schedule_values["departure_date"] = doc.sail_start
		schedule_values["return_date"] = doc.sail_end

	if group_date.status == "Cancelled":
		# Cancelled adalah manual override (sama seperti doctrine
		# _compute_auto_status) — jangan hidupkan semula group date
		# yang telah dibatalkan walaupun schedule kembali aktif
		schedule_values.pop("status", None)

	changed = False
	for fieldname, value in schedule_values.items():
		if str(group_date.get(fieldname) or "") != str(value or ""):
			group_date.set(fieldname, value)
			changed = True

	if changed:
		group_date.save(ignore_permissions=True)

	return group_date.name


def _create_cruise_only_group_date(doc, trip, schedule_values) -> str:
	"""Cipta group date CRUISE ONLY baharu daripada schedule."""
	org_series = None
	if trip.trip_organizer:
		org_series = frappe.db.get_value("Trip Organizer", trip.trip_organizer, "org_series")

	group_date = frappe.get_doc(
		{
			"doctype": "Trip Group Date",
			"naming_series": org_series or "RC.YY.##",
			"group_organizer": trip.trip_organizer,
			# ikut status schedule semasa (biasanya Pending Review untuk
			# schedule baharu)
			"status": doc.status or "Pending Review",
			# cruise only — set_only_once, wajib di-set semasa create
			"is_a_cruise_trip": 1,
			"is_cruise_only": 1,
			"cruise_schedule": doc.name,
			# cruise only: departure/return ikut sailing (validate group
			# date sync nilai ni juga, di-set eksplisit untuk kejelasan)
			"departure_date": doc.sail_start,
			"return_date": doc.sail_end,
			**schedule_values,
		}
	)
	group_date.insert(ignore_permissions=True)

	return group_date.name


def auto_update_cruise_schedule_statuses(schedule_name=None):
	"""Setiap hari jam 0000 — update status Trip Cruise Schedule ikut tarikh hari ini.

	Rules (hanya untuk status bukan Cancelled / Completed):
	- Jika hari ini dalam lingkungan sail_start – sail_end → Sailing
	- Jika hari melepasi sail_end                 → Completed
	"""
	today = getdate()
	filters = {"status": ["not in", ["Cancelled", "Completed"]]}
	if schedule_name:
		filters["name"] = schedule_name

	changed = []
	for name in frappe.get_all("Trip Cruise Schedule", filters=filters, pluck="name"):
		try:
			doc = frappe.get_doc("Trip Cruise Schedule", name)
			new_status = None

			if doc.sail_start and doc.sail_end:
				if today > getdate(doc.sail_end):
					new_status = "Completed"
				elif today >= getdate(doc.sail_start) and today <= getdate(doc.sail_end):
					new_status = "Sailing"

			if new_status and new_status != doc.status:
				old_status = doc.status
				doc.db_set("status", new_status)
				changed.append({
					"name": name,
					"old_status": old_status,
					"new_status": new_status,
				})
		except Exception:
			frappe.log_error(
				frappe.get_traceback(),
				f"CruiseSchedule: Daily auto-status failed for {name}",
			)

	return changed


# ════════════════════════════════════════════════════════════
# CABIN OCCUPANCY & AVAILABILITY SYNC
# Booking Reservation  ↔  Trip Cruise Schedule.cabin_rates
# ════════════════════════════════════════════════════════════
#
# Pemetaan kedua-dua belah:
#   Booking Reservation.trip_cruise_schedule → Trip Cruise Schedule (name)
#   Booking Reservation.room_category        → baris cabin_rates (Trip
#     Package Price).pricing_for_class
#
# Rule kiraan (sumber sebenar = rekod reservasi sebenar):
#   cabin_occupancy = bilangan Booking Reservation AKTIF (status !=
#                     "Cancelled") untuk pasangan (schedule, kelas)
#   cabin_available = cabin_allotment − cabin_occupancy
#
# cabin_allotment (Int, baris cabin_rates) ialah jumlah kabin yang
# diperuntukkan admin untuk kelas itu pada schedule ni. Kosong/0 = kelas
# TIDAK diurus — availability dibiarkan macam mana admin isi manual,
# occupancy tetap dikira. Nilai dikira SEMULA dari kiraan sebenar setiap
# kali (bukan increment/decrement), jadi sync ni idempotent — panggil
# berapa kali pun, hasil tetap sama walaupun sebahagian laluan terlebih
# dulu (cth. rekod lama sebelum hook wujud).


def sync_cabin_availability(doc, method=None) -> None:
	"""doc_events Booking Reservation (after_insert / on_update /
	after_delete) — kira semula occupancy & availability kelas cabin yang
	terlibat bila reservasi dicipta / diubah / dibatalkan / dipadam.

	- after_insert & on_update: kira pasangan (trip_cruise_schedule,
	  room_category) SEMASA; kalau salah satu link BERUBAH pada save ni,
	  pair LAMA pun dikira semula (slot kelas lama mula dikosongkan).
	- after_delete: rekod dah tiada dalam DB (frappe delete_doc buang
	  baris SEBELUM after_delete) — nilai field pada doc masih ada, jadi
	  pair terakhirnya dikira semula supaya kiraan jatuh dengan betul.

	Cancel cascade booking (booking_engine._cancel_booking_cascade) save
	setiap reservation dgn status "Cancelled" — on_update ni yang tangkap,
	tidak perlu hook berasingan pada Booking. Skip senyap bila schedule /
	kelas kosong (rekod lama sebelum field trip_cruise_schedule wujud).
	"""
	pairs = set()
	if doc.trip_cruise_schedule and doc.room_category:
		pairs.add((doc.trip_cruise_schedule, doc.room_category))

	old = doc.get_doc_before_save()
	if old is not None and old.trip_cruise_schedule and old.room_category:
		pairs.add((old.trip_cruise_schedule, old.room_category))

	for schedule_name, room_category in sorted(pairs):
		refresh_cabin_availability(schedule_name, room_category)


def recompute_cabin_availability(doc, method=None) -> None:
	"""doc_events Trip Cruise Schedule (on_update) — kira semula SEMUA
	kelas pada cabin_rates schedule ni setiap kali schedule disimpan.

	Adalah normalisasi: kalau admin tambah / ganti / susun semula baris
	cabin_rates, occupancy & availability terus selari dengan reservasi
	sebenar tanpa tunggu pergerakan reservasi seterusnya. Idempotent —
	tak ada write kalau nilai dah sama.
	"""
	refresh_cabin_availability(doc.name)


def refresh_cabin_availability(schedule_name, room_category=None) -> dict:
	"""Kira semula cabin_occupancy & cabin_available pada baris cabin_rates
	schedule — kelas tertentu sahaja bila room_category diberi, SEMUA kelas
	bila kosong. Pulangkan {kelas: (occupancy, available|None)}.

	Baris cabin_rates dijumpai ikut parenttype="Trip Cruise Schedule" —
	PENTING sebab Trip Package Price juga child Trip Package (harga pakej),
	jangan tersentuh baris parenttype lain. Update melalui
	frappe.db.set_value (skip hooks, update_modified=False) supaya sync tak
	mencetus kitaran save schedule semula — corak sama dengan
	refresh_bookings() Trip Group Date.

	Availability boleh jadi NEGATIF bila reservasi melebihi allotment —
	sengaja: isyarat overbooking yang admin patut nampak, bukan dibuang.
	Kelas yang muncul lebih sekali dalam cabin_rates (duplicate
	pricing_for_class) semua barisnya dapat kiraan yang sama — data
	demikian patut dibetulkan oleh admin.
	"""
	if not schedule_name or not frappe.db.exists("Trip Cruise Schedule", schedule_name):
		return {}

	# Kiraan reservasi aktif per kelas — SATU query GROUP BY. Raw SQL
	# sebab get_all v17 tak terima fungsi SQL dalam fields; corak sama
	# dengan refresh_bookings() Trip Group Date.
	counts = {
		r.room_category: int(r.total or 0)
		for r in frappe.db.sql(
			"""
			SELECT room_category, COUNT(name) AS total
			FROM `tabBooking Reservation`
			WHERE trip_cruise_schedule = %s
				AND status != 'Cancelled'
			GROUP BY room_category
			""",
			(schedule_name,),
			as_dict=True,
		)
		# baris dgn room_category kosong tak match kelas mana-mana;
		# bila kelas tertenti diminta, buang kiraan kelas lain
		if r.room_category and (not room_category or r.room_category == room_category)
	}

	rows = frappe.get_all(
		"Trip Package Price",
		filters={
			"parenttype": "Trip Cruise Schedule",
			"parent": schedule_name,
			**({"pricing_for_class": room_category} if room_category else {}),
		},
		fields=[
			"name",
			"pricing_for_class",
			"cabin_allotment",
			"cabin_occupancy",
			"cabin_available",
		],
	)

	applied = {}
	for row in rows:
		kelas = row.pricing_for_class
		occupancy = counts.get(kelas, 0)
		allotment = int(row.cabin_allotment or 0)

		updates = {}
		if int(row.cabin_occupancy or 0) != occupancy:
			updates["cabin_occupancy"] = occupancy
		if allotment > 0:
			available = allotment - occupancy
			if int(row.cabin_available or 0) != available:
				updates["cabin_available"] = available

		if updates:
			frappe.db.set_value("Trip Package Price", row.name, updates, update_modified=False)
		applied[kelas] = (occupancy, allotment - occupancy if allotment > 0 else None)

	return applied

