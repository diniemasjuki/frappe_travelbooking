"""Enable `grant_commission` on the travel booking Items so ERPNext's
native commission calculation produces a non-zero `total_commission`.

ERPNext's `selling_controller.calculate_commission()` only sums the
`base_net_amount` of line items whose Item master has `grant_commission`
checked. The travel booking app creates three service Items
(TRAVEL-PKG, TRAVEL-ADDON, TRAVEL-INSURANCE) plus the addon-package Item
without that flag, so `total_commission` was always 0 - which made the
affiliate app's Nett commission base return nothing.

This patch backfills the flag on any of those Items that already exist.
New Items created afterwards get the flag at creation time via
`so_helpers._get_or_create_travel_item`.
"""

import frappe

from travel_booking.api.constants import (
	ADDON_ITEM_CODE,
	ADDON_PACKAGE_ITEM_CODE,
	INSURANCE_ITEM_CODE,
	TRAVEL_ITEM_CODE,
)

TRAVEL_ITEM_CODES = [
	TRAVEL_ITEM_CODE,
	ADDON_ITEM_CODE,
	INSURANCE_ITEM_CODE,
	ADDON_PACKAGE_ITEM_CODE,
]


def execute():
	for item_code in TRAVEL_ITEM_CODES:
		if frappe.db.exists("Item", item_code):
			frappe.db.set_value(
				"Item",
				item_code,
				"grant_commission",
				1,
				update_modified=False,
			)
