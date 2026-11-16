<?php
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}
delete_option( 'hxg_connect_leads' );
delete_option( 'hxg_connect_leads_log' );
