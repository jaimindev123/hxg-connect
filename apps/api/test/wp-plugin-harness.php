<?php
/**
 * Runs the real WordPress plugin file without WordPress: the handful of WP
 * functions it calls are stubbed, form plugins' hooks are fired with the data
 * shapes those plugins pass, and wp_remote_post really posts to the address
 * given as argv[2]. Prints the plugin's own send log as JSON.
 *
 * Usage: php wp-plugin-harness.php <plugin file> <address>
 */
define( 'ABSPATH', '/' );
$GLOBALS['hooks']   = array();
$GLOBALS['options'] = array( 'hxg_connect_leads' => array( 'url' => $argv[2], 'woo' => 1 ) );

function add_action( $h, $cb, $p = 10, $n = 1 ) { $GLOBALS['hooks'][ $h ][] = $cb; }
function add_filter( $h, $cb, $p = 10, $n = 1 ) {}
function apply_filters( $h, $v ) { return $v; }
function do_action( $h, ...$args ) { foreach ( $GLOBALS['hooks'][ $h ] ?? array() as $cb ) { $cb( ...$args ); } }
function plugin_basename( $f ) { return basename( $f ); }
function get_option( $k, $d = false ) { return $GLOBALS['options'][ $k ] ?? $d; }
function update_option( $k, $v ) { $GLOBALS['options'][ $k ] = $v; return true; }
function wp_parse_args( $a, $d ) { return array_merge( $d, (array) $a ); }
function wp_strip_all_tags( $s ) { return trim( strip_tags( $s ) ); }
function wp_get_referer() { return 'https://sunriseheights.in/contact'; }
function home_url() { return 'https://sunriseheights.in'; }
function wp_unslash( $v ) { return $v; }
function sanitize_text_field( $v ) { return trim( strip_tags( $v ) ); }
function wp_json_encode( $v ) { return json_encode( $v ); }
function is_wp_error( $v ) { return false; }
function wp_remote_retrieve_response_code( $r ) { return $r['code']; }
function wp_remote_retrieve_body( $r ) { return $r['body']; }
function wp_remote_post( $url, $args ) {
	$headers = array();
	foreach ( $args['headers'] as $k => $v ) { $headers[] = "$k: $v"; }
	$ch = curl_init( $url );
	curl_setopt_array( $ch, array( CURLOPT_POST => true, CURLOPT_POSTFIELDS => $args['body'], CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => $args['timeout'], CURLOPT_NOPROXY => '*' ) );   // the test API is on this machine
	$body = curl_exec( $ch );
	$code = curl_getinfo( $ch, CURLINFO_RESPONSE_CODE );
	return array( 'code' => $code, 'body' => (string) $body );
}

// Contact Form 7 hands over the form; the posted data comes from its submission singleton.
class WPCF7_Submission {
	public static function get_instance() { return new self(); }
	public function get_posted_data() {
		return array( 'your-name' => 'Pooja Kulkarni', 'your-email' => 'pooja@example.com', 'tel-482' => '70300 44556',
			'your-message' => '<b>3BHK</b> brochure please', '_wpcf7' => '12', 'g-recaptcha-response' => 'tok', 'acceptance-1' => '1' );
	}
}
class Fake_CF7_Form { public function title() { return 'Brochure request'; } }
class Fake_Elementor_Record {
	public function get( $k ) {
		return array(
			'name'      => array( 'id' => 'name', 'type' => 'text', 'title' => 'Full Name', 'value' => 'Nikhil Shetty' ),
			'field_a81' => array( 'id' => 'field_a81', 'type' => 'tel', 'title' => 'WhatsApp Number', 'value' => '+91 70300 44557' ),
			'message'   => array( 'id' => 'message', 'type' => 'textarea', 'title' => 'Message', 'value' => 'Site visit on Sunday' ),
		);
	}
	public function get_form_settings( $k ) { return 'Site visit form'; }
}

require $argv[1];

do_action( 'wpcf7_before_send_mail', new Fake_CF7_Form() );
do_action( 'wpforms_process_complete',
	array( 1 => array( 'name' => 'Name', 'value' => 'Tanvi Bhatt', 'type' => 'name', 'id' => 1 ), 2 => array( 'name' => 'Phone', 'value' => '7030044558', 'type' => 'phone', 'id' => 2 ),
		3 => array( 'name' => 'Budget', 'value' => '90 lakh', 'type' => 'text', 'id' => 3 ) ),
	array(), array( 'settings' => array( 'form_title' => 'Quick enquiry' ) ), 77 );
do_action( 'elementor_pro/forms/new_record', new Fake_Elementor_Record(), null );
do_action( 'ninja_forms_after_submission', array( 'settings' => array( 'title' => 'Callback' ), 'fields' => array(
	array( 'key' => 'name_1', 'label' => 'Your Name', 'value' => 'No Phone Given', 'type' => 'textbox' ), array( 'key' => 'submit_1', 'label' => 'Send', 'value' => '', 'type' => 'submit' ) ) ) );

echo json_encode( get_option( 'hxg_connect_leads_log' ) );
