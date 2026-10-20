# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe


def execute():
	"""Seed baris lalai tab "Email Notifications" (Travel Settings) untuk
	site sedia ada. Fungsi shared di install.py adalah idempotent — langkau
	jika senarai sudah diisi (baris seed sebelum ni ATAU konfigurasi sendiri
	admin), jadi selamat dipanggil walhal patch dah pernah jalan."""
	if not frappe.db.exists("Travel Settings", "Travel Settings"):
		return

	from travel_booking.install import _seed_email_notification_settings
	_seed_email_notification_settings()
