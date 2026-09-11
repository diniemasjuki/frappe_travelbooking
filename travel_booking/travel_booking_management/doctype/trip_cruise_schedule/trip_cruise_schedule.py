# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe

import re
from frappe.utils import getdate
from frappe.utils import date_diff

from frappe.model.document import Document


class TripCruiseSchedule(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.travel_booking_management.doctype.trip_package_price.trip_package_price import TripPackagePrice

		cabin_rates: DF.Table[TripPackagePrice]
		cruise_line_company: DF.Link | None
		currency: DF.Link | None
		naming_series: DF.Literal[".ship_code.YY.#"]
		port_end: DF.Link
		port_start: DF.Link
		sail_end: DF.Date
		sail_start: DF.Date
		schedule_code: DF.Data | None
		ship_code: DF.Literal["AC01", "HV01"]
		ship_name: DF.Data | None
		status: DF.Literal["Pending Review", "Active", "Sailing", "Completed", "Closed", "Canceled"]
		total_days: DF.Int
		total_nights: DF.Int
		trip_code: DF.Data | None
		trip_link: DF.Link | None
		trip_name: DF.Data | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Cruise Schedule"

	def validate(self):

			# jangan usik - start

			if self.trip_code:
				self.trip_code = self.trip_code.upper().strip()
				code = self.trip_code

			if self.sail_start and self.sail_end:
				self.schedule_code = ( frappe.utils.getdate(self.sail_start).strftime("%Y %m %d") + " - " + frappe.utils.getdate(self.sail_end).strftime("%Y %m %d") + " : " +  self.ship_code ).upper().strip()

				if self.sail_start > self.sail_end:
					frappe.throw("SAILING START DATE must earlier then SAILING END DATE")

				days = date_diff(self.sail_end, self.sail_start)

				if not self.total_days:
					self.total_days = days + 1

				if not self.total_nights:
					self.total_nights = days


				if self.total_days < (days -2) or self.total_days > (days +2):
					self.total_days = days + 1

				if self.total_nights < (days -2) or self.total_nights > (days +2):
					self.total_nights = days
     
				self._auto_update_status()

				# jangan usik - end

			# AUTO-STATUS: Update status on save based on dates
			self._auto_update_status()

	def _auto_update_status(self):
		"""AUTO-STATUS HOOK: Update status berdasarkan business rules pada save."""
		try:
			new_status = self._compute_auto_status()
			if new_status and new_status != self.status:
				self.status = new_status
		except Exception:
			frappe.log_error(
				frappe.get_traceback(),
				f'CruiseSchedule: Auto-status error for {self.name}'
			)

	def _compute_auto_status(self):
		"""Kira status automatik ikut rules.

		Returns:
			str or None: New status jika perlu diubah, None jika tidak.
		"""
		# Respect manual final states
		if self.status in ['Canceled', 'Completed']:
			return None

		today = getdate()

		if self.sail_start and self.sail_end:
			# Rule 1: After sailing end date → Completed
			if today > getdate(self.sail_end):
				return 'Completed'
			# Rule 2: Within sailing period → sailing
			elif getdate(self.sail_start) <= today <= getdate(self.sail_end):
				return 'Sailing'

		return None


def auto_update_cruise_schedule_statuses(schedule_name=None):
	"""Setiap hari jam 0000 — update status Trip Cruise Schedule ikut tarikh hari ini.

	Rules (hanya untuk status bukan Canceled / Completed):
	- Jika hari ini dalam lingkungan sail_start – sail_end → sailing
	- Jika hari melepasi sail_end                 → Completed
	"""
	today = getdate()
	filters = {"status": ["not in", ["Canceled", "Completed"]]}
	if schedule_name:
		filters["name"] = schedule_name

	changed = []
	for name in frappe.get_all("Trip Cruise Schedule", filters=filters, pluck="name"):
		try:
			doc = frappe.get_doc("Trip Cruise Schedule", name)
			new_status = None

			if doc.sail_start and doc.sail_end:
				if today > getdate(doc.sail_end):
					new_status = "Completed"
				elif today >= getdate(doc.sail_start) and today <= getdate(doc.sail_end):
					new_status = "sailing"

			if new_status and new_status != doc.status:
				old_status = doc.status
				doc.db_set("status", new_status)
				changed.append({
					"name": name,
					"old_status": old_status,
					"new_status": new_status,
				})
		except Exception:
			frappe.log_error(
				frappe.get_traceback(),
				f"CruiseSchedule: Daily auto-status failed for {name}",
			)

	return changed

