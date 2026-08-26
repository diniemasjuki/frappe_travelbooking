# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe

import re
from datetime import datetime, timedelta
from frappe.utils import getdate
from frappe.utils import date_diff
from frappe.utils import nowdate
from frappe.model.document import Document


class TripGroupDate(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		cruise_code: DF.Data | None
		cruise_days: DF.Int
		cruise_schedule: DF.Link | None
		cruise_schedule_title: DF.Data | None
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
		my_url: DF.Data | None
		naming_series: DF.Literal[None]
		return_date: DF.Date | None
		sailing_end: DF.Date | None
		sailing_start: DF.Date | None
		ship_code: DF.Data | None
		ship_name: DF.Data | None
		status: DF.Literal["Active", "Full", "Closed", "Completed", "Pending Review", "Cancelled"]
		total_days: DF.Int
		total_nights: DF.Int
		trip: DF.Link
		trip_group_code: DF.Data | None
		trip_group_description: DF.TextEditor | None
		trip_group_name: DF.Data | None
		trip_name: DF.Data | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Group Date"




	
	def validate(self):


		"""
		JANGAN USIK
		Setting kalau trip ini CRUISE ONLY:
		DEPARTURE DATE akan SAMA dengan SAILING START 
		"""
		if self.is_cruise_only == 1:
			if self.sailing_start:
				self.departure_date = self.sailing_start
			if self.sailing_end:
				self.return_date = self.sailing_end

		""" 
		Convert Date Format into string-to-time format for logical processing
		"""
		if self.sailing_start:
			sailing_start = getdate(self.sailing_start)
		if self.sailing_end:
			sailing_end = getdate(self.sailing_end)
		if self.departure_date:
			departure_date = getdate(self.departure_date)			
		if self.return_date:
			return_date = getdate(self.return_date)

		"""
		Date validation process 
		"""
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

		"""
		JANGAN USIK
		"""
		# this is for FLY CRUISE trip = group title use sailing date
		if (self.is_a_cruise_trip or self.is_a_cruise_trip == 1) and (not self.is_cruise_only or self.is_cruise_only == 0):
			self.trip_group_name = str(self.departure_date) + (" : " + self.trip or "") + " : Fly Cruise"
			self.trip_group_code = (str(self.departure_date) + ":" + self.trip + ":" + "FC").replace("-", "")

		# this is for CRUISE ONLY trip
		elif (self.is_a_cruise_trip or self.is_a_cruise_trip == 1) and (self.is_cruise_only is True or self.is_cruise_only == 1):
			self.trip_group_name = str(self.sailing_start) + (" : " + self.trip or "") + " : Cruise Only"
			self.trip_group_code = (str(self.sailing_start) + ":" + self.trip + ":" + "CO").replace("-", "")

		# this is for RARECATION / NON-CRUISE trip
		else:
			self.trip_group_name = str(self.departure_date) + (" : " + self.trip or "") + (" : " + self.name or "")
			self.trip_group_code = (str(self.departure_date) + ":" + self.trip + ":" + self.name).replace("-", "")

		"""
		JANGAN USIK - TAMAT
		"""

		# ============================================================
		# AUTO-STATUS HOOK: Update status berdasarkan business rules
		# ============================================================
		self._auto_update_status()



	def refresh_bookings(self):
		"""Kira jumlah pax (Booking Reservation) untuk semua Booking bawah Trip Group Date ini."""
		total = frappe.db.sql("""
			SELECT COUNT(r.name)
			FROM `tabBooking Reservation` r
			JOIN `tabBooking` b ON b.name = r.booking
			WHERE b.trip_date = %s
				AND b.status != 'Cancelled'
		""", self.name)[0][0] or 0
		frappe.db.set_value("Trip Group Date", self.name, "current_participants", total, update_modified=False)

	@property
	def available_slots(self):
		# max_participants == 0 -> UNLIMITED (None), sepadan dengan konvensi
		# "0 = unlimited" (sold_out/seats_left). Elak pulangkan
		# nilai negatif/0 yang mengelirukan admin (nampak "penuh" padahal
		# unlimited sebenarnya).
		if not (self.max_participants or 0):
			return None
		return (self.max_participants or 0) - (self.current_participants or 0)

	def _auto_update_status(self):
		"""
		AUTO-STATUS HOOK: Update status berdasarkan business rules.

		Rules (priority order):
		1. COMPLETED: Return date sudah lepas
		2. FULLED:   Capacity == Occupancy (dan capacity > 0)
		3. CLOSED:   Departure date < XX hari dari hari ini (dari Travel Website setting)

		Status yang set akan override manual status kecuali 'Cancelled'.
		"""
		try:
			today = getdate(nowdate())

			# Skip jika status adalah Cancelled (manual override)
			if self.status == 'Cancelled':
				return

			# ============================================================
			# RULE 1: COMPLETED - Return date sudah lepas
			# ============================================================
			if self.return_date:
				return_date = getdate(self.return_date)
				if return_date < today:
					self.status = 'Completed'
					return  # Stop processing, completed is final

			# ============================================================
			# RULE 2: FULLED - Capacity penuh (occupancy == capacity)
			# ============================================================
			if self.max_participants and self.max_participants > 0:
				# Jika occupancy sama atau melebihi capacity
				if self.current_participants and self.current_participants >= self.max_participants:
					self.status = 'Full'
					return  # Full takes priority over Closed

			# ============================================================
			# RULE 3: CLOSED - Departure date < XX hari dari today
			# ============================================================
			if self.departure_date:
				departure = getdate(self.departure_date)

				# Dapatkan setting 'days_before_closure' dari Travel Website
				days_before_closure = self._get_days_before_closure_setting()

				# Kira tarikh closure
				closure_date = departure - timedelta(days=days_before_closure)

				# Jika hari ini sudah lepas closure date, status = Closed
				if today >= closure_date:
					# Jika belum Full, set sebagai Closed
					if self.status != 'Full':
						self.status = 'Closed'

		except Exception as e:
			# Log error tapi jangan block save
			frappe.log_error(
				frappe.get_traceback(),
				f'TripGroupDate: Auto-status error for {self.name}'
			)
			# Jangan change status jika ada error

	def _get_days_before_closure_setting(self) -> int:
		"""
		Dapatkan bilangan hari sebelum departure untuk auto-close.

		Priority (dari tinggi ke rendah):
		1. ✅ Field 'days_before_closure' dalam Trip Group Date ini (per-trip-date override)
		2. Global setting dalam Travel Website doctype (fallback, jika field masih wujud)
		3. Default: 7 hari
		"""
		try:
			# ============================================================
			# PRIORITY 1: Per-Trip-Date Setting (Override)
			# Setiap trip group date boleh ada tarikh tutup berbeza!
			# ============================================================
			if hasattr(self, 'days_before_closure') and self.days_before_closure:
				days = int(self.days_before_closure)
				if days > 0:  # 0 bermakna disable auto-close
					return days

			# ============================================================
			# PRIORITY 2: Global Setting (Fallback dari Travel Website)
			# Note: Field ini mungkin telah dibuang dari Travel Website,
			#       jadi gunakan try/except untuk backward compatibility
			# ============================================================
			try:
				settings = frappe.get_doc('Travel Website')
				if hasattr(settings, 'days_before_closure') and settings.days_before_closure:
					global_days = int(settings.days_before_closure)
					if global_days > 0:
						return global_days
			except Exception:
				pass  # Travel Website mungkin belum wujud atau field dah dibuang

			# ============================================================
			# PRIORITY 3: Hardcoded Default
			# ============================================================
			return 7  # Default: 7 hari sebelum departure (changed from 3)

		except (ValueError, TypeError):
			return 7  # Default jika parsing gagal