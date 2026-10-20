# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class TravelEmailNotification(Document):
    # begin: auto-generated types
    # This code is auto-generated. Do not modify anything in this block.

    from typing import TYPE_CHECKING

    if TYPE_CHECKING:
        from frappe.types import DF

        description: DF.SmallText | None
        email_template: DF.Link | None
        enabled: DF.Check
        label: DF.Data
        notification_key: DF.Literal["booking_status_pending", "booking_status_accepted", "booking_status_processing", "booking_status_confirmed", "booking_status_completed", "payment_receipt", "set_password", "passport_submission"]
        parent: DF.Data
        parentfield: DF.Data
        parenttype: DF.Data
        traveller_email_template: DF.Link | None
    # end: auto-generated types

    pass
