// Copyright (c) 2026, WargaPrihatin and contributors
// For license information, please see license.txt

frappe.ui.form.on("Travel Settings", {
	refresh(frm) {
		render_email_templates(frm);
	},
});

// ══════════════════════════════════════════════
// TAB EMAIL NOTIFICATIONS — SENARAI TEMPLATE
// ══════════════════════════════════════════════
// Tab ni tak cukup dengan child table sahaja: user juga perlu MENGEDIT
// kandungan template. Senarai di bawah (union template lalai app + template
// yang merujuk doctype app) dipaparkan dengan butang Edit supaya urusan
// branding/subject tak perlu cari "Email Template" dalam Desk sendiri.

function render_email_templates(frm) {
	const field = frm.fields_dict.email_templates_html;
	if (!field || !field.$wrapper) return;
	const $wrap = field.$wrapper;

	$wrap.html(`
		<div class="tb-email-template-manager">
			<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin:0 0 10px;">
				<div class="text-muted" style="font-size:12px;">
					${__("All email templates used by the app. Click Edit to change content at Desk — changes take effect immediately, no deploy needed.")}
				</div>
				<div style="white-space:nowrap;">
					<button class="btn btn-xs btn-default" data-action="new">${__("New Email Template")}</button>
					<button class="btn btn-xs btn-default" data-action="list">${__("Email Template List")}</button>
				</div>
			</div>
			<div class="tb-email-template-list"></div>
		</div>
	`);

	$wrap.find('[data-action="new"]').on("click", () => frappe.new_doc("Email Template"));
	$wrap.find('[data-action="list"]').on("click", () => frappe.set_route("List", "Email Template"));

	frappe.call({
		method: "travel_booking.module_travel_booking.doctype.travel_settings.travel_settings.get_app_email_templates",
	}).then((r) => {
		const templates = r.message || [];
		const $list = $wrap.find(".tb-email-template-list");
		$list.empty();
		if (!templates.length) {
			$(`<div class="text-muted">${__("No email templates found.")}</div>`).appendTo($list);
			return;
		}
		templates.forEach((t) => {
			const meta = [t.reference_doctype, t.use_html ? "HTML" : "Markdown"]
				.filter(Boolean).join(" · ");
			const $row = $(`
				<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border:1px solid #EAE7E0;border-radius:6px;margin-bottom:6px;background:#fff;">
					<div style="min-width:0;">
						<div style="font-weight:600;">${frappe.utils.escape_html(t.name)}</div>
						<div class="text-muted" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
							${frappe.utils.escape_html(t.subject || "")}${meta ? " — " + frappe.utils.escape_html(meta) : ""}
						</div>
					</div>
					<button class="btn btn-xs btn-default" style="margin-left:12px;">${__("Edit")}</button>
				</div>`);
			$row.find("button").on("click", () => frappe.set_route("Form", "Email Template", t.name));
			$list.append($row);
		});
	});
}
