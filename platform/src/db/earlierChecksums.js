'use strict';

/**
 * Checksums migration files had when they were applied, before their
 * comments were reworded. The migrations do the same as before, apart from
 * 032 naming the console access column, which 043 renames on tenants
 * migrated earlier. A tenant that recorded one of these checksums is moved to
 * the file's current checksum instead of being refused as changed.
 */
module.exports = {
  'platform': {
    '004_transaction_limits': [
      'f7ccd14f889e06b0'
    ],
    '005_user_custom_fields': [
      '80d3ac9738854326'
    ],
    '006_tenant_user_management': [
      '7b75caa0491baa3c'
    ],
    '007_roles_and_permissions': [
      'dc74b9a7e153f44b'
    ],
    '008_access_control': [
      '0767af5fb35c7d53'
    ],
    '009_clients_and_groups': [
      '69e2abea54e6c71f'
    ],
    '014_activity_feed': [
      '61d934834105c33d'
    ]
  },
  'tenant': {
    '001_core': [
      '671d289ecf7f6019'
    ],
    '009_loan_accounting': [
      '3817d5ef50b78f68'
    ],
    '010_product_types': [
      '59a4029c02e61fc6'
    ],
    '011_loan_product_configuration': [
      'f3b6a51b30fe8319'
    ],
    '012_tranches_revolving_securities_tax_funding': [
      '28e02dbc331d62a6'
    ],
    '013_product_accounting': [
      '6345860ab81f47d7'
    ],
    '017_interest_precision_non_working_days': [
      '6d5bfd192177da16'
    ],
    '018_interest_engine_completion': [
      '2296375ad54d0e7c'
    ],
    '019_index_and_adjustable_rates': [
      'e091d07b6b7314c8'
    ],
    '020_schedule_editing': [
      '45e582d3516a9586'
    ],
    '021_repayment_collection': [
      'f6ffb61ae53aeb5b'
    ],
    '022_prepaid_interest_postdated_application_schedules': [
      'd9a4a9fdd6858a0a'
    ],
    '023_fees_penalties_arrears': [
      'd45661a5ed015d73'
    ],
    '024_securities_controls_settlement': [
      'a00f5afe3a46ff19'
    ],
    '025_working_with_loan_accounts': [
      '4d1903216bbedecb'
    ],
    '026_closing_and_exiting': [
      '6eec337862841664'
    ],
    '027_organization_setup': [
      'd2b47950bd250904'
    ],
    '028_data_management': [
      '203fe9dc34712290'
    ],
    '029_data_importing': [
      'c4412bdb99295eed'
    ],
    '030_reporting': [
      'e42f27d4a90fe086'
    ],
    '031_workspace': [
      '15b18e8a78274c11'
    ],
    '032_access_control': [
      '6f12dd30eab2e53e'
    ],
    '033_clients_and_groups': [
      'e83d23ace8b2029f'
    ],
    '034_open_items': [
      '33ffc34020194ac7'
    ],
    '035_credit_arrangements_and_solidarity_loans': [
      '2ec30a1f748b908e'
    ],
    '036_deposit_products': [
      'adee108ac5eec758'
    ],
    '037_deposit_accounts_and_offset': [
      '2ecf8be081b03e4e'
    ],
    '038_deposit_account_editing': [
      'a49936feea9e6882'
    ],
    '039_working_with_deposit_accounts': [
      '4560ae3199a63a22'
    ],
    '040_overdraft_terms': [
      'a20f4e667661a4ab'
    ],
    '041_chart_and_journal_entries': [
      '1eb336a7b9202dce'
    ],
    '042_activities_and_audit_integrity': [
      'e6d44a9f7893d7b9'
    ]
  }
};
