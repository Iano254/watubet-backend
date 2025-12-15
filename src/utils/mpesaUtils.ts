import axios from 'axios';
import { mpesaConfig } from '../config/mpesaconfig.js';
import { getAccessToken } from '../utils/tokenManager.js';

function getTimestamp(): string {
  return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
}

function generatePassword(timestamp: string): string {
  return Buffer.from(`${mpesaConfig.businessShortCode}${mpesaConfig.passkey}${timestamp}`).toString('base64');
}

export async function initiateSTKPush(phoneNumber: string, amount: number, accountReference: string): Promise<any> {
  try {
    const accessToken = await getAccessToken();
    console.log('Access token obtained:', accessToken);

    const timestamp = getTimestamp();
    const password = generatePassword(timestamp);

    const data = {
      BusinessShortCode: mpesaConfig.businessShortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phoneNumber,
      PartyB: mpesaConfig.businessShortCode,
      PhoneNumber: phoneNumber,
      CallBackURL: mpesaConfig.stkPushCallbackUrl,
      AccountReference: accountReference,
      TransactionDesc: "Game Deposit"
    };

    console.log('STK push request data:', JSON.stringify(data, null, 2));

    const response = await axios.post(mpesaConfig.stkPushUrl, data, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    console.log('STK push response:', JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error) {
    console.error('Error in initiateSTKPush:', error);
    if (axios.isAxiosError(error)) {
      console.error('Axios error details:', error.response?.data);
    }
    throw error;
  }
}

export async function querySTKPush(checkoutRequestId: string): Promise<any> {
  const accessToken = await getAccessToken();
  const timestamp = getTimestamp();
  const password = generatePassword(timestamp);

  const data = {
    BusinessShortCode: mpesaConfig.businessShortCode,
    Password: password,
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId
  };

  try {
    const response = await axios.post(mpesaConfig.stkPushQueryUrl, data, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error querying STK push:', error);
    throw error;
  }
}

export async function b2cPaymentRequest(phoneNumber: string, amount: number, remarks: string, occassion: string = ""): Promise<any> {
  const accessToken = await getAccessToken();

  const data = {
    InitiatorName: mpesaConfig.initiatorName,
    SecurityCredential: mpesaConfig.securityCredential,
    CommandID: "BusinessPayment",
    Amount: amount,
    PartyA: mpesaConfig.businessShortCode,
    PartyB: phoneNumber,
    Remarks: remarks,
    QueueTimeOutURL: mpesaConfig.b2cQueueTimeoutUrl,
    ResultURL: mpesaConfig.b2cResultUrl,
    Occassion: occassion
  };

  try {
    const response = await axios.post(mpesaConfig.b2cPaymentUrl, data, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error initiating B2C payment:', error);
    throw error;
  }
}

export async function transactionStatusQuery(transactionId: string): Promise<any> {
  const accessToken = await getAccessToken();

  const data = {
    Initiator: mpesaConfig.initiatorName,
    SecurityCredential: mpesaConfig.securityCredential,
    CommandID: "TransactionStatusQuery",
    TransactionID: transactionId,
    PartyA: mpesaConfig.businessShortCode,
    IdentifierType: "4",
    ResultURL: mpesaConfig.transactionStatusResultUrl,
    QueueTimeOutURL: mpesaConfig.transactionStatusQueueTimeoutUrl,
    Remarks: "Transaction Status Query",
    Occasion: ""
  };

  try {
    const response = await axios.post(mpesaConfig.transactionStatusUrl, data, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error querying transaction status:', error);
    throw error;
  }
}

export async function accountBalanceQuery(): Promise<any> {
  const accessToken = await getAccessToken();

  const data = {
    Initiator: mpesaConfig.initiatorName,
    SecurityCredential: mpesaConfig.securityCredential,
    CommandID: "AccountBalance",
    PartyA: mpesaConfig.businessShortCode,
    IdentifierType: "4",
    Remarks: "Account Balance Query",
    QueueTimeOutURL: mpesaConfig.transactionStatusQueueTimeoutUrl,
    ResultURL: mpesaConfig.transactionStatusResultUrl
  };

  try {
    const response = await axios.post(mpesaConfig.accountBalanceUrl, data, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error querying account balance:', error);
    throw error;
  }
}

export async function c2bRegisterUrl(): Promise<any> {
  const accessToken = await getAccessToken();

  const data = {
    ShortCode: mpesaConfig.businessShortCode,
    ResponseType: mpesaConfig.responseType,
    ConfirmationURL: mpesaConfig.c2bConfirmationUrl,
    ValidationURL: mpesaConfig.c2bValidationUrl
  };

  try {
    const response = await axios.post(mpesaConfig.c2bRegisterUrl, data, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error registering C2B URLs:', error);
    throw error;
  }
}

export async function c2bSimulate(
  amount: number,
  msisdn: string,
  billRefNumber: string
): Promise<any> {
  const accessToken = await getAccessToken();

  const data = {
    ShortCode: mpesaConfig.businessShortCode,
    CommandID: "CustomerPayBillOnline",
    Amount: amount,
    Msisdn: msisdn,
    BillRefNumber: billRefNumber
  };

  try {
    const response = await axios.post(mpesaConfig.c2bSimulateUrl, data, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error simulating C2B transaction:', error);
    throw error;
  }
}

export async function reverseTransaction(
  transactionID: string,
  amount: number,
  remarks: string
): Promise<any> {
  const accessToken = await getAccessToken();

  const data = {
    Initiator: mpesaConfig.initiatorName,
    SecurityCredential: mpesaConfig.securityCredential,
    CommandID: "TransactionReversal",
    TransactionID: transactionID,
    Amount: amount,
    ReceiverParty: mpesaConfig.businessShortCode,
    RecieverIdentifierType: "11",
    ResultURL: mpesaConfig.transactionReversalResultUrl,
    QueueTimeOutURL: mpesaConfig.transactionReversalQueueTimeoutUrl,
    Remarks: remarks,
    Occasion: ""
  };

  try {
    const response = await axios.post(mpesaConfig.transactionReversalUrl, data, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error reversing transaction:', error);
    throw error;
  }
}
