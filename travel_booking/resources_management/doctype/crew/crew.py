import frappe
from frappe.model.document import Document


class Crew(Document):
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
