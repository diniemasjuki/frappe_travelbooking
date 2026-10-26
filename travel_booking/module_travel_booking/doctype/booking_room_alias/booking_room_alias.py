# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import re

import frappe
from frappe import _
from frappe.model.document import Document

# Pola ID bilik mekanikal — '[ref]-Room_[n]' (mirror assign_room_id()).
# Nama alias TIDAK BOLEH berbentuk ID mekanikal: ID milik booking lain
# pernah tersilak masuk sebagai 'nama' (patch v33 salah tafsir penempatan
# Open Sharing merentas booking) dan menghasilkan label bercampur seperti
# 'X-Room_1 (Y-Room_1)' pada papan rooming.
_ROOM_ID_PATTERN = re.compile(r"^.+-Room_\d+$")


class BookingRoomAlias(Document):
	"""Nama paparan tersuai bagi SATU bilik (booking + cabin_no).

	Dipisahkan daripada Booking Reservation.room_id: room_id kekal
	mekanikal/auto (dijana assign_room_id(), berubah ikut cabin) — nama
	paparan tersuai hidup di sini, sekali per bilik, supaya pergerakan
	tetamu tidak pernah mempengaruhi nama bilik.
	"""

	def validate(self):
		if self.cabin_no is None or self.cabin_no < 1:
			frappe.throw(_("Cabin No must be a positive number"))
		if _ROOM_ID_PATTERN.match((self.custom_name or "").strip()):
			frappe.throw(_("Room name cannot look like a mechanical Room ID "
			               "({0}) — use a display name instead").format(
				frappe.bold(self.custom_name)))
		dup = frappe.db.exists("Booking Room Alias", {
			"booking": self.booking, "cabin_no": self.cabin_no,
			"name": ["!=", self.name],
		})
		if dup:
			frappe.throw(_("Alias for {0} Room {1} already exists").format(
				frappe.bold(self.booking), frappe.bold(self.cabin_no)))
		same_name = frappe.db.exists("Booking Room Alias", {
			"booking": self.booking, "custom_name": self.custom_name,
			"name": ["!=", self.name],
		})
		if same_name:
			frappe.throw(_("Room name {0} is already used in this booking").format(
				frappe.bold(self.custom_name)))
