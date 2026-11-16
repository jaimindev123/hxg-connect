=== HXG Connect Leads ===
Contributors: hxgglobal
Tags: crm, leads, contact form 7, wpforms, elementor
Requires at least: 5.8
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later

Sends every form enquiry on your site to HXG Connect as a lead.

== Description ==

Install, paste one address, done. Enquiries from these plugins go to HXG Connect within seconds, with no per-form setup:

* Contact Form 7
* WPForms
* Elementor Pro forms
* Gravity Forms
* Ninja Forms
* Fluent Forms
* Formidable Forms
* WooCommerce orders (optional)

Field names don't matter: "Phone", "Mobile No.", "your-tel" and "WhatsApp number" are all understood. Each form needs a phone number field, because HXG Connect needs a mobile number to create a lead.

Your form plugin keeps working exactly as before. Emails still go out, entries are still saved.

== Installation ==

1. Plugins > Add New > Upload Plugin, choose the zip, activate.
2. In HXG Connect: Settings > Integrations > Websites, marketplaces and other platforms > WordPress. Copy the address.
3. In WordPress: Settings > HXG Connect Leads. Paste the address and save.
4. Press Send test lead.

== For developers ==

Filter `hxg_connect_leads_payload` receives the payload array and the source plugin's name before sending. Return false to skip a submission, or add your own keys:

    add_filter( 'hxg_connect_leads_payload', function ( $payload, $plugin ) {
        $payload['project'] = 'Sunrise Heights';
        return $payload;
    }, 10, 2 );

== Privacy ==

The plugin sends the submitted form fields to the HXG Connect address you configure. It stores no visitor data in WordPress; the log on the settings page records only the time, the form name and whether the send worked.
