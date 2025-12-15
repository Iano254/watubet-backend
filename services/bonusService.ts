import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Bonus types
export enum BonusType {
  DEPOSIT_CASHBACK = 'DEPOSIT_CASHBACK',
  LOSING_STREAK = 'LOSING_STREAK',
  WINNING_STREAK = 'WINNING_STREAK'
}

// Bonus settings interface
export interface BonusSettings {
  enabled: boolean;
  name: string;
  percentage: number;
  requiredRounds?: number; // For streak bonuses
}

/**
 * Get all bonus settings
 */
export async function getBonusSettings(): Promise<Record<BonusType, BonusSettings>> {
  const settings = await prisma.gameSettings.findMany({
    where: {
      key: {
        startsWith: 'bonus_'
      }
    }
  });

  // Default settings
  const defaultSettings: Record<BonusType, BonusSettings> = {
    [BonusType.DEPOSIT_CASHBACK]: {
      enabled: true,
      name: 'Deposit Cashback Bonus',
      percentage: 20
    },
    [BonusType.LOSING_STREAK]: {
      enabled: true,
      name: 'Bonus Boost',
      percentage: 20,
      requiredRounds: 5
    },
    [BonusType.WINNING_STREAK]: {
      enabled: true,
      name: 'Bonus Boost',
      percentage: 20,
      requiredRounds: 2
    }
  };

  // Parse settings from database
  for (const setting of settings) {
    const [_, bonusType, property] = setting.key.split('_');
    const type = bonusType.toUpperCase() as keyof typeof BonusType;

    if (type in BonusType) {
      if (property === 'enabled') {
        defaultSettings[BonusType[type]].enabled = setting.value === 'true';
      } else if (property === 'name') {
        defaultSettings[BonusType[type]].name = setting.value;
      } else if (property === 'percentage') {
        defaultSettings[BonusType[type]].percentage = parseFloat(setting.value);
      } else if (property === 'requiredRounds') {
        defaultSettings[BonusType[type]].requiredRounds = parseInt(setting.value);
      }
    }
  }

  return defaultSettings;
}

/**
 * Update bonus settings
 */
export async function updateBonusSettings(
  type: BonusType,
  settings: Partial<BonusSettings>
): Promise<void> {
  const updates = [];

  if (settings.enabled !== undefined) {
    updates.push(
      prisma.gameSettings.upsert({
        where: { key: `bonus_${type.toLowerCase()}_enabled` },
        update: { value: settings.enabled.toString() },
        create: { key: `bonus_${type.toLowerCase()}_enabled`, value: settings.enabled.toString() }
      })
    );
  }

  if (settings.name !== undefined) {
    updates.push(
      prisma.gameSettings.upsert({
        where: { key: `bonus_${type.toLowerCase()}_name` },
        update: { value: settings.name },
        create: { key: `bonus_${type.toLowerCase()}_name`, value: settings.name }
      })
    );
  }

  if (settings.percentage !== undefined) {
    updates.push(
      prisma.gameSettings.upsert({
        where: { key: `bonus_${type.toLowerCase()}_percentage` },
        update: { value: settings.percentage.toString() },
        create: { key: `bonus_${type.toLowerCase()}_percentage`, value: settings.percentage.toString() }
      })
    );
  }

  if (settings.requiredRounds !== undefined) {
    updates.push(
      prisma.gameSettings.upsert({
        where: { key: `bonus_${type.toLowerCase()}_requiredRounds` },
        update: { value: settings.requiredRounds.toString() },
        create: { key: `bonus_${type.toLowerCase()}_requiredRounds`, value: settings.requiredRounds.toString() }
      })
    );
  }

  await prisma.$transaction(updates);
}

/**
 * Process deposit cashback bonus
 */
export async function processDepositCashbackBonus(userId: string, depositAmount: number): Promise<number> {
  const bonusSettings = await getBonusSettings();
  const settings = bonusSettings[BonusType.DEPOSIT_CASHBACK];

  if (!settings.enabled || settings.percentage <= 0) {
    return 0;
  }

  const bonusAmount = (depositAmount * settings.percentage) / 100;

  // Create bonus record
  await prisma.bonus.create({
    data: {
      userId,
      type: BonusType.DEPOSIT_CASHBACK,
      amount: bonusAmount,
      depositAmount,
      percentage: settings.percentage,
      status: 'CREDITED'
    }
  });

  // Update user balance
  await prisma.user.update({
    where: { id: userId },
    data: {
      balance: {
        increment: bonusAmount
      }
    }
  });

  return bonusAmount;
}

/**
 * Check and process losing streak bonus
 */
export async function checkLosingStreakBonus(userId: string): Promise<number> {
  const bonusSettings = await getBonusSettings();
  const settings = bonusSettings[BonusType.LOSING_STREAK];

  if (!settings.enabled || !settings.requiredRounds || settings.percentage <= 0) {
    return 0;
  }

  // Get user's recent bets
  const recentBets = await prisma.bet.findMany({
    where: {
      userId,
      isSimulated: false
    },
    orderBy: {
      createdAt: 'desc'
    },
    take: settings.requiredRounds,
    include: {
      game: true
    }
  });

  // Check if we have enough bets to evaluate
  if (recentBets.length < settings.requiredRounds) {
    return 0;
  }

  // Check if all recent bets were losses
  const allLosses = recentBets.every(bet =>
    bet.cashoutAt === null || bet.cashoutAt === 0 || (bet.game && bet.game.crashPoint < (bet.cashoutAt || 0))
  );


  if (!allLosses) {
    return 0;
  }

  // Calculate total lost amount
  const totalLost = recentBets.reduce((sum, bet) => sum + bet.amount, 0);
  const bonusAmount = (totalLost * settings.percentage) / 100;

  // Check if user already received this bonus recently
  const recentBonus = await prisma.bonus.findFirst({
    where: {
      userId,
      type: BonusType.LOSING_STREAK,
      createdAt: {
        gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
      }
    }
  });

  if (recentBonus) {
    return 0; // Already received bonus recently
  }

  // Create bonus record
  await prisma.bonus.create({
    data: {
      userId,
      type: BonusType.LOSING_STREAK,
      amount: bonusAmount,
      percentage: settings.percentage,
      status: 'CREDITED',
      metadata: JSON.stringify({
        lostAmount: totalLost,
        streakLength: settings.requiredRounds
      })
    }
  });

  // Update user balance
  await prisma.user.update({
    where: { id: userId },
    data: {
      balance: {
        increment: bonusAmount
      }
    }
  });

  return bonusAmount;
}

/**
 * Check and process winning streak bonus
 */
export async function checkWinningStreakBonus(userId: string): Promise<number> {
  const bonusSettings = await getBonusSettings();
  const settings = bonusSettings[BonusType.WINNING_STREAK];

  if (!settings.enabled || !settings.requiredRounds || settings.percentage <= 0) {
    return 0;
  }

  // Get user's recent bets
  const recentBets = await prisma.bet.findMany({
    where: {
      userId,
      isSimulated: false,
      cashoutAt: {
        not: null
      }
    },
    orderBy: {
      createdAt: 'desc'
    },
    take: settings.requiredRounds,
    include: {
      game: true
    }
  });

  // Check if we have enough bets to evaluate
  if (recentBets.length < settings.requiredRounds) {
    return 0;
  }

  // Check if all recent bets were wins
  const allWins = recentBets.every(bet =>
    bet.cashoutAt !== null && bet.cashoutAt > 0 && bet.game && bet.game.crashPoint >= bet.cashoutAt
  );


  if (!allWins) {
    return 0;
  }

  // Calculate total won amount
  const totalWon = recentBets.reduce((sum, bet) => {
    const winAmount = bet.cashoutAt ? bet.amount * bet.cashoutAt : 0;
    return sum + (winAmount - bet.amount); // Net profit
  }, 0);

  const bonusAmount = (totalWon * settings.percentage) / 100;

  // Check if user already received this bonus recently
  const recentBonus = await prisma.bonus.findFirst({
    where: {
      userId,
      type: BonusType.WINNING_STREAK,
      createdAt: {
        gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
      }
    }
  });

  if (recentBonus) {
    return 0; // Already received bonus recently
  }

  // Create bonus record
  await prisma.bonus.create({
    data: {
      userId,
      type: BonusType.WINNING_STREAK,
      amount: bonusAmount,
      percentage: settings.percentage,
      status: 'CREDITED',
      metadata: JSON.stringify({
        wonAmount: totalWon,
        streakLength: settings.requiredRounds
      })
    }
  });

  // Update user balance
  await prisma.user.update({
    where: { id: userId },
    data: {
      balance: {
        increment: bonusAmount
      }
    }
  });

  return bonusAmount;
}

/**
 * Get user's bonus history
 */
export async function getUserBonusHistory(userId: string) {
  return prisma.bonus.findMany({
    where: {
      userId
    },
    orderBy: {
      createdAt: 'desc'
    }
  });
}
