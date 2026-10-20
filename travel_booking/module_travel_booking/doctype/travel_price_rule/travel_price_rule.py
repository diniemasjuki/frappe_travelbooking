# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from frappe.utils import cint, flt


class TravelPriceRule(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.module_travel_booking.doctype.travel_price_rule_amount.travel_price_rule_amount import TravelPriceRuleAmount
		from travel_booking.module_travel_booking.doctype.travel_price_rule_group_date.travel_price_rule_group_date import TravelPriceRuleGroupDate
		from travel_booking.module_travel_booking.doctype.travel_price_rule_guest_type.travel_price_rule_guest_type import TravelPriceRuleGuestType
		from travel_booking.module_travel_booking.doctype.travel_price_rule_package.travel_price_rule_package import TravelPriceRulePackage
		from travel_booking.module_travel_booking.doctype.travel_price_rule_room_category.travel_price_rule_room_category import TravelPriceRuleRoomCategory
		from travel_booking.module_travel_booking.doctype.travel_price_rule_trip.travel_price_rule_trip import TravelPriceRuleTrip

		applicable_group_dates: DF.TableMultiSelect[TravelPriceRuleGroupDate]
		applicable_guest_types: DF.Table[TravelPriceRuleGuestType]
		applicable_packages: DF.TableMultiSelect[TravelPriceRulePackage]
		applicable_room_categories: DF.TableMultiSelect[TravelPriceRuleRoomCategory]
		applicable_trips: DF.TableMultiSelect[TravelPriceRuleTrip]
		discount_amounts: DF.Table[TravelPriceRuleAmount]
		discount_percent: DF.Percent
		discount_type: DF.Literal["Percentage", "Fixed Amount"]
		is_active: DF.Check
		min_days_before_departure: DF.Int
		priority: DF.Int
		promo_label: DF.Data | None
		rule_name: DF.Data
		valid_from: DF.Date
		valid_until: DF.Date
	# end: auto-generated types

	_DOCTYPE_NAME = "Travel Price Rule"

	def validate(self):
		if self.valid_from and self.valid_until and self.valid_from > self.valid_until:
			frappe.throw("Valid From cannot be after Valid Until.", title="Invalid Validity")

		if self.discount_type == "Percentage":
			if flt(self.discount_percent) <= 0:
				frappe.throw(
					"Discount Percent is required for a Percentage price rule.",
					title="Discount Percent Required",
				)
			if flt(self.discount_percent) > 100:
				frappe.throw(
					"Discount Percent cannot exceed 100.",
					title="Discount Percent Invalid",
				)
		elif self.discount_type == "Fixed Amount":
			rows = [
				r for r in (self.discount_amounts or [])
				if r.currency and flt(r.amount) > 0
			]
			if not rows:
				frappe.throw(
					"Fixed Amount price rule must have at least one Currency + "
					"Discount Amount row.",
					title="Discount Amount Required",
				)
			self._validate_amount_currencies(rows)

		if cint(self.min_days_before_departure) < 0:
			self.min_days_before_departure = 0

		if not (self.promo_label or "").strip():
			self.promo_label = self.rule_name

	def _validate_amount_currencies(self, rows):
		"""Setiap currency row mesti diisytiharkan dalam paksi axis
		(Travel Settings > Multi Currency Account) — nilai fixed hanya
		bermakna pada currency yang benar-benar boleh dijual."""
		from travel_booking.api.currency_axis import get_declared_currencies

		declared = get_declared_currencies()
		if not declared:
			return
		for r in rows:
			if r.currency not in declared:
				frappe.throw(
					"Currency '{0}' is not declared in Travel Settings > Multi "
					"Currency Account. Available: {1}.".format(
						r.currency, ", ".join(sorted(declared))
					),
					title="Invalid Discount Currency",
				)
