# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document


class TravelSettings(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.travel_booking_management.doctype.travel_currency_account.travel_currency_account import TravelCurrencyAccount
		from travel_booking.travel_booking_management.doctype.price_category_label.price_category_label import PriceCategoryLabel

		account_name: DF.Data
		account_number: DF.Data
		bank_name: DF.Link
		cashback_discount_account: DF.Link | None
		currency_accounts: DF.Table[TravelCurrencyAccount]
		default_deposit_percent: DF.Percent
		default_referral_discount_percent: DF.Percent
		email_verified_session_minutes: DF.Int
		manual_transfer_cashback_enabled: DF.Check
		manual_transfer_cashback_percent: DF.Percent
		manual_transfer_paid_to_account: DF.Link | None
		otp_expiry_minutes: DF.Int
		payment_gateway: DF.Link | None
		price_category_labels: DF.Table[PriceCategoryLabel]
	# end: auto-generated types

	_DOCTYPE_NAME = "Travel Settings"
