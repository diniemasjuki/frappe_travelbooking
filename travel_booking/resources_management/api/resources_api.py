import frappe
from frappe import _
from frappe.utils import getdate, nowdate
import json
from datetime import datetime, timedelta
from dateutil.parser import parse
from dateutil.relativedelta import relativedelta


@frappe.whitelist()
def get_gantt_data(filters: str | None = None) -> list:
    """
    Get data for Gantt chart view.
    Returns list of slots with crew assignments formatted for Gantt.

    Args:
        filters: dict with optional filters:
            - start_date: str (YYYY-MM-DD)
            - end_date: str (YYYY-MM-DD)
            - crew: str (crew name)
            - status: str (Planned/Confirmed/Cancelled/Completed)
            - trip_group_date: str

    Returns:
        list of dict with Gantt task data
    """
    try:
        filters = json.loads(filters) if isinstance(filters, str) else (filters or {})

        # Build base filters
        base_filters = {}

        if filters.get("start_date"):
            base_filters["start_date"] = [">=", filters["start_date"]]
        if filters.get("end_date"):
            base_filters["end_date"] = ["<=", filters["end_date"]]
        if filters.get("status"):
            base_filters["status"] = filters["status"]
        if filters.get("trip_group_date"):
            base_filters["trip_group_date"] = filters["trip_group_date"]

        # Fetch slots
        slots = frappe.get_all(
            "Crew Slot",
            filters=base_filters,
            fields=[
                "name",
                "start_date",
                "end_date",
                "status",
                "max_crew",
                "current_crew",
                "trip_name",
                "trip_group_date",
            ],
            order_by="start_date asc",
        )

        gantt_data = []
        for slot in slots:
            # Get crew allocations for this slot
            allocations = frappe.get_all(
                "Crew Allocation",
                filters={"parent": slot.name, "parenttype": "Crew Slot"},
                fields=["crew", "crew_name", "role_in_slot", "allocation_status"],
            )

            crew_list = ", ".join([
                a.crew_name or a.crew
                for a in allocations
                if a.allocation_status != "Replaced"
            ])

            # Format for Gantt chart
            gantt_task = {
                "id": slot.name,
                "name": f"{slot.name}: {slot.trip_name or 'Unlinked Slot'}",
                "start": str(slot.start_date),
                "end": str(slot.end_date),
                "progress": 100 if slot.status == "Completed" else (50 if slot.status == "Confirmed" else 0),
                "status": slot.status,
                "trip_name": slot.trip_name,
                "trip_group_date": slot.trip_group_date,
                "max_crew": slot.max_crew or 1,
                "current_crew": slot.current_crew or 0,
                "crew_assigned": crew_list,
                "dependencies": "",
                "custom_class": f"gantt-{(slot.status or 'planned').lower()}",
            }

            gantt_data.append(gantt_task)

        return gantt_data

    except Exception as e:
        frappe.throw(f"Error fetching Gantt data: {str(e)}")


@frappe.whitelist()
def get_calendar_events(start: str, end: str, filters: str | None = None) -> list:
    """
    Get events for calendar view.
    Used by Frappe's calendar configuration.

    Args:
        start: start date string
        end: end date string
        filters: optional dict of additional filters

    Returns:
        list of event dicts for FullCalendar
    """
    try:
        filters = json.loads(filters) if isinstance(filters, str) else (filters or {})

        # Build filters — overlap logic: slot starts before/on end AND ends after/on start
        event_filters = {
            "start_date": ["<=", end],
            "end_date": [">=", start],
        }

        if filters.get("status"):
            event_filters["status"] = filters["status"]
        if filters.get("crew"):
            # Filter by crew via child table
            crew_slots = frappe.get_all(
                "Crew Allocation",
                filters={"crew": filters["crew"], "parenttype": "Crew Slot"},
                fields=["parent"],
                distinct=True,
            )
            slot_names = [s.parent for s in crew_slots]
            if slot_names:
                event_filters["name"] = ["in", slot_names]
            else:
                # No slots found for this crew, return empty
                return []

        # Fetch slots
        slots = frappe.get_all(
            "Crew Slot",
            filters=event_filters,
            fields=[
                "name",
                "start_date",
                "end_date",
                "status",
                "trip_name",
                "max_crew",
                "current_crew",
            ],
            order_by="start_date asc",
        )

        # Format for FullCalendar
        events = []
        for slot in slots:
            event = {
                "id": slot.name,
                "title": f"{slot.name}: {slot.trip_name or 'Slot'} ({slot.current_crew or 0}/{slot.max_crew or 1} crew)",
                "start": str(slot.start_date),
                "end": str(slot.end_date),  # FullCalendar uses exclusive end
                "allDay": True,
                "className": f"event-status-{(slot.status or 'planned').lower()}",
                "extendedProps": {
                    "status": slot.status,
                    "trip_name": slot.trip_name,
                    "max_crew": slot.max_crew,
                    "current_crew": slot.current_crew,
                },
            }
            events.append(event)

        return events

    except Exception as e:
        frappe.log_error(f"Error fetching calendar events: {str(e)}", "Resources Management API")
        return []


@frappe.whitelist()
def get_slot_detail(slot_name: str) -> dict:
    """
    Get detailed information about a specific slot including all allocations.

    Args:
        slot_name: name of the Crew Slot document

    Returns:
        dict with slot details and crew list
    """
    try:
        if not frappe.has_permission("Crew Slot", doc=slot_name):
            frappe.throw(_("Not permitted"), frappe.PermissionError)

        slot = frappe.get_doc("Crew Slot", slot_name)

        # Get allocations with crew details
        allocations = []
        for alloc in slot.crew_allocations:
            if alloc.allocation_status == "Replaced":
                continue

            crew_info = None
            if alloc.crew:
                try:
                    crew_doc = frappe.get_doc("Crew", alloc.crew)
                    crew_info = {
                        "name": crew_doc.name,
                        "crew_name": crew_doc.crew_name,
                        "email": crew_doc.email,
                        "phone": crew_doc.phone,
                        "role_position": crew_doc.role_position,
                        "grade": crew_doc.grade,
                        "status": crew_doc.status,
                        "photo": crew_doc.photo,
                    }
                except Exception:
                    crew_info = {"name": alloc.crew, "crew_name": alloc.crew_name}

            allocations.append({
                "allocation_name": alloc.name,
                "crew": alloc.crew,
                "crew_name": alloc.crew_name,
                "role_in_slot": alloc.role_in_slot,
                "allocation_status": alloc.allocation_status,
                "remarks": alloc.remarks,
                "crew_info": crew_info,
            })

        return {
            "slot": {
                "name": slot.name,
                "start_date": str(slot.start_date),
                "end_date": str(slot.end_date),
                "status": slot.status,
                "max_crew": slot.max_crew or 1,
                "current_crew": slot.current_crew or 0,
                "trip_group_date": slot.trip_group_date,
                "trip_name": slot.trip_name,
                "notes": slot.notes,
            },
            "allocations": allocations,
        }

    except frappe.PermissionError:
        raise
    except Exception as e:
        frappe.throw(f"Error fetching slot detail: {str(e)}")


@frappe.whitelist()
def check_crew_availability(
    crew_id: str,
    start_date: str,
    end_date: str,
    exclude_slot: str | None = None,
) -> dict:
    """
    Public API endpoint to check crew availability.
    Wraps the utility function from crew_slot.py

    Args:
        crew_id: Crew document name
        start_date: Start date (YYYY-MM-DD)
        end_date: End date (YYYY-MM-DD)
        exclude_slot: Optional slot name to exclude

    Returns:
        dict with availability status and conflicts
    """
    try:
        from travel_booking.resources_management.doctype.crew_slot.crew_slot import (
            check_crew_availability as _check_availability,
        )

        return _check_availability(crew_id, start_date, end_date, exclude_slot)

    except Exception as e:
        frappe.throw(f"Error checking crew availability: {str(e)}")


@frappe.whitelist()
def get_resources_summary() -> dict:
    """
    Get summary statistics for Resources Management dashboard.

    Returns:
        dict with KPIs and summary data
    """
    try:
        today = datetime.now().date()

        # Total counts
        total_crew = frappe.db.count("Crew", filters={"status": "Active"})
        total_slots = frappe.db.count("Crew Slot")
        active_slots = frappe.db.count(
            "Crew Slot",
            filters={
                "status": ["in", ["Planned", "Confirmed"]],
                "start_date": ["<=", today],
                "end_date": [">=", today],
            },
        )

        # Status breakdown
        status_breakdown = frappe.db.sql(
            """
            SELECT status, COUNT(*) as count
            FROM `tabCrew Slot`
            GROUP BY status
            """,
            as_dict=True,
        )

        # Upcoming slots (next 30 days)
        next_month = today + timedelta(days=30)
        upcoming_slots = frappe.get_all(
            "Crew Slot",
            filters={
                "status": ["in", ["Planned", "Confirmed"]],
                "start_date": [">=", today],
                "start_date": ["<=", next_month],
            },
            fields=["name", "start_date", "end_date", "trip_name", "current_crew", "max_crew", "status"],
            limit=10,
            order_by="start_date asc",
        )

        # Crew utilization (crew with active assignments)
        utilized_crew = frappe.db.sql(
            """
            SELECT DISTINCT ca.crew
            FROM `tabCrew Allocation` ca
            JOIN `tabCrew Slot` cs ON ca.parent = cs.name
            WHERE cs.status IN ('Planned', 'Confirmed')
            AND cs.start_date <= %s
            AND cs.end_date >= %s
            AND ca.allocation_status != 'Replaced'
            """,
            (today, today),
            as_dict=True,
        )

        return {
            "kpi": {
                "total_active_crew": total_crew,
                "total_slots": total_slots,
                "active_slots_now": active_slots,
                "crew_utilized_today": len(utilized_crew),
                "utilization_percent": round(
                    (len(utilized_crew) / total_crew * 100) if total_crew > 0 else 0, 1
                ),
            },
            "status_breakdown": status_breakdown,
            "upcoming_slots": upcoming_slots,
        }

    except Exception as e:
        frappe.throw(f"Error fetching resources summary: {str(e)}")


@frappe.whitelist()
def get_crew_schedule(crew_id: str, months_ahead: int = 3) -> list:
    """
    Get schedule for a specific crew member.

    Args:
        crew_id: Crew document name
        months_ahead: Number of months ahead to fetch

    Returns:
        list of assigned slots
    """
    try:
        future_date = datetime.now() + relativedelta(months=months_ahead)

        # Find all slots where this crew is assigned
        allocations = frappe.get_all(
            "Crew Allocation",
            filters={
                "crew": crew_id,
                "parenttype": "Crew Slot",
                "allocation_status": ["!=", "Replaced"],
            },
            fields=["parent", "role_in_slot", "allocation_status"],
        )

        schedule = []
        seen_slots = set()

        for alloc in allocations:
            if alloc.parent in seen_slots:
                continue
            seen_slots.add(alloc.parent)

            try:
                slot = frappe.get_doc("Crew Slot", alloc.parent)

                # Only include future or active slots
                if slot.end_date and getdate(slot.end_date) >= getdate(nowdate()):
                    schedule.append({
                        "slot_name": slot.name,
                        "start_date": str(slot.start_date),
                        "end_date": str(slot.end_date),
                        "status": slot.status,
                        "trip_name": slot.trip_name,
                        "role_in_slot": alloc.role_in_slot,
                        "allocation_status": alloc.allocation_status,
                    })
            except Exception:
                continue

        # Sort by start date
        schedule.sort(key=lambda x: x["start_date"])

        return schedule

    except Exception as e:
        frappe.throw(f"Error fetching crew schedule: {str(e)}")


@frappe.whitelist()
def get_gantt_data_by_crew(filters: str | None = None) -> list:
    """Get Gantt data grouped by crew member.

    Each crew member is a row; their assigned slots appear as bars.
    A slot appears once per crew member assigned to it.

    Returns:
        list of crew dicts, each with ``slots`` list
    """
    try:
        filters = json.loads(filters) if isinstance(filters, str) else (filters or {})

        crew_filters = {"status": ["in", ["Active", "On Leave"]]}
        if filters.get("crew"):
            crew_filters["name"] = filters["crew"]

        crew_members = frappe.get_all(
            "Crew",
            filters=crew_filters,
            fields=["name", "crew_name", "grade", "role_position", "department", "status"],
            order_by="grade desc, crew_name asc",
        )

        result = []
        for crew in crew_members:
            alloc_filters = {
                "crew": crew.name,
                "parenttype": "Crew Slot",
                "allocation_status": ["!=", "Replaced"],
            }
            allocations = frappe.get_all(
                "Crew Allocation",
                filters=alloc_filters,
                fields=["parent", "role_in_slot", "allocation_status"],
            )

            slots = []
            for alloc in allocations:
                try:
                    slot = frappe.get_doc("Crew Slot", alloc.parent)
                    if filters.get("status") and slot.status != filters["status"]:
                        continue
                    slots.append({
                        "slot_name": slot.name,
                        "start": str(slot.start_date),
                        "end": str(slot.end_date),
                        "status": slot.status,
                        "role_in_slot": alloc.role_in_slot,
                        "allocation_status": alloc.allocation_status,
                        "trip_name": slot.trip_name,
                        "max_crew": slot.max_crew or 1,
                        "current_crew": slot.current_crew or 0,
                        "notes": slot.notes or "",
                    })
                except Exception:
                    continue

            result.append({
                "crew_id": crew.name,
                "crew_name": crew.crew_name,
                "grade": crew.grade or "",
                "role_position": crew.role_position or "",
                "department": crew.department or "",
                "status": crew.status,
                "slots": slots,
            })

        return result

    except Exception as e:
        frappe.throw(f"Error fetching crew Gantt data: {str(e)}")


@frappe.whitelist()
def update_slot_dates(slot_name: str, start_date: str, end_date: str) -> dict:
    """Update a Crew Slot's start/end dates after Gantt drag-to-resize.

    Args:
        slot_name: Crew Slot document name
        start_date: new start date (YYYY-MM-DD)
        end_date: new end date (YYYY-MM-DD)

    Returns:
        dict with updated dates
    """
    try:
        if not frappe.has_permission("Crew Slot", "write"):
            frappe.throw(_("Not permitted to modify Crew Slot"), frappe.PermissionError)

        slot = frappe.get_doc("Crew Slot", slot_name)
        new_start = frappe.utils.getdate(start_date)
        new_end = frappe.utils.getdate(end_date)

        if new_end < new_start:
            frappe.throw(_("End date cannot be before start date"))

        slot.start_date = new_start
        slot.end_date = new_end
        slot.save()

        frappe.db.commit()

        return {
            "slot_name": slot.name,
            "start_date": str(slot.start_date),
            "end_date": str(slot.end_date),
            "status": slot.status,
            "current_crew": slot.current_crew,
            "max_crew": slot.max_crew,
        }

    except frappe.PermissionError:
        raise
    except Exception as e:
        frappe.log_error(f"Error updating slot dates: {str(e)}", "Resources Management API")
        frappe.throw(f"Error updating slot dates: {str(e)}")


@frappe.whitelist()
def create_slot(
    start_date: str,
    end_date: str,
    crew_id: str,
    role_in_slot: str | None = None,
    max_crew: str | None = None,
    slot_name: str | None = None,
    notes: str | None = None,
) -> dict:
    """Create a new Crew Slot with an initial crew allocation.

    Called when the user clicks an empty area in the Gantt chart.

    Args:
        start_date: slot start date (YYYY-MM-DD)
        end_date: slot end date (YYYY-MM-DD)
        crew_id: Crew document name to assign
        role_in_slot: role for this crew in the slot
        max_crew: maximum crew capacity (default "1")
        slot_name: explicit name for the slot (prompt autoname)
        notes: optional notes

    Returns:
        dict with created slot details
    """
    try:
        if not frappe.has_permission("Crew Slot", "create"):
            frappe.throw(_("Not permitted to create Crew Slot"), frappe.PermissionError)

        if not crew_id or not frappe.db.exists("Crew", crew_id):
            frappe.throw(_("Invalid crew member"))

        crew_doc = frappe.get_doc("Crew", crew_id)
        role = role_in_slot or crew_doc.role_position or "Staff"
        capacity = int(max_crew) if max_crew else 1

        # Auto-generate slot name if not provided (base = start date, append counter)
        name = slot_name or start_date
        base = name
        counter = 1
        while frappe.db.exists("Crew Slot", name):
            name = f"{base}-{counter}"
            counter += 1

        slot = frappe.get_doc({
            "doctype": "Crew Slot",
            "__newname": name,
            "start_date": frappe.utils.getdate(start_date),
            "end_date": frappe.utils.getdate(end_date),
            "max_crew": capacity,
            "status": "Planned",
            "crew_allocations": [{
                "crew": crew_id,
                "crew_name": crew_doc.crew_name,
                "role_in_slot": role,
                "allocation_status": "Assigned",
            }],
        })

        if notes:
            slot.notes = notes

        slot.insert()
        frappe.db.commit()

        return {
            "slot_name": slot.name,
            "start_date": str(slot.start_date),
            "end_date": str(slot.end_date),
            "status": slot.status,
            "crew_id": crew_id,
            "crew_name": crew_doc.crew_name,
            "max_crew": slot.max_crew,
            "current_crew": slot.current_crew,
        }

    except frappe.PermissionError:
        raise
    except Exception as e:
        frappe.db.rollback()
        frappe.log_error(f"Error creating slot: {str(e)}", "Resources Management API")
        frappe.throw(str(e))


@frappe.whitelist()
def add_crew_to_slot(
    slot_name: str,
    crew_id: str,
    role_in_slot: str | None = None,
    max_crew: str | None = None,
) -> dict:
    """Add a crew member to an existing Crew Slot.

    Args:
        slot_name: Crew Slot document name
        crew_id: Crew document name to add
        role_in_slot: role for this crew in the slot
        max_crew: new max capacity (increase if adding beyond current limit)

    Returns:
        dict with updated slot info
    """
    try:
        if not frappe.has_permission("Crew Slot", "write"):
            frappe.throw(_("Not permitted to modify Crew Slot"), frappe.PermissionError)

        slot = frappe.get_doc("Crew Slot", slot_name)

        if slot.status in ("Cancelled", "Completed"):
            frappe.throw(_("Cannot add crew to a {0} slot").format(slot.status))

        if not frappe.db.exists("Crew", crew_id):
            frappe.throw(_("Invalid crew member"))

        # Check if crew already in slot
        existing = [
            a.crew for a in slot.crew_allocations
            if a.allocation_status != "Replaced"
        ]
        if crew_id in existing:
            crew_name = frappe.get_value("Crew", crew_id, "crew_name")
            frappe.throw(_("{0} is already assigned to this slot").format(crew_name))

        # Update max_crew if provided
        if max_crew:
            slot.max_crew = int(max_crew)

        crew_doc = frappe.get_doc("Crew", crew_id)
        role = role_in_slot or crew_doc.role_position or "Staff"

        slot.append("crew_allocations", {
            "crew": crew_id,
            "crew_name": crew_doc.crew_name,
            "role_in_slot": role,
            "allocation_status": "Assigned",
        })

        slot.save()
        frappe.db.commit()

        return {
            "slot_name": slot.name,
            "current_crew": slot.current_crew,
            "max_crew": slot.max_crew,
            "added_crew": crew_doc.crew_name,
        }

    except frappe.PermissionError:
        raise
    except Exception as e:
        frappe.db.rollback()
        frappe.log_error(f"Error adding crew to slot: {str(e)}", "Resources Management API")
        frappe.throw(str(e))


@frappe.whitelist()
def remove_crew_from_slot(slot_name: str, crew_id: str) -> dict:
    """Remove a crew member from a Crew Slot.

    Args:
        slot_name: Crew Slot document name
        crew_id: Crew document name to remove

    Returns:
        dict with updated slot info
    """
    try:
        if not frappe.has_permission("Crew Slot", "write"):
            frappe.throw(_("Not permitted to modify Crew Slot"), frappe.PermissionError)

        slot = frappe.get_doc("Crew Slot", slot_name)

        if slot.status == "Cancelled":
            frappe.throw(_("Cannot modify a Cancelled slot"))

        removed = False
        for i, alloc in enumerate(slot.crew_allocations):
            if alloc.crew == crew_id:
                slot.crew_allocations.pop(i)
                removed = True
                break

        if not removed:
            frappe.throw(_("Crew not found in this slot"))

        slot.save()
        frappe.db.commit()

        return {
            "slot_name": slot.name,
            "current_crew": slot.current_crew,
            "max_crew": slot.max_crew,
        }

    except frappe.PermissionError:
        raise
    except Exception as e:
        frappe.db.rollback()
        frappe.log_error(f"Error removing crew from slot: {str(e)}", "Resources Management API")
        frappe.throw(str(e))

