import twilio from 'twilio';

// require('dotenv').config();
import dotenv from 'dotenv';


const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

const client = twilio(accountSid, authToken);

export const sendVerificationCode = async (phoneNumber: string) => {
  try {
    if (!verifyServiceSid) {
      throw new Error('Twilio Verify Service SID is not defined');
    }
    const verification = await client.verify.v2
      .services(verifyServiceSid)
      .verifications.create({ to: phoneNumber, channel: 'sms' });
    console.log(`Verification sent to ${phoneNumber}: ${verification.status}`);
    return verification.status;
  } catch (error) {
    console.error('Error sending verification:', error);
    throw error;
  }
};

export const checkVerificationCode = async (phoneNumber: string, code: string) => {
  try {
    if (!verifyServiceSid) {
      throw new Error('Twilio Verify Service SID is not defined');
    }
    const verificationCheck = await client.verify.v2
      .services(verifyServiceSid)
      .verificationChecks.create({ to: phoneNumber, code });
    console.log(`Verification check for ${phoneNumber}: ${verificationCheck.status}`);
    return verificationCheck.status === 'approved';
  } catch (error) {
    console.error('Error checking verification:', error);
    throw error;
  }
};
