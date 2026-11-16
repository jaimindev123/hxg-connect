<?php
/**
 * Plugin Name:       HXG Connect Leads
 * Description:       Sends every form enquiry on this site to HXG Connect as a lead. Works with Contact Form 7, WPForms, Elementor Pro, Gravity Forms, Ninja Forms, Fluent Forms, Formidable and WooCommerce.
 * Version:           1.0.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            HXG Global LLP
 * License:           GPL-2.0-or-later
 * Text Domain:       hxg-connect-leads
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class HXG_Connect_Leads {

	const OPTION = 'hxg_connect_leads';
	const LOG    = 'hxg_connect_leads_log';

	/** Field names that are never worth sending. */
	const SKIP = '/^(_|g-recaptcha|h-captcha|cf-turnstile|recaptcha|captcha|password|pass|pwd|nonce|action$|submit$|item_key$|form_id$|frm_action$)/i';

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_init', array( __CLASS__, 'register' ) );
		add_action( 'admin_post_hxg_connect_test', array( __CLASS__, 'send_test' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), array( __CLASS__, 'links' ) );

		// Contact Form 7: before the mail goes out, so a broken mail server never costs a lead.
		add_action( 'wpcf7_before_send_mail', array( __CLASS__, 'cf7' ), 20, 1 );
		add_action( 'wpforms_process_complete', array( __CLASS__, 'wpforms' ), 20, 4 );
		add_action( 'elementor_pro/forms/new_record', array( __CLASS__, 'elementor' ), 20, 2 );
		add_action( 'gform_after_submission', array( __CLASS__, 'gravity' ), 20, 2 );
		add_action( 'ninja_forms_after_submission', array( __CLASS__, 'ninja' ), 20, 1 );
		add_action( 'fluentform/submission_inserted', array( __CLASS__, 'fluent' ), 20, 3 );
		add_action( 'fluentform_submission_inserted', array( __CLASS__, 'fluent' ), 20, 3 ); // Fluent Forms before 5.0
		add_action( 'frm_after_create_entry', array( __CLASS__, 'formidable' ), 30, 2 );
		add_action( 'woocommerce_checkout_order_processed', array( __CLASS__, 'woo' ), 20, 1 );
		add_action( 'woocommerce_store_api_checkout_order_processed', array( __CLASS__, 'woo' ), 20, 1 );
	}

	// ------------------------------------------------------------------
	// Form plugins
	// ------------------------------------------------------------------

	public static function cf7( $contact_form ) {
		if ( ! class_exists( 'WPCF7_Submission' ) ) {
			return;
		}
		$submission = WPCF7_Submission::get_instance();
		if ( ! $submission ) {
			return;
		}
		self::send( 'contact-form-7', $contact_form->title(), $submission->get_posted_data() );
	}

	public static function wpforms( $fields, $entry, $form_data, $entry_id ) {
		$out = array();
		foreach ( (array) $fields as $f ) {
			$label = ! empty( $f['name'] ) ? $f['name'] : ( isset( $f['type'] ) ? $f['type'] : 'field' );
			$out[ $label ] = isset( $f['value'] ) ? $f['value'] : '';
		}
		$title = isset( $form_data['settings']['form_title'] ) ? $form_data['settings']['form_title'] : '';
		self::send( 'wpforms', $title, $out );
	}

	public static function elementor( $record, $handler ) {
		$out = array();
		foreach ( (array) $record->get( 'fields' ) as $id => $f ) {
			$label         = ! empty( $f['title'] ) ? $f['title'] : $id;
			$out[ $label ] = isset( $f['value'] ) ? $f['value'] : '';
		}
		self::send( 'elementor', (string) $record->get_form_settings( 'form_name' ), $out );
	}

	public static function gravity( $entry, $form ) {
		$out = array();
		foreach ( (array) $form['fields'] as $field ) {
			if ( ! is_object( $field ) || in_array( $field->type, array( 'html', 'section', 'page', 'captcha', 'password' ), true ) ) {
				continue;
			}
			$value = method_exists( $field, 'get_value_export' ) ? $field->get_value_export( $entry, $field->id, true ) : rgar( $entry, (string) $field->id );
			$out[ $field->label ? $field->label : 'field_' . $field->id ] = $value;
		}
		self::send( 'gravity-forms', isset( $form['title'] ) ? $form['title'] : '', $out );
	}

	public static function ninja( $form_data ) {
		$out = array();
		foreach ( (array) ( isset( $form_data['fields'] ) ? $form_data['fields'] : array() ) as $f ) {
			$settings = isset( $f['settings'] ) && is_array( $f['settings'] ) ? $f['settings'] : array();
			$type     = isset( $f['type'] ) ? $f['type'] : ( isset( $settings['type'] ) ? $settings['type'] : '' );
			if ( in_array( $type, array( 'submit', 'html', 'hr', 'recaptcha', 'spam', 'password' ), true ) ) {
				continue;
			}
			$label = isset( $f['label'] ) ? $f['label'] : ( isset( $settings['label'] ) ? $settings['label'] : ( isset( $f['key'] ) ? $f['key'] : 'field' ) );
			$out[ $label ] = isset( $f['value'] ) ? $f['value'] : '';
		}
		$title = isset( $form_data['settings']['title'] ) ? $form_data['settings']['title'] : '';
		self::send( 'ninja-forms', $title, $out );
	}

	public static function fluent( $entry_id, $form_data, $form ) {
		self::send( 'fluent-forms', is_object( $form ) && isset( $form->title ) ? $form->title : '', (array) $form_data );
	}

	public static function formidable( $entry_id, $form_id ) {
		if ( ! class_exists( 'FrmField' ) || ! class_exists( 'FrmEntryMeta' ) ) {
			return;
		}
		$out = array();
		foreach ( (array) FrmField::get_all_for_form( $form_id ) as $field ) {
			if ( in_array( $field->type, array( 'html', 'divider', 'captcha', 'password', 'break', 'end_divider' ), true ) ) {
				continue;
			}
			$out[ $field->name ] = FrmEntryMeta::get_entry_meta_by_field( $entry_id, $field->id );
		}
		$form = class_exists( 'FrmForm' ) ? FrmForm::getOne( $form_id ) : null;
		self::send( 'formidable', $form && isset( $form->name ) ? $form->name : '', $out );
	}

	public static function woo( $order ) {
		$o = self::options();
		if ( empty( $o['woo'] ) || ! function_exists( 'wc_get_order' ) ) {
			return;
		}
		$order = is_object( $order ) ? $order : wc_get_order( $order );
		if ( ! $order || $order->get_meta( '_hxg_connect_sent' ) ) {
			return;
		}
		$items = array();
		foreach ( $order->get_items() as $item ) {
			$items[] = $item->get_name();
		}
		$sent = self::send(
			'woocommerce',
			'WooCommerce order',
			array(
				'name'    => trim( $order->get_billing_first_name() . ' ' . $order->get_billing_last_name() ),
				'phone'   => $order->get_billing_phone(),
				'email'   => $order->get_billing_email(),
				'city'    => $order->get_billing_city(),
				'company' => $order->get_billing_company(),
				'product' => implode( ', ', array_slice( $items, 0, 8 ) ),
				'message' => sprintf( 'WooCommerce order #%s, %s %s', $order->get_order_number(), $order->get_currency(), $order->get_total() ),
			)
		);
		if ( $sent ) {
			$order->update_meta_data( '_hxg_connect_sent', 1 );
			$order->save();
		}
	}

	// ------------------------------------------------------------------
	// Sending
	// ------------------------------------------------------------------

	private static function options() {
		return wp_parse_args( get_option( self::OPTION, array() ), array( 'url' => '', 'woo' => 0 ) );
	}

	private static function clean( $fields ) {
		$out = array();
		foreach ( (array) $fields as $key => $value ) {
			if ( preg_match( self::SKIP, (string) $key ) ) {
				continue;
			}
			if ( is_array( $value ) ) {
				$value = self::clean( $value );
				if ( ! $value ) {
					continue;
				}
			} elseif ( is_scalar( $value ) ) {
				$value = trim( wp_strip_all_tags( (string) $value ) );
				if ( '' === $value ) {
					continue;
				}
				$value = mb_substr( $value, 0, 4000 );
			} else {
				continue;
			}
			$out[ (string) $key ] = $value;
		}
		return $out;
	}

	/** Posts one enquiry. Returns true when HXG Connect added it. */
	private static function send( $plugin, $form_name, $fields ) {
		$o = self::options();
		if ( empty( $o['url'] ) ) {
			return false;
		}
		$fields = self::clean( $fields );
		if ( ! $fields ) {
			return false;
		}
		$payload = array(
			'plugin'    => $plugin,
			'form_name' => (string) $form_name,
			'page_url'  => (string) wp_get_referer(),
			'site'      => home_url(),
			'fields'    => $fields,
		);
		foreach ( array( 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid' ) as $k ) {
			if ( ! empty( $_COOKIE[ $k ] ) ) { // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
				$payload[ $k ] = sanitize_text_field( wp_unslash( $_COOKIE[ $k ] ) );
			}
		}
		$payload = apply_filters( 'hxg_connect_leads_payload', $payload, $plugin );
		if ( ! $payload ) {
			return false;
		}

		$res = wp_remote_post(
			$o['url'],
			array(
				'timeout' => 6,
				'headers' => array( 'Content-Type' => 'application/json', 'User-Agent' => 'HXG-Connect-Leads/1.0; ' . home_url() ),
				'body'    => wp_json_encode( $payload ),
			)
		);

		if ( is_wp_error( $res ) ) {
			self::log( $plugin, $form_name, 0, $res->get_error_message() );
			return false;
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		$body = json_decode( wp_remote_retrieve_body( $res ), true );
		self::log( $plugin, $form_name, $code, is_array( $body ) && isset( $body['message'] ) ? (string) $body['message'] : '' );
		return 200 === $code;
	}

	/** Last 20 results, without any of the visitor's details. */
	private static function log( $plugin, $form_name, $code, $message ) {
		$log = get_option( self::LOG, array() );
		array_unshift(
			$log,
			array(
				't'    => time(),
				'p'    => $plugin,
				'f'    => mb_substr( (string) $form_name, 0, 80 ),
				'c'    => $code,
				'm'    => mb_substr( (string) $message, 0, 160 ),
			)
		);
		update_option( self::LOG, array_slice( $log, 0, 20 ), false );
	}

	// ------------------------------------------------------------------
	// Settings page
	// ------------------------------------------------------------------

	public static function links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( admin_url( 'options-general.php?page=hxg-connect-leads' ) ) . '">' . esc_html__( 'Settings', 'hxg-connect-leads' ) . '</a>' );
		return $links;
	}

	public static function menu() {
		add_options_page( 'HXG Connect Leads', 'HXG Connect Leads', 'manage_options', 'hxg-connect-leads', array( __CLASS__, 'page' ) );
	}

	public static function register() {
		register_setting( 'hxg_connect_leads', self::OPTION, array( 'sanitize_callback' => array( __CLASS__, 'sanitize' ) ) );
	}

	public static function sanitize( $in ) {
		$url = isset( $in['url'] ) ? esc_url_raw( trim( $in['url'] ), array( 'https', 'http' ) ) : '';
		if ( $url && false === strpos( $url, '/api/webhooks/in/' ) ) {
			add_settings_error( self::OPTION, 'bad_url', __( 'That doesn\'t look like a HXG Connect address. Copy it from HXG Connect: Settings > Integrations > Websites, marketplaces and other platforms > WordPress.', 'hxg-connect-leads' ) );
			$url = '';
		}
		return array(
			'url' => $url,
			'woo' => empty( $in['woo'] ) ? 0 : 1,
		);
	}

	public static function send_test() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Not allowed.', 'hxg-connect-leads' ) );
		}
		check_admin_referer( 'hxg_connect_test' );
		$user = wp_get_current_user();
		$ok   = self::send(
			'test',
			'Test from WordPress',
			array(
				'name'    => 'Test lead from ' . wp_parse_url( home_url(), PHP_URL_HOST ),
				'phone'   => '9000012347',
				'email'   => $user->user_email,
				'message' => 'Test lead sent from the HXG Connect Leads plugin',
			)
		);
		wp_safe_redirect( admin_url( 'options-general.php?page=hxg-connect-leads&hxg_test=' . ( $ok ? 'ok' : 'failed' ) ) );
		exit;
	}

	public static function page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$o      = self::options();
		$log    = get_option( self::LOG, array() );
		$found  = array_filter(
			array(
				'Contact Form 7'  => defined( 'WPCF7_VERSION' ),
				'WPForms'         => function_exists( 'wpforms' ),
				'Elementor Pro'   => defined( 'ELEMENTOR_PRO_VERSION' ),
				'Gravity Forms'   => class_exists( 'GFForms' ),
				'Ninja Forms'     => class_exists( 'Ninja_Forms' ),
				'Fluent Forms'    => defined( 'FLUENTFORM' ),
				'Formidable'      => class_exists( 'FrmForm' ),
				'WooCommerce'     => class_exists( 'WooCommerce' ),
			)
		);
		$test = isset( $_GET['hxg_test'] ) ? sanitize_key( wp_unslash( $_GET['hxg_test'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification
		?>
		<div class="wrap">
			<h1>HXG Connect Leads</h1>
			<?php if ( 'ok' === $test ) : ?>
				<div class="notice notice-success"><p><?php esc_html_e( 'Test lead added. Look for it in HXG Connect under Leads.', 'hxg-connect-leads' ); ?></p></div>
			<?php elseif ( 'failed' === $test ) : ?>
				<div class="notice notice-error"><p><?php esc_html_e( 'The test lead didn\'t go through. See the reason in the table below.', 'hxg-connect-leads' ); ?></p></div>
			<?php endif; ?>

			<form method="post" action="options.php">
				<?php settings_fields( 'hxg_connect_leads' ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="hxg-url"><?php esc_html_e( 'HXG Connect address', 'hxg-connect-leads' ); ?></label></th>
						<td>
							<input id="hxg-url" type="url" class="large-text code" name="<?php echo esc_attr( self::OPTION ); ?>[url]" value="<?php echo esc_attr( $o['url'] ); ?>" placeholder="https://…/api/webhooks/in/wordpress/…" />
							<p class="description"><?php esc_html_e( 'In HXG Connect, open Settings > Integrations > Websites, marketplaces and other platforms, choose WordPress and copy the address. Treat it like a password.', 'hxg-connect-leads' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'WooCommerce', 'hxg-connect-leads' ); ?></th>
						<td><label><input type="checkbox" name="<?php echo esc_attr( self::OPTION ); ?>[woo]" value="1" <?php checked( $o['woo'], 1 ); ?> /> <?php esc_html_e( 'Also send each new order\'s buyer as a lead', 'hxg-connect-leads' ); ?></label></td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Forms found on this site', 'hxg-connect-leads' ); ?></th>
						<td><?php echo $found ? esc_html( implode( ', ', array_keys( $found ) ) ) : esc_html__( 'None of the supported form plugins is active yet.', 'hxg-connect-leads' ); ?>
							<p class="description"><?php esc_html_e( 'Every form made with these sends its enquiries automatically. Each form needs a phone number field: HXG Connect needs a mobile number to create a lead.', 'hxg-connect-leads' ); ?></p></td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>

			<?php if ( $o['url'] ) : ?>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
					<input type="hidden" name="action" value="hxg_connect_test" />
					<?php wp_nonce_field( 'hxg_connect_test' ); ?>
					<?php submit_button( __( 'Send test lead', 'hxg-connect-leads' ), 'secondary' ); ?>
				</form>
			<?php endif; ?>

			<?php if ( $log ) : ?>
				<h2><?php esc_html_e( 'Recent sends', 'hxg-connect-leads' ); ?></h2>
				<table class="widefat striped" style="max-width:900px">
					<thead><tr><th><?php esc_html_e( 'When', 'hxg-connect-leads' ); ?></th><th><?php esc_html_e( 'Form', 'hxg-connect-leads' ); ?></th><th><?php esc_html_e( 'Result', 'hxg-connect-leads' ); ?></th></tr></thead>
					<tbody>
					<?php foreach ( $log as $row ) : ?>
						<tr>
							<td><?php echo esc_html( wp_date( 'j M, g:i a', (int) $row['t'] ) ); ?></td>
							<td><?php echo esc_html( $row['f'] ? $row['f'] : $row['p'] ); ?></td>
							<td><?php echo esc_html( 200 === (int) $row['c'] ? ( $row['m'] ? $row['m'] : 'Lead added' ) : ( $row['c'] ? $row['c'] . ': ' : '' ) . ( $row['m'] ? $row['m'] : 'Could not reach HXG Connect' ) ); ?></td>
						</tr>
					<?php endforeach; ?>
					</tbody>
				</table>
				<p class="description"><?php esc_html_e( 'Visitor details are never stored here, only whether each enquiry went through.', 'hxg-connect-leads' ); ?></p>
			<?php endif; ?>
		</div>
		<?php
	}
}

HXG_Connect_Leads::init();
