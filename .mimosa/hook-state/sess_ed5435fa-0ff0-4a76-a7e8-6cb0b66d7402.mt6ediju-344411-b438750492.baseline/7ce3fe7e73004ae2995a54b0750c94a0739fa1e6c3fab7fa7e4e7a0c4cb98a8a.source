"""Patch: Make Frappe's create_contact BG job resilient to error 1020 deadlock.

Frappe's frappe.core.doctype.user.user.create_contact() (Path B — updating
an existing Contact) hits MariaDB error 1020 ("Record has changed since last read")
when it tries to .save() a Contact that travel_booking's _create_customer() just
created/modified in the same or overlapping transaction.

The raw pymysql.InternalError(1020) gets wrapped as frappe.QueryDeadlockError,
which does NOT inherit from frappe.db.InternalError — so it escapes the BG job
retry wrapper in background_jobs.py and kills the job permanently.

This patch wraps create_contact to catch error 1020 / QueryDeadlockError and
re-raise as RetryBackgroundJobError, which the BG job runner already knows how
to handle (retries up to 5x with linear backoff).
"""

import frappe
from frappe.exceptions import QueryDeadlockError


def apply():
    import frappe.core.doctype.user.user as mod

    _orig = mod.create_contact

    def _patched(user, *args, **kwargs):
        try:
            return _orig(user, *args, **kwargs)
        except (QueryDeadlockError, frappe.db.InternalError) as e:
            # Error 1020 / deadlock on Contact save during create_contact BG job.
            # Convert to retryable error so the BG job runner retries instead of dying.
            raise frappe.RetryBackgroundJobError from e

    mod.create_contact = _patched
