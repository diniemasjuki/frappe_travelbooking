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
