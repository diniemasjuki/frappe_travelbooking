import frappe
from frappe.model.document import Document
from frappe.utils import getdate, nowdate
from dateutil.parser import parse
from datetime import datetime, timedelta


class CrewSlot(Document):
    def validate(self):
        """Main validation entry point"""
        self.validate_dates()
        self.validate_capacity()
        self.validate_crew_conflicts()
        self.auto_update_status()
        self.calculate_current_crew()

    def validate_dates(self):
        """Validate date logic"""
        if not self.start_date or not self.end_date:
            return

        start = getdate(self.start_date)
        end = getdate(self.end_date)

        if start > end:
            frappe.throw("Start Date must be before End Date")

    def validate_capacity(self):
        """Validate crew capacity"""
        max_crew = self.max_crew or 1
        current_count = len(self.crew_allocations or [])

        if current_count > max_crew:
            frappe.throw(
                f"Slot capacity exceeded! Maximum crew allowed: {max_crew}, "
                f"but you have {current_count} allocations."
            )

    def validate_crew_conflicts(self):
        """
        CRITICAL VALIDATION: Check each crew is not assigned to overlapping slots.
        This prevents double-booking of crew members.
        """
        if not self.crew_allocations:
            return

        for alloc in self.crew_allocations:
            if not alloc.crew:
                continue

            # Find all OTHER slots where this crew is assigned
            conflicting_slots = frappe.get_all(
                "Crew Slot",
                filters={
                    "name": ["!=", self.name],  # Exclude current slot
                    "status": ["!=", "Cancelled"],  # Exclude cancelled slots
                    # Overlap condition:
                    # Existing slot starts before or on current end date AND
                    # Existing slot ends after or on current start date
                    "start_date": ["<=", self.end_date],
                    "end_date": [">=", self.start_date],
                },
                fields=["name", "start_date", "end_date", "status"],
            )

            # Check if crew exists in any of these conflicting slots
            for slot in conflicting_slots:
                crew_in_slot = frappe.get_all(
                    "Crew Allocation",
                    filters={
                        "parent": slot.name,
                        "parenttype": "Crew Slot",
                        "crew": alloc.crew,
                    },
                    limit=1,
                )

                if crew_in_slot:
                    crew_name = alloc.crew_name or frappe.get_value("Crew", alloc.crew, "crew_name")
                    frappe.throw(
                        f"<b>Conflict Detected!</b><br><br>"
                        f"Crew <b>{crew_name}</b> is already assigned to "
                        f"Slot <b>{slot.name}</b> ({slot.start_date} to {slot.end_date}).<br><br>"
                        f"A crew member cannot be in two slots at the same time. "
                        f"Please adjust the dates or select a different crew member."
                    )

    def auto_update_status(self):
        """Auto-update status based on business rules"""
        if self.status == "Cancelled":
            return  # Manual override

        today = getdate(nowdate())

        # Rule 1: Auto-complete if end date has passed
        if self.end_date and getdate(self.end_date) < today:
            self.status = "Completed"
            return

        # Rule 2: Auto-confirm if all allocations are confirmed
        if self.crew_allocations and len(self.crew_allocations) > 0:
            all_confirmed = all(
                alloc.allocation_status == "Confirmed"
                for alloc in self.crew_allocations
                if alloc.allocation_status != "Replaced"
            )
            if all_confirmed and self.status == "Planned":
                self.status = "Confirmed"

    def calculate_current_crew(self):
        """Calculate and set current crew count from child table"""
        if self.crew_allocations:
            # Count non-replaced allocations
            active_allocations = [
                alloc
                for alloc in self.crew_allocations
                if alloc.allocation_status != "Replaced"
            ]
            self.current_crew = len(active_allocations)
        else:
            self.current_crew = 0

    def before_save(self):
        """Auto-populate fields before saving"""
        self.calculate_current_crew()

    def on_update(self):
        """After save actions"""
        # If slot is cancelled, cascade cancel all allocations
        if self.status == "Cancelled":
            self.cancel_all_allocations()

    def cancel_all_allocations(self):
        """Cancel all allocations when slot is cancelled"""
        if not self.crew_allocations:
            return

        for alloc in self.crew_allocations:
            if alloc.allocation_status != "Cancelled":
                alloc.allocation_status = "Cancelled"
                alloc.save()


def check_crew_availability(crew_id, start_date, end_date, exclude_slot=None):
    """
    Utility function to check if a crew member is available for a given date range.
    Can be called from API or other doctypes.

    Args:
        crew_id: Crew document name
        start_date: Start date string (YYYY-MM-DD)
        end_date: End date string (YYYY-MM-DD)
        exclude_slot: Optional slot name to exclude from conflict check

    Returns:
        dict with 'available' (bool) and 'conflicts' (list)
    """
    filters = {
        "status": ["!=", "Cancelled"],
        "start_date": ["<=", end_date],
        "end_date": [">=", start_date],
    }

    if exclude_slot:
        filters["name"] = ["!=", exclude_slot]

    # Find overlapping slots
    overlapping_slots = frappe.get_all(
        "Crew Slot",
        filters=filters,
        fields=["name", "start_date", "end_date", "status"],
    )

    conflicts = []
    for slot in overlapping_slots:
        # Check if crew is in this slot
        crew_in_slot = frappe.get_all(
            "Crew Allocation",
            filters={
                "parent": slot.name,
                "parenttype": "Crew Slot",
                "crew": crew_id,
            },
            limit=1,
        )

        if crew_in_slot:
            conflicts.append({
                "slot_name": slot.name,
                "start_date": str(slot.start_date),
                "end_date": str(slot.end_date),
                "status": slot.status,
            })

    return {
        "available": len(conflicts) == 0,
        "conflicts": conflicts,
    }
