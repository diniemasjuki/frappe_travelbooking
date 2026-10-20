# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class PriceCategoryLabel(Document):
    # begin: auto-generated types
    # This code is auto-generated. Do not modify anything in this block.

    from typing import TYPE_CHECKING

    if TYPE_CHECKING:
        from frappe.types import DF

        applies_to: DF.Literal["Cruise", "Non_Cruise", "Both"]
        display_label: DF.Data
        display_note: DF.TextEditor | None
        is_active: DF.Check
        parent: DF.Data
        parentfield: DF.Data
        parenttype: DF.Data
        price_key: DF.Literal["price_adult", "price_adult_single", "price_upperberth", "price_children", "price_infant"]
        sort_order: DF.Int
    # end: auto-generated types

    pass
