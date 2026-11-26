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
		from travel_booking.module_travel_booking.doctype.trip_package_price.trip_package_price import TripPackagePrice

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
		trip_name_cruise_company: DF.Data | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Cruise Schedule"

	def validate(self):

			# Peraturan relationship #1 (Nov 2026): schedule yang AKTIF
			# (boleh dijual) mesti terkait sekurang-kurangnya SATU Package
			# Offer editorial-Active — tanpa offer, sailing tiada harga &
			# inventori, jualan akan gagal tersembunyi pada gate kapasiti.
			# Bukan-Active (Pending Review/Completed/dsb.) tidak disekat.
			# Throw hanya semasa UPDATE manual (bukan insert pertama —
			# offer dijana selepas schedule dicipta).
			if self.status in ("Active", "Running", "Sailing", "Full", "Closed") \
					and not self.get("__islocal") and not self.flags.skip_offer_check:
				has_offer = frappe.db.exists("Package Offer", {
					"cruise_schedule": self.name,
					"status_editorial": "Active",
				})
				if not has_offer:
					frappe.throw(
						"Cruise Schedule '{0}' tidak mempunyai sebarang Package "
						"Offer aktif. Setiap cruise schedule mesti terkait "
						"sekurang-kurangnya satu offer sebelum status ditukar "
						"ke Active — jana offer pada Travel Date tarikh ini "
						"dahulu (Travel Manager → halaman tarikh → Add Offer).".format(
							self.name),
						title="Sailing Tanpa Offer Aktif",
					)

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


# [BUANG Stage 2 Nov 2026] sync_cruise_only_group_date +
# _update_linked_group_date + _create_cruise_only_group_date — jentera
# sync schedule → Trip Group Date (struktur lama). Schedule kini
# berpaut Travel Date (Travel Date.cruise_schedule); pautan/proofing
# TGD tidak lagi dijana daripada schedule.


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
	Occupancy mengira KABIN (DISTINCT room_id — tetamu berkongsi kabin),
	bukan baris penumpang.

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

	# Kiraan KABIN terisi per kelas — inventori cruise schedule mengira
	# BILIK/KABIN, bukan penumpang: reservasi tetamu berkongsi kabin
	# (room_id sama), jadi kira DISTINCT room_id. Fallback COALESCE ke
	# name (satu reservasi = satu kabin) bila room_id kosong (rekod lama).
	# SATU query GROUP BY. Raw SQL sebab get_all v17 tak terima fungsi
	# SQL dalam fields; corak sama dengan refresh_bookings() Trip Group
	# Date.
	counts = {
		r.room_category: int(r.total or 0)
		for r in frappe.db.sql(
			"""
			SELECT room_category,
			       COUNT(DISTINCT COALESCE(NULLIF(room_id, ''), name)) AS total
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

