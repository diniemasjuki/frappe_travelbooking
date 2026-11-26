# travel_booking/api/portal_cancellation.py
#
# Pembatalan self-service portal traveller:
#   - Booking "Pending" (belum bayar) → customer cancel TERUS
#     (cancel_booking) — hook Booking.on_update menjalankan
#     _cancel_booking_cascade (reservation/voucher/SO/PR/addon/Booking Item).
#   - Booking "Accepted" ke atas → PERMOHONAN (request_cancellation) —
#     keputusan oleh admin/operator (decide_cancellation_request,
#     Desk form "Booking Cancellation Request" atau API).
#
# Perimeter Varian B: customer TIDAK dapat akses doctype — semua melalui
# endpoint ini dengan semakan pemilikan manual (_booking_action_allowed
# "Docs"). Admin decide digate _require_access() (manage_trip_booking).

import frappe

from frappe import _

from travel_booking.api.booking_engine import (
    _get_all_booking_sales_orders,
    _send_status_email,
)
from travel_booking.api.portal_booking import _booking_action_allowed, _portal_access

_EPS = 0.01

# Status booking yang layak permohonan pembatalan (laluan keputusan admin)
_REQUESTABLE_STATUSES = ("Accepted", "Processing", "Confirmed")


def _load_booking(booking_number: str) -> frappe._dict:
    booking = frappe.db.get_value(
        "Booking", {"booking_number": booking_number},
        ["name", "booking_number", "status", "payment_status", "customer",
         "end_customer", "booking_channel", "booked_by", "cust_email"],
        as_dict=True,
    )
    if not booking:
        frappe.throw("Booking not found.", frappe.PermissionError)
    return booking


def _require_owned(booking: frappe._dict) -> None:
    """Gate pemilikan portal (corak _get_owned_booking addon_manager):
    owner / on-behalf manager (Docs). B2B end-customer DISEKAT —
    pembatalan ialah tindakan kewangan atas booking yang dibilkan kepada
    Customer partner."""
    _user, customer_name, managed = _portal_access()
    from travel_booking.api.addon_manager import _price_hidden_for
    if _price_hidden_for(booking, customer_name):
        frappe.throw(
            "Cancelling this booking is arranged by your travel agent. "
            "Please contact your agent.",
            frappe.PermissionError,
        )
    if not _booking_action_allowed(booking, customer_name, managed, "Docs"):
        frappe.throw("Access denied.", frappe.PermissionError)


def _paid_total(booking_name: str) -> float:
    total = 0.0
    for so_name in _get_all_booking_sales_orders(booking_name):
        total += float(frappe.db.get_value("Sales Order", so_name, "advance_paid") or 0)
    return total


def _has_invoice(booking_name: str) -> bool:
    return bool(frappe.db.sql("""
        SELECT sii.name
        FROM `tabSales Invoice Item` sii
        JOIN `tabSales Invoice` si ON si.name = sii.parent
        JOIN `tabSales Order` so ON so.name = sii.sales_order
        INNER JOIN `tabBooking Sales Order` reg
            ON reg.sales_order = so.name AND reg.parenttype = 'Booking'
        WHERE reg.parent = %s AND si.docstatus != 2
        LIMIT 1
    """, (booking_name,)))


def _audit(booking_name: str, subject: str, content: str) -> None:
    """Jejak audit pada Booking (corak booking_hub.update_booking_status)."""
    try:
        frappe.get_doc({
            "doctype": "Communication",
            "subject": subject,
            "content": content,
            "sending_user": frappe.session.user,
            "communication_medium": "Other",
            "sent_or_received": "Sent",
            "reference_doctype": "Booking",
            "reference_name": booking_name,
            "status": "Linked",
        }).insert(ignore_permissions=True)
    except Exception:
        frappe.log_error(
            title="Cancellation Audit Failed",
            message="Booking " + str(booking_name) + " (" + subject + "): " +
                    frappe.get_traceback(),
        )


def _open_request(booking_name: str):
    return frappe.db.get_value(
        "Booking Cancellation Request",
        {"booking": booking_name, "status": "Requested"},
        ["name", "reason", "requested_at", "requested_by"], as_dict=True,
    )


# ══════════════════════════════════════════════
# STATE (untuk UI portal)
# ══════════════════════════════════════════════

@frappe.whitelist()
def get_cancellation_state(booking_number: str) -> dict:
    """Status pembatalan semasa untuk halaman booking portal:
    {mode: none|cancel|request|requested, request: {...}|null}."""
    booking = _load_booking(booking_number)
    _require_owned(booking)

    req = _open_request(booking.name)
    if req:
        return {
            "mode": "requested",
            "request": {
                "name": req.name,
                "reason": req.reason,
                "requested_at": str(req.requested_at or ""),
                "requested_by": req.requested_by or "",
            },
            "booking_status": booking.status,
        }

    if booking.status == "Pending" and _paid_total(booking.name) <= _EPS:
        mode = "cancel"
    elif booking.status in _REQUESTABLE_STATUSES or (
            booking.status == "Pending" and _paid_total(booking.name) > _EPS):
        # Pending dengan bayaran (edge) — jangan cancel terus; permohonan.
        mode = "request"
    else:
        mode = "none"
    return {"mode": mode, "request": None, "booking_status": booking.status}


# ══════════════════════════════════════════════
# CANCEL TERUS (Pending + belum bayar)
# ══════════════════════════════════════════════

@frappe.whitelist()
def cancel_booking(booking_number: str, reason: str = "") -> dict:
    """Cancel TERUS oleh customer — HANYA booking Pending yang belum
    mempunyai sebarang bayaran. Status → Cancelled melalui doc.save()
    penuh supaya hook on_booking_update menjalankan _cancel_booking_
    cascade (reservation → Cancelled, voucher dilepaskan, SO/PR belum
    bayar di-cancel, addon orders ditutup, Booking Item ditutup).

    Booking berbayar / Accepted mesti melalui request_cancellation()."""
    booking = _load_booking(booking_number)
    _require_owned(booking)
    reason = (reason or "").strip()
    if not reason:
        frappe.throw(_("Please tell us why you are cancelling this booking."))

    if booking.status != "Pending":
        frappe.throw(
            _("This booking is already {0} — cancellation must be requested "
              "for admin review.").format(booking.status),
            title=_("Cancellation Request Required"),
        )
    if _paid_total(booking.name) > _EPS:
        frappe.throw(
            _("This booking has payments recorded — cancellation requires "
              "admin review and refund processing."),
            title=_("Cancellation Request Required"),
        )
    if _has_invoice(booking.name):
        frappe.throw(
            _("This booking has been invoiced — cancellation requires admin "
              "review."),
            title=_("Cancellation Request Required"),
        )

    bdoc = frappe.get_doc("Booking", booking.name)
    bdoc.status = "Cancelled"
    bdoc.save(ignore_permissions=True)
    frappe.db.commit()

    _audit(
        booking.name,
        "Booking Cancelled (by Customer)",
        "Booking cancelled by customer via portal. Reason: " + reason,
    )
    try:
        _send_cancellation_email(booking.name, reason)
    except Exception:
        frappe.log_error(
            title="Cancellation Email Failed",
            message=frappe.get_traceback(),
        )

    return {
        "success": True,
        "booking": booking.name,
        "booking_number": booking.booking_number,
        "status": "Cancelled",
    }


# ══════════════════════════════════════════════
# PERMOHONAN (Accepted ke atas)
# ══════════════════════════════════════════════

@frappe.whitelist()
def request_cancellation(booking_number: str, reason: str = "") -> dict:
    """Mohon pembatalan (booking Accepted/Processing/Confirmed — atau
    Pending yang ada bayaran). Dicipta: Booking Cancellation Request
    (status Requested) — keputusan oleh admin/operator melalui
    decide_cancellation_request(). Satu permohonan terbuka setiap booking."""
    booking = _load_booking(booking_number)
    _require_owned(booking)
    reason = (reason or "").strip()
    if not reason:
        frappe.throw(_("Please tell us why you want to cancel this booking."))

    if booking.status not in _REQUESTABLE_STATUSES and not (
            booking.status == "Pending" and _paid_total(booking.name) > _EPS):
        frappe.throw(
            _("This booking cannot be cancelled (status: {0}).").format(booking.status),
            title=_("Cancellation Not Available"),
        )
    if _open_request(booking.name):
        frappe.throw(
            _("An open cancellation request already exists for this booking."),
            title=_("Request Already Submitted"),
        )

    req = frappe.get_doc({
        "doctype": "Booking Cancellation Request",
        "booking": booking.name,
        "status": "Requested",
        "reason": reason,
    })
    req.insert(ignore_permissions=True)
    frappe.db.commit()

    _audit(
        booking.name,
        "Cancellation Requested (by Customer)",
        "Customer requested cancellation via portal. Request: " + req.name +
        ". Reason: " + reason,
    )
    try:
        ctx_email = booking.cust_email or frappe.db.get_value(
            "Booking", booking.name, "cust_email") or ""
        if ctx_email:
            frappe.sendmail(
                recipients=[ctx_email],
                subject="Cancellation Request Received — " + booking.booking_number,
                message=(
                    "<p>Hello,</p>"
                    "<p>We have received your cancellation request for booking "
                    "<strong>" + frappe.utils.escape_html(booking.booking_number) +
                    "</strong>.</p>"
                    "<p>Our team will review your request and notify you of the "
                    "decision by email. Reason submitted: <em>" +
                    frappe.utils.escape_html(reason) + "</em></p>"
                ),
            )
    except Exception:
        frappe.log_error(
            title="Cancellation Request Ack Email Failed",
            message=frappe.get_traceback(),
        )

    return {
        "success": True,
        "request": req.name,
        "booking_number": booking.booking_number,
        "status": "Requested",
    }


@frappe.whitelist()
def withdraw_cancellation(booking_number: str) -> dict:
    """Customer menarik balik permohonan mereka yang masih terbuka."""
    booking = _load_booking(booking_number)
    _require_owned(booking)

    req = _open_request(booking.name)
    if not req:
        frappe.throw(_("No open cancellation request for this booking."))

    frappe.db.set_value("Booking Cancellation Request", req.name, {
        "status": "Withdrawn",
        "decided_by": frappe.session.user,
        "decision_reason": "Withdrawn by customer",
    })
    frappe.db.commit()

    _audit(
        booking.name,
        "Cancellation Request Withdrawn",
        "Customer withdrew cancellation request " + req.name + ".",
    )
    return {"success": True, "request": req.name, "status": "Withdrawn"}


# ══════════════════════════════════════════════
# KEPUTUSAN (admin / operator)
# ══════════════════════════════════════════════

@frappe.whitelist()
def decide_cancellation_request(request: str, decision: str,
                                decision_reason: str = "") -> dict:
    """Keputusan admin atas permohonan pembatalan.

    Approved → Booking.status = Cancelled (doc.save penuh — hook
    _cancel_booking_cascade: reservation/voucher/SO belum bayar/addon
    orders/Booking Item; SO BERBAYAR kekal + log 'Booking Cancel -
    Refund Needed' + payment_status 'Request Refund' — laluan refund
    manual sedia ada) + emel pembatalan kepada customer.
    Rejected → permohonan ditutup + emel sebab kepada customer."""
    from travel_booking.api.manage_trip_booking import _require_access
    _require_access()

    decision = (decision or "").strip()
    if decision not in ("Approved", "Rejected"):
        frappe.throw(_("Decision must be Approved or Rejected."))
    decision_reason = (decision_reason or "").strip()

    req = frappe.db.get_value(
        "Booking Cancellation Request", request,
        ["name", "booking", "status", "reason", "requested_by"], as_dict=True,
    )
    if not req:
        frappe.throw(_("Cancellation request not found."))
    if req.status != "Requested":
        frappe.throw(
            _("This request has already been decided ({0}).").format(req.status),
            title=_("Already Decided"),
        )

    booking_name = req.booking
    b_status = frappe.db.get_value("Booking", booking_name, "status")
    if b_status in ("Cancelled", "Abandoned"):
        # Booking dah dibatalkan melalui saluran lain — tutup permohonan.
        frappe.db.set_value("Booking Cancellation Request", req.name, {
            "status": "Closed",
            "decided_by": frappe.session.user,
            "decision_reason": "Booking was already cancelled through another channel.",
        })
        frappe.db.commit()
        return {"success": True, "request": req.name, "status": "Closed"}

    if decision == "Approved":
        bdoc = frappe.get_doc("Booking", booking_name)
        bdoc.status = "Cancelled"
        bdoc.save(ignore_permissions=True)
        frappe.db.set_value("Booking Cancellation Request", req.name, {
            "status": "Approved",
            "decided_by": frappe.session.user,
            "decision_reason": decision_reason,
        })
        frappe.db.commit()
        _audit(
            booking_name,
            "Booking Cancelled (Request Approved)",
            "Cancellation request " + req.name + " approved by " +
            frappe.session.user + ". Customer reason: " + req.reason +
            ". Admin notes: " + (decision_reason or "-"),
        )
        try:
            _send_cancellation_email(booking_name, req.reason)
        except Exception:
            frappe.log_error(
                title="Cancellation Email Failed",
                message=frappe.get_traceback(),
            )
        return {"success": True, "request": req.name, "status": "Approved",
                "booking_status": "Cancelled"}

    # Rejected
    frappe.db.set_value("Booking Cancellation Request", req.name, {
        "status": "Rejected",
        "decided_by": frappe.session.user,
        "decision_reason": decision_reason,
    })
    frappe.db.commit()
    _audit(
        booking_name,
        "Cancellation Request Rejected",
        "Cancellation request " + req.name + " rejected by " +
        frappe.session.user + ". Reason: " + decision_reason,
    )
    try:
        booking_number = frappe.db.get_value("Booking", booking_name, "booking_number")
        cust_email = frappe.db.get_value("Booking", booking_name, "cust_email") or ""
        if cust_email:
            frappe.sendmail(
                recipients=[cust_email],
                subject="Cancellation Request Update — " + booking_number,
                message=(
                    "<p>Hello,</p>"
                    "<p>Your cancellation request for booking <strong>" +
                    frappe.utils.escape_html(str(booking_number)) +
                    "</strong> has been reviewed and was <strong>not approved</strong>.</p>" +
                    ("<p>Reason: " + frappe.utils.escape_html(decision_reason) + "</p>"
                     if decision_reason else "") +
                    "<p>Your booking remains active. Please contact us if you have "
                    "any questions.</p>"
                ),
            )
    except Exception:
        frappe.log_error(
            title="Cancellation Reject Email Failed",
            message=frappe.get_traceback(),
        )
    return {"success": True, "request": req.name, "status": "Rejected"}


# ══════════════════════════════════════════════
# EMEL PEMBATALAN
# ══════════════════════════════════════════════

def _send_cancellation_email(booking_name: str, reason: str) -> None:
    """Emel 'Booking Cancelled' — template Email Template (boleh edit di
    Desk; lalai dijana install.py), corak _send_status_email."""
    from travel_booking.api.email_service import _booking_email_context, get_site_url

    template_name = "Booking Cancelled"
    if not frappe.db.exists("Email Template", template_name):
        return

    ctx = _booking_email_context(booking_name)
    if not ctx:
        return
    ctx["cancellation_reason"] = reason or "-"
    site_url = get_site_url()

    email_template = frappe.get_doc("Email Template", template_name)
    message = email_template.get_formatted_response(ctx)
    subject = frappe.render_template(email_template.subject, ctx)

    frappe.sendmail(
        recipients=[ctx.get("email")],
        subject=subject,
        message=message,
        now=True,
    )
