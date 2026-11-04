# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


# ══════════════════════════════════════════════
# HELPERS DIKONGSI — sumber TUNGGAL untuk kod & tajuk pakej (P1/M3).
# Trip Package.validate() dan Trip._propagate_package_title() dulu
# menyimpan salinan logik yang sama (map package_type→kod + format
# tajuk) — bila satu pihak berubah, tajuk yang diagihkan oleh Trip
# drift daripada yang disimpan semasa save. Kedua-dua pihak kini
# panggil fungsi yang sama di sini.
# ══════════════════════════════════════════════

def get_package_type_code(package_type: str) -> str:
	"""Map package_type → kod 2-huruf (FC/CO/FP/GP/CU) untuk package_code."""
	return {
		"Cruise + Flight": "FC",
		"Cruise Only": "CO",
		"Fly Package": "FP",
		"Ground Only": "GP",
		"Customed": "CU",
	}.get(package_type or "", "")


def build_package_title(trip_name: str, package_type: str, airport_form: str, currency: str) -> str:
	"""package_title format: "{trip_name} : {package_type} : {airport_or_currency}"
	— CO/GP guna currency sebagai suffix (pakej tanpa penerbangan); yang
	lain guna airport_form. Pariti EXACT dengan kedua-dua implementasi lama."""
	code = get_package_type_code(package_type)
	if code in ("CO", "GP"):
		suffix = currency or "MYR"
	else:
		suffix = airport_form or ""
	return " : ".join([trip_name or "", package_type or "", suffix])


class TripPackage(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.module_travel_booking.doctype.trip_package_group_date_select.trip_package_group_date_select import TripPackageGroupDateSelect
		from travel_booking.module_travel_booking.doctype.trip_package_price.trip_package_price import TripPackagePrice

		airport_form: DF.Link | None
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

		# P1/M3: kod pakej via helper dikongsi (sumber tunggal, rujuk atas fail)
		package_type = get_package_type_code(self.package_type)

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
			# P1/M3: format tajuk via helper dikongsi — pariti dengan logik
			# lama (CO/GP → currency suffix; selain itu → airport_form)
			self.package_title = build_package_title(
				self.trip_name, self.package_type, self.airport_form, self.currency
			)

	
		domain = frappe.utils.get_url()
		self.my_url = domain + "/booking/?trip=" + self.name

		