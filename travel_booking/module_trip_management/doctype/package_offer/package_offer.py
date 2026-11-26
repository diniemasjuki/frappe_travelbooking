# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class PackageOffer(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.module_travel_booking.doctype.trip_itinerary.trip_itinerary import TripItinerary
		from travel_booking.module_travel_booking.doctype.trip_package_price.trip_package_price import TripPackagePrice

		cruise_schedule: DF.Link | None
		days_before_closure: DF.Int
		departure_date: DF.Date | None
		deposit_percent: DF.Percent
		disembarkation_port: DF.Data | None
		embarkation_port: DF.Data | None
		final_payment_days: DF.Int
		flight: DF.Link | None
		group_block_code: DF.Data | None
		itinerary: DF.Table[TripItinerary]
		legacy_tgd: DF.Data | None
		legacy_trip_package: DF.Data | None
		matrix_flight: DF.Check
		matrix_hotel: DF.Check
		matrix_meal: DF.Check
		matrix_room: DF.Check
		matrix_transport: DF.Check
		naming_series: DF.Literal["OFF-.YYYY.-.####"]
		overwrite_itinerary: DF.Check
		currency: DF.Link | None
		offer_name: DF.Data | None
		addon_price_matrix: DF.Table[TripPackagePrice]
		package: DF.Link | None
		price_matrix: DF.Table[TripPackagePrice]
		public_slug: DF.Data | None
		return_date: DF.Date | None
		sailing_end: DF.Date | None
		sailing_start: DF.Date | None
		sale_mode: DF.Literal["Public", "Group Block", "Full Charter", "Private"]
		ship_code: DF.Data | None
		ship_name: DF.Data | None
		status_editorial: DF.Literal["Draft", "Active", "Cancelled"]
		status_operational: DF.Literal["Scheduled", "Running", "Sailing", "Closed", "Completed"]
		total_days: DF.Int
		total_nights: DF.Int
		travel_date: DF.Link | None
		trip: DF.Link | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Package Offer"

	# Medan yang DIWARISI DARIPADA Travel Date (satu sumber kebenaran).
	# trip TIDAK diambil terus dari mana-mana field lain — nilainya sentiasa
	# Travel Date.trip, diselesaikan di sini (server-side) supaya semua
	# laluan ciptaan (Desk / API / factory) mendapat nilai yang sama.
	INHERITED_FIELDS = (
		"trip", "departure_date", "return_date", "sailing_start",
		"sailing_end", "ship_name", "ship_code", "embarkation_port",
		"disembarkation_port", "cruise_schedule", "days_before_closure",
	)

	def validate(self):
		# Warisi trip + medan salinan ops DARIPADA Travel Date sahaja.
		# Offer legacy tanpa travel_date (v40) tidak disentuh.
		if self.travel_date:
			td = frappe.db.get_value(
				"Travel Date", self.travel_date,
				self.INHERITED_FIELDS, as_dict=True)
			if td:
				for f in self.INHERITED_FIELDS:
					setattr(self, f, td.get(f))
		if not self.departure_date:
			frappe.throw(
				"Offer memerlukan tarikh pergi — pilih Travel Date induknya.")
		if self.return_date and self.departure_date and self.return_date < self.departure_date:
			frappe.throw("Return Date tidak boleh sebelum Departure Date.")
		if not self.offer_name:
			# Travel Package sudah deprecated — label fallback guna Trip
			# (diwarisi) atau Travel Date.
			label = self.trip or self.travel_date or "Offer"
			self.offer_name = f"{label} : {self.departure_date}"

	def before_insert(self):
		# SECURITY (spec F9-learned): URL awam guna slug rawak, bukan nama berjujukan
		if not self.public_slug:
			self.public_slug = frappe.generate_hash(length=16)

	def on_update(self):
		# Fasa-B (amaran): perubahan status_operational manual direkod — auto-job
		# yang sepatutnya pegang paksi ini. Enforcement throw datang kemudian.
		if not self.is_new():
			old = frappe.db.get_value(self.doctype, self.name, "status_operational")
			if old and old != self.status_operational:
				frappe.logger("package_offer").info(
					f"Offer {self.name}: status_operational {old} -> {self.status_operational} "
					f"oleh {frappe.session.user}"
				)


def auto_update_offer_statuses():
	"""Auto-job harian (scheduler 00:40) — paksi OPERASIONAL Package Offer.

	Tangga keutamaan (pertama yang padan):
	  1. Completed  — return_date sudah lepas
	  2. Sailing    — hari ini dalam tetingkap sailing_start..sailing_end
	  3. Running    — departure <= hari ini <= return
	  4. Closed     — dalam tetingkap days_before_closure sebelum berangkat
	  5. Scheduled  — lalai (belum dekat tarikh)

	[Nov 2026] Status "Full" DIBUANG daripada offer — keadaan penuh ialah
	sifat KOLAM SAILING (cabin_rates schedule: allotment − occupancy),
	dikongsi semua offer satu sailing; dilihat terus pada schedule/Rooming
	panel, bukan kaunter per offer (max_pax/current_pax ditanggalkan).

	Aturan:
	  - HANYA offer status_editorial = 'Active' (Draft/Cancelled tak disentuh)
	  - tarikh/sailing dibaca DARIPADA Travel Date (fallback salinan offer
	    untuk offer legacy tanpa travel_date)
	  - idempotent: db.set_value(update_modified=False), tiada hook side-effect
	  - kembalikan ringkasan {checked, changed} untuk log scheduler
	"""
	from datetime import date, timedelta

	import frappe
	from frappe.utils import getdate, today

	today = getdate(today())
	# Tarikh/sailing DARIPADA Travel Date (satu sumber kebenaran) —
	# COALESCE fallback kepada salinan offer hanya bagi offer legacy
	# tanpa travel_date (v40). status_operational kekal milik offer.
	rows = frappe.db.sql(
		"""
		SELECT o.name, o.status_operational,
		       COALESCE(td.departure_date, o.departure_date) AS departure_date,
		       COALESCE(td.return_date, o.return_date) AS return_date,
		       COALESCE(td.sailing_start, o.sailing_start) AS sailing_start,
		       COALESCE(td.sailing_end, o.sailing_end) AS sailing_end,
		       COALESCE(td.days_before_closure, o.days_before_closure)
		           AS days_before_closure
		FROM `tabPackage Offer` o
		LEFT JOIN `tabTravel Date` td ON td.name = o.travel_date
		WHERE o.status_editorial = 'Active'
		ORDER BY o.name
		""",
		as_dict=True,
	)

	changed = 0
	tally: dict = {}
	for o in rows:
		if not o.departure_date:
			continue
		dep = getdate(o.departure_date)
		ret = getdate(o.return_date) if o.return_date else None

		if ret and ret < today:
			new = "Completed"
		elif o.sailing_start and o.sailing_end and \
				getdate(o.sailing_start) <= today <= getdate(o.sailing_end):
			new = "Sailing"
		elif dep <= today and (not ret or ret >= today):
			new = "Running"
		elif o.days_before_closure and dep > today and \
				today >= dep - timedelta(days=int(o.days_before_closure)):
			new = "Closed"
		else:
			new = "Scheduled"

		tally[new] = tally.get(new, 0) + 1
		if new != o.status_operational:
			frappe.db.set_value("Package Offer", o.name,
				"status_operational", new, update_modified=False)
			changed += 1

	return {"checked": len(rows), "changed": changed, "tally": tally}
