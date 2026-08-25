import frappe
from frappe.model.document import Document


class Crew(Document):
    # begin: auto-generated types
    # This code is auto-generated. Do not modify anything in this block.

    from typing import TYPE_CHECKING

    if TYPE_CHECKING:
        from frappe.types import DF

        crew_name: DF.Data
        department: DF.Literal["Operations", "Transport", "Hospitality"]
        email: DF.Data | None
        grade: DF.Literal["Captain", "Co-Captain"]
        notes: DF.SmallText | None
        phone: DF.Phone | None
        photo: DF.AttachImage | None
        role_position: DF.Literal["Tour Leader", "Chief Journey", "Driver", "Guide", "Staff", "Other"]
        status: DF.Literal["Active", "Inactive", "On Leave"]
        user: DF.Link | None
    # end: auto-generated types

    def validate(self):
        """Validate crew record before save"""
        self.validate_email()
        self.auto_fetch_user_email()

    def validate_email(self):
        """Validate email format if provided"""
        if self.email:
            # Frappe handles email validation via options: "Email" in field definition
            # Additional check for uniqueness if needed
            existing = frappe.get_all(
                "Crew",
                filters={"email": self.email, "name": ["!=", self.name]},
                limit=1,
            )
            if existing:
                frappe.throw(f"Email {self.email} already exists in another Crew record")

    def auto_fetch_user_email(self):
        """Auto-fetch email from linked user if not set"""
        if self.user and not self.email:
            user_doc = frappe.get_doc("User", self.user)
            if user_doc.email:
                self.email = user_doc.email

    def before_save(self):
        """Auto-populate fields before saving"""
        self.auto_fetch_user_email()
