import axios from 'axios';
import { mpesaConfig } from '../config/mpesaconfig.js';

interface TokenData {
  accessToken: string;
  expiresAt: number;
}

let tokenData: TokenData | null = null;

async function fetchNewToken(): Promise<TokenData> {
  const auth = Buffer.from(`${mpesaConfig.consumerKey}:${mpesaConfig.consumerSecret}`).toString('base64');
  try {
    const response = await axios.get(mpesaConfig.oauthTokenUrl, {
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });
    const expiresIn = parseInt(response.data.expires_in, 10);
    return {
      accessToken: response.data.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  } catch (error) {
    console.error('Error fetching new access token:', error);
    throw error;
  }
}

export async function getAccessToken(): Promise<string> {
  if (!tokenData || tokenData.expiresAt <= Date.now()) {
    tokenData = await fetchNewToken();
  }
  return tokenData.accessToken;
}