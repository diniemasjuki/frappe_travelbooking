frappe.pages['travel-booking'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Travel & Booking Management',
		single_column: true
	});
}