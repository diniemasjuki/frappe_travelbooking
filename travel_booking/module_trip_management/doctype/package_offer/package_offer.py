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

		from travel_booking.module_trip_management.doctype.offer_inventory.offer_inventory import OfferInventory
		from travel_booking.module_trip_management.doctype.offer_price.offer_price import OfferPrice
		from travel_booking.module_trip_management.doctype.offer_component.offer_component import OfferComponent

		naming_series: DF.Literal["OFF-.YYYY.-.####"]
		package: DF.Link | None  # Travel Package
		offer_name: DF.Data | None
		status_editorial: DF.Literal["Draft", "Active", "Cancelled"]
		status_operational: DF.Literal["Scheduled", "Running", "Sailing", "Full", "Closed", "Completed"]
		departure_date: DF.Date
		return_date: DF.Date
		total_days: DF.Int
		total_nights: DF.Int
		sailing_start: DF.Date
		sailing_end: DF.Date
		cruise_schedule: DF.Link | None  # Trip Cruise Schedule
		flight: DF.Link | None  # Flight
		ship_name: DF.Data | None
		ship_code: DF.Data | None
		embarkation_port: DF.Data | None
		disembarkation_port: DF.Data | None
		max_pax: DF.Int
		current_pax: DF.Int
		days_before_closure: DF.Int
		public_slug: DF.Data | None
		legacy_tgd: DF.Data | None
		legacy_trip_package: DF.Data | None
		inventory: DF.Table[OfferInventory]
		prices: DF.Table[OfferPrice]
		components: DF.Table[OfferComponent]
	# end: auto-generated types

	_DOCTYPE_NAME = "Package Offer"

	def validate(self):
		if self.return_date and self.departure_date and self.return_date < self.departure_date:
			frappe.throw("Return Date tidak boleh sebelum Departure Date.")
		if not self.offer_name:
			pkg_name = frappe.db.get_value("Travel Package", self.package, "package_name") or self.package
			self.offer_name = f"{pkg_name} : {self.departure_date}"
		for inv in self.inventory or []:
			inv.available = int(inv.allotment or 0) - int(inv.sold or 0)

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
	  5. Full       — max_pax > 0 dan current_pax >= max_pax
	  6. Scheduled  — lalai (belum dekat tarikh)

	Aturan:
	  - HANYA offer status_editorial = 'Active' (Draft/Cancelled tak disentuh)
	  - idempotent: db.set_value(update_modified=False), tiada hook side-effect
	  - kembalikan ringkasan {checked, changed} untuk log scheduler
	"""
	from datetime import date, timedelta

	import frappe
	from frappe.utils import getdate, today

	today = getdate(today())
	rows = frappe.get_all(
		"Package Offer",
		filters={"status_editorial": "Active"},
		fields=["name", "departure_date", "return_date", "sailing_start",
				"sailing_end", "status_operational", "max_pax",
				"current_pax", "days_before_closure"],
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
		elif int(o.max_pax or 0) > 0 and int(o.current_pax or 0) >= int(o.max_pax):
			new = "Full"
		else:
			new = "Scheduled"

		tally[new] = tally.get(new, 0) + 1
		if new != o.status_operational:
			frappe.db.set_value("Package Offer", o.name,
				"status_operational", new, update_modified=False)
			changed += 1

	return {"checked": len(rows), "changed": changed, "tally": tally}
