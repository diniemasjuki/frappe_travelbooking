# travel_booking/api/package_admin.py
# API pengurusan Travel Package / Package Offer (F2) — STAF SAHAJA.
# Ciptaan offer guna offer_factory (satu laluan dengan patch migrasi).

import frappe
from frappe import _
from frappe.utils import cint

from travel_booking.api.trip_command_center import (
	TRIP_COMMAND_CENTER_ROLES,
	_check_command_center_roles,
)


def _require_product_admin():
	_check_command_center_roles(TRIP_COMMAND_CENTER_ROLES, "Package Management")


@frappe.whitelist()
def generate_offer_from_template(package: str, departure_date: str, return_date: str = None) -> dict:
	"""Cipta Package Offer baharu daripada templat pakej (harga disalin,
	inventori kosong — staf isi allotment). Offer tercipta status Draft;
	Active perlu kelulusan Tour Manager (workflow).

	Note: kerana nama offer berjujukan, JANGAN dedahkan nama ini ke URL awam
	— guna public_slug (pelajaran audit F9).
	"""
	_require_product_admin()
	from travel_booking.utils.offer_factory import create_offer

	if not departure_date:
		frappe.throw(_("Departure date is required."))

	offer_name = create_offer(package, {
		"departure_date": departure_date,
		"return_date": return_date,
	})
	return {"status": "ok", "offer": offer_name}


@frappe.whitelist()
def cross_check_structure(limit: int = 500) -> dict:
	"""Cross-check struktur baharu vs sumber lama (harga/allotment/sold)
	melalui provenance legacy_* — bukti migrasi tak drift (F3)."""
	_require_product_admin()
	from travel_booking.utils.product_readiness import cross_check_legacy
	return cross_check_legacy(cint(limit) or 500)
