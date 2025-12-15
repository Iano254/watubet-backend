// betManager.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface Bet {
  id: string;
  userId: string;
  amount: number;
  gameId: string;
  cashoutAt: number | null;
}

export async function getCurrentBets(gameId: string): Promise<Bet[]> {
  return prisma.bet.findMany({
    where: { gameId: gameId },
    select: { id: true, userId: true, amount: true, gameId: true, cashoutAt: true }
  });
}

export async function addBet(bet: Omit<Bet, 'id'>): Promise<Bet> {
  return prisma.bet.create({ data: bet });
}

export async function updateBet(id: string, cashoutAt: number): Promise<Bet> {
  return prisma.bet.update({
    where: { id },
    data: { cashoutAt }
  });
}

export async function clearBets(gameId: string): Promise<void> {
  await prisma.bet.deleteMany({ where: { gameId } });
}
