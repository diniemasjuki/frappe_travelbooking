import frappe
from frappe.model.document import Document


class CrewAllocation(Document):
    def validate(self):
        """Validate allocation before save"""
        self.fetch_crew_details()

    def fetch_crew_details(self):
        """Auto-fetch crew name from linked crew"""
        if self.crew and not self.crew_name:
            crew_doc = frappe.get_doc("Crew", self.crew)
            if crew_doc.crew_name:
                self.crew_name = crew_doc.crew_name
