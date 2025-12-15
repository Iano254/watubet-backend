import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient({
  log: ['error', 'warn']
});
export class CrashGame {
  static maxAllowedCrashpoint: number | PromiseLike<number>;
  static setMaxCrashPoint(newMaxCrashPoint: Promise<number>) {
    throw new Error('Method not implemented.');
  }
  private readonly POINTS_TO_GENERATE = 25;
  private currentCrashPoint: number;
  private emergencyThreshold: number;
  private currentGameWinnings: number;
  private isEmergencyCrash: boolean;
  private maxAllowedCrashpoint: number;
  private enforceMaxCrashpoint: boolean;
  private potentialWinnings: number;
  // Add properties for bet based crash point management
  private isBetBasedCrashPoint: boolean;
  private betBasedHouseEdgePercentage: number;
  private minCrashPoint: number;
  private highCrashPointFrequency: number;
  private skipCrashPointManagement: number;
  private betBasedOffsetAmount: number; // Add property to track offset amount

  constructor() {
    this.currentCrashPoint = 1;
    this.currentGameWinnings = 0;
    this.isEmergencyCrash = false;
    this.potentialWinnings = 0;
    
    // Initialize with defaults - these will be updated from database immediately
    this.emergencyThreshold = 0;
    this.maxAllowedCrashpoint = 0;
    this.enforceMaxCrashpoint = false;
    
    // Initialize bet based crash point management with defaults
    this.isBetBasedCrashPoint = false;
    this.betBasedHouseEdgePercentage = 60;
    this.minCrashPoint = 1;
    this.highCrashPointFrequency = 80;
    this.skipCrashPointManagement = 10;
    this.betBasedOffsetAmount = 0; // Initialize the offset amount
    
    // Initialize settings and check the database value (properly)
    this.initializeSettings().catch(error => {
      console.error('Failed to initialize settings:', error);
    });
    
    // Add this debug function call 
    this.debugCheckDbSettings();
  }

  private async initializeSettings(): Promise<void> {
    await Promise.all([
      CrashGame.getEmergencySettings(),
      this.initializeHouseEdge(),
      this.getBetBasedCrashPointSettings()
    ]);
    
    // Get the bet-based offset amount separately to avoid Promise.all issues
    await this.getBetBasedOffsetAmount();
    
    // Force enable bet-based crash point in the database
    console.log("Forcing bet-based crash point enabled in database at startup");
    await this.setBetBasedCrashPointEnabled(true);
    
    // Refresh settings
    await this.getBetBasedCrashPointSettings();
    console.log("After forcing, bet-based crash point enabled:", this.isBetBasedCrashPoint);
  }

  private static async getEmergencySettings(): Promise<void> {
    try {
      const [emergencyThreshold, maxCrashpoint, enforceMax] = await Promise.all([
        prisma.gameSettings.findUnique({ where: { key: 'emergencyThreshold' } }),
        prisma.gameSettings.findUnique({ where: { key: 'maxCrashpoint' } }),
        prisma.gameSettings.findUnique({ where: { key: 'maxCrashpointEnabled' } })
      ]);

      // Create default settings if they don't exist
      if (!emergencyThreshold) {
        await prisma.gameSettings.create({
          data: { key: 'emergencyThreshold', value: '1000' }
        });
        this.setEmergencyThreshold(1000);
      } else {
        this.setEmergencyThreshold(parseFloat(emergencyThreshold.value));
      }

      if (!maxCrashpoint) {
        await prisma.gameSettings.create({
          data: { key: 'maxCrashpoint', value: '3.0' }
        });
        this.setMaxAllowedCrashpoint(3.0);
      } else {
        this.setMaxAllowedCrashpoint(parseFloat(maxCrashpoint.value));
      }

      if (!enforceMax) {
        await prisma.gameSettings.create({
          data: { key: 'maxCrashpointEnabled', value: 'true' }
        });
        this.setEnforceMaxCrashpoint(true);
      } else {
        this.setEnforceMaxCrashpoint(enforceMax.value === 'true');
      }

      // console.log('Emergency settings loaded:', {
      //   threshold: this.emergencyThreshold,
      //   maxCrashpoint: this.maxAllowedCrashpoint,
      //   enforceMax: this.enforceMaxCrashpoint
      // });
    } catch (error) {
      console.error('Error loading emergency settings:', error);
      throw error;
    }
  }

  private async initializeHouseEdge(): Promise<void> {
    try {
      const houseEdge = await prisma.gameSettings.findUnique({
        where: { key: 'houseEdge' }
      });

      if (!houseEdge) {
        await prisma.gameSettings.create({
          data: {
            key: 'houseEdge',
            value: '0.25'
          }
        });
      }
    } catch (error) {
      console.error('Error initializing house edge:', error);
      throw error;
    }
  }

  public async getBetBasedCrashPointSettings(): Promise<void> {
    try {
      const [
        isBetBasedEnabled, 
        houseEdgePercentage, 
        minCrashPoint, 
        highCrashPointFrequency,
        skipCrashPointManagement,
        betBasedOffsetAmount  // Add this line to fetch offset amount
      ] = await Promise.all([
        prisma.gameSettings.findUnique({ where: { key: 'betBasedCrashPointEnabled' } }),
        prisma.gameSettings.findUnique({ where: { key: 'betBasedHouseEdgePercentage' } }),
        prisma.gameSettings.findUnique({ where: { key: 'minCrashPoint' } }),
        prisma.gameSettings.findUnique({ where: { key: 'highCrashPointFrequency' } }),
        prisma.gameSettings.findUnique({ where: { key: 'skipCrashPointManagement' } }),
        prisma.gameSettings.findUnique({ where: { key: 'betBasedOffsetAmount' } })  // Add this line
      ]);

      // Create default settings if they don't exist
      if (!isBetBasedEnabled) {
        await prisma.gameSettings.create({
          data: { key: 'betBasedCrashPointEnabled', value: 'false' }
        });
        this.isBetBasedCrashPoint = false;
      } else {
        this.isBetBasedCrashPoint = isBetBasedEnabled.value === 'true';
      }

      if (!houseEdgePercentage) {
        await prisma.gameSettings.create({
          data: { key: 'betBasedHouseEdgePercentage', value: '40' }
        });
        this.betBasedHouseEdgePercentage = 40;
      } else {
        this.betBasedHouseEdgePercentage = parseFloat(houseEdgePercentage.value);
      }

      if (!minCrashPoint) {
        await prisma.gameSettings.create({
          data: { key: 'minCrashPoint', value: '2' }
        });
        this.minCrashPoint = 2;
      } else {
        this.minCrashPoint = parseFloat(minCrashPoint.value);
      }

      if (!highCrashPointFrequency) {
        await prisma.gameSettings.create({
          data: { key: 'highCrashPointFrequency', value: '80' }
        });
        this.highCrashPointFrequency = 80;
      } else {
        this.highCrashPointFrequency = parseFloat(highCrashPointFrequency.value);
      }

      if (!skipCrashPointManagement) {
        await prisma.gameSettings.create({
          data: { key: 'skipCrashPointManagement', value: '10' }
        });
        this.skipCrashPointManagement = 10;
      } else {
        this.skipCrashPointManagement = parseFloat(skipCrashPointManagement.value);
      }

      // Initialize bet based offset amount if it doesn't exist
      if (!betBasedOffsetAmount) {
        await prisma.gameSettings.create({
          data: { key: 'betBasedOffsetAmount', value: '0' }
        });
        this.betBasedOffsetAmount = 0;
      } else {
        this.betBasedOffsetAmount = parseFloat(betBasedOffsetAmount.value);
      }

      console.log('Bet based crash point settings loaded:', {
        enabled: this.isBetBasedCrashPoint,
        houseEdgePercentage: this.betBasedHouseEdgePercentage,
        minCrashPoint: this.minCrashPoint,
        highCrashPointFrequency: this.highCrashPointFrequency,
        skipCrashPointManagement: this.skipCrashPointManagement,
        betBasedOffsetAmount: this.betBasedOffsetAmount // Add this line
      });
    } catch (error) {
      console.error('Error loading bet based crash point settings:', error);
      throw error;
    }
  }

  public getIsEmergencyCrash(): boolean {
    return this.isEmergencyCrash;
  }

  public static async setEmergencyThreshold(amount: number): Promise<void> {
    try {
      await prisma.gameSettings.upsert({
        where: { key: 'emergencyThreshold' },
        update: { value: amount.toString() },
        create: { 
          key: 'emergencyThreshold',
          value: amount.toString()
        }
      });
      await this.getEmergencySettings();
    } catch (error) {
      console.error('Error setting emergency threshold:', error);
      throw error;
    }
  }

  public async getEmergencyThreshold(): Promise<number> {
    await CrashGame.getEmergencySettings();
    return this.emergencyThreshold;
  }

  public static async setMaxAllowedCrashpoint(value: number): Promise<void> {
    if (value < 1.0) {
      throw new Error('Max crashpoint must be greater than 1.0');
    }

    try {
      await prisma.gameSettings.upsert({
        where: { key: 'maxCrashpoint' },
        update: { value: value.toString() },
        create: {
          key: 'maxCrashpoint',
          value: value.toString()
        }
      });
      await this.getEmergencySettings();
    } catch (error) {
      console.error('Error setting max crashpoint:', error);
      throw error;
    }
  }


  public static async setEnforceMaxCrashpoint(enabled: boolean): Promise<void> {
    try {
      await prisma.gameSettings.upsert({
        where: { key: 'maxCrashpointEnabled' },
        update: { value: enabled.toString() },
        create: {
          key: 'maxCrashpointEnabled',
          value: enabled.toString()
        }
      });
      await this.getEmergencySettings();
    } catch (error) {
      console.error('Error setting enforce max crashpoint:', error);
      throw error;
    }
  }

  public updateCurrentWinnings(betAmount: number, cashoutMultiplier: number, isSimulated: boolean = false): void {
    if (isSimulated) {
      console.log(`Skipping simulated bet tracking: Amount ${betAmount}, Multiplier ${cashoutMultiplier}`);
      return;
    }
  
    const winAmount = betAmount * cashoutMultiplier;
    const netWin = winAmount - betAmount;
    this.currentGameWinnings += netWin;
    this.potentialWinnings += netWin;
    
    if (this.currentGameWinnings > this.emergencyThreshold || this.potentialWinnings > this.emergencyThreshold) {
      this.isEmergencyCrash = true;
      console.log(`Emergency crash triggered! Total winnings (${this.currentGameWinnings}) or potential winnings (${this.potentialWinnings}) exceeded threshold (${this.emergencyThreshold})`);
    }
  
    console.log(`Updated current winnings: ${this.currentGameWinnings} (Added ${netWin} from bet ${betAmount} at ${cashoutMultiplier}x)`);
  }

  public async shouldEmergencyCrash(currentMultiplier: number, activeBets: Array<{ amount: number, walletId: string }>): Promise<boolean> {
    try {
      // Always get fresh settings before checking
      await CrashGame.getEmergencySettings();
  
      // Calculate total potential winnings at current multiplier for all active bets
      let totalPotentialWinnings = 0;
      for (const bet of activeBets) {
        if (!bet.walletId.startsWith('SW_') && !bet.walletId.startsWith('SIM_')) {
          const potentialWinAmount = bet.amount * currentMultiplier;
          const potentialNetWin = potentialWinAmount - bet.amount;
          totalPotentialWinnings += potentialNetWin;
        }
      }
  
      // Check max crashpoint first
      if (this.enforceMaxCrashpoint && currentMultiplier >= this.maxAllowedCrashpoint) {
        console.log(`Emergency crash triggered - max crashpoint ${this.maxAllowedCrashpoint} reached at ${currentMultiplier}x`);
        this.isEmergencyCrash = true;
        return true;
      }
  
      // Check emergency threshold based on potential winnings
      if (totalPotentialWinnings > this.emergencyThreshold) {
        console.log(`Emergency crash triggered - potential winnings ${totalPotentialWinnings} would exceed threshold ${this.emergencyThreshold} at multiplier ${currentMultiplier}`);
        this.isEmergencyCrash = true;
        return true;
      }
  
      // Check if emergency flag is already set
      if (this.isEmergencyCrash) {
        console.log('Emergency crash flag is active');
        return true;
      }
  
      return false;
    } catch (error) {
      console.error('Error checking emergency crash conditions:', error);
      throw error;
    }
  }

  public resetGameWinnings(): void {
    this.currentGameWinnings = 0;
    this.potentialWinnings = 0;
    this.isEmergencyCrash = false;
  }

  public static async getMaxAllowedCrashpoint(): Promise<number> {
    await this.getEmergencySettings();
    return this.maxAllowedCrashpoint;
  }

  public async isEnforceMaxCrashpointEnabled(): Promise<boolean> {
    await CrashGame.getEmergencySettings();
    return this.enforceMaxCrashpoint;
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

  private async calculateCrashPoint(gameHash: string, clientSeed: string, salt: string): Promise<number> {
    const houseEdge = await CrashGame.getHouseEdge();
    const hash = this.calculateHmac(clientSeed + '-' + salt, gameHash);
    const h = parseInt(hash.slice(0, 52 / 4), 16);
    const e = Math.pow(2, 52);

    const r = h / e;

    let crashPoint: number;

    if (this.isEmergencyCrash) {
      console.log('Forcing crash point to 1.0 due to emergency');
      return 1.0;
    }

    if (r < 0.30) {
      return 1.0;
    } else if (r < 0.31) {
      crashPoint = 20 + ((r - 0.30) / 0.01) * 20;
    } else if (r < 0.34) {
      crashPoint = 8 + ((r - 0.31) / 0.03) * 12;
    } else if (r < 0.40) {
      crashPoint = 4 + ((r - 0.34) / 0.06) * 4;
    } else if (r < 0.55) {
      crashPoint = 2 + ((r - 0.40) / 0.15) * 2;
    } else if (r < 0.75) {
      crashPoint = 1.3 + ((r - 0.55) / 0.20) * 0.7;
    } else {
      crashPoint = 1.01 + ((r - 0.75) / 0.25) * 0.29;
    }

    if (crashPoint > 1.0) {
      const variance = 0.03;
      const randomFactor = 1 + (crypto.randomBytes(1)[0] / 255 - 0.5) * variance;
      crashPoint *= randomFactor;
    }

    crashPoint /= (1 - houseEdge);
    crashPoint = Math.floor(crashPoint * 100) / 100;

    // Ensure crash point doesn't exceed max allowed if enforced
    if (this.enforceMaxCrashpoint && crashPoint > this.maxAllowedCrashpoint) {
      crashPoint = this.maxAllowedCrashpoint;
    }

    return Math.max(1.0, crashPoint);
  }

  private async getNextAvailableRoundId(): Promise<number> {
    const nextRound = await prisma.$transaction(async (tx) => {
      const counter = await tx.gameCounter.findUnique({
        where: { id: 'game_counter' }
      });

      let nextRoundId: number;
      
      if (!counter) {
        nextRoundId = 1;
        await tx.gameCounter.create({
          data: {
            id: 'game_counter',
            lastRoundId: nextRoundId
          }
        });
      } else {
        nextRoundId = counter.lastRoundId + 1;
        await tx.gameCounter.update({
          where: { id: 'game_counter' },
          data: { lastRoundId: nextRoundId }
        });
      }

      return nextRoundId;
    });

    return nextRound;
  }

  public async generateNextRounds(previousGameHash: string): Promise<void> {
    await CrashGame.getEmergencySettings();
    
    let currentHash = this.generateHash(previousGameHash);
    const clientSeed = await this.getClientSeed();
    const salt = CrashGame.generateNewSalt();
    const houseEdge = await CrashGame.getHouseEdge();
  
    console.log(`Generating ${this.POINTS_TO_GENERATE} future crash points`);
    
    for (let i = 0; i < this.POINTS_TO_GENERATE; i++) {
      try {
        const nextRoundId = await this.getNextAvailableRoundId();
        const crashPoint = await this.calculateCrashPoint(currentHash, clientSeed, salt);
        currentHash = this.generateHash(currentHash);
        
        console.log(`Creating future point with roundId: ${nextRoundId}`);
  
        // Create records separately instead of in a transaction
        await prisma.game.create({
          data: {
            id: crypto.randomUUID(),
            roundId: nextRoundId,
            gameHash: crypto.randomBytes(16).toString('hex'),
            crashPoint: crashPoint,
            salt: salt,
            clientSeed: clientSeed,
            serverSeed: currentHash,
            houseEdge: houseEdge,
            startTime: new Date()
          }
        });
  
        await prisma.futureCrashPoint.create({
          data: {
            roundId: nextRoundId,
            crashPoint: crashPoint
          }
        });
  
        // Add small delay between iterations to prevent database overload
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`Error generating round ${i}:`, error);
        i--; // Retry this round
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  // Add a diagnostic method to help debug the issue
public async diagnosticCheckFutureCrashPoints(): Promise<void> {
  const points = await prisma.futureCrashPoint.findMany({
    orderBy: { roundId: 'asc' },
    take: 20
  });
  
  console.log('Future crash points:');
  points.forEach(point => {
    console.log(`RoundID: ${point.roundId}, Used: ${point.isUsed}, UsedAt: ${point.usedAt ? point.usedAt.toISOString() : 'N/A'}, CrashPoint: ${point.crashPoint}`);
  });
  
  // Check for gaps in round IDs
  let gaps = [];
  for (let i = 1; i < points.length; i++) {
    const gap = points[i].roundId - points[i-1].roundId;
    if (gap > 1) {
      gaps.push(`${points[i-1].roundId} to ${points[i].roundId} (gap of ${gap})`);
    }
  }
  
  if (gaps.length > 0) {
    console.log('Gaps found in round IDs:', gaps);
  } else {
    console.log('No gaps found in round IDs');
  }
}

public async advanceToNextRound(): Promise<void> {
  await CrashGame.getEmergencySettings();

  try {
    // Check if we have any future crash points
    const currentPoint = await prisma.futureCrashPoint.findFirst({
      where: { isUsed: false },
      orderBy: { roundId: 'asc' }
    });

    if (currentPoint) {
      // If we have a point, use it
      this.currentCrashPoint = currentPoint.crashPoint;

      // Mark it as used
      await prisma.futureCrashPoint.update({
        where: { roundId: currentPoint.roundId },
        data: { 
          isUsed: true, 
          usedAt: new Date() 
        }
      });

      // Now check how many unused points we have left
      const remainingPoints = await prisma.futureCrashPoint.count({
        where: { isUsed: false }
      });

      // Only regenerate if we're running low
      if (remainingPoints < this.POINTS_TO_GENERATE / 2) {
        // Generate a new batch of points instead of just one
        // This prevents the gap issue by keeping point generation in one place
        console.log('Running low on future crash points, generating new batch');
        await this.generateNextRounds(crypto.randomBytes(16).toString('hex'));
      }
    } else {
      // We have no future crash points - we need to generate a batch
      console.log('No future crash points available, generating new batch');
      await this.generateNextRounds(crypto.randomBytes(16).toString('hex'));
      
      // Try again after points are generated
      await this.advanceToNextRound();
    }
  } catch (error) {
    console.error('Error advancing to next round:', error);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await this.advanceToNextRound();
  }
}

  public async getFutureCrashPoints(): Promise<{ roundId: number; crashPoint: number }[]> {
    return prisma.futureCrashPoint.findMany({
      orderBy: { roundId: 'asc' },
      select: {
        roundId: true,
        crashPoint: true
      }
    });
  }

  public static async setHouseEdge(newHouseEdge: number): Promise<void> {
    if (newHouseEdge < 0 || newHouseEdge >= 1) {
      throw new Error('House edge must be between 0 and 1');
    }
    try {
      await prisma.gameSettings.upsert({
        where: { key: 'houseEdge' },
        update: { value: newHouseEdge.toString() },
        create: { key: 'houseEdge', value: newHouseEdge.toString() }
      });
    } catch (error) {
      console.error('Error setting house edge:', error);
      throw new Error('Failed to set house edge');
    }
  }

  public static async getHouseEdge(): Promise<number> {
    try {
      const setting = await prisma.gameSettings.findUnique({
        where: { key: 'houseEdge' }
      });
      return setting ? parseFloat(setting.value) : 0.25;
    } catch (error) {
      console.error('Error getting house edge:', error);
      return 0.25;
    }
  }

  public async setFutureCrashPoint(roundId: number, crashPoint: number): Promise<void> {
    try {
      await prisma.futureCrashPoint.update({
        where: { roundId },
        data: { crashPoint }
      });
    } catch (error) {
      console.error('Error setting future crash point:', error);
      throw error;
    }
  }

  public async getProbableWinSettings(): Promise<{ threshold: number, enabled: boolean }> {
    try {
      const [thresholdSetting, enabledSetting] = await Promise.all([
        prisma.gameSettings.findUnique({ where: { key: 'probableWinThreshold' } }),
        prisma.gameSettings.findUnique({ where: { key: 'probableWinThresholdEnabled' } })
      ]);

      return {
        threshold: thresholdSetting ? parseFloat(thresholdSetting.value) : 10000,
        enabled: enabledSetting ? enabledSetting.value === 'true' : false
      };
    } catch (error) {
      console.error('Error getting probable win threshold settings:', error);
      return { threshold: 10000, enabled: false };
    }
  }

  public async setProbableWinThreshold(amount: number, enabled: boolean): Promise<void> {
    try {
      await prisma.gameSettings.upsert({
        where: { key: 'probableWinThreshold' },
        update: { value: amount.toString() },
        create: { 
          key: 'probableWinThreshold',
          value: amount.toString()
        }
      });
  
      await prisma.gameSettings.upsert({
        where: { key: 'probableWinThresholdEnabled' },
        update: { value: enabled.toString() },
        create: { 
          key: 'probableWinThresholdEnabled',
          value: enabled.toString()
        }
      });
    } catch (error) {
      console.error('Error setting probable win threshold:', error);
      throw error;
    }
  }

  private async getClientSeed(): Promise<string> {
    try {
      const setting = await prisma.gameSettings.findUnique({
        where: { key: 'clientSeed' }
      });
      if (setting) {
        return setting.value;
      }
      const newSeed = CrashGame.generateNewClientSeed();
      await prisma.gameSettings.create({
        data: { key: 'clientSeed', value: newSeed }
      });
      return newSeed;
    } catch (error) {
      console.error('Error getting client seed:', error);
      return CrashGame.generateNewClientSeed();
    }
  }

  public async setCurrentCrashPoint(crashPoint: number): Promise<void> {
    this.currentCrashPoint = crashPoint;
    console.log(`Crash point updated to: ${crashPoint}`);
  }

  public async getCurrentCrashPoint(): Promise<number> {
    return this.currentCrashPoint;
  }

  public static async verifyGame(
    serverSeed: string,
    clientSeed: string,
    salt: string,
    houseEdge: number
  ): Promise<number> {
    const hmac = crypto
      .createHmac('sha256', serverSeed)
      .update(clientSeed + '-' + salt)
      .digest('hex');
    
    const h = parseInt(hmac.slice(0, 52 / 4), 16);
    const e = Math.pow(2, 52);
    const r = h / e;

    let crashPoint: number;

    if (r < 0.10) { // Reduced instant crashes to 10%
      return 1.0;
    } else if (r < 0.12) { // 2% chance for 100-200x
      crashPoint = 100 + ((r - 0.10) / 0.02) * 100;
    } else if (r < 0.15) { // 3% chance for 50-100x
      crashPoint = 50 + ((r - 0.12) / 0.03) * 50;
    } else if (r < 0.18) { // 3% chance for 30-50x
      crashPoint = 30 + ((r - 0.15) / 0.03) * 20;
    } else if (r < 0.22) { // 4% chance for 15-30x
      crashPoint = 15 + ((r - 0.18) / 0.04) * 15;
    } else if (r < 0.28) { // 6% chance for 8-15x
      crashPoint = 8 + ((r - 0.22) / 0.06) * 7;
    } else if (r < 0.38) { // 10% chance for 4-8x
      crashPoint = 4 + ((r - 0.28) / 0.10) * 4;
    } else if (r < 0.53) { // 15% chance for 2-4x
      crashPoint = 2 + ((r - 0.38) / 0.15) * 2;
    } else if (r < 0.75) { // 22% chance for 1.5-2x
      crashPoint = 1.5 + ((r - 0.53) / 0.22) * 0.5;
    } else { // 15% chance for 1.1-1.5x
      crashPoint = 1.1 + ((r - 0.75) / 0.15) * 0.4;
    }

    if (crashPoint > 1.0) {
      const variance = 0.03;
      const randomFactor = 1 + (crypto.randomBytes(1)[0] / 255 - 0.5) * variance;
      crashPoint *= randomFactor;
    }

    crashPoint /= (1 - houseEdge);
    crashPoint = Math.floor(crashPoint * 100) / 100;
    return Math.max(1.0, crashPoint);
  }

  public static generateNewClientSeed(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  public static generateNewSalt(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  public async getGameStatistics(): Promise<{
    totalGames: number;
    averageCrashPoint: number;
    maxCrashPoint: number;
    totalWinnings: number;
    emergencyThreshold: number;
    currentGameWinnings: number;
  }> {
    try {
      await CrashGame.getEmergencySettings();
      const games = await prisma.game.findMany({
        take: 1000,
        orderBy: { startTime: 'desc' },
        select: { crashPoint: true }
      });

      const crashPoints = games.map(game => game.crashPoint);
      
      return {
        totalGames: games.length,
        averageCrashPoint: crashPoints.reduce((a, b) => a + b, 0) / games.length,
        maxCrashPoint: Math.max(...crashPoints),
        totalWinnings: this.currentGameWinnings,
        emergencyThreshold: this.emergencyThreshold,
        currentGameWinnings: this.currentGameWinnings
      };
    } catch (error) {
      console.error('Error getting game statistics:', error);
      return {
        totalGames: 0,
        averageCrashPoint: 0,
        maxCrashPoint: 0,
        totalWinnings: 0,
        emergencyThreshold: this.emergencyThreshold,
        currentGameWinnings: this.currentGameWinnings
      };
    }
  }

  public wouldTriggerEmergencyCrash(additionalWinnings: number, isSimulated: boolean = false): boolean {
    if (isSimulated) {
      return false;
    }
    return (this.currentGameWinnings + additionalWinnings > this.emergencyThreshold) ||
           (this.potentialWinnings + additionalWinnings > this.emergencyThreshold);
  }

  public getCurrentRiskMetrics(includeSimulated: boolean = false): {
    currentWinnings: number;
    potentialWinnings: number;
    distanceToThreshold: number;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
    isSimulatedIncluded: boolean;
  } {
    const distanceToThreshold = this.emergencyThreshold - Math.max(this.currentGameWinnings, this.potentialWinnings);
    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
  
    if (distanceToThreshold <= this.emergencyThreshold * 0.2) {
      riskLevel = 'HIGH';
    } else if (distanceToThreshold <= this.emergencyThreshold * 0.5) {
      riskLevel = 'MEDIUM';
    }
  
    const metrics = {
      currentWinnings: this.currentGameWinnings,
      potentialWinnings: this.potentialWinnings,
      distanceToThreshold,
      riskLevel,
      isSimulatedIncluded: includeSimulated
    };
  
    console.log('Current risk metrics:', metrics);
    return metrics;
  }

  // Methods for bet based crash point management
  public async setBetBasedCrashPointEnabled(enabled: boolean): Promise<void> {
    try {
      await prisma.gameSettings.upsert({
        where: { key: 'betBasedCrashPointEnabled' },
        update: { value: enabled.toString() },
        create: {
          key: 'betBasedCrashPointEnabled',
          value: enabled.toString()
        }
      });
      this.isBetBasedCrashPoint = enabled;
    } catch (error) {
      console.error('Error setting bet based crash point enabled:', error);
      throw error;
    }
  }

  public async setBetBasedHouseEdgePercentage(percentage: number): Promise<void> {
    if (percentage < 1 || percentage > 60) {
      throw new Error('House edge percentage must be between 1 and 60');
    }
    try {
      await prisma.gameSettings.upsert({
        where: { key: 'betBasedHouseEdgePercentage' },
        update: { value: percentage.toString() },
        create: {
          key: 'betBasedHouseEdgePercentage',
          value: percentage.toString()
        }
      });
      this.betBasedHouseEdgePercentage = percentage;
    } catch (error) {
      console.error('Error setting bet based house edge percentage:', error);
      throw error;
    }
  }

  public async setMinCrashPoint(value: number): Promise<void> {
    try {
      await prisma.gameSettings.upsert({
        where: { key: 'minCrashPoint' },
        update: { value: value.toString() },
        create: {
          key: 'minCrashPoint',
          value: value.toString()
        }
      });
      this.minCrashPoint = value;
    } catch (error) {
      console.error('Error setting min crash point:', error);
      throw error;
    }
  }

  public async setHighCrashPointFrequency(value: number): Promise<void> {
    try {
      await prisma.gameSettings.upsert({
        where: { key: 'highCrashPointFrequency' },
        update: { value: value.toString() },
        create: {
          key: 'highCrashPointFrequency',
          value: value.toString()
        }
      });
      this.highCrashPointFrequency = value;
    } catch (error) {
      console.error('Error setting high crash point frequency:', error);
      throw error;
    }
  }

  public async setSkipCrashPointManagement(value: number): Promise<void> {
    try {
      await prisma.gameSettings.upsert({
        where: { key: 'skipCrashPointManagement' },
        update: { value: value.toString() },
        create: {
          key: 'skipCrashPointManagement',
          value: value.toString()
        }
      });
      this.skipCrashPointManagement = value;
    } catch (error) {
      console.error('Error setting skip crash point management:', error);
      throw error;
    }
  }

  // Rename this method to getBetBasedSettings to avoid duplicate function
  public async getBetBasedSettings(): Promise<{
    enabled: boolean;
    houseEdgePercentage: number;
    minCrashPoint: number;
    highCrashPointFrequency: number;
    skipCrashPointManagement: number;
    betBasedOffsetAmount: number;  // Add this line
  }> {
    try {
      // Call the initialization method instead of this method (which would cause recursion)
      await this.getBetBasedCrashPointSettings();
      return {
        enabled: this.isBetBasedCrashPoint,
        houseEdgePercentage: this.betBasedHouseEdgePercentage,
        minCrashPoint: this.minCrashPoint,
        highCrashPointFrequency: this.highCrashPointFrequency,
        skipCrashPointManagement: this.skipCrashPointManagement,
        betBasedOffsetAmount: this.betBasedOffsetAmount  // Add this line
      };
    } catch (error) {
      console.error('Error getting bet based crash point settings:', error);
      return {
        enabled: false,
        houseEdgePercentage: 40,
        minCrashPoint: 2,
        highCrashPointFrequency: 80,
        skipCrashPointManagement: 10,
        betBasedOffsetAmount: 0  // Add this line
      };
    }
  }

  // Calculate crash point based on active bets and target house edge
  public calculateBetBasedCrashPoint(activeBets: Array<{ amount: number, walletId: string }>): number {
    console.log('Processing active bets for crash point calculation');
    
    // First check if we should skip management for this game (adds randomness)
    if (Math.random() * 100 < this.skipCrashPointManagement) {
      console.log('Skipping bet based crash point management for this game (random)');
      return -1; // Signal to use normal crash point generation
    }
  
    // Filter out system and simulation wallets
    const realBets = activeBets.filter(bet => {
      // Filter out system and simulation wallets
      return !bet.walletId.startsWith('SW_') && !bet.walletId.startsWith('SIM_');
    });
    
    console.log(`Filtered from ${activeBets.length} to ${realBets.length} real bets`);
    
    const totalBetAmount = realBets.reduce((sum, bet) => sum + bet.amount, 0);
    
    if (totalBetAmount === 0) {
      console.log('No real bets, using standard crash point generation');
      return -1; // No real bets, use normal generation
    }
  
    console.log(`Total bet amount after filtering: ${totalBetAmount}`);
    
    // Calculate desired house profit (percentage of total bet amount)
    const targetProfit = totalBetAmount * (this.betBasedHouseEdgePercentage / 100);
    console.log(`Target profit: ${targetProfit} (${this.betBasedHouseEdgePercentage}% of ${totalBetAmount})`);
  
    // Calculate crash point as totalBetAmount / targetProfit
    let crashPoint = totalBetAmount / targetProfit;
    
    console.log(`Initial calculated crash point: ${crashPoint.toFixed(2)}`);
    console.log(`Formula: totalBetAmount ÷ targetProfit = ${totalBetAmount} ÷ ${targetProfit.toFixed(2)} = ${crashPoint.toFixed(2)}`);
    
    // Check if the calculated point is below the minimum
    if (crashPoint < this.minCrashPoint) {
      console.log(`Calculated crash point ${crashPoint.toFixed(2)} is below minimum ${this.minCrashPoint}`);
      // Add the calculated crash point to the minimum instead of just using the minimum
      const newCrashPoint = this.minCrashPoint + crashPoint;
      console.log(`Adding calculated point to minimum: ${this.minCrashPoint} + ${crashPoint.toFixed(2)} = ${newCrashPoint.toFixed(2)}`);
      crashPoint = newCrashPoint;
    }
    
    // Check if we should use a higher crash point for variety (based on frequency setting)
    if (Math.random() * 100 < this.highCrashPointFrequency) {
      const highMultiplier = 1.5 + Math.random() * 3.5; // Between 1.5x and 5x higher
      const originalPoint = crashPoint;
      crashPoint = crashPoint * highMultiplier;
      console.log(`Using high crash point: ${crashPoint.toFixed(2)} (${highMultiplier.toFixed(2)}x original ${originalPoint.toFixed(2)})`);
    }
    
    // Round to 2 decimal places for clean display
    crashPoint = Math.floor(crashPoint * 100) / 100;
    
    console.log(`Final bet-based crash point: ${crashPoint} for total bet amount: ${totalBetAmount}, target profit: ${targetProfit}`);
    
    // Show risk metrics for this crash point
    this.logBetBasedRiskMetrics(realBets, crashPoint, totalBetAmount, targetProfit);
    
    return crashPoint;
  }

  // Log detailed risk metrics for bet-based crash point
  private logBetBasedRiskMetrics(realBets: Array<{ amount: number, walletId: string }>, crashPoint: number, totalBetAmount: number, targetProfit: number): void {
    const potentialPayouts = realBets.map(bet => ({
      walletId: bet.walletId,
      amount: bet.amount,
      multiplier: crashPoint,
      payout: bet.amount * crashPoint,
      profit: bet.amount * crashPoint - bet.amount
    }));
    
    const totalPayout = potentialPayouts.reduce((sum, bet) => sum + bet.payout, 0);
    const houseProfit = totalBetAmount - totalPayout;
    const houseProfitPercentage = (houseProfit / totalBetAmount) * 100;
    
    console.log('=== BET-BASED CRASH POINT RISK METRICS ===');
    console.log(`Total bets: ${realBets.length}`);
    console.log(`Total bet amount: ${totalBetAmount}`);
    console.log(`Target house profit: ${targetProfit} (${this.betBasedHouseEdgePercentage}%)`);
    console.log(`Formula: totalBetAmount ÷ targetProfit = ${totalBetAmount} ÷ ${targetProfit.toFixed(2)} = ${crashPoint.toFixed(2)}`);
    console.log(`Calculated crash point: ${crashPoint}`);
    console.log(`Potential total payout: ${totalPayout.toFixed(2)}`);
    console.log(`Expected house profit: ${houseProfit.toFixed(2)} (${houseProfitPercentage.toFixed(2)}%)`);
    
    // Calculate theoretical values
    const theoreticalPayoutPercentage = (1 / crashPoint) * 100;
    const theoreticalHouseEdge = 100 - theoreticalPayoutPercentage;
    
    console.log(`Theoretical payout percentage: ${theoreticalPayoutPercentage.toFixed(2)}%`);
    console.log(`Theoretical house edge: ${theoreticalHouseEdge.toFixed(2)}%`);
    
    if (houseProfit < 0) {
      console.log('⚠️ WARNING: House would LOSE money with this crash point!');
    } else if (Math.abs(houseProfit - targetProfit) > 1) {
      console.log('⚠️ WARNING: House profit differs significantly from target!');
    } else {
      console.log('✅ House profit aligns with target');
    }
    
    // Verify that the multiplier is correctly set to retain the desired house edge
    const idealMultiplier = 100 / (100 - this.betBasedHouseEdgePercentage);
    if (Math.abs(crashPoint - idealMultiplier) > 0.01 && crashPoint > this.minCrashPoint) {
      console.log(`⚠️ WARNING: Crash point ${crashPoint} differs from ideal ${idealMultiplier.toFixed(2)}`);
    } else {
      console.log(`✅ Crash point is appropriate for target house edge`);
    }
    
    console.log('=========================================');
  }

  // Override current crash point with a bet-based one if the feature is enabled
  public async applyBetBasedCrashPointIfEnabled(activeBets: Array<{ amount: number, walletId: string }>): Promise<boolean> {
    console.log('Checking if bet-based crash point management is enabled');
    
    await this.getBetBasedCrashPointSettings();
    console.log('Settings after refresh: enabled =', this.isBetBasedCrashPoint);
    
    if (!this.isBetBasedCrashPoint) {
      console.log('Bet-based crash point management is disabled');
      return false;
    }
    
    // Check if we have an offset amount - if we do, skip bet-based crash point for this round
    if (this.betBasedOffsetAmount > 0) {
      console.log(`Bet-based offset amount is ${this.betBasedOffsetAmount} - skipping bet-based crash point for this round to allow players to win`);
      return false;
    }
    
    console.log('Bet-based crash point management is enabled');
    console.log('Total bets:', activeBets.length);
    console.log('Total bet amount before filtering:', activeBets.reduce((sum, bet) => sum + bet.amount, 0));
    
    const crashPoint = this.calculateBetBasedCrashPoint(activeBets);
    
    if (crashPoint <= 0) {
      console.log('No valid crash point calculated, using standard generation');
      return false; // Use normal generation
    }
    
    await this.setCurrentCrashPoint(crashPoint);
    console.log(`Applied bet-based crash point: ${crashPoint}`);
    return true;
  }

  // Add this method to the class
  public debugCheckDbSettings(): void {
    prisma.gameSettings.findUnique({ 
      where: { key: 'betBasedCrashPointEnabled' } 
    }).then(setting => {
      console.log("Database value for betBasedCrashPointEnabled:", setting);
    }).catch(error => {
      console.error("Error checking database value:", error);
    });
  }

  // Force enable the bet-based crash point feature for testing
  public forceEnableBetBasedCrashPoint(): void {
    console.log("*** FORCE ENABLING BET-BASED CRASH POINT VIA METHOD ***");
    this.isBetBasedCrashPoint = true;
    console.log("Bet-based crash point enabled status:", this.isBetBasedCrashPoint);
  }

  // Add this method to get the bet based offset amount
  public async getBetBasedOffsetAmount(): Promise<number> {
    try {
      const setting = await prisma.gameSettings.findUnique({
        where: { key: 'betBasedOffsetAmount' }
      });
      
      if (!setting) {
        await prisma.gameSettings.create({
          data: { key: 'betBasedOffsetAmount', value: '0' }
        });
        this.betBasedOffsetAmount = 0;
      } else {
        this.betBasedOffsetAmount = parseFloat(setting.value);
      }
      
      return this.betBasedOffsetAmount;
    } catch (error) {
      console.error('Error getting bet based offset amount:', error);
      this.betBasedOffsetAmount = 0;
      return 0;
    }
  }

  // Add this method to update the bet based offset amount
  public async updateBetBasedOffsetAmount(amount: number): Promise<void> {
    try {
      const newAmount = this.betBasedOffsetAmount + amount;
      this.betBasedOffsetAmount = Math.max(0, newAmount); // Ensure it never goes below 0
      
      await prisma.gameSettings.upsert({
        where: { key: 'betBasedOffsetAmount' },
        update: { value: this.betBasedOffsetAmount.toString() },
        create: { key: 'betBasedOffsetAmount', value: this.betBasedOffsetAmount.toString() }
      });
      
      console.log(`Updated bet based offset amount: ${this.betBasedOffsetAmount} (changed by ${amount})`);
    } catch (error) {
      console.error('Error updating bet based offset amount:', error);
    }
  }

  // Set the bet based offset amount directly
  public async setBetBasedOffsetAmount(amount: number): Promise<void> {
    try {
      this.betBasedOffsetAmount = Math.max(0, amount); // Ensure it never goes below 0
      
      await prisma.gameSettings.upsert({
        where: { key: 'betBasedOffsetAmount' },
        update: { value: this.betBasedOffsetAmount.toString() },
        create: { key: 'betBasedOffsetAmount', value: this.betBasedOffsetAmount.toString() }
      });
      
      console.log(`Set bet based offset amount to: ${this.betBasedOffsetAmount}`);
    } catch (error) {
      console.error('Error setting bet based offset amount:', error);
    }
  }

  // Add a method to track round results and update the offset amount
  public async trackRoundResults(
    activeBets: Array<{ amount: number, walletId: string, cashoutAt: number | null }>,
    finalCrashPoint: number
  ): Promise<void> {
    // Filter out system and simulation wallets
    const realBets = activeBets.filter(bet => {
      return !bet.walletId.startsWith('SW_') && !bet.walletId.startsWith('SIM_');
    });
    
    if (realBets.length === 0) {
      console.log('No real bets to track for offset amount');
      return;
    }
    
    const totalBetAmount = realBets.reduce((sum, bet) => sum + bet.amount, 0);
    
    // Calculate player winnings and losses
    let totalPayouts = 0;
    
    realBets.forEach(bet => {
      if (bet.cashoutAt && bet.cashoutAt > 0 && bet.cashoutAt <= finalCrashPoint) {
        // Player cashed out successfully
        totalPayouts += bet.amount * bet.cashoutAt;
      }
    });
    
    // Calculate net profit/loss for the house
    const houseProfit = totalBetAmount - totalPayouts;
    
    console.log(`Round results - Total bets: ${totalBetAmount}, Total payouts: ${totalPayouts}, House profit: ${houseProfit}`);
    
    // Update the offset amount based on the results
    await this.updateBetBasedOffsetAmount(houseProfit);
    
    console.log(`Updated offset amount is now: ${this.betBasedOffsetAmount}`);
  }
}