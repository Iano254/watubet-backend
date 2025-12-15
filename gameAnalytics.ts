// gameAnalytics.ts

import { PrismaClient } from '@prisma/client';
import { CrashGame } from './crashGame.ts';

const prisma = new PrismaClient();

interface GameAnalytics {
  averageCrashPoint: number;
  totalBets: number;
  totalWagered: number;
  totalPayout: number;
  uniquePlayers: number;
  houseProfit: number;
  effectiveHouseEdge: number;
}

interface PlayerRetention {
  totalPlayers: number;
  returningPlayers: number;
  retentionRate: number;
}

export class GameAnalyticsManager {
  private static instance: GameAnalyticsManager;
  private gameCount: number = 0;
  private targetProfitMargin: number = 0.05; // 5% target profit margin
  private playerRetentionGoal: number = 0.7; // 70% retention rate goal
  private riskThreshold: number = 1000000; // Maximum allowed loss in a given period

  private constructor() {}

  public static getInstance(): GameAnalyticsManager {
    if (!GameAnalyticsManager.instance) {
      GameAnalyticsManager.instance = new GameAnalyticsManager();
    }
    return GameAnalyticsManager.instance;
  }

  public async collectGameData(gameId: string): Promise<void> {
    // Collect and store game data
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: { bets: true }
    });

    if (game) {
      this.gameCount++;
      // Here you would store or process the game data
      // For now, we'll just log it
      console.log(`Game ${gameId} data collected. Crash point: ${game.crashPoint}`);
    }
  }

  public async getGameAnalytics(days: number = 7): Promise<GameAnalytics> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const games = await prisma.game.findMany({
      where: {
        createdAt: { gte: startDate }
      },
      include: { bets: true }
    });

    let totalCrashPoints = 0;
    let totalBets = 0;
    let totalWagered = 0;
    let totalPayout = 0;
    const uniquePlayers = new Set<string>();

    games.forEach(game => {
      totalCrashPoints += game.crashPoint;
      totalBets += game.bets.length;
      game.bets.forEach(bet => {
        totalWagered += bet.amount;
        if (bet.cashoutAt) {
          totalPayout += bet.amount * bet.cashoutAt;
        }
        uniquePlayers.add(bet.userId);
      });
    });

    const houseProfit = totalWagered - totalPayout;
    const effectiveHouseEdge = totalWagered > 0 ? houseProfit / totalWagered : 0;

    return {
      averageCrashPoint: totalCrashPoints / games.length,
      totalBets,
      totalWagered,
      totalPayout,
      uniquePlayers: uniquePlayers.size,
      houseProfit,
      effectiveHouseEdge
    };
  }

  public async getPlayerRetention(days: number = 30): Promise<PlayerRetention> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const players = await prisma.user.findMany({
      where: {
        createdAt: { lte: startDate }
      },
      include: {
        bets: {
          where: {
            createdAt: { gte: startDate }
          }
        }
      }
    });

    const totalPlayers = players.length;
    const returningPlayers = players.filter(player => player.bets.length > 0).length;

    return {
      totalPlayers,
      returningPlayers,
      retentionRate: returningPlayers / totalPlayers
    };
  }

  public async adjustGameParameters(): Promise<void> {
    const analytics = await this.getGameAnalytics();
    const retention = await this.getPlayerRetention();

    let newHouseEdge = CrashGame.getHouseEdge();
    let newMaxCrashPoint = CrashGame.getMaxCrashPoint();

    if (analytics.effectiveHouseEdge < this.targetProfitMargin) {
      newHouseEdge = Math.min(newHouseEdge + 0.01, 0.10); // Increase house edge, max 10%
    } else if (retention.retentionRate < this.playerRetentionGoal) {
      newHouseEdge = Math.max(newHouseEdge - 0.005, 0.01); // Decrease house edge, min 1%
      newMaxCrashPoint = Math.min(newMaxCrashPoint * 1.1, 1000); // Increase max crash point, max 1000x
    }

    if (analytics.houseProfit < -this.riskThreshold) {
      newHouseEdge = Math.min(newHouseEdge + 0.02, 0.15); // Significant increase in house edge
      newMaxCrashPoint = Math.max(newMaxCrashPoint * 0.9, 20); // Decrease max crash point, min 20x
    }

    CrashGame.setHouseEdge(newHouseEdge);
    CrashGame.setMaxCrashPoint(newMaxCrashPoint);

    console.log(`Game parameters adjusted. New house edge: ${newHouseEdge}, New max crash point: ${newMaxCrashPoint}`);
  }

  public setTargetProfitMargin(margin: number): void {
    this.targetProfitMargin = margin;
  }

  public setPlayerRetentionGoal(goal: number): void {
    this.playerRetentionGoal = goal;
  }

  public setRiskThreshold(threshold: number): void {
    this.riskThreshold = threshold;
  }

  public getGameCount(): number {
    return this.gameCount;
  }
}