# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from urllib.parse import urlparse


class TripPackage(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.travel_booking_management.doctype.trip_package_group_date_select.trip_package_group_date_select import TripPackageGroupDateSelect
		from travel_booking.travel_booking_management.doctype.trip_package_price.trip_package_price import TripPackagePrice

		airport_form: DF.Link | None
		currency: DF.Link | None
		is_a_cruise_trip: DF.Check
		is_cruise_only: DF.Check
		my_url: DF.Data | None
		organizer_link: DF.Link | None
		package_code: DF.Data | None
		package_description: DF.TextEditor | None
		package_pricing: DF.Table[TripPackagePrice]
		package_title: DF.SmallText | None
		package_type: DF.Literal["", "Fly Package", "Ground Only", "Fly Cruise", "Cruise Only", "Customed"]
		select_group_by_date: DF.TableMultiSelect[TripPackageGroupDateSelect]
		status: DF.Literal["Pending Review", "Active", "Inactive"]
		trip_image: DF.AttachImage | None
		trip_link: DF.Link | None
		trip_name: DF.Data | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Package"


	def validate(self):

		if self.package_type == "Fly Cruise":
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
			airport = " / " + self.airport_form
		else :
			airport = ""


		if not self.currency:
			self.currency = "MYR"

		if package_type == "GP":
			self.airport_form = None
					
		if not self.package_code:
			self.package_code = (self.trip_link + " / " + package_type + airport ).upper().replace(" ","").replace("/",":").strip()

		if not self.package_title:
			self.package_title = (self.trip_name or "") + " / " + (self.package_type or "") + airport

		# Generate the my_url field based on the current domain and trip name
		url = frappe.request.url
		domain = domain = urlparse(url).hostname
		self.my_url = "https://" + domain + "/booking/?trip=" + self.name