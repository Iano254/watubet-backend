import crypto from 'crypto';

export interface GameState {
  state: 'WAITING' | 'ACTIVE' | 'ENDED';
  elapsedTime: number;
  multiplier: number;
  countdown: number | null;
  gameHash: string;
  crashPoint: number | null;
  roundId: number;
}

export class GameSession {
  public readonly id: string;
  public readonly gameHash: string;
  private crashPoint: number; 
  private readonly salt: string;
  public readonly clientSeed: string;
  private gameStartTime: number | null = null;
  private gameEndTime: number | null = null;
  private bets: Map<string, { walletId: string; amount: number; cashoutAt: number | null }> = new Map();
  private nextRoundBets: Array<{ walletId: string, amount: number }> = [];
  private currentMultiplier: number = 1;
  private secondBets: Map<string, { walletId: string; amount: number; cashoutAt: number | null }> = new Map();
  private secondNextRoundBets: Array<{ walletId: string, amount: number }> = [];
  private roundId: number;

constructor(id: string, gameHash: string, crashPoint: number, salt: string, clientSeed: string, roundId: number) {
  this.id = id;
  this.gameHash = gameHash;
  this.crashPoint = crashPoint;
  this.salt = salt;
  this.clientSeed = clientSeed;
  this.roundId = roundId;
}

  public startGame(): void {
    this.gameStartTime = Date.now();
    console.log('Game started. Moving next round bets to current bets.');
    this.moveNextRoundBetsToCurrent();
    this.moveSecondNextRoundBetsToCurrent();
    console.log('Current bets after moving:', JSON.stringify(Array.from(this.bets.entries())));
    console.log('Current second bets after moving:', JSON.stringify(Array.from(this.secondBets.entries())));
  }

  public endGame(): void {
    this.gameEndTime = Date.now();
  }

  public isGameInProgress(): boolean {
    return this.gameStartTime !== null && this.gameEndTime === null;
  }

  public updateMultiplier(): void {
    if (!this.isGameInProgress()) return;
    const elapsed = Date.now() - (this.gameStartTime as number);
    const rawMultiplier = Math.pow(Math.E, 0.3 * elapsed / 1000);
    
    // Use larger increment (0.5) for multipliers above 10x
    const increment = this.currentMultiplier > 10 ? 0.51 : 0.011;
    const steps = Math.floor((rawMultiplier - this.currentMultiplier) / increment);
    if (steps > 0) {
      this.currentMultiplier = Math.round((this.currentMultiplier + increment) * 100) / 100;
    }
  }

  public getCurrentMultiplier(): number {
    return this.currentMultiplier;
  }

  public getCrashPoint(): number {
    return this.crashPoint;
  }

  public getCurrentGameHash(): string {
    return this.gameHash;
  }

  public getActiveBet(walletId: string, isSecondBet: boolean = false): { amount: number; cashoutAt: number | null } | null {
    const bet = isSecondBet ? this.secondBets.get(walletId) : this.bets.get(walletId);
    if (bet && bet.cashoutAt === null) {
      return bet;
    }
    return null;
  }

  // Add this new method
  public getCurrentCrashPoint(): number {
    return this.crashPoint;
  }

  public setCurrentCrashPoint(newCrashPoint: number): void {
    this.crashPoint = newCrashPoint;
    console.log(`Crash point updated to: ${newCrashPoint}`);
  }

  public getGameState(): GameState {
    const now = Date.now();
    let state: 'WAITING' | 'ACTIVE' | 'ENDED' = 'WAITING';
    let elapsedTime = 0;
    let countdown = null;
  
    if (this.gameStartTime === null) {
      state = 'WAITING';
    } else if (this.gameEndTime === null) {
      state = 'ACTIVE';
      elapsedTime = now - this.gameStartTime;
    } else {
      state = 'ENDED';
      elapsedTime = this.gameEndTime - this.gameStartTime;
    }
  
    return {
      state,
      elapsedTime,
      multiplier: this.currentMultiplier,
      countdown,
      gameHash: this.gameHash,
      crashPoint: state === 'ENDED' ? this.crashPoint : null,
      roundId: this.roundId
    };
  }

  public placeBet(walletId: string, amount: number): boolean {
    if (!this.bets.has(walletId)) {
      this.bets.set(walletId, { walletId, amount, cashoutAt: null });
      console.log(`Placed bet for current round: Wallet ${walletId}, Amount ${amount}`);
      console.log('Current bets:', JSON.stringify(Array.from(this.bets.entries())));
      return true;
    }
    console.log(`Failed to place bet: Wallet ${walletId}, Amount ${amount}`);
    return false;
  }

  public cancelBet(walletId: string): number | null {
    if (this.isGameInProgress()) {
      const nextRoundBetIndex = this.nextRoundBets.findIndex(bet => bet.walletId === walletId);
      if (nextRoundBetIndex !== -1) {
        const bet = this.nextRoundBets[nextRoundBetIndex];
        this.nextRoundBets.splice(nextRoundBetIndex, 1);
        return bet.amount;
      }
    } else {
      const bet = this.bets.get(walletId);
      if (bet && bet.cashoutAt === null) {
        this.bets.delete(walletId);
        return bet.amount;
      }
    }
    return null;
  }

  public cashout(walletId: string): number | null {
    console.log(`Cashout attempt for wallet ${walletId}`);
    console.log('Current bets:', JSON.stringify(Array.from(this.bets.entries())));
    if (!this.isGameInProgress()) {
      console.log(`Cashout failed: Game is not in progress`);
      return null;
    }
    const bet = this.bets.get(walletId);
    if (!bet) {
      console.log(`Cashout failed: No bet found for wallet ${walletId}`);
      return null;
    }
    if (bet.cashoutAt !== null) {
      console.log(`Cashout failed: Wallet ${walletId} has already cashed out`);
      return null;
    }
    bet.cashoutAt = this.currentMultiplier;
    const winnings = bet.amount * this.currentMultiplier;
    console.log(`Cashout successful for wallet ${walletId}: ${winnings}`);
    return winnings;
  }

  public getBets(): Map<string, { walletId: string; amount: number; cashoutAt: number | null }> {
    return this.bets;
  }

  public getNextRoundBets(): Array<{ walletId: string, amount: number }> {
    return this.nextRoundBets;
  }

  public addNextRoundBet(bet: { walletId: string, amount: number }): void {
    this.nextRoundBets.push(bet);
    console.log(`Added next round bet for wallet ${bet.walletId}: ${bet.amount}`);
    console.log('Next round bets:', JSON.stringify(this.nextRoundBets));
  }

  public moveNextRoundBetsToCurrent(): void {
    console.log('Moving next round bets to current bets');
    console.log('Next round bets before moving:', JSON.stringify(this.nextRoundBets));
    this.nextRoundBets.forEach(bet => {
      this.placeBet(bet.walletId, bet.amount);
    });
    this.nextRoundBets = [];
    console.log('Current bets after moving:', JSON.stringify(Array.from(this.bets.entries())));
  }

  public static generateHash(seed: string): string {
    return crypto.createHash('sha256').update(seed).digest('hex');
  }

  public placeSecondBet(walletId: string, amount: number): boolean {
    if (!this.secondBets.has(walletId)) {
      this.secondBets.set(walletId, { walletId, amount, cashoutAt: null });
      console.log(`Placed second bet for current round: Wallet ${walletId}, Amount ${amount}`);
      console.log('Current second bets:', JSON.stringify(Array.from(this.secondBets.entries())));
      return true;
    }
    console.log(`Failed to place second bet: Wallet ${walletId}, Amount ${amount}`);
    return false;
  }

  public cancelSecondBet(walletId: string): number | null {
    if (this.isGameInProgress()) {
      const nextRoundBetIndex = this.secondNextRoundBets.findIndex(bet => bet.walletId === walletId);
      if (nextRoundBetIndex !== -1) {
        const bet = this.secondNextRoundBets[nextRoundBetIndex];
        this.secondNextRoundBets.splice(nextRoundBetIndex, 1);
        return bet.amount;
      }
    } else {
      const bet = this.secondBets.get(walletId);
      if (bet && bet.cashoutAt === null) {
        this.secondBets.delete(walletId);
        return bet.amount;
      }
    }
    return null;
  }

  public secondCashout(walletId: string): number | null {
    console.log(`Second cashout attempt for wallet ${walletId}`);
    console.log('Current second bets:', JSON.stringify(Array.from(this.secondBets.entries())));
    if (!this.isGameInProgress()) {
      console.log(`Second cashout failed: Game is not in progress`);
      return null;
    }
    const bet = this.secondBets.get(walletId);
    if (!bet) {
      console.log(`Second cashout failed: No bet found for wallet ${walletId}`);
      return null;
    }
    if (bet.cashoutAt !== null) {
      console.log(`Second cashout failed: Wallet ${walletId} has already cashed out`);
      return null;
    }
    bet.cashoutAt = this.currentMultiplier;
    const winnings = bet.amount * this.currentMultiplier;
    console.log(`Second cashout successful for wallet ${walletId}: ${winnings}`);
    return winnings;
  }

  public getSecondBets(): Map<string, { walletId: string; amount: number; cashoutAt: number | null }> {
    return this.secondBets;
  }

  public getSecondNextRoundBets(): Array<{ walletId: string, amount: number }> {
    return this.secondNextRoundBets;
  }

  public addSecondNextRoundBet(bet: { walletId: string, amount: number }): void {
    this.secondNextRoundBets.push(bet);
    console.log(`Added second next round bet for wallet ${bet.walletId}: ${bet.amount}`);
    console.log('Second next round bets:', JSON.stringify(this.secondNextRoundBets));
  }

  public cancelSecondNextRoundBet(walletId: string): number | null {
    const nextRoundBetIndex = this.secondNextRoundBets.findIndex(bet => bet.walletId === walletId);
    if (nextRoundBetIndex !== -1) {
      const bet = this.secondNextRoundBets[nextRoundBetIndex];
      this.secondNextRoundBets.splice(nextRoundBetIndex, 1);
      return bet.amount;
    }
    return null;
  }

  public moveSecondNextRoundBetsToCurrent(): void {
    console.log('Moving second next round bets to current bets');
    console.log('Second next round bets before moving:', JSON.stringify(this.secondNextRoundBets));
    this.secondNextRoundBets.forEach(bet => {
      this.placeSecondBet(bet.walletId, bet.amount);
    });
    this.secondNextRoundBets = [];
    console.log('Current second bets after moving:', JSON.stringify(Array.from(this.secondBets.entries())));
  }

  public forceGameEnd(): void {
    if (this.isGameInProgress()) {
      this.crashPoint = this.currentMultiplier;
      this.gameEndTime = Date.now();
      console.log(`Game forcefully ended at multiplier: ${this.currentMultiplier}`);
    }
  }
}