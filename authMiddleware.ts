import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'your-refresh-secret-key';

export const generateTokens = async (user: { id: string; walletId: string; phoneNumber: string }) => {
  const accessToken = jwt.sign(user, JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = jwt.sign(user, REFRESH_TOKEN_SECRET, { expiresIn: '7d' });

  // Store the refresh token in the database
  await prisma.user.update({
    where: { id: user.id },
    data: { refreshToken }
  });

  return { accessToken, refreshToken };
};

export const verifyToken = (token: string): { id: string; walletId: string; phoneNumber: string } | null => {
  try {
    return jwt.verify(token, JWT_SECRET) as { id: string; walletId: string; phoneNumber: string };
  } catch (error) {
    return null;
  }
};

export const verifyRefreshToken = async (token: string): Promise<{ id: string; walletId: string; phoneNumber: string } | null> => {
  try {
    const decoded = jwt.verify(token, REFRESH_TOKEN_SECRET) as { id: string; walletId: string; phoneNumber: string };
    const user = await prisma.user.findUnique({ where: { id: decoded.id } });

    if (user && user.refreshToken === token) {
      return decoded;
    }
    return null;
  } catch (error) {
    return null;
  }
};

export const invalidateRefreshToken = async (userId: string): Promise<void> => {
  await prisma.user.update({
    where: { id: userId },
    data: { refreshToken: null }
  });
};