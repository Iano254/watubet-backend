import { PrismaClient, User, MinesGame as PrismaMinesGame } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

interface GameState {
  grid: Array<'mine' | 'gem'>;
  revealedCells: number[];
  minePositions: number[];
  gameHash: string;
  clientSeed: string;
  serverSeed: string;
  salt: string;
  nonce: string;
  numberOfMines: number;
  isActive: boolean;
  multiplier: number;
  betAmount: number;
  walletId: string | null;
  startTime: Date;
  endTime: Date | null;
}

interface GameConfig {
  houseEdge: number;
  minBet: number;
  maxBet: number;
  maxMines: number;
  minMines: number;
  minClicksBeforeCashout: number; // Add minimum clicks requirement
  maxWinMultiplier: number;      // Add maximum win multiplier
}

interface RevealResult {
  isMine: boolean;
  revealedCells: number[];
  multiplier: number;
  minePositions?: number[];
  potentialWinAmount: number;
}

interface CashoutResult {
  success: boolean;
  winAmount: number;
  newBalance: number;
  gameState: GameState;
}

export class MinesGame {
  private readonly GRID_SIZE = 25; // 5x5 grid
  private gameState: GameState;
  private readonly gameConfig: GameConfig;

  constructor() {
    this.gameConfig = {
      houseEdge: 0.01,          // 1% house edge
      minBet: 1,                // Minimum bet amount
      maxBet: 1000,             // Maximum bet amount
      maxMines: 24,             // Maximum number of mines
      minMines: 1,              // Minimum number of mines
      minClicksBeforeCashout: 2, // Require at least 2 clicks before cashout
      maxWinMultiplier: 1000    // Maximum win multiplier allowed
    };

    this.gameState = this.createInitialGameState();
  }

  private createInitialGameState(): GameState {
    return {
      grid: Array(this.GRID_SIZE).fill('gem'),
      revealedCells: [],
      minePositions: [],
      gameHash: '',
      clientSeed: '',
      serverSeed: '',
      salt: '',
      nonce: '',
      numberOfMines: 3,
      isActive: false,
      multiplier: 1,
      betAmount: 0,
      walletId: null,
      startTime: new Date(),
      endTime: null
    };
  }

  private generateHash(seed: string): string {
    return crypto.createHash('sha256').update(seed).digest('hex');
  }

  private calculateHmac(message: string, key: string): string {
    return crypto
      .createHmac('sha256', key)
      .update(message)
      .digest('hex');
  }

  private async validateGameConfig(betAmount: number, numberOfMines: number): Promise<void> {
    if (betAmount < this.gameConfig.minBet || betAmount > this.gameConfig.maxBet) {
      throw new Error(`Bet amount must be between ${this.gameConfig.minBet} and ${this.gameConfig.maxBet}`);
    }

    if (numberOfMines < this.gameConfig.minMines || numberOfMines > this.gameConfig.maxMines) {
      throw new Error(`Number of mines must be between ${this.gameConfig.minMines} and ${this.gameConfig.maxMines}`);
    }
  }

  private generateMinePositions(numMines: number, firstClickIndex: number): number[] {
    // Create HMAC using game parameters
    const hmacMessage = `${this.gameState.clientSeed}-${this.gameState.salt}-${this.gameState.nonce}`;
    const hash = this.calculateHmac(hmacMessage, this.gameState.serverSeed);

    const positions = new Set<number>();
    let currentHash = hash;

    // Exclude first clicked position from available positions
    const availablePositions = Array.from(Array(this.GRID_SIZE).keys())
      .filter(i => i !== firstClickIndex);

    while (positions.size < numMines) {
      currentHash = this.generateHash(currentHash);
      const number = parseInt(currentHash.slice(0, 8), 16);
      const position = availablePositions[number % availablePositions.length];
      
      if (!positions.has(position)) {
        positions.add(position);
        // Remove the selected position from available positions
        availablePositions.splice(availablePositions.indexOf(position), 1);
      }
    }

    return Array.from(positions).sort((a, b) => a - b);
  }

  private calculateMultiplier(revealedCount: number, totalMines: number): number {
    const remainingCells = this.GRID_SIZE - revealedCount;
    const safeCells = remainingCells - totalMines;
    
    if (safeCells <= 0) return 0;

    // Calculate fair multiplier based on probability
    const probability = safeCells / remainingCells;
    const fairMultiplier = 1 / probability;
    
    // Apply house edge only to the profit portion (multiplier - 1)
    // This ensures the initial stake is not affected by house edge
    const profit = fairMultiplier - 1;
    const adjustedProfit = profit * (1 - this.gameConfig.houseEdge);
    
    return Number((1 + adjustedProfit).toFixed(4));
  }

  public async startNewGame(walletId: string, betAmount: number, numberOfMines: number): Promise<GameState> {
    try {
      // Validate game parameters
      await this.validateGameConfig(betAmount, numberOfMines);

      // Verify user has sufficient balance
      const user = await prisma.user.findUnique({ 
        where: { walletId },
        select: { id: true, balance: true, clientSeed: true }
      });

      if (!user) throw new Error('User not found');
      if (user.balance < betAmount) throw new Error('Insufficient balance');

      // Deduct bet amount
      await prisma.user.update({
        where: { walletId },
        data: { balance: user.balance - betAmount }
      });

      // Initialize new game state
      this.gameState = {
        ...this.createInitialGameState(),
        gameHash: crypto.randomBytes(32).toString('hex'),
        clientSeed: user.clientSeed || crypto.randomBytes(16).toString('hex'),
        serverSeed: crypto.randomBytes(32).toString('hex'),
        salt: crypto.randomBytes(16).toString('hex'),
        nonce: crypto.randomBytes(8).toString('hex'),
        numberOfMines,
        isActive: true,
        betAmount,
        walletId,
        startTime: new Date()
      };

      // Save game to database
      await prisma.minesGame.create({
        data: {
          userId: user.id,
          walletId,
          betAmount,
          numberOfMines,
          gameHash: this.gameState.gameHash,
          clientSeed: this.gameState.clientSeed,
          serverSeed: this.gameState.serverSeed,
          salt: this.gameState.salt,
          status: 'ACTIVE',
          startTime: this.gameState.startTime
        }
      });

      return { ...this.gameState };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to start new game: ${error.message}`);
      }
      throw new Error('Failed to start new game: Unknown error');
    }
  }

  public async revealCell(index: number): Promise<RevealResult> {
    if (!this.gameState.isActive) {
      throw new Error('No active game');
    }

    if (index < 0 || index >= this.GRID_SIZE) {
      throw new Error('Invalid cell index');
    }

    if (this.gameState.revealedCells.includes(index)) {
      throw new Error('Cell already revealed');
    }

    try {
      // Generate mine positions if this is the first click
      if (this.gameState.revealedCells.length === 0) {
        this.gameState.minePositions = this.generateMinePositions(
          this.gameState.numberOfMines,
          index  // Now passing index as excludePosition
        );
      }

      const isMine = this.gameState.minePositions.includes(index);
      this.gameState.revealedCells.push(index);

      if (isMine) {
        // Game over - reveal all mines
        this.gameState.isActive = false;
        await this.endGame('LOSS');
        return {
          isMine: true,
          revealedCells: this.gameState.revealedCells,
          multiplier: 0,
          minePositions: this.gameState.minePositions,
          potentialWinAmount: 0
        };
      }

      // Calculate new multiplier
      this.gameState.multiplier = this.calculateMultiplier(
        this.gameState.revealedCells.length,
        this.gameState.numberOfMines
      );

      const potentialWinAmount = this.gameState.betAmount * this.gameState.multiplier;

      // Update game state in database
      await prisma.minesGame.update({
        where: { gameHash: this.gameState.gameHash },
        data: {
          revealedCells: this.gameState.revealedCells,
          finalMultiplier: this.gameState.multiplier
        }
      });

      return {
        isMine: false,
        revealedCells: this.gameState.revealedCells,
        multiplier: this.gameState.multiplier,
        potentialWinAmount
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to reveal cell: ${error.message}`);
      }
      throw new Error('Failed to reveal cell: Unknown error');
    }
  }

  public async cashout(): Promise<CashoutResult> {
    if (!this.gameState.isActive || !this.gameState.walletId) {
      throw new Error('No active game');
    }

    try {
      const winAmount = this.gameState.betAmount * this.gameState.multiplier;

      // Update user's balance
      const user = await prisma.user.findUnique({
        where: { walletId: this.gameState.walletId }
      });

      if (!user) {
        throw new Error('User not found');
      }

      const newBalance = user.balance + winAmount;
      await prisma.user.update({
        where: { walletId: this.gameState.walletId },
        data: { balance: newBalance }
      });

      // End the game
      await this.endGame('WIN');

      return {
        success: true,
        winAmount,
        newBalance,
        gameState: { ...this.gameState }
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to cashout: ${error.message}`);
      }
      throw new Error('Failed to cashout: Unknown error');
    }
  }

  private async endGame(status: 'WIN' | 'LOSS'): Promise<void> {
    this.gameState.isActive = false;
    this.gameState.endTime = new Date();

    await prisma.minesGame.update({
      where: { gameHash: this.gameState.gameHash },
      data: {
        status,
        endTime: this.gameState.endTime,
        revealedCells: this.gameState.revealedCells,
        minePositions: this.gameState.minePositions,
        finalMultiplier: this.gameState.multiplier
      }
    });
  }

  public getGameState(): Partial<GameState> {
    // Return only safe properties
    return {
      isActive: this.gameState.isActive,
      revealedCells: this.gameState.revealedCells,
      multiplier: this.gameState.multiplier,
      betAmount: this.gameState.betAmount,
      numberOfMines: this.gameState.numberOfMines,
      startTime: this.gameState.startTime,
      endTime: this.gameState.endTime
    };
  }

  public static async verifyGame(
    gameHash: string,
    clientSeed: string,
    serverSeed: string,
    salt: string,
    numberOfMines: number
  ): Promise<number[]> {
    const hmac = crypto
      .createHmac('sha256', serverSeed)
      .update(`${clientSeed}-${salt}`)
      .digest('hex');

    const positions = new Set<number>();
    let currentHash = hmac;

    const availablePositions = Array.from(Array(25).keys());

    while (positions.size < numberOfMines) {
      currentHash = crypto.createHash('sha256').update(currentHash).digest('hex');
      const number = parseInt(currentHash.slice(0, 8), 16);
      const position = availablePositions[number % availablePositions.length];
      
      if (!positions.has(position)) {
        positions.add(position);
        availablePositions.splice(availablePositions.indexOf(position), 1);
      }
    }

    return Array.from(positions).sort((a, b) => a - b);
  }

  public async getGameHistory(walletId: string, limit: number = 10): Promise<PrismaMinesGame[]> {
    return prisma.minesGame.findMany({
      where: { walletId },
      orderBy: { startTime: 'desc' },
      take: limit
    });
  }

  public getGameConfig(): GameConfig {
    return { ...this.gameConfig };
  }
}