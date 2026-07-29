# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe

import re
from frappe.utils import getdate
from frappe.utils import date_diff

from frappe.model.document import Document


class TripGroupDate(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		cruise_days: DF.Int
		cruise_schedule: DF.Link | None
		cruise_trip: DF.Data | None
		current_participants: DF.Int
		departure_date: DF.Date | None
		disembarkation_port: DF.Link | None
		embarkation_port: DF.Link | None
		filter_by_trip: DF.Check
		group_organizer: DF.Link | None
		is_a_cruise_trip: DF.Check
		is_cruise_only: DF.Check
		max_participants: DF.Int
		naming_series: DF.Literal[None]
		return_date: DF.Date | None
		sailing_end: DF.Date | None
		sailing_start: DF.Date | None
		ship_code: DF.Data | None
		ship_name: DF.Data | None
		status: DF.Literal["Pending Review", "Active", "Full", "Cancelled", "Completed"]
		total_days: DF.Int
		total_nights: DF.Int
		trip: DF.Link
		trip_code: DF.Data | None
		trip_group_code: DF.Data | None
		trip_group_description: DF.TextEditor | None
		trip_group_name: DF.Data | None
		trip_name: DF.Data | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Group Date"

	def validate(self):

		# setting kalau trip ini CRUISE ONLY
		if self.is_cruise_only == 1:
			if self.sailing_start:
				self.departure_date = self.sailing_start
			if self.sailing_end:
				self.return_date = self.sailing_end

		# -- variable date
		if self.sailing_start:
			sailing_start = getdate(self.sailing_start)
		if self.sailing_end:
			sailing_end = getdate(self.sailing_end)
		if self.departure_date:
			departure_date = getdate(self.departure_date)			
		if self.return_date:
			return_date = getdate(self.return_date)


		# -- date checking

		if self.departure_date and self.return_date:

			if departure_date > return_date:
				frappe.throw("DEPARTURE DATE must earlier then RETURN DATE")

			if (not self.total_days or self.total_days == 0) or (not self.total_nights or self.total_nights == 0):
				self.total_nights = date_diff(self.return_date, self.departure_date)
				self.total_days = self.total_nights + 1
		
		if self.sailing_start and self.sailing_end:
			if sailing_start > sailing_end:
				frappe.throw("SAILING START DATE must earlier then SAILING END DATE")

		if self.departure_date and self.sailing_start and not self.is_cruise_only:
			if departure_date > sailing_start:
				frappe.throw("DEPARTURE DATE must earlier then SAILING START DATE")

		if self.return_date and self.sailing_end and not self.is_cruise_only:
			if sailing_end > return_date:
				frappe.throw("RETURN DATE must earlier then SAILING END DATE" )


		
		# -- trip group name

		date_range = str(self.departure_date) + " to " + str(self.return_date)

		if (self.is_a_cruise_trip or self.is_a_cruise_trip == 1) and (not self.is_cruise_only or self.is_cruise_only == 0):
			self.trip_group_name = date_range + " : " + (self.cruise_schedule or "") + " : Fly Cruise"
		
		elif (self.is_a_cruise_trip or self.is_a_cruise_trip == 1) and (self.is_cruise_only is True or self.is_cruise_only == 1) :
			self.trip_group_name = date_range + " : " + (self.cruise_schedule or "") + " : Cruise Only"

		else:
			self.trip_group_name = date_range + " : " + (self.trip_code or "") + " : Tour Trip"



		# -- trip group code 

		if not self.trip_group_code or self.trip_group_code == "":
			self.trip_group_code = self.trip + "-" + self.name
			
		if self.trip_group_code:
			self.trip_group_code = re.sub(r'[^a-zA-Z0-9\-]', '', self.trip_group_code).upper().replace(" ","")


		# -- update trip_link in Trip Cruise Schedule if this is a cruise trip
		if self.cruise_schedule and not self.cruise_trip:
			frappe.db.set_value(
				"Trip Cruise Schedule", # nama doctype
				self.cruise_schedule,   # id atau name Trip Cruise Schedule yang nak diupdate
				{
					"trip_link" : self.trip,
					"trip_name" : self.trip_name
				}
			)
		


	def refresh_bookings(self):
		"""Kira jumlah pax (Booking Reservation) untuk semua Booking bawah Trip Group Date ini."""
		total = frappe.db.sql("""
			SELECT COUNT(r.name)
			FROM `tabBooking Reservation` r
			JOIN `tabBooking` b ON b.name = r.booking
			WHERE b.trip_date = %s
				AND b.status != 'Cancelled'
		""", self.name)[0][0] or 0

		frappe.db.set_value("Trip Group Date", self.name, "current_participants", total,update_modified=False)

	@property
	def available_slots(self):
		return (self.max_participants or 0) - (self.current_participants or 0)