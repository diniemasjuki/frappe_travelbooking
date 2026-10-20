// travel_website.js — Travel Website doctype client script.
//
// Menambah butang "Edit HTML" pada setiap medan Text Editor supaya admin boleh
// tukar antara Rich Text Editor (Quill) dan raw HTML code view.
//
// Butang diletak bersebelahan label medan, hanya muncul untuk fieldtype
// "Text Editor".  Toggle menyimpan nilai semasa ke model (dirty flag aktif)
// jadi save berfungsi walaupun lupa toggle balik.

frappe.ui.form.on("Travel Website", {
	refresh(frm) {
		frm.fields.forEach((field) => {
			if (field.df.fieldtype !== "Text Editor") return;
			setup_html_toggle(field);
		});
	},
});

function setup_html_toggle(field) {
	const $wrapper = $(field.wrapper);
	const df = field.df;

	// ── Cipta butang toggle ──
	const btn_id = `html-toggle-${df.fieldname}`;
	const $btn = $(`
		<button type="button" id="${btn_id}"
			class="btn btn-xs btn-default rc-html-toggle"
			title="${__("Edit as HTML")}"
			style="margin-left:6px;vertical-align:middle;font-size:11px;padding:1px 8px;">
			<i class="fa fa-code" style="font-size:10px;margin-right:3px;"></i>
			${__("HTML")}
		</button>
	`);

	// Letak butang selepas label (atau sebelum input jika tiada label)
	const $label = $wrapper.find(".control-label");
	if ($label.length) {
		$label.after($btn);
	} else {
		$wrapper.find(".form-group").prepend($btn);
	}

	// ── State & DOM elements ──
	let html_mode = false;
	let $textarea = null;
	let debounce_timer = null;

	function enter_html_mode() {
		if (!field.quill || html_mode) return;
		html_mode = true;

		// Sorok Quill UI
		$wrapper.find(".ql-toolbar").hide();
		$wrapper.find(".ql-container").hide();

		// Ambil HTML semasa dari Quill
		const raw_html = field.quill.root.innerHTML || "";

		// Cipta textarea
		$textarea = $(`
			<textarea class="rc-html-source form-control"
				rows="8"
				placeholder="${__("Enter HTML here…")}"
				style="font-family:ui-monospace,SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;
					font-size:12.5px;line-height:1.55;resize:vertical;
					min-height:${(df.max_height || 110)}px;max-height:400px;">
		</textarea>
		`).val(raw_html);

		// Sisip selepas .ql-container
		$wrapper.find(".ql-container").after($textarea);

		// Update butang
		$btn.removeClass("btn-default").addClass("btn-primary")
			.attr("title", __("Back to Rich Text"))
			.html('<i class="fa fa-edit" style="font-size:10px;margin-right:3px;"></i>' + __("Rich"));

		// Debounce sync ke field value
		$textarea.on("input", () => {
			clearTimeout(debounce_timer);
			debounce_timer = setTimeout(() => {
				field.set_value($textarea.val());
			}, 350);
		});

		$textarea.trigger("focus");
	}

	function exit_html_mode() {
		if (!html_mode) return;

		// Simpan nilai terakhir dari textarea
		if ($textarea && $textarea.length) {
			clearTimeout(debounce_timer);
			field.set_value($textarea.val());
		}

		// Buang textarea
		if ($textarea) { $textarea.remove(); $textarea = null; }

		// Papar semula Quill
		$wrapper.find(".ql-toolbar").show();
		$wrapper.find(".ql-container").show();

		html_mode = false;

		// Reset butang
		$btn.removeClass("btn-primary").addClass("btn-default")
			.attr("title", __("Edit as HTML"))
			.html('<i class="fa fa-code" style="font-size:10px;margin-right:3px;"></i>' + __("HTML"));
	}

	// ── Event handler ──
	$btn.on("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (html_mode) {
			exit_html_mode();
		} else {
			enter_html_mode();
		}
	});

	// Cleanup bila field di-rebuild (refresh)
	field.$wrapper.on("destroy", () => {
		if ($textarea) { $textarea.remove(); }
		$btn.remove();
	});
}
