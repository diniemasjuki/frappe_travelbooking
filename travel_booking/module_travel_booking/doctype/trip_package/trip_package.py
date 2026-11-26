# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class TripPackage(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.module_travel_booking.doctype.trip_package_component.trip_package_component import TripPackageComponent
		from travel_booking.module_travel_booking.doctype.trip_package_group_date_select.trip_package_group_date_select import TripPackageGroupDateSelect
		from travel_booking.module_travel_booking.doctype.trip_package_price.trip_package_price import TripPackagePrice

		airport_form: DF.Link | None
		components: DF.Table[TripPackageComponent]
		currency: DF.Link
		ground_arrangement: DF.Check
		is_a_cruise_trip: DF.Check
		is_cruise_only: DF.Check
		organizer_link: DF.Link | None
		package_code: DF.Data | None
		package_description: DF.TextEditor | None
		package_pricing: DF.Table[TripPackagePrice]
		package_title: DF.SmallText | None
		package_type: DF.Literal["", "Fly Package", "Ground Only", "Cruise + Flight", "Cruise Only", "Customed"]
		price_review_required: DF.Check
		select_group_by_date: DF.TableMultiSelect[TripPackageGroupDateSelect]
		status: DF.Literal["Pending Review", "Active", "Inactive"]
		trip_image: DF.AttachImage | None
		trip_link: DF.Link | None
		trip_name: DF.Data | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Package"


	def validate(self):

		if self.package_type == "Cruise + Flight":
			package_type = "FC"
		elif self.package_type == "Cruise Only":
			package_type = "CO"
		elif self.package_type == "Fly Package":
			package_type = "FP"
		elif self.package_type == "Ground Only":
			package_type = "GP"
		elif self.package_type == "Customed":
			package_type = "CU"
		else:
			package_type = ""

		if( self.airport_form ):
			airport = self.airport_form
		else :
			airport = ""

		if not self.currency:
			self.currency = "MYR"

		# Currency = paksi utama pakej (1 pakej = 1 currency). Hanya
		# currency yang diisytiharkan dalam Travel Settings > Multi
		# Currency Account sah (tiada company/pivot untuk yang lain).
		from travel_booking.api.currency_axis import get_declared_currencies
		declared = get_declared_currencies()
		if declared and self.currency not in declared:
			frappe.throw(
				"Currency '{0}' is not declared in Travel Settings > Multi "
				"Currency Account. Available: {1}.".format(
					self.currency, ", ".join(sorted(declared))
				),
				title="Invalid Package Currency",
			)

		if package_type == "CO" or package_type == "GP":
			self.airport_form = None
			airport = self.currency
					
		if not self.package_code:
			self.package_code = (self.trip_link + " : " + package_type + " : " + airport ).upper().replace(" ","").strip()

		if not self.package_title or self.package_title == "" :
			self.package_title = (self.trip_name or "") + " : " + (self.package_type or "") + " : " + airport

	
		self.validate_price_currencies()

		domain = frappe.utils.get_url()
		self.my_url = domain + "/booking/?trip=" + self.name

	def validate_price_currencies(self):
		"""Harga per-currency (patch v41): baris Trip Package Price boleh
		bawa currency berbeza dari native parent. Semak:

		1. Setiap currency baris mesti diisytiharkan dalam paksi
		   (Travel Settings > Multi Currency Account) — SO hanya boleh
		   dikeluarkan oleh company currency yang diisytiharkan.
		2. AMARAN (bukan throw) bila kategori sama muncul dengan currency
		   berbeza — itu matrix sah (MYR + SGD per kategori), tapi kalau
		   TIDAK disengajakan ia tanda salah isian.

		Baris kosong currency = native parent — semantic sedia ada,
		tidak divalidasi di sini (parent currency dah divalidasi
		di validate() atas)."""
		from travel_booking.api.currency_axis import get_declared_currencies
		declared = get_declared_currencies()

		row_currencies = set()
		by_category = {}
		for row in (self.package_pricing or []):
			cur = (row.currency or "").strip()
			if not cur:
				continue  # native parent — bukan scope sini
			row_currencies.add(cur)
			by_category.setdefault(row.pricing_for_class, set()).add(cur)

		# 1. Currency mesti diisytiharkan dalam axis.
		for cur in sorted(row_currencies):
			if declared and cur not in declared:
				frappe.throw(
					"Price row currency '{0}' is not declared in Travel "
					"Settings > Multi Currency Account. Available: {1}.".format(
						cur, ", ".join(sorted(declared))),
					title="Invalid Price Currency",
				)

		