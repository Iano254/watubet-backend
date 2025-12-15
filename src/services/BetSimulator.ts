import { Server } from 'socket.io';
import { GameSession } from '../../gameSession.js';
import { PrismaClient } from '@prisma/client';
import { CrashGame } from '../../crashGame.js';

const prisma = new PrismaClient();



interface SimulatedUser {
  userId: string;
  walletId: string;
  wallet: number;
  bettingStyle: 'conservative' | 'moderate' | 'aggressive';
  targetMultiplier: number;
  preferredBetRange: { min: number; max: number };
  hasCashedOut: boolean;
  cashoutMultiplier?: number;
  activeBet?: {
    amount: number;
    placedAt: number;
    gameId?: string;
  };
}

interface CompletedBet {
  userId: string;
  walletId: string;
  amount: number;
  cashoutAt: number | null;
  gameId: string;
  isSimulated: boolean;
}

export class BetSimulator {
  private simulatedUsers: Map<string, SimulatedUser> = new Map();
  private activeBets: Set<string> = new Set();
  private nextRoundBets: Set<string> = new Set();
  private completedBets: CompletedBet[] = [];
  private io: Server;
  private currentGameId: string | null = null;
  private crashGameInstance: CrashGame | null = null;

  constructor(io: Server, crashGameInstance: CrashGame) {
    this.io = io;
    this.crashGameInstance = crashGameInstance;
    this.generateSimulatedUsers();
  }

  private generateSimulatedUsers(): void {
    const numberOfUsers = Math.floor(Math.random() * 20) + 30; // 30-50 users
    this.simulatedUsers.clear();
    
    for (let i = 0; i < numberOfUsers; i++) {
      const userId = this.generateUserId();
      const walletId = this.generateWalletId();
      const bettingStyle = this.assignBettingStyle();
      
      this.simulatedUsers.set(userId, {
        userId,
        walletId,
        wallet: 1000000,
        bettingStyle,
        targetMultiplier: this.generateTargetMultiplier(bettingStyle),
        preferredBetRange: this.getPreferredBetRange(bettingStyle),
        hasCashedOut: false
      });
    }
  }

  private generateUserId(): string {
    return 'SIM_' + Math.random().toString(36).substring(2, 8);
  }

  private generateWalletId(): string {
    return 'SW_' + Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  private assignBettingStyle(): 'conservative' | 'moderate' | 'aggressive' {
    const rand = Math.random();
    if (rand < 0.4) return 'conservative';
    if (rand < 0.8) return 'moderate';
    return 'aggressive';
  }

  private generateTargetMultiplier(style: 'conservative' | 'moderate' | 'aggressive'): number {
    // Base multiplier based on style
    const baseMultiplier = (() => {
      switch (style) {
        case 'conservative':
          return 1.2 + Math.random() * 0.8; // 1.2x - 2x
        case 'moderate':
          return 2 + Math.random() * 2; // 2x - 4x
        case 'aggressive':
          return 4 + Math.random() * 5; // 4x - 9x
      }
    })();

    // Add some variance (±10%)
    const variance = (Math.random() - 0.5) * 0.2 * baseMultiplier;
    return Number((baseMultiplier + variance).toFixed(2));
  }

  private getPreferredBetRange(style: 'conservative' | 'moderate' | 'aggressive'): { min: number; max: number } {
    switch (style) {
      case 'conservative':
        return { min: 10, max: 500 };
      case 'moderate':
        return { min: 500, max: 2000 };
      case 'aggressive':
        return { min: 2000, max: 10000 };
    }
  }

  private generateBetAmount(user: SimulatedUser): number {
    const { min, max } = user.preferredBetRange;
    // Add some randomness to bet amounts
    const baseAmount = Math.floor(Math.random() * (max - min + 1) + min);
    const variance = Math.random() < 0.2 ? 
      Math.random() * baseAmount * 0.3 : // 20% chance of significant variance
      Math.random() * baseAmount * 0.1;  // Normal small variance
    
    return Math.floor(baseAmount + variance);
  }

  public setCurrentGameId(gameId: string) {
    this.currentGameId = gameId;
  }

  public simulateBetsForNewGame(currentGame: GameSession): void {
    this.currentGameId = currentGame.id;
    
    // Reset all users' status for new game
    this.simulatedUsers.forEach(user => {
      user.hasCashedOut = false;
      user.cashoutMultiplier = undefined;
      user.activeBet = undefined;
    });
    
    this.activeBets.clear();
    this.nextRoundBets.clear();

    // Select random number of users to bet (40-60%)
    const bettingUsers = Math.floor(this.simulatedUsers.size * (0.4 + Math.random() * 0.2));
    const shuffledUsers = Array.from(this.simulatedUsers.values())
      .sort(() => Math.random() - 0.5)
      .slice(0, bettingUsers);

    // Place bets
    shuffledUsers.forEach(user => {
      const betAmount = this.generateBetAmount(user);
      this.activeBets.add(user.userId);
      
      user.activeBet = {
        amount: betAmount,
        placedAt: Date.now(),
        gameId: currentGame.id
      };

      // Randomize target multiplier slightly for each new bet
      user.targetMultiplier = this.generateTargetMultiplier(user.bettingStyle);

      this.io.emit('betPlaced', {
        userId: user.userId,
        amount: betAmount,
        gameHash: currentGame.getCurrentGameHash(),
        isSimulated: true
      });

      currentGame.placeBet(user.walletId, betAmount);
    });
  }

  public simulateCashouts(currentGame: GameSession, currentMultiplier: number): void {
    const potentialCashouts = Array.from(this.activeBets)
      .map(userId => this.simulatedUsers.get(userId))
      .filter(user => user && !user.hasCashedOut && user.activeBet);
  
    console.log(`Simulating cashouts for ${potentialCashouts.length} potential users at ${currentMultiplier}x`);
  
    potentialCashouts.forEach(user => {
      if (!user || !user.activeBet || user.hasCashedOut) return;
  
      // Randomize cashout decision based on proximity to target
      const proximityToTarget = currentMultiplier / user.targetMultiplier;
      
      const shouldCashout = (() => {
        if (currentMultiplier >= user.targetMultiplier) {
          switch (user.bettingStyle) {
            case 'conservative':
              // Conservative users cash out quickly once target is reached
              return Math.random() < 0.8;
            case 'moderate':
              // Moderate users might wait a bit longer
              return Math.random() < 0.5 * proximityToTarget;
            case 'aggressive':
              // Aggressive users more likely to wait for higher multipliers
              return Math.random() < 0.3 * proximityToTarget;
            default:
              return false;
          }
        }
        // Small chance of early cashout if close to target
        return proximityToTarget > 0.9 && Math.random() < 0.1;
      })();
  
      if (shouldCashout) {
        console.log(`Simulated user ${user.walletId} attempting cashout at ${currentMultiplier}x`);
        const winnings = currentGame.cashout(user.walletId);
        
        if (winnings !== null) {
          user.hasCashedOut = true;
          user.cashoutMultiplier = currentMultiplier;
          this.activeBets.delete(user.userId);
  
          // Store completed bet
          const completedBet: CompletedBet = {
            userId: user.userId,
            walletId: user.walletId,
            amount: user.activeBet.amount,
            cashoutAt: currentMultiplier,
            gameId: this.currentGameId || currentGame.id,
            isSimulated: true
          };
          
          this.completedBets.push(completedBet);
  
          // Update game stats with simulated flag
          if (this.crashGameInstance) {
            this.crashGameInstance.updateCurrentWinnings(
              user.activeBet.amount,
              currentMultiplier,
              true // Mark as simulated
            );
          }
  
          // Calculate actual winnings amount
          const cashoutAmount = user.activeBet.amount * currentMultiplier;
  
          // Emit the cashout event
          this.io.emit('cashoutSuccess', {
            userId: user.userId,
            walletId: user.walletId,
            multiplier: currentMultiplier,
            amount: winnings,
            originalBet: user.activeBet.amount,
            profit: winnings - user.activeBet.amount,
            isSimulated: true,
            bettingStyle: user.bettingStyle,
            timestamp: Date.now()
          });
  
          // Update bet display for all users
          this.io.emit('betUpdated', {
            userId: user.userId,
            walletId: user.walletId,
            amount: user.activeBet.amount,
            cashoutAt: currentMultiplier,
            winAmount: cashoutAmount,
            isSimulated: true,
            timestamp: Date.now()
          });
  
          console.log(`Simulated cashout successful for ${user.walletId}: ${winnings} at ${currentMultiplier}x`);
        } else {
          console.log(`Simulated cashout failed for ${user.walletId} at ${currentMultiplier}x`);
        }
      }
    });
  }

  public simulateNextRoundBets(currentGame: GameSession): void {
    // Only allow users who haven't bet or have cashed out to place next round bets
    const eligibleUsers = Array.from(this.simulatedUsers.values())
      .filter(user => 
        !this.activeBets.has(user.userId) && 
        !this.nextRoundBets.has(user.userId) &&
        (user.hasCashedOut || !user.activeBet)
      );

    // Limit next round bets
    const maxBets = Math.min(5, Math.floor(eligibleUsers.length * 0.2));
    const selectedUsers = eligibleUsers
      .sort(() => Math.random() - 0.5)
      .slice(0, maxBets);

    selectedUsers.forEach(user => {
      const betAmount = this.generateBetAmount(user);
      this.nextRoundBets.add(user.userId);
      
      this.io.emit('betPlaced', {
        userId: user.userId,
        amount: betAmount,
        gameHash: currentGame.getCurrentGameHash(),
        forNextRound: true,
        isSimulated: true
      });

      currentGame.addNextRoundBet({ walletId: user.walletId, amount: betAmount });
    });
  }

  private async saveSimulatedBet(bet: CompletedBet) {
    try {
      // Create a simulated user if doesn't exist
      const user = await prisma.user.upsert({
        where: { walletId: bet.walletId },
        update: {},
        create: {
          id: bet.userId,
          walletId: bet.walletId,
          phoneNumber: `+254${Math.floor(Math.random() * 100000000)}`,
          password: 'simulated',
          balance: 1000000,
          clientSeed: Math.random().toString(36).substring(7),
          
        }
      });

      // Save the bet
      await prisma.bet.create({
        data: {
          userId: user.id,
          walletId: bet.walletId,
          amount: bet.amount,
          gameId: bet.gameId,
          cashoutAt: bet.cashoutAt,
          
        }
      });
    } catch (error) {
      console.error('Error saving simulated bet:', error);
    }
  }

  public async saveGameHistory(gameId: string) {
    const betsToSave = Array.from(this.simulatedUsers.values())
      .filter(user => user.hasCashedOut || user.activeBet)
      .map(user => ({
        userId: user.userId,
        walletId: user.walletId,
        amount: user.activeBet?.amount || 0,
        cashoutAt: user.cashoutMultiplier || null,
        gameId,
        isSimulated: true
      }));

    await Promise.all(betsToSave.map(bet => this.saveSimulatedBet(bet)));
  }

  public resetSimulation(): void {
    this.activeBets.clear();
    this.nextRoundBets.clear();
    this.completedBets = [];
    this.currentGameId = null;
    this.generateSimulatedUsers();
  }

  public getBetCount(): number {
    return this.activeBets.size;
  }

  public getNextRoundBetCount(): number {
    return this.nextRoundBets.size;
  }
}
