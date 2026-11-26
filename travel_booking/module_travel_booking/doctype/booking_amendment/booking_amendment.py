# Copyright (c) 2026, WargaPrihatan and contributors
# For license information, please see license.txt

import json

import frappe
from frappe.model.document import Document


class BookingAmendment(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		amendment_type: DF.Literal["Change Date", "Change Package", "Change Date & Package"]
		applied_by: DF.Link | None
		applied_on: DF.Datetime | None
		before_snapshot: DF.Code | None
		booking: DF.Link
		credit_note: DF.Link | None
		new_trip_group_date: DF.Link | None
		new_trip_package: DF.Link | None
		price_difference: DF.Currency | None
		reason: DF.SmallText | None
		sales_order: DF.Link | None
		settlement_amount: DF.Currency | None
		settlement_method: DF.Literal["None", "Additional Payment", "Credit Note", "Waiver"]
		status: DF.Literal["Draft", "Applied", "Cancelled"]
	# end: auto-generated types

	_DOCTYPE_NAME = "Booking Amendment"

	def validate(self):
		if self.status == "Applied":
			self.validate_applied_immutable()
			return
		self.autofill_before_snapshot()
		self.validate_targets()
		self.compute_price_difference()

	def validate_applied_immutable(self):
		"""Dokumen Applied adalah rekod sejarah — hanya reason boleh
		ditambah selepas apply."""
		if self.flags.get("amendment_apply"):
			return  # apply flow itu sendiri
		frozen = ("booking", "amendment_type", "new_trip_group_date",
		          "new_trip_package", "price_difference",
		          "settlement_method", "settlement_amount",
		          "sales_order", "credit_note", "before_snapshot")
		if not self.is_new():
			_db_vals = frappe.db.get_value(
				"Booking Amendment", self.name, list(frozen), as_dict=True)
			for f in frozen:
				if (self.get(f) or "") != (_db_vals.get(f) or ""):
					frappe.throw(
						"Applied amendment is a historical record — only "
						"'Reason / Notes' can be edited.",
						title="Amendment Applied",
					)

	def autofill_before_snapshot(self):
		"""Snapshot keadaan booking semasa dokumen dicipta — sebelum
		sebarang perubahan. Sumber audit untuk before/after."""
		if self.before_snapshot:
			return
		b = frappe.get_doc("Booking", self.booking)
		reservations = frappe.get_all(
			"Booking Reservation", {"booking": self.booking},
			["name", "room_category", "cabin_no", "pax_type", "stateroom_no",
			 "status"],
		)
		self.before_snapshot = json.dumps({
			"trip_date":     b.trip_date,
			"trip_package":  b.trip_package,
			"booked_pax":    b.booked_pax,
			"status":        b.status,
			"payment_status": b.payment_status,
			# total_amount/balance_amount ialah @property virtual (bukan
			# kolom DB) — baca dari objek dokumen. paid = total − balance.
			"total_amount":  float(b.total_amount or 0),
			"paid_amount":   max(0.0, float(b.total_amount or 0)
			                     - float(b.balance_amount or 0)),
			"reservations":  [dict(r) for r in reservations],
		}, indent=1, default=str)

	def validate_targets(self):
		"""Sasaran mesti berbeza dari keadaan semasa (perubahan sebenar)
		dan sah (pakej baharu mesti aktif untuk tarikh baharu)."""
		b = frappe.db.get_value(
			"Booking", self.booking,
			["trip_date", "trip_package", "status"], as_dict=True)
		if not b:
			frappe.throw("Booking not found.")
		if b.status in ("Cancelled", "Abandoned", "Completed"):
			frappe.throw(
				"Cannot amend a {0} booking.".format(b.status),
				title="Invalid Booking Status",
			)

		new_date = self.new_trip_group_date or b.trip_date
		new_pkg = self.new_trip_package or b.trip_package

		if new_date == b.trip_date and new_pkg == b.trip_package:
			frappe.throw(
				"Amendment must change the trip date or the package.",
				title="No Change",
			)

		# Konsistensi jenis
		if self.new_trip_group_date and self.new_trip_package:
			self.amendment_type = "Change Date & Package"
		elif self.new_trip_group_date:
			self.amendment_type = "Change Date"
		elif self.new_trip_package:
			self.amendment_type = "Change Package"

		# Pakej baharu mesti aktif dan dijual untuk tarikh baharu
		if self.new_trip_package:
			pkg_status = frappe.db.get_value(
				"Trip Package", self.new_trip_package, "status")
			if pkg_status != "Active":
				frappe.throw(
					"New package is not Active.",
					title="Invalid Package",
				)
		if self.new_trip_group_date:
			tgd_status = frappe.db.get_value(
				"Trip Group Date", self.new_trip_group_date, "status")
			if tgd_status in ("Full", "Closed", "Completed", "Cancelled"):
				frappe.throw(
					"New trip date is {0}.".format(tgd_status),
					title="Invalid Trip Date",
				)
			# Kapasiti: pax booking tak boleh melebihi slots tersedia
			max_pax = frappe.db.get_value(
				"Trip Group Date", self.new_trip_group_date, "max_participants")
			booked_pax = frappe.db.get_value(
				"Booking", self.booking, "booked_pax") or 0
			if max_pax:
				existing = frappe.db.sql("""
					SELECT COALESCE(SUM(b.booked_pax), 0)
					FROM `tabBooking` b
					WHERE b.trip_date = %s AND b.status != 'Cancelled'
					  AND b.name != %s
				""", (self.new_trip_group_date, self.booking))[0][0] or 0
				if existing + booked_pax > max_pax:
					frappe.throw(
						"New trip date does not have enough slots for {0} "
						"pax ({1} left).".format(booked_pax, max_pax - existing),
						title="Trip Date Full",
					)

	def compute_price_difference(self):
		"""Beza harga kasar: jumlah pakej baharu − jumlah SO utama semasa.
		Perluasan kemudian: pemetaan pax-per-kategori terperinci. Nilai
		informative untuk keputusan settlement (final di re-price semasa
		apply)."""
		try:
			before = json.loads(self.before_snapshot or "{}")
		except Exception:
			before = {}
		old_total = float(before.get("total_amount") or 0)

		pkg = self.new_trip_package or before.get("trip_package")
		# Anggaran kasar: guna pricing pakej baharu × komposisi pax semasa
		if pkg:
			# Kiraan anggaran ringkas: jumlah sama dengan SO lama jika
			# tiada pakej baharu; untuk pakej baharu guna kadar adult
			# runcit × booked_pax (anggaran atas).
			booked_pax = int(before.get("booked_pax") or 0)
			rate = frappe.db.sql("""
				SELECT MIN(tpp.price_adult)
				FROM `tabTrip Package Price` tpp
				WHERE tpp.parent = %s AND tpp.parenttype = 'Trip Package'
			""", pkg)[0][0]
			if rate and booked_pax:
				new_total = float(rate) * booked_pax
				self.price_difference = round(new_total - old_total, 2)
				return
		self.price_difference = 0
