# DEPRECATED: This file contains dead stub endpoints.
# The real implementation is in travel_booking.api.price_config.fetch_price_labels
# These functions are kept only for backward compatibility but return errors.

import frappe
from frappe import _


@frappe.whitelist(allow_guest=True)
def get_price_category_config(trip_type="non_cruise"):
    """DEPRECATED: Use price_config.fetch_price_labels instead."""
    frappe.throw(
        _("This endpoint is deprecated. Please use price_config.fetch_price_labels."),
        title="Deprecated API"
    )
