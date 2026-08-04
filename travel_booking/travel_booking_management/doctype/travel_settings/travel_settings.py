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

		account_name: DF.Data
		account_number: DF.Data
		bank_name: DF.Link
		cashback_discount_account: DF.Link | None
		default_deposit_percent: DF.Percent
		default_referral_discount_percent: DF.Percent
		email_verified_session_minutes: DF.Int
		manual_transfer_cashback_enabled: DF.Check
		manual_transfer_cashback_percent: DF.Percent
		manual_transfer_paid_to_account: DF.Link | None
		otp_expiry_minutes: DF.Int
		payment_gateway: DF.Link | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Travel Settings"
