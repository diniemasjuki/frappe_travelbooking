# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe

import re
from frappe.utils import getdate
from frappe.utils import date_diff
from frappe.utils import nowdate
from frappe.model.document import Document
from datetime import datetime, timedelta


class TripGroupDate(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		cruise_code: DF.Data | None
		cruise_days: DF.Int
		cruise_nights: DF.Int
		cruise_schedule: DF.Link | None
		cruise_schedule_title: DF.Data | None
		cruise_trip: DF.Data | None
		current_participants: DF.Int
		days_before_closure: DF.Int
		departure_date: DF.Date | None
		disembarkation_port: DF.Link | None
		embarkation_port: DF.Link | None
		filter_by_trip: DF.Check
		group_organizer: DF.Link | None
		is_a_cruise_trip: DF.Check
		is_cruise_only: DF.Check
		max_participants: DF.Int
		naming_series: DF.Literal["RC.YY.##"]
		return_date: DF.Date | None
		sailing_end: DF.Date | None
		sailing_start: DF.Date | None
		ship_code: DF.Data | None
		ship_name: DF.Data | None
		status: DF.Literal["Active", "Full", "Closed", "Running", "Completed", "Pending Review", "Cancelled"]
		total_days: DF.Int
		total_nights: DF.Int
		trip: DF.Link
		trip_group_code: DF.Data | None
		trip_group_name: DF.Data | None
		trip_name: DF.Data | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Group Date"




	
	def validate(self):

		"""
		JANGAN USIK
		"""
  
		"""
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
    
		if self.departure_date and self.return_date:
			date_format_departure = departure_date.strftime("%d %b %Y") + " - " + return_date.strftime("%d %b %Y")

		if self.sailing_start and self.sailing_end:
			date_format_sailing = sailing_start.strftime("%d %b %Y") + " - " + sailing_end.strftime("%d %b %Y")

		# this is for FLY CRUISE trip = group title use sailing date
		if (self.is_a_cruise_trip or self.is_a_cruise_trip == 1) and (not self.is_cruise_only or self.is_cruise_only == 0):
			self.trip_group_name = date_format_departure + (" : " + self.trip or "") + " : Fly Cruise"
			self.trip_group_code = (str(self.departure_date) + "-" + str(self.return_date) + ":" + self.trip + ":" + "FC").replace("-", "")

		# this is for CRUISE ONLY trip
		elif (self.is_a_cruise_trip or self.is_a_cruise_trip == 1) and (self.is_cruise_only is True or self.is_cruise_only == 1):
			self.trip_group_name =  date_format_sailing + (" : " + self.trip or "") + " : Cruise Only"
			self.trip_group_code = (str(self.sailing_start) + "-" + str(self.sailing_end) + ":" + self.trip + ":" + "CO").replace("-", "")

		# this is for RARECATION / NON-CRUISE trip
		else:
			self.trip_group_name = date_format_departure + (" : " + self.trip or "") + (" : " + self.name or "")
			self.trip_group_code = (str(self.departure_date) + "-" + str(self.return_date) + ":" + self.trip + ":" + self.name).replace("-", "")

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
		Rules dikira dalam _compute_auto_status(); method ini hanya
		apply hasilnya pada doc semasa validate.
		"""
		try:
			new_status = self._compute_auto_status()
			if new_status and new_status != self.status:
				self.status = new_status
		except Exception:
			# Log error tapi jangan block save
			frappe.log_error(
				frappe.get_traceback(),
				f'TripGroupDate: Auto-status error for {self.name}'
			)

	def _compute_auto_status(self):
		"""
		Kira status automatik ikut rules di bawah. Pulangkan status baharu
		hanya jika berbeza dari status semasa; None jika tiada perubahan.

		Rules (priority order) — selagi status bukan 'Cancelled':
		1. COMPLETED: today > return_date (final, tak boleh regres)
		2. RUNNING:   departure_date <= today <= return_date (trip sedang berjalan)
		3. FULL:      Capacity penuh (occupancy >= capacity)
		4. CLOSED:    closure_date <= today <= departure_date, di mana
		              closure_date = departure_date - days_before_closure,
		              dan hanya jika days_before_closure > 0
		"""
		# Skip jika status adalah Cancelled (manual override)
		if self.status == 'Cancelled':
			return None

		today = getdate(nowdate())
		return_date = getdate(self.return_date) if self.return_date else None
		departure_date = getdate(self.departure_date) if self.departure_date else None

		# ============================================================
		# RULE 1: COMPLETED - Return date sudah lepas (final)
		# ============================================================
		if return_date and return_date < today:
			return 'Completed'

		# ============================================================
		# RULE 2: RUNNING - Trip sedang berjalan
		# (dari departure date hingga return date, termasuk kedua-duanya)
		# ============================================================
		if departure_date and departure_date <= today and (not return_date or today <= return_date):
			return 'Running'

		# ============================================================
		# RULE 3: FULL - Capacity penuh (occupancy >= capacity)
		# ============================================================
		if self.max_participants and self.max_participants > 0:
			if (self.current_participants or 0) >= self.max_participants:
				return 'Full'

		# ============================================================
		# RULE 4: CLOSED - Dalam window days_before_closure sebelum
		# departure (days_before_closure == 0 bermakna auto-close OFF)
		# ============================================================
		if departure_date:
			days_before_closure = self._get_days_before_closure_setting()
			if days_before_closure > 0:
				closure_date = departure_date - timedelta(days=days_before_closure)
				if closure_date <= today <= departure_date:
					return 'Closed'

		return None

	def _get_days_before_closure_setting(self) -> int:
		"""
		Dapatkan bilangan hari sebelum departure untuk auto-close.

		Priority (dari tinggi ke rendah):
		1. ✅ Field 'days_before_closure' dalam Trip Group Date ini
		   (per-trip-date override; 0 = auto-close OFF)
		2. Global setting dalam Travel Website doctype (fallback, jika field masih wujud)
		3. Default: 7 hari
		"""
		try:
			# ============================================================
			# PRIORITY 1: Per-Trip-Date Setting (Override)
			# Setiap trip group date boleh ada tarikh tutup berbeza!
			# ============================================================
			if hasattr(self, 'days_before_closure') and self.days_before_closure is not None:
				days = int(self.days_before_closure or 0)
				if days > 0:
					return days
				# 0 = auto-close dimatikan untuk trip ini (per-trip override) —
				# JANGAN fallback ke global/default
				return 0

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


def auto_update_trip_group_statuses(tgd_name=None):
	"""
	Scheduled task (cron '0 0 * * *', rujuk hooks.py scheduler_events) —
	jalankan semakan auto-status untuk SEMUA Trip Group Date setiap hari
	jam 12:00 malam. tgd_name (opsyenal) untuk test/panggilan manual
	terhadap satu doc sahaja. Pulangkan senarai doc yang berubah status.
	"""
	filters = {"status": ["not in", ["Cancelled", "Completed"]]}
	if tgd_name:
		filters["name"] = tgd_name

	changed = []
	for name in frappe.get_all("Trip Group Date", filters=filters, pluck="name"):
		try:
			doc = frappe.get_doc("Trip Group Date", name)
			new_status = doc._compute_auto_status()
			if new_status and new_status != doc.status:
				old_status = doc.status
				doc.db_set("status", new_status)
				changed.append({"name": name, "old_status": old_status, "new_status": new_status})
		except Exception:
			frappe.log_error(
				frappe.get_traceback(),
				f'TripGroupDate: Daily auto-status failed for {name}'
			)
	return changed