# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Travel Date — entiti induk hierarki ERD:
Trip >> Travel Date >> Packages (Package Offer) >> (Room Category × Age) + components.

SATU travel date = SATU tarikh pergi bagi sebuah trip:
- banyak pakej (offer) dijual atas tarikh ini;
- trip cruise: TEPAT SATU Trip Cruise Schedule — maklumat sailing/ship/port
  disinkron turun kepada SEMUA offer anak (field tarikh offer = salinan,
  consumer lama seperti katalog web & job status terus berjalan tanpa
  refactor);
- kabin ialah aset fizikal sailing: availabiliti rooming dikongsi melalui
  kolam cabin_rates schedule ini (allotment kontrak − occupancy live
  Booking Reservation) — sama untuk semua pakej sailing itu."""

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint


# Medan yang DISINKRON turun ke setiap Package Offer anak.
# trip disertakan supaya offer sentiasa memegang rujukan Trip yang
# diwarisi daripada Travel Date (satu sumber kebenaran).
SYNC_FIELDS = (
	"trip", "departure_date", "return_date", "days_before_closure",
	"total_days", "total_nights",
	"sailing_start", "sailing_end", "ship_name", "ship_code",
	"embarkation_port", "disembarkation_port", "cruise_schedule",
)


class TravelDate(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.module_travel_booking.doctype.trip_itinerary.trip_itinerary import TripItinerary

		cruise_schedule: DF.Link | None
		days_before_closure: DF.Int
		departure_date: DF.Date
		description: DF.SmallText | None
		destination: DF.Data | None
		disembarkation_port: DF.Data | None
		embarkation_port: DF.Data | None
		is_a_cruise_trip: DF.Check
		itinerary: DF.Table[TripItinerary]
		legacy_tgd: DF.Data | None
		naming_series: DF.Literal["TD-.YYYY.-.####"]
		overwrite_itinerary: DF.Check
		return_date: DF.Date | None
		sailing_end: DF.Date | None
		sailing_start: DF.Date | None
		ship_code: DF.Data | None
		ship_name: DF.Data | None
		status_editorial: DF.Literal["Draft", "Active", "Cancelled"]
		total_days: DF.Int
		total_nights: DF.Int
		travel_date_name: DF.Data | None
		trip: DF.Link
		trip_category: DF.Link | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Travel Date"

	def validate(self):
		if self.return_date and self.departure_date \
				and self.return_date < self.departure_date:
			frappe.throw(_("Return Date cannot be before Departure Date."))

		# [Nov 2026] days_before_closure wajib berangka (kolum NOT NULL) —
		# ciptaan API/wizard tanpa medan ini → 0 (tiada closure), elak
		# IntegrityError NULL pada insert.
		if self.days_before_closure is None:
			self.days_before_closure = 0

		# [Nov 2026] total_days/total_nights — auto kira bila kosong/0
		# daripada Departure/Return (formula TGD trip_group_date.validate:
		# nights = date_diff, days = nights + 1; trip same-day → 1 hari
		# 0 malam). Nilai eksplisit bukan sifar dihormati (override).
		# Kolum NOT NULL — ciptaan tanpa tarikh → 0 (elak IntegrityError).
		if self.departure_date and self.return_date:
			nights = frappe.utils.date_diff(
				self.return_date, self.departure_date)
			if not cint(self.total_nights):
				self.total_nights = nights
			if not cint(self.total_days):
				self.total_days = nights + 1
		elif self.total_days is None or self.total_nights is None:
			self.total_days = cint(self.total_days)
			self.total_nights = cint(self.total_nights)

		# Warisi sifat cruise daripada Trip — satu sumber kebenaran.
		# fetch_from hanya berkesan pada form Desk; ciptaan server-side
		# (API package_admin, patch v48) diliputi di sini. Readonly di UI.
		self.is_a_cruise_trip = cint(
			frappe.db.get_value("Trip", self.trip, "is_a_cruise_trip"))

		# Trip cruise WAJIB ada cruise schedule — tarikh tanpa schedule tak
		# boleh jadi tapak pakej cruise (kabin/inventori tiada sumber).
		if self.cruise_schedule:
			self._sync_from_schedule()
		elif self.is_a_cruise_trip:
			frappe.throw(_(
				"Travel Date untuk trip cruise mesti mempunyai Cruise "
				"Schedule (satu per tarikh) — maklumat kapal & availabiliti "
				"kabin datang darinya."))

		# Nama paparan: "DD MMM YYYY : TRIP" (auto, konsisten).
		if not self.travel_date_name:
			self.travel_date_name = "{} : {}".format(
				frappe.utils.formatdate(self.departure_date, "dd MMM yyyy"),
				self.trip)

		# ANCHOR LEGACY: Travel Date cruise yang dicipta terus daripada
		# struktur baharu (wizard Travel Manager) tiada provenance
		# legacy_tgd — cipta TGD shadow supaya rantaian legacy yang masih
		# bergantung pada Booking.trip_date → reservasi date_selection →
		# trip_cruise_schedule → kolam cabin_rates terus sah.
		if self.cruise_schedule and not self.legacy_tgd:
			self.legacy_tgd = _ensure_shadow_tgd_values(self) or ""

	def _sync_from_schedule(self):
		"""Tarik maklumat sailing/ship/port daripada Trip Cruise Schedule
		(corak _apply_cruise_fetch pada api/trip_manager.py — satu sumber
		kebenaran ops)."""
		sch = frappe.db.get_value(
			"Trip Cruise Schedule", self.cruise_schedule,
			["ship_name", "ship_code", "sail_start", "sail_end",
			 "port_start", "port_end"], as_dict=True)
		if not sch:
			frappe.throw(_("Cruise Schedule {0} not found.").format(
				self.cruise_schedule))
		self.ship_name = sch.ship_name or ""
		self.ship_code = sch.ship_code or ""
		self.sailing_start = sch.sail_start
		self.sailing_end = sch.sail_end
		self.embarkation_port = sch.port_start or ""
		self.disembarkation_port = sch.port_end or ""

	def on_update(self):
		self.sync_to_offers()

	def sync_to_offers(self):
		"""SYNC TURUN: medan tarikh/sailing pada SEMUA offer anak dikemas
		kini mengikut Travel Date (satu sumber). Tulis terus db.set_value
		tanpa picu hook (corak refresh_cabin_availability) — job status &
		katalog web membaca field offer dan terus nampak nilai baharu."""
		children = frappe.get_all(
			"Package Offer", filters={"travel_date": self.name}, pluck="name")
		values = {f: self.get(f) for f in SYNC_FIELDS}
		for name in children:
			frappe.db.set_value("Package Offer", name, values,
								update_modified=False)
		return len(children)

	# [BUANG Nov 2026] ensure_sailing_inventory — kolam Sailing Inventory
	# ditanggalkan (konsolidasi). Kolam kapasiti tunggal = cabin_rates
	# schedule ini (cabin_allotment kontrak − cabin_occupancy live
	# Booking Reservation via hooks sync_cabin_availability).


# ══════════════════════════════════════════════
# SHADOW TGD — anchor legacy untuk Travel Date cruise baharu
# ══════════════════════════════════════════════

def _ensure_shadow_tgd_values(td) -> str | None:
	"""Cipta (atau padankan) TGD shadow untuk SATU Travel Date cruise
	yang tiada legacy_tgd — dipanggil TravelDate.validate dan
	backfill_shadow_tgds().

	Mengapa masih perlu: aliran tulis legacy (confirm_booking → Booking
	.trip_date → Booking Reservation.date_selection → trip_cruise_schedule
	→ hooks sync_cabin_availability) masih berpaut pada Trip Group Date.
	Travel Date yang dicipta terus dalam struktur baharu (wizard Travel
	Manager, tanpa skrip migrasi v40) tiada anchor itu — jadi kita cipta
	satu TGD sepadan (kapasiti 0 = unlimited; penghad sebenar ialah kolam
	cabin_rates schedule, dipintu check_offer_capacity FOR UPDATE).

	td: objek dict-like dengan medan Travel Date yang diperlukan.
	Pulangkan nama TGD shadow, None bila bukan cruise / dah ada
	legacy_tgd."""
	if not td.cruise_schedule or td.legacy_tgd:
		return td.legacy_tgd or None

	# Elak dubel: TGD sedia ada untuk (trip, tarikh, sailing) yang sama
	# — cth backfill selepas TGD shadow dicipta secara berasingan.
	existing = frappe.db.get_value(
		"Trip Group Date",
		{"trip": td.trip, "departure_date": td.departure_date,
		 "cruise_schedule": td.cruise_schedule},
		"name",
	)
	if existing:
		return existing

	tgd = frappe.get_doc({
		"doctype": "Trip Group Date",
		"naming_series": "RC.YY.##",
		"trip": td.trip,
		"trip_group_name": td.travel_date_name or td.name,
		"departure_date": td.departure_date,
		"return_date": td.return_date,
		"sailing_start": td.sailing_start,
		"sailing_end": td.sailing_end,
		"ship_name": td.ship_name,
		"ship_code": td.ship_code,
		"embarkation_port": td.embarkation_port,
		"disembarkation_port": td.disembarkation_port,
		"cruise_schedule": td.cruise_schedule,
		"days_before_closure": td.days_before_closure or 0,
		"status": "Active",
		"is_a_cruise_trip": 1,
		# Kapasiti trip-level = UNLIMITED — penghad sebenar ialah kolam
		# cabin_rates schedule (check_offer_capacity, FOR UPDATE). Elak
		# gate overbooking TGD lama menghalang booking sah.
		"max_participants": 0,
	})
	tgd.insert(ignore_permissions=True)
	return tgd.name


def backfill_shadow_tgds() -> dict:
	"""Backfill satu kali (idempoten): cipta TGD shadow + tulis
	legacy_tgd untuk SEMUA Travel Date cruise yang masih tiada anchor.
	Pulangkan {checked, created, reused, skipped}."""
	tds = frappe.get_all(
		"Travel Date",
		filters={"cruise_schedule": ["is", "set"]},
		fields=["name", "trip", "departure_date", "return_date",
				"sailing_start", "sailing_end", "ship_name", "ship_code",
				"embarkation_port", "disembarkation_port",
				"cruise_schedule", "days_before_closure", "legacy_tgd",
				"travel_date_name"],
	)
	out = {"checked": len(tds), "created": 0, "reused": 0, "skipped": 0}
	for td in tds:
		if td.legacy_tgd:
			out["skipped"] += 1
			continue
		name = _ensure_shadow_tgd_values(td)
		if name:
			frappe.db.set_value("Travel Date", td.name, "legacy_tgd", name)
			out["created"] += 1
		else:
			out["reused"] += 1
	frappe.db.commit()
	return out
