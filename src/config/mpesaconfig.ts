// src/config/mpesaConfig.ts

export const mpesaConfig = {
  consumerKey: process.env.MPESA_CONSUMER_KEY || '',
  consumerSecret: process.env.MPESA_CONSUMER_SECRET || '',
  passkey: process.env.MPESA_PASSKEY || '',
  businessShortCode: process.env.MPESA_SHORTCODE || '',
  initiatorName: process.env.MPESA_INITIATOR_NAME || '',
  initiatorPassword: process.env.MPESA_INITIATOR_PASSWORD || '',
  securityCredential: process.env.MPESA_SECURITY_CREDENTIAL || '',

  // Live URLs
  oauthTokenUrl: 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
  stkPushUrl: 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
  stkPushQueryUrl: 'https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query',
  b2cPaymentUrl: 'https://api.safaricom.co.ke/mpesa/b2c/v1/paymentrequest',
  transactionStatusUrl: 'https://api.safaricom.co.ke/mpesa/transactionstatus/v1/query',
  accountBalanceUrl: 'https://api.safaricom.co.ke/mpesa/accountbalance/v1/query',
  c2bRegisterUrl: 'https://api.safaricom.co.ke/mpesa/c2b/v1/registerurl',
  c2bSimulateUrl: process.env.MPESA_C2B_SIMULATE_URL || 'https://api.safaricom.co.ke/mpesa/c2b/v1/simulate',
  transactionReversalUrl: process.env.MPESA_TRANSACTION_REVERSAL_URL || 'https://api.safaricom.co.ke/mpesa/reversal/v1/request',
  transactionReversalResultUrl: process.env.MPESA_TRANSACTION_REVERSAL_RESULT_URL || 'https://your-domain.com/api/mpesa/reversal-result',
  transactionReversalQueueTimeoutUrl: process.env.MPESA_TRANSACTION_REVERSAL_QUEUE_TIMEOUT_URL || 'https://your-domain.com/api/mpesa/reversal-queue-timeout',




  // Callback URLs (update these with your actual live endpoints)
  stkPushCallbackUrl: process.env.MPESA_STK_PUSH_CALLBACK_URL || 'https://pepeaaviator.com/api/mpesa/stk-callback',
  b2cResultUrl: process.env.MPESA_B2C_RESULT_URL || 'https://pepeaaviator.com/api/mpesa/b2c-result',
  b2cQueueTimeoutUrl: process.env.MPESA_B2C_QUEUE_TIMEOUT_URL || 'https://pepeaaviator.com/api/mpesa/b2c-queue-timeout',
  c2bValidationUrl: process.env.MPESA_C2B_VALIDATION_URL || 'https://pepeaaviator.com/api/mpesa/c2b-validation',
  c2bConfirmationUrl: process.env.MPESA_C2B_CONFIRMATION_URL || 'https://pepeaaviator.com/api/mpesa/c2b-confirmation',
  transactionStatusResultUrl: process.env.MPESA_TRANSACTION_STATUS_RESULT_URL || 'https://pepeaaviator.com/api/mpesa/transaction-status-result',
  transactionStatusQueueTimeoutUrl: process.env.MPESA_TRANSACTION_STATUS_QUEUE_TIMEOUT_URL || 'https://pepeaaviator.com/api/mpesa/transaction-status-queue-timeout',

  // Other configurations
  environment: 'production',
  responseType: 'Completed',
};