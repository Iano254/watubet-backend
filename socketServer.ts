import { Server, Socket } from 'socket.io';
import http from 'http';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { PrismaClient, User as PrismaUser, Game as PrismaGame, ChatMessage, MessageReaction, Prisma, AffiliateEarning } from '@prisma/client';
import { CrashGame } from './crashGame.js';
import { GameSession, GameState } from './gameSession.js';
import { generateTokens, verifyToken, verifyRefreshToken, invalidateRefreshToken} from './authMiddleware.js';
import { v4 as uuidv4 } from 'uuid';
import { sendVerificationCode, checkVerificationCode } from './twilioverify.js';
import { initiateSTKPush, b2cPaymentRequest, querySTKPush  } from './src/utils/mpesaUtils.js';
import { BetSimulator } from './src/services/BetSimulator.js';
import { MinesGame } from './MinesGame.js';
import {
  processAffiliateEarnings,
  handleAffiliateWithdrawal,
  processSuccessfulAffiliateWithdrawal,
  handleAffiliateWithdrawalCallback,
  calculateAffiliateStats
} from './services/affiliateService.js';

import {
  BonusType,
  processDepositCashbackBonus,
  checkLosingStreakBonus,
  checkWinningStreakBonus
} from './services/bonusService.js'; // Added bonus service imports

const prisma = new PrismaClient({
  log: ['error', 'warn']
});


interface CommissionRates {
  [key: number]: number;
}

interface ReferralStats {
  pendingAmount: number;
  totalReferrals: number;
}

interface AffiliateEarningWithDetails extends AffiliateEarning {
  user: User;
}

interface User {
  id: string;
  walletId: string;
  phoneNumber?: string;
  wallet: number;
  isLoggedIn: boolean;
  clientSeed: string;
  balance: number;
  nickname?: string;
  activeMinesGame?: MinesGame;
  autoMinesConfig?: {
    enabled: boolean;
    betAmount: number;
    numberOfMines: number;
    stopOnWin?: boolean;
    stopOnLoss?: boolean;
    maxGames?: number;
    stopOnMultiplier?: number;
    stopOnBalance?: number;
  };
}

interface VerifyMinesGameInput {
  gameHash: string;
  walletId: string;
}

interface MinesGameVerificationResult {
  gameHash: string;
  storedMines: number[];
  verifiedMines: number[];
  isValid: boolean;
}


interface Bet {
  walletId: string;
  amount: number;
  cashoutAt: number | null;
  isNextRound: boolean;
}

interface SecondBet {
  walletId: string;
  amount: number;
  cashoutAt: number | null;
  isNextRound: boolean;
}

interface EnhancedChatMessage extends ChatMessage {
  reactions: { [emoji: string]: string[] };
}

interface OnlineUser {
  isLoggedIn: boolean;
  isFunMode: boolean;
}

let currentGame: GameSession | null = null;
let crashGameInstance: CrashGame | null = null;
let users: Map<string, User> = new Map();
let lastGameHash: string = crypto.randomBytes(16).toString('hex');
let clientSeed: string = crypto.randomBytes(16).toString('hex');
let nextRoundBetsBuffer: Array<{ walletId: string, amount: number, isSecondBet:boolean }> = [];
let betSimulator: BetSimulator | null = null;  // Add this line

let onlineUsers: Map<string, OnlineUser> = new Map();

let io: Server;

export function getOnlineUsersStats() {
  const total = onlineUsers.size;
  const loggedIn = Array.from(onlineUsers.values()).filter(user => user.isLoggedIn).length;
  const funMode = total - loggedIn;

  return { total, loggedIn, funMode };
}

function generateUniqueUserId(): string {
  return uuidv4();
}

function generateWalletId(): string {
  return 'B' + uuidv4().substring(0, 8).toUpperCase();
}

function emitCurrentBets(io: Server, currentGame: GameSession) {
  if (currentGame) {
    const currentBets = Array.from(currentGame.getBets().values()).map(bet => ({
      walletId: bet.walletId,
      amount: bet.amount,
      cashoutAt: bet.cashoutAt,
      isNextRound: false
    }));

    io.emit('currentBets', currentBets);
  }
}

function emitCurrentSecondBets(io: Server, currentGame: GameSession) {
  if (currentGame) {
    const currentSecondBets = Array.from(currentGame.getSecondBets().values()).map(bet => ({
      walletId: bet.walletId,
      amount: bet.amount,
      cashoutAt: bet.cashoutAt,
      isNextRound: false
    }));

    io.emit('currentSecondBets', currentSecondBets);
  }
}

export async function updateUserBalance(walletId: string, newBalance: number): Promise<void> {
  try {
    await prisma.user.update({
      where: { walletId },
      data: { balance: Math.max(0, newBalance) }
    });

    // Update the in-memory user object
    const user = Array.from(users.values()).find(u => u.walletId === walletId);
    if (user) {
      user.wallet = Math.max(0, newBalance);
      user.balance = Math.max(0, newBalance);
    }
  } catch (error) {

    console.error(`Failed to update balance for wallet ${walletId}:`, error);
    throw error;
  }
}

function isUserInFunMode(user: User): boolean {
  return !user.isLoggedIn;
}

export function setupSocketServer(server: http.Server): void {
  // First, initialize the Server
  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  // Then, create CrashGame instance
  crashGameInstance = new CrashGame();

  // Now initialize BetSimulator with the guaranteed crashGameInstance
  betSimulator = new BetSimulator(io, crashGameInstance);

  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (token) {
      const user = verifyToken(token);
      if (user) {
        (socket as any).user = user;
      }
    }
    next();
  });

  io.on('connection', (socket: Socket) => {
    console.log('New client connected:', socket.id);

    const userId = generateUniqueUserId();
    const walletId = generateWalletId();
    users.set(socket.id, {
      id: userId,
      walletId: walletId,
      wallet: 8000,
      balance: 8000, // Add this line
      isLoggedIn: false,
      clientSeed: crypto.randomBytes(16).toString('hex')
    });

    onlineUsers.set(socket.id, { isLoggedIn: false, isFunMode: true });

    socket.emit('assignedId', { id: walletId, balance: 8000, clientSeed: users.get(socket.id)?.clientSeed });
    console.log(`Assigned wallet ID to client ${socket.id}: ${walletId}`);

    if (currentGame) {
      socket.emit('gameState', {
        ...currentGame.getGameState(),
        gameId: currentGame.id
      });
    }





    socket.on('makeItRain', async ({ amount, userId, recipients }) => {
      const user = Array.from(users.values()).find(u => u.walletId === userId);
      if (!user || !user.isLoggedIn || user.wallet < amount) {
        socket.emit('makeItRainFailed', { message: 'Cannot make it rain at this time' });
        return;
      }

      try {
        // Deduct amount from sender
        user.wallet -= amount;
        if (!isUserInFunMode(user)) {
          await updateUserBalance(user.walletId, user.wallet);
        }

        // Get all online users except sender
        const onlineUsers = Array.from(users.values())
          .filter(u => u.walletId !== userId)
          .slice(0, recipients); // Limit to requested number of recipients

        if (onlineUsers.length < 2) {
          socket.emit('makeItRainFailed', { message: 'Not enough users online to make it rain' });
          return;
        }

        // Calculate amount per user (ensure it's an even number)
        const amountPerUser = Math.floor(amount / recipients);

        // Distribute to selected users
        for (const recipient of onlineUsers) {
          recipient.wallet += amountPerUser;
          if (!isUserInFunMode(recipient)) {
            await updateUserBalance(recipient.walletId, recipient.wallet);
          }
          io.to(recipient.walletId).emit('receivedRain', {
            amount: amountPerUser,
            from: user.walletId
          });
        }

        // Broadcast the make it rain event to all users
        io.emit('makeItRainEvent', {
          from: user.walletId,
          amount: amount,
          recipients: onlineUsers.length,
          nickname: user.nickname  // Add this line
        });

        // Send chat message about the event
        const message = `${user.nickname || user.walletId} made it rain ${amount} KES to ${onlineUsers.length} users!`;
        io.emit('chatMessage', {
          id: uuidv4(),
          walletId: 'system',
          message,
          timestamp: Date.now(),
          reactions: {},
          edited: false,
          isSystem: true
        });

      } catch (error) {
        console.error('Error processing make it rain:', error);
        socket.emit('makeItRainFailed', { message: 'Failed to make it rain' });
      }
    });



    // Add these handlers inside your socket.io connection handler
socket.on('startMinesGame', async ({ betAmount, numberOfMines, walletId }) => {
  console.log(`Starting mines game for wallet ${walletId}`);
  try {
    const user = Array.from(users.values()).find(u => u.walletId === walletId);
    if (!user) {
      socket.emit('error', { message: 'User not found' });
      return;
    }

    if (user.wallet < betAmount) {
      socket.emit('error', { message: 'Insufficient balance' });
      return;
    }

    // Create new mines game instance
    const minesGame = new MinesGame();
    const success = await minesGame.startNewGame(walletId, betAmount, numberOfMines);

    if (success) {
      user.activeMinesGame = minesGame;
      user.wallet -= betAmount;
      if (!isUserInFunMode(user)) {
        await updateUserBalance(user.walletId, user.wallet);
      }

      socket.emit('minesGameStarted', { success: true });
      socket.emit('walletBalance', {
        balance: user.wallet,
        isRealMoney: user.isLoggedIn,
        clientSeed: user.clientSeed
      });
    }
  } catch (error) {
    console.error('Error starting mines game:', error);
    socket.emit('error', { message: 'Failed to start game' });
  }
});

socket.on('revealMinesCell', async ({ index, walletId }) => {
  console.log(`Revealing mines cell ${index} for wallet ${walletId}`);
  try {
    const user = Array.from(users.values()).find(u => u.walletId === walletId);
    if (!user || !user.activeMinesGame) {
      socket.emit('error', { message: 'No active game found' });
      return;
    }

    const result = await user.activeMinesGame.revealCell(index);
    socket.emit('minesCellRevealed', result);

    if (result.isMine) {
      // Game over - cleanup
      user.activeMinesGame = undefined;
      socket.emit('walletBalance', {
        balance: user.wallet,
        isRealMoney: user.isLoggedIn,
        clientSeed: user.clientSeed
      });
    }
  } catch (error) {
    console.error('Error revealing cell:', error);
    socket.emit('error', { message: 'Failed to reveal cell' });
  }
});

socket.on('minesCashout', async ({ walletId }) => {
  console.log(`Processing mines cashout for wallet ${walletId}`);
  try {
    const user = Array.from(users.values()).find(u => u.walletId === walletId);
    if (!user || !user.activeMinesGame) {
      socket.emit('error', { message: 'No active game found' });
      return;
    }

    const result = await user.activeMinesGame.cashout();
    if (result.success) {
      user.wallet += result.winAmount;
      if (!isUserInFunMode(user)) {
        await updateUserBalance(user.walletId, result.newBalance);
      }

      socket.emit('minesCashoutSuccess', {
        success: true,
        winAmount: result.winAmount,
        newBalance: result.newBalance
      });

      socket.emit('walletBalance', {
        balance: result.newBalance,
        isRealMoney: user.isLoggedIn,
        clientSeed: user.clientSeed
      });

      // Clear the active game
      user.activeMinesGame = undefined;
    }
  } catch (error) {
    console.error('Error processing cashout:', error);
    socket.emit('error', { message: 'Failed to process cashout' });
  }
});

socket.on('getMinesGameHistory', async ({ walletId }) => {
  try {
    const games = await prisma.minesGame.findMany({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    socket.emit('minesGameHistory', games);
  } catch (error) {
    console.error('Error fetching mines game history:', error);
    socket.emit('error', { message: 'Failed to fetch game history' });
  }
});


// Handle mines game history request
socket.on('getMinesGames', async ({ walletId }) => {
  try {
    const games = await prisma.minesGame.findMany({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    socket.emit('minesGames', games);
  } catch (error) {
    console.error('Error fetching mines games:', error);
    socket.emit('error', { message: 'Failed to fetch mines games' });
  }
});

// Handle provably fair verification for mines game
socket.on('verifyMinesGame', async (data: VerifyMinesGameInput) => {
  try {
    const game = await prisma.minesGame.findUnique({
      where: { gameHash: data.gameHash }
    });

    if (!game) {
      socket.emit('error', { message: 'Game not found' });
      return;
    }

    const verifiedMines = await MinesGame.verifyGame(
      game.serverSeed,
      game.clientSeed,
      game.salt,
      String(game.numberOfMines), // Convert to string
      game.revealedCells[0]
    );

    const result: MinesGameVerificationResult = {
      gameHash: data.gameHash,
      storedMines: game.minePositions,
      verifiedMines,
      isValid: JSON.stringify(game.minePositions.sort()) === JSON.stringify(verifiedMines.sort())
    };

    socket.emit('minesGameVerified', result);
  } catch (error) {
    console.error('Error verifying mines game:', error);
    socket.emit('error', { message: 'Failed to verify game' });
  }
});

// Handle user stats request for mines game
socket.on('getMinesStats', async (data: { walletId: string }) => {
  try {
    const games = await prisma.minesGame.findMany({
      where: { walletId: data.walletId },
      orderBy: { createdAt: 'desc' },
      take: 100  // Get last 100 games for stats
    });

    const stats = {
      totalGames: games.length,
      totalWagered: games.reduce((sum, game) => sum + game.betAmount, 0),
      totalWon: games.reduce((sum, game) => {
        if (game.status === 'WIN') {
          return sum + (game.betAmount * (game.finalMultiplier || 0));
        }
        return sum;
      }, 0),
      bestMultiplier: Math.max(...games.map(game => game.finalMultiplier || 0)),
      winRate: games.filter(game => game.status === 'WIN').length / games.length,
      averageMultiplier: games.reduce((sum, game) => sum + (game.finalMultiplier || 0), 0) / games.length,
      highestBet: Math.max(...games.map(game => game.betAmount)),
      averageBet: games.reduce((sum, game) => sum + game.betAmount, 0) / games.length
    };

    socket.emit('minesStats', stats);
  } catch (error) {
    console.error('Error fetching mines stats:', error);
    socket.emit('error', { message: 'Failed to fetch mines stats' });
  }
});

// Handle auto-mines setup
socket.on('setupAutoMines', async ({ walletId, config }) => {
  const user = Array.from(users.values()).find(u => u.walletId === walletId);
  if (!user) {
    socket.emit('error', { message: 'User not found' });
    return;
  }

  user.autoMinesConfig = config;
  socket.emit('autoMinesConfigured', config);
});

// Handle mines game leaderboard request
socket.on('getMinesLeaderboard', async () => {
  try {
    const topGames = await prisma.minesGame.findMany({
      orderBy: [
        { finalMultiplier: 'desc' }
      ],
      take: 10,
      include: {
        user: true
      }
    });

    const leaderboard = topGames.map(game => ({
      walletId: game.walletId,
      multiplier: game.finalMultiplier,
      betAmount: game.betAmount,
      winAmount: game.betAmount * (game.finalMultiplier || 0),
      nickname: game.user?.nickname,
      date: game.createdAt
    }));

    socket.emit('minesLeaderboard', leaderboard);
  } catch (error) {
    console.error('Error fetching mines leaderboard:', error);
    socket.emit('error', { message: 'Failed to fetch leaderboard' });
  }
});


    // Handle chat messages
    socket.on('sendChatMessage', async (data: { message: string, parentId?: string, walletId: string, timestamp: number }) => {
      const user = users.get(socket.id);
      const isGuest = data.walletId.startsWith('Guest-');

      try {
        const messageId = uuidv4();
        let newMessage;

        if (!isGuest) {
          // Get the user's current nickname from the database
          const dbUser = await prisma.user.findUnique({
            where: { walletId: data.walletId }
          });

          newMessage = await prisma.chatMessage.create({
            data: {
              id: messageId,
              userId: user?.id || 'guest',
              message: data.message,
              parentId: data.parentId,
              createdAt: new Date(data.timestamp),
              edited: false
            }
          });

          const chatMessage = {
            ...newMessage,
            reactions: {},
            walletId: data.walletId,
            nickname: dbUser?.nickname || null // Include the nickname
          };

          socket.broadcast.emit('chatMessage', chatMessage);
          socket.emit('messageConfirmed', {
            id: messageId,
            timestamp: data.timestamp,
            nickname: dbUser?.nickname || null // Include the nickname in confirmation
          });
        } else {
          newMessage = {
            id: messageId,
            message: data.message,
            parentId: data.parentId,
            createdAt: new Date(data.timestamp),
            edited: false
          };

          const chatMessage = {
            ...newMessage,
            reactions: {},
            walletId: data.walletId,
            nickname: null
          };

          socket.broadcast.emit('chatMessage', chatMessage);
          socket.emit('messageConfirmed', {
            id: messageId,
            timestamp: data.timestamp,
            nickname: null
          });
        }
      } catch (error) {
        console.error('Error processing chat message:', error);
        socket.emit('messageError', { error: 'Failed to send message' });
      }
    });


    socket.on('getHistoricalMessages', async () => {
      try {
        const messages = await prisma.chatMessage.findMany({
          orderBy: { createdAt: 'asc' },
          include: {
            reactions: true,
            user: true // Include the user relation to get the nickname
          },
          take: 100  // Limit to last 100 messages
        });

        const formattedMessages = messages.map(msg => ({
          id: msg.id,
          walletId: msg.user?.walletId || 'Guest',
          message: msg.message,
          timestamp: msg.createdAt.getTime(),
          reactions: msg.reactions.reduce((acc, reaction) => {
            if (!acc[reaction.emoji]) acc[reaction.emoji] = [];
            acc[reaction.emoji].push(reaction.userId);
            return acc;
          }, {} as Record<string, string[]>),
          parentId: msg.parentId,
          edited: msg.edited,
          isGif: msg.isGif,
          nickname: msg.user?.nickname || null // Include the nickname
        }));

        socket.emit('historicalMessages', formattedMessages);
      } catch (error) {
        console.error('Error fetching chat history:', error);
      }
    });


    // Add this to your socket connection handling in socketServer.ts

socket.on('updateNickname', async (data: { nickname: string }) => {
  const user = users.get(socket.id);
  if (!user || !user.isLoggedIn) {
    socket.emit('nicknameError', { message: 'You must be logged in to set a nickname' });
    return;
  }

  try {
    // Check if nickname is already taken
    const existingUser = await prisma.user.findUnique({
      where: { nickname: data.nickname }
    });

    if (existingUser && existingUser.id !== user.id) {
      socket.emit('nicknameError', { message: 'This nickname is already taken' });
      return;
    }

    // Update the nickname in the database
    await prisma.user.update({
      where: { id: user.id },
      data: { nickname: data.nickname }
    });

    // Emit success event
    socket.emit('nicknameUpdated', { nickname: data.nickname });

    // Update the in-memory user object as well
    if (users.has(socket.id)) {
      const userToUpdate = users.get(socket.id)!;
      userToUpdate.nickname = data.nickname;
    }

    // Broadcast the nickname change to all connected clients
    io.emit('userNicknameChanged', {
      walletId: user.walletId,
      nickname: data.nickname
    });

  } catch (error) {
    console.error('Error updating nickname:', error);
    socket.emit('nicknameError', {
      message: 'Failed to update nickname. Please try again.'
    });
  }
});


    // Handle message reactions
    socket.on('addReaction', async (data: { messageId: string, emoji: string })=> {
      const user = users.get(socket.id);
      if (user) {
        try {
          const reaction = await prisma.messageReaction.create({
            data: {
              messageId: data.messageId,
              userId: user.id,
              emoji: data.emoji,
            }
          });

          io.emit('messageReaction', {
            messageId: data.messageId,
            userId: user.walletId,
            emoji: data.emoji,
          });
        } catch (error) {
          console.error('Error adding reaction:', error);
        }
      }
    });

    // Handle message editing
    socket.on('editMessage', async (data: { messageId: string, newContent: string }) => {
      const user = users.get(socket.id);
      if (user) {
        try {
          const updatedMessage = await prisma.chatMessage.update({
            where: { id: data.messageId, userId: user.id },
            data: { message: data.newContent, edited: true }
          });

          if (updatedMessage) {
            io.emit('messageEdited', {
              messageId: data.messageId,
              newContent: data.newContent,
              edited: true,
            });
          }
        } catch (error) {
          console.error('Error editing message:', error);
        }
      }
    });

    // Handle message deletion
    socket.on('deleteMessage', async (data: { messageId: string }) => {
      const user = users.get(socket.id);
      if (user) {
        try {
          await prisma.chatMessage.delete({
            where: { id: data.messageId, userId: user.id }
          });

          io.emit('messageDeleted', { messageId: data.messageId });
        } catch (error) {
          console.error('Error deleting message:', error);
        }
      }
    });

    // Handle message search
    socket.on('searchMessages', async (data: { query: string }) => {
      try {
        const messages = await prisma.chatMessage.findMany({
          where: {
            message: {
              contains: data.query,
              mode: 'insensitive',
            }
          },
          take: 50,
          orderBy: { createdAt: 'desc' },
          include: { user: true, reactions: true }
        });

        const formattedMessages = messages.map(msg => ({
          id: msg.id,
          userId: msg.user.walletId,
          message: msg.message,
          timestamp: msg.createdAt.getTime(),
          reactions: msg.reactions.reduce((acc, reaction) => {
            if (!acc[reaction.emoji]) {
              acc[reaction.emoji] = [];
            }
            acc[reaction.emoji].push(reaction.userId);
            return acc;
          }, {} as Record<string, string[]>),
          parentId: msg.parentId,
          edited: msg.edited,
          isGif: msg.isGif,
        }));

        socket.emit('searchResults', formattedMessages);
      } catch (error) {
        console.error('Error searching messages:', error);
      }
    });

    // Handle user reconnection
    socket.on('reconnectUser', async ({ token }: { token: string }) => {
      console.log(`Reconnection attempt with token`);
      try {
        const user = verifyToken(token);
        if (user) {
          const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
          if (dbUser) {
            users.set(socket.id, {
              id: dbUser.id,
              walletId: dbUser.walletId,
              phoneNumber: dbUser.phoneNumber,
              wallet: dbUser.balance,
              balance: dbUser.balance,
              isLoggedIn: true,
              clientSeed: dbUser.clientSeed
            });
            socket.emit('reconnectSuccess', {
              id: dbUser.walletId,
              phoneNumber: dbUser.phoneNumber,
              balance: dbUser.balance,
              clientSeed: dbUser.clientSeed
            });
            console.log(`User ${dbUser.walletId} reconnected successfully`);

            onlineUsers.set(socket.id, { isLoggedIn: true, isFunMode: false });
          } else {
            socket.emit('reconnectFailed', { message: 'User not found' });
          }
        } else {
          socket.emit('reconnectFailed', { message: 'Invalid token' });
        }
      } catch (error) {
        console.error('Error during reconnection:', error);
        socket.emit('reconnectFailed', { message: 'Reconnection failed' });
      }
    });

    // Handle user registration
    socket.on('register', async ({ phoneNumber, password, referralCode }: {
      phoneNumber: string,
      password: string,
      referralCode?: string
    }) => {
      console.log(`Registration requested for phone number: ${phoneNumber}`);
      try {
        const existingUser = await prisma.user.findUnique({ where: { phoneNumber } });
        if (existingUser) {
          socket.emit('registerFailed', { message: 'Phone number already registered' });
          return;
        }

        // Verify referral code if provided
        let referrerId = null;
        if (referralCode) {
          const referrer = await prisma.user.findFirst({
            where: { referralCode }
          });
          if (referrer) {
            referrerId = referrer.id;
          }
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const userId = generateUniqueUserId();
        const walletId = generateWalletId();
        const newUserReferralCode = generateReferralCode(); // Implement this function

        const newUser = await prisma.user.create({
          data: {
            id: userId,
            walletId: walletId,
            phoneNumber,
            password: hashedPassword,
            balance: 0,
            clientSeed: crypto.randomBytes(16).toString('hex'),
            referralCode: newUserReferralCode,
            referredBy: referrerId, // Add referrer if exists
          }
        });

        const token = generateTokens({ id: userId, walletId: walletId, phoneNumber });
        users.set(socket.id, {
          id: userId,
          walletId: walletId,
          phoneNumber,
          wallet: 0,
          balance: 0,
          isLoggedIn: true,
          clientSeed: newUser.clientSeed
        });

        socket.emit('registerSuccess', {
          token,
          phoneNumber: newUser.phoneNumber,
          balance: 0,
          id: walletId,
          clientSeed: newUser.clientSeed
        });

        onlineUsers.set(socket.id, { isLoggedIn: true, isFunMode: false });

      } catch (error) {
        console.error('Registration error:', error);
        socket.emit('registerFailed', { message: 'Registration failed' });
      }
    });

    // Add helper function to generate referral code
    function generateReferralCode(): string {
      return Math.random().toString(36).substring(2, 8).toUpperCase();
    }


    socket.on('deposit', async ({ amount, phoneNumber, businessShortCode }) => {
      const user = users.get(socket.id);
      if (!user?.isLoggedIn) {
        socket.emit('error', { message: 'Must be logged in to deposit' });
        return;
      }

      try {
        // Create deposit record
        const deposit = await prisma.deposit.create({
          data: {
            userId: user.id,
            walletId: user.walletId,
            amount,
            phoneNumber,
            businessShortCode,
            status: 'PENDING'
          }
        });

        // Once deposit is confirmed as successful:
        await prisma.deposit.update({
          where: { id: deposit.id },
          data: { status: 'COMPLETED' }
        });

        // Update user balance
        await prisma.user.update({
          where: { id: user.id },
          data: {
            balance: {
              increment: amount
            }
          }
        });

        // Add to deposit success handler
        await handleDepositSuccess(user.id, amount); // Corrected: Pass user.id
        await processAffiliateEarnings(user.id, amount);

        socket.emit('depositSuccess', {
          amount,
          newBalance: user.balance + amount
        });

      } catch (error) {
        console.error('Deposit error:', error);
        socket.emit('error', { message: 'Deposit failed' });
      }
    });


    // Handle registration code verification
    socket.on('verifyRegistrationCode', async ({ phoneNumber, password, verificationCode }: { phoneNumber: string, password: string, verificationCode: string })=> {
      console.log(`Verifying registration code for phone number: ${phoneNumber}`);
      try {
        const isVerified = await checkVerificationCode(phoneNumber, verificationCode);
        if (isVerified) {
          const hashedPassword = await bcrypt.hash(password, 10);
          const userId = generateUniqueUserId();
          const walletId = generateWalletId();
          const newUser = await prisma.user.create({
            data: {
              id: userId,
              walletId: walletId,
              phoneNumber,
              password: hashedPassword,
              balance: 0,
              clientSeed: crypto.randomBytes(16).toString('hex')
            }
          });

          const token = generateTokens({ id: userId, walletId: walletId, phoneNumber });
          users.set(socket.id, {
            id: userId,
            walletId: walletId,
            phoneNumber,
            wallet: 0,
            balance: 0, // Add this line
            isLoggedIn: true,
            clientSeed: newUser.clientSeed
          });
          socket.emit('registerSuccess', {
            token,
            phoneNumber: newUser.phoneNumber,
            balance: 0,
            id: walletId,
            clientSeed: newUser.clientSeed
          });
          console.log(`User registered successfully: ${walletId}`);

          onlineUsers.set(socket.id, { isLoggedIn: true, isFunMode: false });
        } else {
          socket.emit('registerFailed', { message: 'Invalid verification code' });
        }
      } catch (error) {
        console.error('Registration error:', error);
        socket.emit('registerFailed', { message: 'Registration failed' });
      }
    });

    // Handle token verification
    socket.on('verifyToken', async (accessToken: string, refreshToken: string) => {
      console.log('Verifying token');
      try {
        let decoded = verifyToken(accessToken);
        let user;

        if (!decoded) {
          console.log('Access token invalid, attempting to use refresh token');
          decoded = await verifyRefreshToken(refreshToken);
          if (!decoded) {
            console.log('Refresh token invalid');
            socket.emit('tokenInvalid');
            return;
          }
          // Generate new tokens
          const { accessToken: newAccessToken, refreshToken: newRefreshToken } = await generateTokens(decoded);
          user = await prisma.user.findUnique({ where: { id: decoded.id } });
          if (user) {
            // Update refresh token in the database
            await prisma.user.update({
              where: { id: user.id },
              data: { refreshToken: newRefreshToken }
            });
            socket.emit('tokenRefreshed', { accessToken: newAccessToken, refreshToken: newRefreshToken });
          }
        } else {
          user = await prisma.user.findUnique({ where: { id: decoded.id } });
        }

        if (!user) {
          console.log('User not found');
          socket.emit('tokenInvalid');
          return;
        }

        console.log('Token valid, user found:', user.id);
        socket.join(user.walletId);
        users.set(socket.id, {
          id: user.id,
          walletId: user.walletId,
          phoneNumber: user.phoneNumber,
          wallet: user.balance,
          balance: user.balance,
          isLoggedIn: true,
          clientSeed: user.clientSeed
        });

        socket.emit('tokenVerified', {
          phoneNumber: user.phoneNumber,
          balance: user.balance,
          id: user.walletId,
          clientSeed: user.clientSeed
        });

        onlineUsers.set(socket.id, { isLoggedIn: true, isFunMode: false });
      } catch (error) {
        console.error('Error verifying token:', error);
        socket.emit('tokenInvalid');
      }
    });

    // Handle token refresh
    socket.on('refreshToken', async (refreshToken: string) => {
      const decoded = await verifyRefreshToken(refreshToken);
      if (decoded) {
        const { accessToken, refreshToken: newRefreshToken } = await generateTokens(decoded);
        socket.emit('tokenRefreshed', { accessToken, refreshToken: newRefreshToken });
      } else {
        socket.emit('refreshTokenFailed');
      }
    });



    // Handle user login
    socket.on('login', async ({ phoneNumber, password }: { phoneNumber: string,password: string }) => {
      console.log(`Login requested for phone number: ${phoneNumber}`);
      try {
        const user = await prisma.user.findUnique({ where: { phoneNumber } });
        if (!user) {
          console.log(`Login failed: User not found for phone number ${phoneNumber}`);
          socket.emit('loginFailed', { message: 'Invalid credentials' });
          return;
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
          console.log(`Login failed: Invalid password for user ${user.id}`);
          socket.emit('loginFailed', { message: 'Invalid credentials' });
          return;
        }

        const { accessToken, refreshToken } = await generateTokens({ id: user.id, walletId: user.walletId, phoneNumber: user.phoneNumber });
        users.set(socket.id, {
          id: user.id,
          walletId: user.walletId,
          phoneNumber,
          wallet: user.balance,
          balance: user.balance,
          isLoggedIn: true,
          clientSeed: user.clientSeed
        });
        socket.emit('loginSuccess', {
          accessToken,
          refreshToken,
          phoneNumber: user.phoneNumber,
          balance: user.balance,
          id: user.walletId,
          clientSeed: user.clientSeed
        });
        console.log(`User logged in successfully: ${user.walletId}`);

        onlineUsers.set(socket.id, { isLoggedIn: true, isFunMode: false });
      } catch (error) {
        console.error('Login error:', error);
        let errorMessage = 'An unexpected error occurred';
        if (error instanceof Error) {
          errorMessage = error.message;
        }
        socket.emit('loginFailed', { message: errorMessage });
      }
    });

    // Handle user logout
    socket.on('logout', async () => {
      const user = users.get(socket.id);
      if (user && user.isLoggedIn) {
        await invalidateRefreshToken(user.id);
        const tempWalletId = generateWalletId();
        users.set(socket.id, {
          id: generateUniqueUserId(),
          walletId: tempWalletId,
          wallet: 8000,
          balance: 8000,
          isLoggedIn: false,
          clientSeed: crypto.randomBytes(16).toString('hex')
        });
        socket.emit('logoutSuccess', {
          id: tempWalletId,
          balance: 8000,
          clientSeed: users.get(socket.id)?.clientSeed
        });
        console.log(`User logged out: ${tempWalletId}`);

        onlineUsers.set(socket.id, { isLoggedIn: false, isFunMode: true });
      } else {
        socket.emit('logoutFailed', { message: 'User not logged in' });
      }
    });

    // Handle wallet balance request
    socket.on('getWalletBalance', () => {
      const user = users.get(socket.id);
      if (user) {
        socket.emit('walletBalance', {
          balance: user.wallet,
          isRealMoney: user.isLoggedIn,
          clientSeed: user.clientSeed
        });
        console.log(`Sent wallet balance to user ${user.walletId}: ${user.wallet}`);
      } else {
        console.log(`Wallet balance request failed: User not found for socket ${socket.id}`);
        socket.emit('walletBalance', {
          balance: 8000,
          isRealMoney: false,
          clientSeed: crypto.randomBytes(16).toString('hex')
        });
      }
    });

    // Handle client seed change
    socket.on('changeClientSeed', async (newClientSeed: string) => {
      const user = users.get(socket.id);
      if (user) {
        user.clientSeed = newClientSeed;
        if (user.isLoggedIn) {
          await prisma.user.update({
            where: { id: user.id },
            data: { clientSeed: newClientSeed }
          });
        }
        socket.emit('clientSeedChanged', { clientSeed: newClientSeed });
        console.log(`Client seed changed for user ${user.walletId}`);
      } else {
        socket.emit('changeClientSeedFailed', { message: 'User not found' });
      }
    });

    // Handle deposit initiation
    socket.on('initiateDeposit', async ({ amount, phoneNumber, walletId }) => {
      console.log(`Initiating deposit - Amount: ${amount}, Phone: ${phoneNumber}, WalletID: ${walletId}`);
      try {
        let user;
        if (walletId) {
          user = await prisma.user.findUnique({ where: { walletId } });
          console.log(`User found by walletId: ${JSON.stringify(user)}`);
        }
        if (!user && phoneNumber) {
          const formattedPhoneNumber = phoneNumber.startsWith('+') ? phoneNumber: `+${phoneNumber}`;
          user = await prisma.user.findUnique({ where: { phoneNumber: formattedPhoneNumber } });
          console.log(`User found by phoneNumber: ${JSON.stringify(user)}`);
        }
        if (!user) {
          console.log('User not found');
          socket.emit('depositFailed', { message: 'User not found' });
          return;
        }
        walletId = user.walletId;
        console.log(`Proceeding with deposit for walletId: ${walletId}`);

        // Proceed with the STK push
        const stkPushResponse = await initiateSTKPush(phoneNumber, amount, walletId);
        console.log('STK push response:', stkPushResponse);

        if (stkPushResponse.ResponseCode === "0") {
          // STK push initiated successfully
          console.log('STK push initiated successfully');

          // Create a deposit record
          try {
            const deposit = await prisma.deposit.create({
              data: {
                userId: user.id,
                walletId: user.walletId,
                amount: amount,
                phoneNumber: phoneNumber,
                businessShortCode: process.env.MPESA_BUSINESS_SHORTCODE || '',
                merchantRequestID: stkPushResponse.MerchantRequestID,
                checkoutRequestID: stkPushResponse.CheckoutRequestID,
                status: 'PENDING',
                // Add these fields with default values
                mpesaReceiptNumber: null,
                transactionDate: new Date(),
              }
            });
            console.log('Deposit record created:', deposit);
          } catch (dbError) {
            console.error('Failed to create deposit record:', dbError);
          }

          socket.emit('depositInitiated', {
            checkoutRequestID: stkPushResponse.CheckoutRequestID,
            amount: amount
          });
        } else {
          console.error(`STK push failed: ${stkPushResponse.ResponseDescription}`);
          throw new Error(`STK push failed: ${stkPushResponse.ResponseDescription}`);
        }
      } catch (error) {
        console.error('Error initiating deposit:', error);
        socket.emit('depositFailed', {
          message: error instanceof Error ? error.message : 'Failed to initiate deposit. Please try again.'
        });
      }
    });



    // CheckSTKstatus

    socket.on('checkSTKStatus', async ({ CheckoutRequestID }) => {
      console.log(`Checking STK status for CheckoutRequestID: ${CheckoutRequestID}`);
      try {
        const result = await querySTKPush(CheckoutRequestID);
        console.log("STK status check result:", result);

        if (result.ResultCode === "0") {
          try {
            const deposit = await prisma.deposit.findFirst({
              where: { checkoutRequestID: CheckoutRequestID },
              include: { user: true },
            });

            if (!deposit) {
              console.error(`No deposit found for CheckoutRequestID: ${CheckoutRequestID}`);
              socket.emit('stkStatusResult', {
                success: false,
                message: "Deposit record not found",
              });
              return;
            }

            console.log('Updating deposit:', deposit.id);

            // Check if MpesaReceiptNumber and TransactionDate exist in the result
            const mpesaReceiptNumber = result.MpesaReceiptNumber || null;
            const transactionDate = result.TransactionDate ? new Date(result.TransactionDate) : new Date();

            console.log('MpesaReceiptNumber:', mpesaReceiptNumber);
            console.log('TransactionDate:', transactionDate);

            const updatedDeposit = await prisma.deposit.update({
              where: { id: deposit.id },
              data: {
                status: 'COMPLETED',
                mpesaReceiptNumber: mpesaReceiptNumber,
                transactionDate: transactionDate,
              },
            });

            console.log('Deposit updated:', updatedDeposit);

            console.log('Updating user balance:', deposit.walletId);

            const updatedUser = await prisma.user.update({
              where: { walletId: deposit.walletId },
              data: {
                balance: { increment: deposit.amount },
              },
            });

            console.log('User balance updated:', updatedUser);

            socket.emit('stkStatusResult', {
              success: true,
              amount: deposit.amount,
              mpesaReceiptNumber: mpesaReceiptNumber,
              newBalance: updatedUser.balance, // Initial balance update from deposit
            });

            // Process deposit cashback bonus
            const depositBonusAmount = await processDepositCashbackBonus(deposit.userId, deposit.amount);
            let finalBalance = updatedUser?.balance || deposit.amount; // Start with balance after deposit

            if (depositBonusAmount > 0) {
              // Fetch the user again to get the balance *after* the bonus was added by the service
              const userAfterBonus = await prisma.user.findUnique({ where: { id: deposit.userId } });
              finalBalance = userAfterBonus?.balance || finalBalance; // Use the latest balance

              io.to(deposit.walletId).emit('bonusReceived', {
                type: BonusType.DEPOSIT_CASHBACK,
                amount: depositBonusAmount,
                message: `You received a ${depositBonusAmount.toFixed(2)} KES deposit cashback bonus!`
              });
              // Update in-memory user if they exist
              const userInMemory = Array.from(users.values()).find(u => u.id === deposit.userId);
              if (userInMemory) {
                userInMemory.wallet = finalBalance;
                userInMemory.balance = finalBalance;
                // Re-emit wallet balance to ensure UI updates correctly
                 io.to(deposit.walletId).emit('walletBalance', {
                   balance: finalBalance,
                   isRealMoney: userInMemory.isLoggedIn,
                   clientSeed: userInMemory.clientSeed
                 });
              }
            }

            console.log("Deposit processed successfully:", {
              amount: deposit.amount,
              mpesaReceiptNumber: result.MpesaReceiptNumber,
              walletId: deposit.walletId,
              bonusAwarded: depositBonusAmount,
              finalBalance: finalBalance,
            });

          } catch (dbError) {
            console.error('Database operation failed:', dbError);
            socket.emit('stkStatusResult', {
              success: false,
              message: "Failed to process deposit",
            });
          }
        } else {
          console.log('STK push failed:', result.ResultDesc);
          socket.emit('stkStatusResult', {
            success: false,
            message: result.ResultDesc || "STK push failed",
          });
        }
      } catch (error) {
        console.error("Error checking STK status:", error);
        socket.emit('stkStatusResult', {
          success: false,
          message: "Failed to check STK status",
        });
      }
    });



    // Handle emergency threshold setting
socket.on('setEmergencyThreshold', async ({ amount, walletId }: { amount: number, walletId: string }) => {
  const user = Array.from(users.values()).find(u => u.walletId === walletId);
  if (!user || !user.isLoggedIn) {
    socket.emit('error', { message: 'Unauthorized' });
    return;
  }

  try {
    // Check if user is admin (you'll need to add an isAdmin field to your User type)
    const dbUser = await prisma.user.findUnique({
      where: { walletId }
    });

    if (!dbUser?.isAdmin) {
      socket.emit('error', { message: 'Unauthorized' });
      return;
    }

    if (crashGameInstance) {
      await crashGameInstance.setEmergencyThreshold(amount);
      socket.emit('emergencyThresholdSet', { amount });
    }
  } catch (error) {
    console.error('Error setting emergency threshold:', error);
    socket.emit('error', { message: 'Failed to set emergency threshold' });
  }
});

// Get current emergency threshold
socket.on('getEmergencyThreshold', async ({ walletId }: { walletId: string }) => {
  const user = Array.from(users.values()).find(u => u.walletId === walletId);
  if (!user || !user.isLoggedIn) {
    socket.emit('error', { message: 'Unauthorized' });
    return;
  }

  try {
    const dbUser = await prisma.user.findUnique({
      where: { walletId }
    });

    if (!dbUser?.isAdmin) {
      socket.emit('error', { message: 'Unauthorized' });
      return;
    }

    if (crashGameInstance) {
      const threshold = await crashGameInstance.getEmergencyThreshold();
      socket.emit('emergencyThreshold', { amount: threshold });
    }
  } catch (error) {
    console.error('Error getting emergency threshold:', error);
    socket.emit('error', { message: 'Failed to get emergency threshold' });
  }
});





const commissionRates: CommissionRates = {
  1: 0.25, // 25% for first level
  2: 0.05, // 5% for second level
  3: 0.01  // 1% for third level
};

async function calculateReferralEarnings(referredUsers: string[], level: number): Promise<ReferralStats> {
  if (referredUsers.length === 0) {
    return { pendingAmount: 0, totalReferrals: 0 };
  }

  const firstDeposits = await prisma.deposit.findMany({
    where: {
      userId: { in: referredUsers },
      status: 'COMPLETED'
    },
    orderBy: { createdAt: 'asc' },
    distinct: ['userId'],
  });

  const pendingAmount = firstDeposits.reduce((sum, deposit) =>
    sum + deposit.amount * commissionRates[level], 0
  );

  return {
    pendingAmount,
    totalReferrals: referredUsers.length
  };
}

socket.on('getAffiliateStats', async () => {
  const user = users.get(socket.id);
  if (!user?.isLoggedIn) return;

  try {
    // Get referrals for each level
    const firstLevel = await prisma.user.findMany({
      where: { referredBy: user.id },
      select: { id: true }
    });

    const secondLevel = await prisma.user.findMany({
      where: { referredBy: { in: firstLevel.map(u => u.id) } },
      select: { id: true }
    });

    const thirdLevel = await prisma.user.findMany({
      where: { referredBy: { in: secondLevel.map(u => u.id) } },
      select: { id: true }
    });

    // Calculate earnings for each level
    const [firstLevelStats, secondLevelStats, thirdLevelStats] = await Promise.all([
      calculateReferralEarnings(firstLevel.map(u => u.id), 1),
      calculateReferralEarnings(secondLevel.map(u => u.id), 2),
      calculateReferralEarnings(thirdLevel.map(u => u.id), 3)
    ]);

    // Get paid earnings
    const paidEarnings = await prisma.affiliateEarning.groupBy({
      by: ['level'],
      where: {
        userId: user.id,
        isPaid: true
      },
      _sum: {
        amount: true
      }
    });

    const stats = {
      firstLevel: {
        referrals: firstLevelStats.totalReferrals,
        pendingAmount: firstLevelStats.pendingAmount,
        approvedAmount: paidEarnings.find(e => e.level === 1)?._sum?.amount || 0
      },
      secondLevel: {
        referrals: secondLevelStats.totalReferrals,
        pendingAmount: secondLevelStats.pendingAmount,
        approvedAmount: paidEarnings.find(e => e.level === 2)?._sum?.amount || 0
      },
      thirdLevel: {
        referrals: thirdLevelStats.totalReferrals,
        pendingAmount: thirdLevelStats.pendingAmount,
        approvedAmount: paidEarnings.find(e => e.level === 3)?._sum?.amount || 0
      }
    };

    const totalBonus = Object.values(stats).reduce(
      (sum, level) => sum + level.pendingAmount + level.approvedAmount,
      0
    );
    const amountPaid = Object.values(stats).reduce(
      (sum, level) => sum + level.approvedAmount,
      0
    );

    socket.emit('affiliateStats', {
      ...stats,
      totalBonus,
      amountPaid,
      availableBalance: totalBonus - amountPaid
    });

  } catch (error) {
    console.error('Error getting affiliate stats:', error);
    socket.emit('error', { message: 'Failed to fetch affiliate statistics' });
  }
});


socket.on('getAffiliateWithdrawals', async () => {
  const user = users.get(socket.id);
  if (!user?.isLoggedIn) return;

  try {
    const withdrawals = await prisma.affiliateWithdrawal.findMany({
      where: {
        userId: user.id
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    socket.emit('affiliateWithdrawals', withdrawals);
  } catch (error) {
    console.error('Error fetching affiliate withdrawals:', error);
    socket.emit('error', { message: 'Failed to fetch withdrawal history' });
  }
});

// Handle referral link request
socket.on('getReferralLink', async () => {
  const user = users.get(socket.id);
  if (!user?.isLoggedIn) return;

  try {
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id }
    });

    if (dbUser) {
      const referralCode = dbUser.referralCode || crypto.randomUUID();

      // Update user with new referral code if none exists
      if (!dbUser.referralCode) {
        await prisma.user.update({
          where: { id: user.id },
          data: { referralCode }
        });
      }

      const baseUrl = process.env.FRONTEND_URL || 'https://watubet.com';
      const referralLink = `${baseUrl}?ref=${referralCode}`;

      // Get total referrals count
      const referralCount = await prisma.user.count({
        where: { referredBy: user.id }
      });

      // Get total earnings
      const earnings = await prisma.affiliateEarning.aggregate({
        where: {
          userId: user.id,
          isPaid: true
        },
        _sum: {
          amount: true
        }
      });

      socket.emit('referralLink', {
        link: referralLink,
        code: referralCode,
        stats: {
          totalReferrals: referralCount,
          totalEarnings: earnings._sum.amount || 0
        }
      });
    }
  } catch (error) {
    console.error('Error getting referral link:', error);
    socket.emit('error', { message: 'Failed to get referral link' });
  }
});


// Add this socket handler inside the setupSocketServer function after the getReferralLink handler
socket.on('updateReferralCode', async ({ code }: { code: string }) => {
  const user = users.get(socket.id);
  if (!user?.isLoggedIn) {
    socket.emit('error', { message: 'You must be logged in to update referral code' });
    return;
  }

  try {
    // Validate referral code format
    if (code.length < 4) {
      socket.emit('error', { message: 'Referral code must be at least 4 characters' });
      return;
    }

    // Check if code is already taken
    const existingUser = await prisma.user.findUnique({
      where: { referralCode: code }
    });

    if (existingUser && existingUser.id !== user.id) {
      socket.emit('error', { message: 'This referral code is already taken' });
      return;
    }

    // Update user's referral code
    await prisma.user.update({
      where: { id: user.id },
      data: { referralCode: code }
    });

    // Generate new referral link with updated code
    const baseUrl = process.env.FRONTEND_URL || 'https://watubet.com/';
    const referralLink = `${baseUrl}?ref=${code}`;

    socket.emit('referralCodeUpdated', {
      success: true,
      code,
      link: referralLink
    });
  } catch (error) {
    console.error('Error updating referral code:', error);
    socket.emit('error', { message: 'Failed to update referral code' });
  }
});


// Add new socket handler
socket.on('requestAffiliateWithdrawal', async ({ amount, walletAddress }) => {
  const user = users.get(socket.id);
  if (!user?.isLoggedIn) {
    socket.emit('error', { message: 'You must be logged in to withdraw' });
    return;
  }

  try {
    const withdrawal = await handleAffiliateWithdrawal(user.id, amount, walletAddress);

    socket.emit('withdrawalRequestSuccess', {
      message: 'Withdrawal request submitted successfully',
      withdrawal
    });

    // Refresh affiliate stats
    socket.emit('getAffiliateStats');

  } catch (error) {
    console.error('Error processing withdrawal:', error);
    socket.emit('error', {
      message: error instanceof Error ? error.message : 'Failed to process withdrawal request'
    });
  }
});





// Update in handleMpesaCallback function or wherever deposit success is handled
async function handleDepositSuccess(userId: string, amount: number) {

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        referrer: {
          include: {
            referrer: {
              include: {
                referrer: true
              }
            }
          }
        }
      }
    });

    if (!user?.referrer) return;

    // First level referral (25%)
    await prisma.affiliateEarning.create({
      data: {
        userId: user.referrer.id,
        referralId: userId,
        depositAmount: amount,
        commissionRate: 0.25,
        level: 1,
        amount: amount * 0.25,
        isPaid: false
      }
    });

    console.log(`Created Level 1 affiliate earning for ${user.referrer.id}`);

    // Second level referral (5%)
    if (user.referrer.referrer) {
      await prisma.affiliateEarning.create({
        data: {
          userId: user.referrer.referrer.id,
          referralId: userId,
          depositAmount: amount,
          commissionRate: 0.05,
          level: 2,
          amount: amount * 0.05,
          isPaid: false
        }
      });

      console.log(`Created Level 2 affiliate earning for ${user.referrer.referrer.id}`);
    }

    // Third level referral (1%)
    if (user.referrer.referrer?.referrer) {
      await prisma.affiliateEarning.create({
        data: {
          userId: user.referrer.referrer.referrer.id,
          referralId: userId,
          depositAmount: amount,
          commissionRate: 0.01,
          level: 3,
          amount: amount * 0.01,
          isPaid: false
        }
      });

      console.log(`Created Level 3 affiliate earning for ${user.referrer.referrer.referrer.id}`);
    }
  } catch (error) {
    console.error('Error processing affiliate earnings:', error);
  }
}


    // Handle withdrawal initiation
socket.on('initiateWithdrawal', async ({ amount, phoneNumber, walletId }) => {
  console.log(`Initiating withdrawal of ${amount} for wallet ${walletId}`);
  try {
    const user = await prisma.user.findUnique({ where: { walletId } });
    if (!user) {
      throw new Error('User not found');
    }

    if (user.balance < amount) {
      throw new Error('Insufficient balance');
    }

    // Create a pending withdrawal record
    const withdrawal = await prisma.withdrawal.create({
      data: {
        walletId: user.walletId,
        amount: amount,
        status: 'PENDING',
        transactionId: '',
      } as Prisma.WithdrawalUncheckedCreateInput
    });

    // Initiate B2C transaction
    const b2cResult = await b2cPaymentRequest(phoneNumber, amount, 'Withdrawal');

    if (b2cResult.ResponseCode === '0') {
      // Update withdrawal record with transaction details
      await prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          transactionId: b2cResult.ConversationID,
          status: 'PROCESSING'
        }
      });

      // Deduct amount from user's balance
      await prisma.user.update({
        where: { walletId: user.walletId },
        data: { balance: { decrement: amount } }
      });

      socket.emit('withdrawalInitiated', {
        message: 'Withdrawal initiated successfully',
        amount: amount,
        transactionId: b2cResult.ConversationID
      });
    } else {
      // Update withdrawal status to FAILED
      await prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: 'FAILED' }
      });

      throw new Error('Failed to initiate withdrawal');
    }
  } catch (error) {
    console.error('Error initiating withdrawal:', error);
    socket.emit('withdrawalFailed', {
      message: error instanceof Error ? error.message : 'An unexpected error occurred'
    });
  }
});

socket.on('requestWithdrawal', async ({ amount, phoneNumber, walletId }) => {
  try {
    const user = await prisma.user.findUnique({ where: { walletId } });
    if (!user) {
      throw new Error('User not found');
    }

    if (user.balance < amount) {
      throw new Error('Insufficient balance');
    }

    const withdrawalRequest = await prisma.withdrawalRequest.create({
      data: {
        amount: amount,
        status: 'PENDING',
        phoneNumber: phoneNumber,
        walletId: walletId,
        user: {
          connect: { id: user.id }
        }
      }
    });

    socket.emit('withdrawalRequested', {
      message: 'Withdrawal request submitted successfully',
      amount: amount,
      id: withdrawalRequest.id
    });

    // Notify admin about the new withdrawal request (implement this part in your admin panel)
    // io.to('admin').emit('newWithdrawalRequest', withdrawalRequest);

  } catch (error) {
    console.error('Error requesting withdrawal:', error);
    socket.emit('withdrawalRequestFailed', {
      message: error instanceof Error ? error.message : 'An unexpected error occ urred'
    });
  }
});

socket.on('getWithdrawalRequests', async (walletId: string) => {
  try {
    const withdrawalRequests = await prisma.withdrawalRequest.findMany({
      where: {
        walletId: walletId,
        status: 'PENDING'
      },
      orderBy: { createdAt: 'desc' }
    });

    socket.emit('withdrawalRequests', withdrawalRequests);
  } catch (error) {
    console.error('Error fetching withdrawal requests:', error);
    socket.emit('withdrawalRequestsFailed', {
      message: 'Failed to fetch withdrawal requests'
    });
  }
});


// Update the withdrawal handler in setupSocketServer
socket.on('requestAffiliateWithdrawal', async ({ amount, walletAddress }) => {
  const user = users.get(socket.id);
  if (!user?.isLoggedIn) {
    socket.emit('error', { message: 'You must be logged in to withdraw' });
    return;
  }

  try {
    const withdrawal = await handleAffiliateWithdrawal(user.id, amount, walletAddress);

    // Emit success event
    socket.emit('withdrawalRequestSuccess', {
      message: 'Withdrawal request submitted successfully',
      withdrawal
    });

    // Refresh affiliate stats for the user
    socket.emit('getAffiliateStats');

  } catch (error) {
    console.error('Error processing withdrawal:', error);
    socket.emit('error', {
      message: error instanceof Error ? error.message : 'Failed to process withdrawal request'
    });
  }
});

// Add handler for withdrawal success callback
async function handleAffiliateWithdrawalSuccess(callbackData: any) {
  const { withdrawalRequestId } = callbackData;

  try {
    await processSuccessfulAffiliateWithdrawal(withdrawalRequestId);

    // Find the user and notify them
    const user = await prisma.user.findFirst({
      where: {
        withdrawalRequests: {
          some: { id: withdrawalRequestId }
        }
      }
    });

    if (user) {
      const socket = Array.from(io.sockets.sockets.values()).find(
        (s) => (s as any).user?.id === user.id
      );

      if (socket) {
        socket.emit('affiliateWithdrawalComplete', {
          message: 'Your affiliate withdrawal has been processed successfully'
        });
        socket.emit('getAffiliateStats'); // Refresh stats
      }
    }
  } catch (error) {
    console.error('Error processing affiliate withdrawal success:', error);
  }
}


    // Handle bet placement
    socket.on('placeBet', async ({ amount, walletId, forNextRound }: { amount: number, walletId: string, forNextRound: boolean }) => {
      console.log('Received placeBet event:', amount, walletId, forNextRound);
      const user = Array.from(users.values()).find(u => u.walletId === walletId);
      if (!user || !currentGame) {
        console.log('Cannot place bet: User not found or no current game');
        socket.emit('betFailed', { message: 'Cannot place bet at this time' });
        return;
      }

      if (user.wallet < amount || amount <= 0) {
        console.log('Insufficient funds for bet or invalid bet amount');
        socket.emit('betFailed', { message: 'Insufficient funds or invalid bet amount' });
        return;
      }

      try {
        if (forNextRound || currentGame.isGameInProgress()) {
          const nextRoundBet = {
            walletId: user.walletId,
            amount: amount,
          };
          currentGame.addNextRoundBet(nextRoundBet);
          console.log(`Next round bet added to GameSession for wallet ${user.walletId}: ${amount}`);

          user.wallet -= amount;
          if (!isUserInFunMode(user)) {
            await updateUserBalance(user.walletId, user.wallet);
            console.log(`User balance updated for next round bet: ${user.wallet}`);
          }

          socket.emit('betPlaced', {
            walletId: user.walletId,
            amount,
            wallet: user.wallet,
            gameHash: currentGame.getCurrentGameHash(),
            forNextRound: true
          });
          console.log(`Next round bet placed for wallet ${user.walletId}: ${amount}`);
        } else {
          console.log(`Placing current round bet for wallet ${user.walletId}: ${amount}`);

          let newBet;
          if (!isUserInFunMode(user)) {
            newBet = await prisma.bet.create({
              data: {
                userId: user.id,
                walletId: user.walletId,
                amount: amount,
                gameId: currentGame.id,
              }
            });
            console.log(`Bet saved to database with id: ${newBet.id}`);
          }

          const betPlaced = currentGame.placeBet(user.walletId, amount);
          if (betPlaced) {
            user.wallet -= amount;
            if (!isUserInFunMode(user)) {
              await updateUserBalance(user.walletId, user.wallet);
              console.log(`User balance updated for current round bet: ${user.wallet}`);
            }
            socket.emit('betPlaced', {
              walletId: user.walletId,
              amount,
              wallet: user.wallet,
              gameHash: currentGame.getCurrentGameHash(),
              forNextRound: false
            });
            console.log(`Current round bet placed for wallet ${user.walletId}: ${amount}`);
          } else {
            if (newBet) {
              await prisma.bet.delete({ where: { id: newBet.id } });
              console.log(`Failed to place bet in GameSession, deleted from database: ${newBet.id}`);
            }
            socket.emit('betFailed', { message: 'Failed to place bet' });
          }
        }

        emitCurrentBets(io, currentGame);

      } catch (error) {
        console.error('Error placing bet:', error);
        socket.emit('betFailed', { message: 'Failed to place bet' });
      }
    });

    // Handle bet cancellation
    socket.on('cancelBet', async ({ walletId, forNextRound }: { walletId: string, forNextRound: boolean }) => {
      console.log('Received cancelBet event');
      const user = Array.from(users.values()).find(u => u.walletId === walletId);
      if (!user || !currentGame) {
        socket.emit('cancelBetFailed', { message: 'Cannot cancel bet at this time' });
        return;
      }

      try {
        const refundedAmount = currentGame.cancelBet(user.walletId);
        if (refundedAmount !== null) {
          user.wallet += refundedAmount;
          if (!isUserInFunMode(user)) {
            await updateUserBalance(user.walletId, user.wallet);
          }

          if (!currentGame.isGameInProgress() && !isUserInFunMode(user)) {
            await prisma.bet.deleteMany({
              where: {
                walletId: user.walletId,
                gameId: currentGame.id,
                cashoutAt: null
              }
            });
          }

          socket.emit('betCancelled', { refundedAmount, wallet: user.wallet, forNextRound });

          emitCurrentBets(io, currentGame);
        } else {
          socket.emit('cancelBetFailed', { message: 'No active bet to cancel' });
        }
      } catch (error) {
        console.error('Error cancelling bet:', error);
        socket.emit('cancelBetFailed', { message: 'Failed to cancel bet' });
      }
    });

    // Handle cashout
    socket.on('cashout', async ({ walletId }: { walletId: string }) => {
      console.log('Received cashout event');
      const user = Array.from(users.values()).find(u => u.walletId === walletId);
      if (!user) {
        console.log('Cashout failed: User not found');
        socket.emit('cashoutFailed', { message: 'User not found' });
        return;
      }
      if (!currentGame || !crashGameInstance) {
        console.log('Cashout failed: No active game');
        socket.emit('cashoutFailed', { message: 'No active game' });
        return;
      }
      if (!currentGame.isGameInProgress()) {
        console.log('Cashout failed: Game is not in progress');
        socket.emit('cashoutFailed', { message: 'Game is not in progress' });
        return;
      }

      try {
        console.log(`Attempting cashout for wallet ${user.walletId}`);
        const isSimulatedBet = walletId.startsWith('SW_') || walletId.startsWith('SIM_');

        let activeBet;
        if (!isUserInFunMode(user)) {
          activeBet = await prisma.bet.findFirst({
            where: {
              walletId: user.walletId,
              gameId: currentGame.id,
              cashoutAt: null
            }
          });

          if (!activeBet) {
            console.log(`Cashout failed for wallet ${user.walletId}: No active bet found in database`);
            socket.emit('cashoutFailed', { message: 'No active bet found' });
            return;
          }
        }

        const currentMultiplier = currentGame.getCurrentMultiplier();
        let riskMetrics;

        // Check emergency conditions before processing cashout
        if (!isUserInFunMode(user) && activeBet && !isSimulatedBet) {
          const potentialWinnings = activeBet.amount * currentMultiplier - activeBet.amount;
          console.log(`Checking potential winnings: ${potentialWinnings} for bet ${activeBet.amount} at ${currentMultiplier}x`);

          // Update crash game winnings tracking before processing cashout
          crashGameInstance.updateCurrentWinnings(
            activeBet.amount,
            currentMultiplier,
            isSimulatedBet
          );

          // Get current risk metrics
          riskMetrics = crashGameInstance.getCurrentRiskMetrics(false);
          console.log('Current risk metrics:', riskMetrics);

          // Check if emergency crash is triggered
          if (crashGameInstance.getIsEmergencyCrash()) {
            console.log('Emergency crash triggered - ending game immediately');
            const maxAllowedCrashpoint = await crashGameInstance.getMaxAllowedCrashpoint();

            // Force an immediate crash
            await currentGame.setCurrentCrashPoint(currentMultiplier);

            io.emit('emergencyCrash', {
              totalWinnings: riskMetrics.currentWinnings,
              threshold: await crashGameInstance.getEmergencyThreshold(),
              reason: 'TOTAL_WINNINGS',
              multiplier: currentMultiplier,
              maxAllowed: maxAllowedCrashpoint
            });

            endGame(io);
            return;
          }
        }

        // Process the cashout if no emergency was triggered
        const winnings = currentGame.cashout(user.walletId);
        if (winnings === null) {
          console.log(`Cashout failed for wallet ${user.walletId}: No active bet found`);
          socket.emit('cashoutFailed', { message: 'No active bet found' });
          return;
        }

        // Process the winnings
        user.wallet += winnings;
        if (!isUserInFunMode(user)) {
          // Update user balance
          await updateUserBalance(user.walletId, user.wallet);

          // Update bet record
          if (activeBet) {
            await prisma.bet.update({
              where: { id: activeBet.id },
              data: {
                cashoutAt: currentMultiplier,
                winAmount: winnings,
                profit: winnings - activeBet.amount,
                isSimulated: isSimulatedBet
              }
            });
          }

          // Log high-value cashouts (exclude simulated bets)
          if (winnings > 1000 && !isSimulatedBet) {
            await prisma.highValueTransaction.create({
              data: {
                walletId: user.walletId,
                type: 'CASHOUT',
                amount: winnings,
                gameId: currentGame.id,
                multiplier: currentMultiplier,
                isSimulated: false
              }
            });
          }
        }

        // Update risk metrics after the cashout
        if (!isSimulatedBet) {
          riskMetrics = crashGameInstance.getCurrentRiskMetrics(false);

          // Notify admins if risk level is HIGH (only for real bets)
          if (riskMetrics.riskLevel === 'HIGH') {
            io.to('admin').emit('highRiskAlert', {
              currentWinnings: riskMetrics.currentWinnings,
              distanceToThreshold: riskMetrics.distanceToThreshold,
              isSimulated: false
            });
          }
        }

        console.log(`Cashout successful for wallet ${user.walletId}: ${winnings}`);
        const cashoutData = {
          walletId: user.walletId,
          multiplier: currentMultiplier,
          amount: winnings,
          wallet: user.wallet,
          isSimulated: isSimulatedBet
        };

        // Emit success events
        socket.emit('cashoutSuccess', cashoutData);
        socket.emit('walletBalance', {
          balance: user.wallet,
          isRealMoney: user.isLoggedIn,
          clientSeed: user.clientSeed
        });

        // Update game state for all users
        emitCurrentBets(io, currentGame);

      } catch (error) {
        console.error('Error processing cashout:', error);
        socket.emit('cashoutFailed', { message: 'Failed to process cashout' });
      }
    });

    // Add these event handlers to the socketServer.ts file

socket.on('placeSecondBet', async ({ amount, walletId, forNextRound }: { amount:number, walletId: string, forNextRound: boolean }) => {
  console.log('Received placeSecondBet event:', amount, walletId, forNextRound);
  const user = Array.from(users.values()).find(u => u.walletId === walletId);
  if (!user || !currentGame) {
    console.log('Cannot place second bet: User not found or no current game');
    socket.emit('secondBetFailed', { message: 'Cannot place second bet at this time' });
    return;
  }

  if (user.wallet < amount) {
    console.log('Insufficient funds for second bet');
    socket.emit('secondBetFailed', { message: 'Insufficient funds' });
    return;
  }

  try {
    if (forNextRound || currentGame.isGameInProgress()) {
      currentGame.addSecondNextRoundBet({ walletId: user.walletId, amount });
      console.log(`Second next round bet added to GameSession for wallet ${user.walletId}: ${amount}`);

      user.wallet -= amount;
      if (!isUserInFunMode(user)) {
        await updateUserBalance(user.walletId, user.wallet);
        console.log(`User balance updated for second next round bet: ${user.wallet}`);
      }

      socket.emit('secondBetPlaced', {
        walletId: user.walletId,
        amount,
        wallet: user.wallet,
        gameHash: currentGame.getCurrentGameHash(),
        forNextRound: true
      });
    } else {
      const betPlaced = currentGame.placeSecondBet(user.walletId, amount);
      if (betPlaced) {
        user.wallet -= amount;
        if (!isUserInFunMode(user)) {
          await updateUserBalance(user.walletId, user.wallet);
          console.log(`User balance updated for second current round bet: ${user.wallet}`);
        }
        socket.emit('secondBetPlaced', {
          walletId: user.walletId,
          amount,
          wallet: user.wallet,
          gameHash: currentGame.getCurrentGameHash(),
          forNextRound: false
        });
      } else {
        socket.emit('secondBetFailed', { message: 'Failed to place second bet' });
      }
    }

    emitCurrentSecondBets(io, currentGame);

  } catch (error) {
    console.error('Error placing second bet:', error);
    socket.emit('secondBetFailed', { message: 'Failed to place second bet' });
  }
});

socket.on('cancelSecondBet', async ({ walletId, forNextRound }: { walletId: string, forNextRound: boolean }) => {
  console.log('Received cancelSecondBet event');
  const user = Array.from(users.values()).find(u => u.walletId === walletId);
  if (!user || !currentGame) {
    socket.emit('cancelSecondBetFailed', { message: 'Cannot cancel second bet at this time' });
    return;
  }

  try {
    const refundedAmount = forNextRound
      ? currentGame.cancelSecondNextRoundBet(user.walletId)
      : currentGame.cancelSecondBet(user.walletId);

    if (refundedAmount !== null) {
      user.wallet += refundedAmount;
      if (!isUserInFunMode(user)) {
        await updateUserBalance(user.walletId, user.wallet);
      }

      socket.emit('secondBetCancelled', { refundedAmount, wallet: user.wallet, forNextRound });

      emitCurrentSecondBets(io, currentGame);
    } else {
      socket.emit('cancelSecondBetFailed', { message: 'No active second bet to cancel' });
    }
  } catch (error) {
    console.error('Error cancelling second bet:', error);
    socket.emit('cancelSecondBetFailed', { message: 'Failed to cancel second bet' });
  }
});

// Second cashout handler in socketServer.ts
socket.on('secondCashout', async ({ walletId }: { walletId: string }) => {
  console.log('Received second cashout event');
  const user = Array.from(users.values()).find(u => u.walletId === walletId);
  if (!user) {
    console.log('Second cashout failed: User not found');
    socket.emit('secondCashoutFailed', { message: 'User not found' });
    return;
  }
  if (!currentGame || !crashGameInstance) {
    console.log('Second cashout failed: No active game');
    socket.emit('secondCashoutFailed', { message: 'No active game' });
    return;
  }
  if (!currentGame.isGameInProgress()) {
    console.log('Second cashout failed: Game is not in progress');
    socket.emit('secondCashoutFailed', { message: 'Game is not in progress' });
    return;
  }

  try {
    console.log(`Attempting second cashout for wallet ${user.walletId}`);
    const isSimulatedBet = walletId.startsWith('SW_') || walletId.startsWith('SIM_');
    const currentMultiplier = currentGame.getCurrentMultiplier();

    // Get active bet before processing cashout
    const activeBet = currentGame.getActiveBet(user.walletId, true);
    if (!activeBet) {
      console.log(`Second cashout failed for wallet ${user.walletId}: No active bet found`);
      socket.emit('secondCashoutFailed', { message: 'No active bet found' });
      return;
    }

    // Check emergency conditions before processing cashout
    if (!isUserInFunMode(user) && !isSimulatedBet) {
      const potentialWinnings = activeBet.amount * currentMultiplier - activeBet.amount;
      console.log(`Checking potential winnings for second bet: ${potentialWinnings} for bet ${activeBet.amount} at ${currentMultiplier}x`);

      // Update crash game winnings tracking before processing cashout
      crashGameInstance.updateCurrentWinnings(
        activeBet.amount,
        currentMultiplier,
        isSimulatedBet
      );

      // Get current risk metrics
      const riskMetrics = crashGameInstance.getCurrentRiskMetrics(false);
      console.log('Current risk metrics:', riskMetrics);

      // Check if emergency crash is triggered
      if (crashGameInstance.getIsEmergencyCrash()) {
        console.log('Emergency crash triggered from second bet - ending game immediately');
        const maxAllowedCrashpoint = await crashGameInstance.getMaxAllowedCrashpoint();

        // Force an immediate crash
        await currentGame.setCurrentCrashPoint(currentMultiplier);

        io.emit('emergencyCrash', {
          totalWinnings: riskMetrics.currentWinnings,
          threshold: await crashGameInstance.getEmergencyThreshold(),
          reason: 'TOTAL_WINNINGS',
          multiplier: currentMultiplier,
          maxAllowed: maxAllowedCrashpoint
        });

        endGame(io);
        return;
      }
    }

    // Process the second cashout if no emergency was triggered
    const winnings = currentGame.secondCashout(user.walletId);
    if (winnings === null) {
      console.log(`Second cashout failed for wallet ${user.walletId}: No active bet found`);
      socket.emit('secondCashoutFailed', { message: 'No active bet found' });
      return;
    }

    // Update user's wallet and database
    user.wallet += winnings;
    if (!isUserInFunMode(user)) {
      await updateUserBalance(user.walletId, user.wallet);

      const dbBet = await prisma.bet.findFirst({
        where: {
          walletId: user.walletId,
          gameId: currentGame.id,
          cashoutAt: null,
          isSecondBet: true
        }
      });

      if (dbBet) {
        await prisma.bet.update({
          where: { id: dbBet.id },
          data: {
            cashoutAt: currentMultiplier,
            winAmount: winnings,
            profit: winnings - dbBet.amount,
            isSimulated: isSimulatedBet
          }
        });

        if (winnings > 1000) {
          await prisma.highValueTransaction.create({
            data: {
              walletId: user.walletId,
              type: 'SECOND_CASHOUT',
              amount: winnings,
              gameId: currentGame.id,
              multiplier: currentMultiplier,
              isSimulated: false
            }
          });
        }
      }
    }

    console.log(`Second cashout successful for wallet ${user.walletId}: ${winnings}`);

    // Emit success events
    socket.emit('secondCashoutSuccess', {
      walletId: user.walletId,
      multiplier: currentMultiplier,
      amount: winnings,
      wallet: user.wallet,
      isSimulated: isSimulatedBet
    });

    socket.emit('walletBalance', {
      balance: user.wallet,
      isRealMoney: user.isLoggedIn,
      clientSeed: user.clientSeed
    });

    // Update game state for all users
    emitCurrentSecondBets(io, currentGame);

  } catch (error) {
    console.error('Error processing second cashout:', error);
    socket.emit('secondCashoutFailed', { message: 'Failed to process second cashout' });
  }
});

// Add this function to emit current second bets
function emitCurrentSecondBets(io: Server, currentGame: GameSession) {
  if (currentGame) {
    const currentSecondBets = Array.from(currentGame.getSecondBets().values()).map(bet => ({
      walletId: bet.walletId,
      amount: bet.amount,
      cashoutAt: bet.cashoutAt,
      isNextRound: false
    }));

    io.emit('currentSecondBets', currentSecondBets);
  }
}

    // Handle user bet history request
    socket.on('getUserBetHistory', async (data: { walletId?: string }) => {
      const walletId = data?.walletId || (users.get(socket.id)?.walletId);

      if (!walletId) {
        console.error('getUserBetHistory: No wallet ID provided or found');
        socket.emit('userBetHistoryError', { message: 'No wallet ID found' });
        return;
      }

      const user = Array.from(users.values()).find(u => u.walletId === walletId);
      if (user) {
        try {
          const betHistory = await prisma.bet.findMany({
            where: { walletId: user.walletId },
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: { game: true }
          });

          const formattedBetHistory = betHistory.map(bet => ({
            walletId: bet.walletId,
            amount: bet.amount,
            cashoutAt: bet.cashoutAt,
            gameId: bet.gameId,
            crashPoint: bet.game.crashPoint,
            createdAt: bet.createdAt
          }));

          socket.emit('userBetHistory', formattedBetHistory);
        } catch (error) {
          console.error('Error fetching user bet history:', error);
          socket.emit('userBetHistoryError', { message: 'Failed to fetch bet history' });
        }
      } else {
        console.error(`getUserBetHistory: User not found for wallet ID ${walletId}`);
        socket.emit('userBetHistoryError', { message: 'User not found' });
      }
    });

    // Handle top bets request
    socket.on('getTopBets', async () => {
      try {
        const topBets = await prisma.bet.findMany({
          orderBy: { amount: 'desc' },
          take: 50,
          include: { game: true, user: true }
        });

        const formattedTopBets = topBets.map(bet => ({
          walletId: bet.walletId,
          amount: bet.amount,
          cashoutAt: bet.cashoutAt,
          gameId: bet.gameId,
          crashPoint: bet.game.crashPoint,
          createdAt: bet.createdAt
        }));

        socket.emit('topBets', formattedTopBets);
      } catch (error) {
        console.error('Error fetching top bets:', error);
      }
    });


    // Add these new socket handlers for admin controls
socket.on('setMaxCrashpoint', async ({ value, walletId }: { value: number, walletId: string }) => {
  const user = Array.from(users.values()).find(u => u.walletId === walletId);
  if (!user || !user.isLoggedIn) {
    socket.emit('error', { message: 'Unauthorized' });
    return;
  }

  try {
    const dbUser = await prisma.user.findUnique({
      where: { walletId }
    });

    if (!dbUser?.isAdmin) {
      socket.emit('error', { message: 'Unauthorized' });
      return;
    }

    if (crashGameInstance) {
      await crashGameInstance.setMaxAllowedCrashpoint(value);
      socket.emit('maxCrashpointSet', { value });
    }
  } catch (error) {
    console.error('Error setting max crashpoint:', error);
    socket.emit('error', { message: 'Failed to set max crashpoint' });
  }
});

socket.on('toggleMaxCrashpoint', async ({ enabled, walletId }: { enabled: boolean, walletId: string }) => {
  const user = Array.from(users.values()).find(u => u.walletId === walletId);
  if (!user || !user.isLoggedIn) {
    socket.emit('error', { message: 'Unauthorized' });
    return;
  }

  try {
    const dbUser = await prisma.user.findUnique({
      where: { walletId }
    });

    if (!dbUser?.isAdmin) {
      socket.emit('error', { message: 'Unauthorized' });
      return;
    }

    if (crashGameInstance) {
      await crashGameInstance.setEnforceMaxCrashpoint(enabled);
      socket.emit('maxCrashpointEnforcement', { enabled });
    }
  } catch (error) {
    console.error('Error toggling max crashpoint enforcement:', error);
    socket.emit('error', { message: 'Failed to toggle max crashpoint enforcement' });
  }
});



    // Handle game state request
    socket.on('getGameState', () => {
      if (currentGame) {
        socket.emit('gameState', {
          ...currentGame.getGameState(),
          gameId: currentGame.id
        });
      }
    });

    // Handle current bets request
    socket.on('getCurrentBets', () => {
      if (currentGame) {
        emitCurrentBets(io, currentGame);
        emitCurrentSecondBets(io, currentGame);
      }
    });


    // Handle disconnection
    socket.on('disconnect', () => {
      const user = users.get(socket.id);
      console.log(`Client disconnected: ${socket.id}${user ? ` (Wallet ${user.walletId})` : ''}`);
      users.delete(socket.id);
      onlineUsers.delete(socket.id);
    });

// Handle disconnection
socket.on('disconnect', () => {
  const user = users.get(socket.id);
  if (user?.activeMinesGame) {
    user.activeMinesGame = undefined;
  }
  console.log(`Client disconnected: ${socket.id}${user ? ` (Wallet ${user.walletId})` : ''}`);
  users.delete(socket.id);
  onlineUsers.delete(socket.id);
});



  });

  startNewGame(io);

  setInterval(() => emitOnlineUsersCount(io), 5000);
}

// Add this function before runGame in socketServer.ts
async function checkEmergencyConditions(
  currentGame: GameSession,
  crashGameInstance: CrashGame,
  currentMultiplier: number
): Promise<{ shouldCrash: boolean; reason: 'POTENTIAL_WINNINGS' | 'MAX_CRASHPOINT' | 'PROBABLE_WIN' | 'TOTAL_WON' | 'BET_BASED' | null }> {
  // Get all active bets (both first and second bets)
  const activeBets = Array.from(currentGame.getBets().values())
    .filter(bet => bet.cashoutAt === null && !bet.walletId.startsWith('SW_') && !bet.walletId.startsWith('SIM_'));

  const activeSecondBets = Array.from(currentGame.getSecondBets().values())
    .filter(bet => bet.cashoutAt === null && !bet.walletId.startsWith('SW_') && !bet.walletId.startsWith('SIM_'));

  const hasRealPlayers = [...activeBets, ...activeSecondBets].length > 0;

  // Get all thresholds
  const maxAllowedCrashpoint = await crashGameInstance.getMaxAllowedCrashpoint();
  const isEnforceMaxCrashpoint = await crashGameInstance.isEnforceMaxCrashpointEnabled();
  const { threshold: probableWinThreshold, enabled: isProbableWinEnabled } = await crashGameInstance.getProbableWinSettings();
  const totalWonEmergency = parseFloat((await prisma.gameSettings.findUnique({ where: { key: 'totalWonEmergency' } }))?.value || '200');

  // Calculate total potential winnings
  let totalPotentialWinnings = 0;
  for (const bet of [...activeBets, ...activeSecondBets]) {
    const potentialWinAmount = bet.amount * currentMultiplier;
    const potentialNetWin = potentialWinAmount - bet.amount;
    totalPotentialWinnings += potentialNetWin;
  }

  // 1. Check if bet-based crash point management is enabled and should crash
  const betBasedSettings = await crashGameInstance.getBetBasedSettings();
  if (betBasedSettings.enabled && hasRealPlayers) {
    // Prepare bets for bet-based calculation
    const allBets = [...activeBets, ...activeSecondBets].map(bet => ({
      amount: bet.amount,
      walletId: bet.walletId
    }));

    // Calculate potential house profit at current multiplier
    const totalBetAmount = allBets.reduce((sum, bet) => sum + bet.amount, 0);
    const potentialPayout = allBets.reduce((sum, bet) => sum + (bet.amount * currentMultiplier), 0);
    const currentHouseProfit = totalBetAmount - potentialPayout;
    const currentHouseProfitPercentage = (currentHouseProfit / totalBetAmount) * 100;

    // Calculate the target bet-based crash point
    const betBasedCrashPoint = crashGameInstance.calculateBetBasedCrashPoint(allBets);

    if (betBasedCrashPoint > 0 && currentMultiplier >= betBasedCrashPoint) {
      // Calculate the target profit
      const targetProfit = totalBetAmount * (betBasedSettings.houseEdgePercentage / 100);

      // Calculate the theoretical crash point using the formula: totalBetAmount / targetProfit
      const theoreticalCrashPoint = totalBetAmount / targetProfit;

      console.log(`\n=== BET-BASED CRASH TRIGGERED ===`);
      console.log(`Current multiplier: ${currentMultiplier.toFixed(2)}x reached calculated crash point: ${betBasedCrashPoint.toFixed(2)}x`);
      console.log(`Total bet amount: ${totalBetAmount}`);
      console.log(`Target house edge: ${betBasedSettings.houseEdgePercentage}%`);
      console.log(`Target house profit: ${(totalBetAmount * betBasedSettings.houseEdgePercentage / 100).toFixed(2)}`);
      console.log(`Calculation formula: totalBetAmount ÷ targetProfit`);
      console.log(`Theoretical crash point: ${totalBetAmount} ÷ ${targetProfit.toFixed(2)} = ${theoreticalCrashPoint.toFixed(2)}`);
      console.log(`Actual crash point used: ${betBasedCrashPoint.toFixed(2)}`);
      console.log(`Current house profit: ${currentHouseProfit.toFixed(2)} (${currentHouseProfitPercentage.toFixed(2)}%)`);
      console.log(`Active bets: ${allBets.length}`);
      console.log(`================================\n`);

      await currentGame.setCurrentCrashPoint(currentMultiplier);
      return { shouldCrash: true, reason: 'BET_BASED' };
    }
  }

  // 2. Check max crashpoint if enabled
  if (isEnforceMaxCrashpoint && hasRealPlayers && currentMultiplier >= maxAllowedCrashpoint) {
    console.log(`Emergency crash triggered - multiplier ${currentMultiplier} reached max allowed ${maxAllowedCrashpoint}`);
    await currentGame.setCurrentCrashPoint(currentMultiplier);
    return { shouldCrash: true, reason: 'MAX_CRASHPOINT' };
  }

  // 3. Check probable win threshold if enabled
  if (isProbableWinEnabled && hasRealPlayers && totalPotentialWinnings >= probableWinThreshold) {
    console.log(`Emergency crash triggered - probable win ${totalPotentialWinnings} exceeds threshold ${probableWinThreshold}`);
    await currentGame.setCurrentCrashPoint(currentMultiplier);
    return { shouldCrash: true, reason: 'PROBABLE_WIN' };
  }

  // 4. Check current game total winnings threshold
  if (crashGameInstance.wouldTriggerEmergencyCrash(totalPotentialWinnings)) {
    console.log(`Emergency crash triggered - potential winnings ${totalPotentialWinnings} would exceed threshold`);
    await currentGame.setCurrentCrashPoint(currentMultiplier);

    // Update current winnings
    for (const bet of [...activeBets, ...activeSecondBets]) {
      crashGameInstance.updateCurrentWinnings(bet.amount, currentMultiplier, false);
    }

    return { shouldCrash: true, reason: 'POTENTIAL_WINNINGS' };
  }

  // 5. Check total won emergency threshold
  const riskMetrics = crashGameInstance.getCurrentRiskMetrics(false);
  if (riskMetrics.currentWinnings >= totalWonEmergency) {
    console.log(`Emergency crash triggered - total won ${riskMetrics.currentWinnings} exceeds emergency threshold ${totalWonEmergency}`);
    await currentGame.setCurrentCrashPoint(currentMultiplier);
    return { shouldCrash: true, reason: 'TOTAL_WON' };
  }

  return { shouldCrash: false, reason: null };
}

async function runGame(io: Server): Promise<void> {
  if (!currentGame || !crashGameInstance) return;

  const gameInstance = currentGame; // Keep reference to current game
  const crashInstance = crashGameInstance; // Keep reference to crash instance

  gameInstance.startGame();
  console.log('Game started. Moving next round bets to current bets.');

  // Reset emergency crash state for new game
  crashInstance.resetGameWinnings();

  // Move bets to current round
  gameInstance.moveNextRoundBetsToCurrent();
  gameInstance.moveSecondNextRoundBetsToCurrent();

  // Calculate total bet amount for monitoring
  const currentBets = gameInstance.getBets();
  const totalBetAmount = Array.from(currentBets.values())
    .reduce((sum, bet) => sum + bet.amount, 0);

  // Emit initial game state
  emitCurrentBets(io, gameInstance);
  emitCurrentSecondBets(io, gameInstance);

  const initialGameState = gameInstance.getGameState();
  io.emit('gameState', {
    ...initialGameState,
    gameId: gameInstance.id,
    totalBetAmount,
    riskMetrics: crashInstance.getCurrentRiskMetrics()
  });

  io.emit('gameStarted');

  // Track last risk notification to prevent spam
  let lastRiskNotification = Date.now();
  const RISK_NOTIFICATION_COOLDOWN = 5000; // 5 seconds

  const gameInterval = setInterval(async () => {
    // Use local references instead of global
    if (!gameInstance.isGameInProgress()) {
      clearInterval(gameInterval);
      endGame(io);
      return;
    }

    try {
      gameInstance.updateMultiplier();
      const currentMultiplier = gameInstance.getCurrentMultiplier();

      // Get all active bets (excluding cashed out bets)
      const activeBets = Array.from(gameInstance.getBets().values())
        .filter(bet => bet.cashoutAt === null)
        .map(bet => ({
          amount: bet.amount,
          walletId: bet.walletId
        }));

      const activeSecondBets = Array.from(gameInstance.getSecondBets().values())
        .filter(bet => bet.cashoutAt === null)
        .map(bet => ({
          amount: bet.amount,
          walletId: bet.walletId
        }));

      const allActiveBets = [...activeBets, ...activeSecondBets];
      const hasActivePlayers = allActiveBets.length > 0;

      // Use the checkEmergencyConditions function to check all emergency conditions
      const emergencyCheck = await checkEmergencyConditions(gameInstance, crashInstance, currentMultiplier);

      if (emergencyCheck.shouldCrash) {
        console.log(`Emergency crash triggered - reason: ${emergencyCheck.reason} at multiplier ${currentMultiplier}`);

        // Prepare emergency crash info based on reason
        let emergencyCrashInfo: any = {
          multiplier: currentMultiplier,
          reason: emergencyCheck.reason
        };

        // Add specific details based on the reason
        if (emergencyCheck.reason === 'MAX_CRASHPOINT') {
          const maxAllowedCrashpoint = await crashInstance.getMaxAllowedCrashpoint();
          emergencyCrashInfo.maxAllowed = maxAllowedCrashpoint;
        }
        else if (emergencyCheck.reason === 'POTENTIAL_WINNINGS') {
          const emergencyThreshold = await crashInstance.getEmergencyThreshold();
          const riskMetrics = crashInstance.getCurrentRiskMetrics();

          // Calculate total potential winnings
      let totalPotentialWinnings = 0;
      for (const bet of allActiveBets) {
        if (!bet.walletId.startsWith('SW_') && !bet.walletId.startsWith('SIM_')) {
          const potentialWinAmount = bet.amount * currentMultiplier;
          const potentialNetWin = potentialWinAmount - bet.amount;
          totalPotentialWinnings += potentialNetWin;
        }
      }

          emergencyCrashInfo.threshold = emergencyThreshold;
          emergencyCrashInfo.currentWinnings = riskMetrics.currentWinnings;
          emergencyCrashInfo.potentialWinnings = totalPotentialWinnings;
        }
        else if (emergencyCheck.reason === 'PROBABLE_WIN') {
          const { threshold } = await crashInstance.getProbableWinSettings();
          emergencyCrashInfo.threshold = threshold;
        }
        else if (emergencyCheck.reason === 'TOTAL_WON') {
          const totalWonEmergency = parseFloat((await prisma.gameSettings.findUnique({ where: { key: 'totalWonEmergency' } }))?.value || '200');
          emergencyCrashInfo.threshold = totalWonEmergency;
        }
        else if (emergencyCheck.reason === 'BET_BASED') {
          const betBasedSettings = await crashInstance.getBetBasedSettings();

          // Calculate more detailed metrics for bet-based crashes
          const activeBets = [...Array.from(gameInstance.getBets().values()), ...Array.from(gameInstance.getSecondBets().values())]
            .filter(bet => bet.cashoutAt === null && !bet.walletId.startsWith('SW_') && !bet.walletId.startsWith('SIM_'))
            .map(bet => ({
              amount: bet.amount,
              walletId: bet.walletId
            }));

          const totalBetAmount = activeBets.reduce((sum, bet) => sum + bet.amount, 0);
          const targetProfit = totalBetAmount * (betBasedSettings.houseEdgePercentage / 100);

          // Calculate theoretical crash point using the formula: totalBetAmount / targetProfit
          const theoreticalCrashPoint = totalBetAmount / targetProfit;

          // For minimum crash point handling
          const minCrashPoint = betBasedSettings.minCrashPoint;
          let finalCrashPoint = theoreticalCrashPoint;

          // Check if we need to apply minimum crash point logic
          if (theoreticalCrashPoint < minCrashPoint) {
            finalCrashPoint = minCrashPoint + theoreticalCrashPoint;
            console.log(`Adding theoretical point to minimum: ${minCrashPoint} + ${theoreticalCrashPoint.toFixed(2)} = ${finalCrashPoint.toFixed(2)}`);
          }

          const potentialPayout = activeBets.reduce((sum, bet) => sum + (bet.amount * finalCrashPoint), 0);
          const actualProfit = totalBetAmount - potentialPayout;
          const actualProfitPercentage = (actualProfit / totalBetAmount) * 100;

          console.log(`\n=== BET-BASED EMERGENCY CRASH DETAILS ===`);
          console.log(`Formula: totalBetAmount ÷ targetProfit`);
          console.log(`Theoretical calculation: ${totalBetAmount} ÷ ${targetProfit.toFixed(2)} = ${theoreticalCrashPoint.toFixed(2)}`);
          console.log(`Final crash point: ${finalCrashPoint.toFixed(2)}`);
          console.log(`Total bet amount: ${totalBetAmount}`);
          console.log(`Target house edge: ${betBasedSettings.houseEdgePercentage}%`);
          console.log(`Target profit: ${targetProfit.toFixed(2)} (${betBasedSettings.houseEdgePercentage}%)`);
          console.log(`Theoretical player return: ${((1 / theoreticalCrashPoint) * 100).toFixed(2)}%`);
          console.log(`Actual crash point: ${currentMultiplier.toFixed(2)}x`);
          console.log(`Actual profit: ${actualProfit.toFixed(2)} (${actualProfitPercentage.toFixed(2)}%)`);
          console.log(`==========================================\n`);

          emergencyCrashInfo = {
            totalBetAmount,
            totalBets: activeBets.length,
            targetProfit,
            targetProfitPercentage: betBasedSettings.houseEdgePercentage,
            actualProfit,
            actualProfitPercentage,
            potentialPayout,
            theoreticalCrashPoint,
            finalCrashPoint,
            minCrashPoint,
            formulaDescription: 'totalBetAmount ÷ targetProfit',
            calculationDetail: `${totalBetAmount} ÷ ${targetProfit.toFixed(2)} = ${theoreticalCrashPoint.toFixed(2)}`
          };
        }

        io.emit('emergencyCrash', emergencyCrashInfo);

        clearInterval(gameInterval);
        await endGame(io);
        return;
      }

      // Get current risk metrics
      const riskMetrics = crashInstance.getCurrentRiskMetrics();

      // Calculate total potential winnings for metrics
      let totalPotentialWinnings = 0;
      for (const bet of allActiveBets) {
        if (!bet.walletId.startsWith('SW_') && !bet.walletId.startsWith('SIM_')) {
          const potentialWinAmount = bet.amount * currentMultiplier;
          const potentialNetWin = potentialWinAmount - bet.amount;
          totalPotentialWinnings += potentialNetWin;
        }
      }

      // Notify admins of high risk (with cooldown)
      if (riskMetrics.riskLevel === 'HIGH' &&
          Date.now() - lastRiskNotification > RISK_NOTIFICATION_COOLDOWN) {
        io.to('admin').emit('highRiskAlert', {
          multiplier: currentMultiplier,
          ...riskMetrics,
          totalPotentialWinnings,
          activeBets: allActiveBets.length
        });
        lastRiskNotification = Date.now();
      }

      // Emit current game state
      const gameState = gameInstance.getGameState();
      io.emit('gameState', {
        ...gameState,
        gameId: gameInstance.id,
        riskMetrics: {
          ...riskMetrics,
          totalPotentialWinnings,
          activeBets: allActiveBets.length
        }
      });

      // Handle bet simulation if enabled
      if (betSimulator) {
        await betSimulator.simulateCashouts(gameInstance, currentMultiplier);

        // Randomly simulate next round bets with risk awareness
        if (Math.random() < 0.1 && riskMetrics.riskLevel !== 'HIGH') {
          await betSimulator.simulateNextRoundBets(gameInstance);
        }
      }

      // Check if game should end normally
      const crashPoint = await crashInstance.getCurrentCrashPoint();
      if (!gameInstance.isGameInProgress() || currentMultiplier >= crashPoint) {
        console.log(`Game ending at multiplier ${currentMultiplier}, crash point ${crashPoint}`);
        clearInterval(gameInterval);
        await endGame(io);
      }
    } catch (error) {
      console.error('Error during game tick:', error);
    }
  }, 100);
}

export async function handleMpesaCallback(callbackData: any) {
  const { Body } = callbackData;

  // Handle different callback types
  if (Body.stkCallback.ResultCode === 0) {
    if (Body.stkCallback.CheckoutRequestID.startsWith('AFF_')) {
      // Handle affiliate withdrawal callback
      await handleAffiliateWithdrawalCallback(callbackData, io);
    } else {
      // Handle regular deposit callback
      const amount = Body.stkCallback.CallbackMetadata.Item.find((item: any) => item.Name === 'Amount').Value;
      const phoneNumber = Body.stkCallback.CallbackMetadata.Item.find((item: any)=> item.Name === 'PhoneNumber').Value.toString();
      const mpesaReceiptNumber = Body.stkCallback.CallbackMetadata.Item.find((item: any) => item.Name === 'MpesaReceiptNumber').Value;
      const transactionDate = Body.stkCallback.CallbackMetadata.Item.find((item: any) => item.Name === 'TransactionDate').Value;

      try {
        const user = await prisma.user.findUnique({ where: { phoneNumber } });
        if (user) {
          await prisma.$transaction(async (tx) => {
            // Update user's balance
            await tx.user.update({
              where: { id: user.id },
              data: { balance: { increment: amount } }
            });

            // Create deposit record
            await tx.deposit.create({
              data: {
                userId: user.id,
                walletId: user.walletId,
                amount: amount,
                phoneNumber: phoneNumber,
                businessShortCode: process.env.MPESA_BUSINESS_SHORTCODE || '',
                mpesaReceiptNumber,
                transactionDate: new Date(transactionDate),
                status: 'COMPLETED'
              }
            });
          });

          // Process affiliate earnings
          await processAffiliateEarnings(user.id, amount);

          // Process deposit cashback bonus
          const depositBonusAmount = await processDepositCashbackBonus(user.id, amount);
          const finalBalance = user.balance + amount + depositBonusAmount; // Calculate final balance including deposit and bonus

          // Emit success event
          const socket = Array.from(io.sockets.sockets.values()).find(
            (s) => (s as any).user?.id === user.id
          );
          if (socket) {
            socket.emit('depositSuccess', {
              amount,
              mpesaReceiptNumber,
              newBalance: finalBalance // Send updated balance including bonus
            });

             if (depositBonusAmount > 0) {
              socket.emit('bonusReceived', {
                type: BonusType.DEPOSIT_CASHBACK,
                amount: depositBonusAmount,
                message: `You received a ${depositBonusAmount.toFixed(2)} KES deposit cashback bonus!`
              });
              // Update the in-memory user object's balance again to reflect the bonus
              const userInMemory = users.get(socket.id);
              if(userInMemory) {
                userInMemory.wallet = finalBalance;
                userInMemory.balance = finalBalance;
                 // Re-emit wallet balance after bonus
                 socket.emit('walletBalance', {
                   balance: userInMemory.wallet,
                   isRealMoney: userInMemory.isLoggedIn,
                   clientSeed: userInMemory.clientSeed
                 });
              }
            }
          }
        }
      } catch (error) {
        console.error('Error processing M-Pesa callback:', error);
      }
    }
  }
}

async function endGame(io: Server): Promise<void> {
  if (!currentGame) return;

  // Store game instance before nullifying global reference
  const gameInstance = currentGame;
  const nextRoundBets = gameInstance.getNextRoundBets();
  const secondNextRoundBets = gameInstance.getSecondNextRoundBets();

  gameInstance.endGame();
  io.emit('gameState', {
    ...gameInstance.getGameState(),
    gameId: gameInstance.id
  });

  const finalCrashPoint = await crashGameInstance?.getCurrentCrashPoint() || 1;
  console.log(`Game ended. Crash Point: ${finalCrashPoint}`);

  io.emit('currentBets', []);
  io.emit('currentSecondBets', []);

  try {
    await prisma.game.update({
      where: { id: gameInstance.id },
      data: { endTime: new Date() }
    });

    if (betSimulator) {
      betSimulator.resetSimulation();
    }

    // Store next round bets in buffer
    nextRoundBetsBuffer = [
      ...nextRoundBets.map(bet => ({ ...bet, isSecondBet: false })),
      ...secondNextRoundBets.map(bet => ({ ...bet, isSecondBet: true }))
    ];
    console.log(`Stored ${nextRoundBetsBuffer.length} next round bets in buffer`);

    // Track round results to update the offset amount
    if (crashGameInstance) {
      // Get all bets (both primary and secondary) with their cashout status
      const allBets = [
        ...Array.from(gameInstance.getBets().values()).map(bet => ({
          walletId: bet.walletId,
          amount: bet.amount,
          cashoutAt: bet.cashoutAt
        })),
        ...Array.from(gameInstance.getSecondBets().values()).map(bet => ({
          walletId: bet.walletId,
          amount: bet.amount,
          cashoutAt: bet.cashoutAt
        }))
      ];

      // Update the offset amount based on round results
      await crashGameInstance.trackRoundResults(allBets, finalCrashPoint);

      // Get updated offset amount and emit to admin clients
      const betBasedSettings = await crashGameInstance.getBetBasedSettings();
      io.to('admin').emit('betBasedOffsetUpdated', {
        offsetAmount: betBasedSettings.betBasedOffsetAmount,
        enabled: betBasedSettings.enabled,
        houseEdgePercentage: betBasedSettings.houseEdgePercentage
      });
    }

  } catch (error) {
    console.error('Failed to update game or process bets:', error);
  }

  // --- Check Streak Bonuses ---
  try {
    const participatingUserIds = new Set<string>();
    gameInstance.getBets().forEach(bet => {
      const user = Array.from(users.values()).find(u => u.walletId === bet.walletId);
      if (user && !isUserInFunMode(user)) {
        participatingUserIds.add(user.id);
      }
    });
     gameInstance.getSecondBets().forEach(bet => {
      const user = Array.from(users.values()).find(u => u.walletId === bet.walletId);
      if (user && !isUserInFunMode(user)) {
        participatingUserIds.add(user.id);
      }
    });


    for (const userId of participatingUserIds) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) continue;

      // Check Losing Streak
      const losingBonus = await checkLosingStreakBonus(userId);
      if (losingBonus > 0) {
        const socket = Array.from(io.sockets.sockets.values()).find(
          (s) => (s as any).user?.id === userId
        );
        if (socket) {
           const updatedUser = await prisma.user.findUnique({ where: { id: userId } });
           socket.emit('bonusReceived', {
            type: BonusType.LOSING_STREAK,
            amount: losingBonus,
            message: `You received a ${losingBonus.toFixed(2)} KES losing streak bonus!`
          });
           socket.emit('walletBalance', { balance: updatedUser?.balance }); // Update client balance
        }
      }

      // Check Winning Streak
      const winningBonus = await checkWinningStreakBonus(userId);
      if (winningBonus > 0) {
         const socket = Array.from(io.sockets.sockets.values()).find(
          (s) => (s as any).user?.id === userId
        );
        if (socket) {
           const updatedUser = await prisma.user.findUnique({ where: { id: userId } });
           socket.emit('bonusReceived', {
            type: BonusType.WINNING_STREAK,
            amount: winningBonus,
            message: `You received a ${winningBonus.toFixed(2)} KES winning streak bonus!`
          });
           socket.emit('walletBalance', { balance: updatedUser?.balance }); // Update client balance
        }
      }
    }
  } catch (bonusError) {
    console.error('Error checking streak bonuses:', bonusError);
  }
  // --- End Check Streak Bonuses ---


  // Only nullify current game after processing everything
  currentGame = null;

  // Start new game after a delay
  setTimeout(() => startNewGame(io), 2000);
}

async function getNextRoundId(): Promise<number> {
  // Use a transaction to ensure atomic increment
  const result = await prisma.$transaction(async (tx) => {
    const counter = await tx.gameCounter.upsert({
      where: { id: 'game_counter' },
      update: { lastRoundId: { increment: 1 }, updatedAt: new Date() },
      create: { id: 'game_counter', lastRoundId: 1 },
    });

    // Verify the round ID is not already used
    const existingGame = await tx.game.findUnique({
      where: { roundId: counter.lastRoundId },
    });

    if (existingGame) {
      // If somehow the ID is already used, increment again
      return (await tx.gameCounter.update({
        where: { id: 'game_counter' },
        data: { lastRoundId: { increment: 1 }, updatedAt: new Date() },
      })).lastRoundId;
    }

    return counter.lastRoundId;
  });

  return result;
}



async function startNewGame(io: Server): Promise<void> {
  console.log("Starting new game...");
  try {
    const salt = crypto.randomBytes(16).toString('hex');

    if (!crashGameInstance) {
      crashGameInstance = new CrashGame();
      await crashGameInstance.generateNextRounds(lastGameHash);
    } else {
      await crashGameInstance.advanceToNextRound();
    }

    // Get next round ID safely
    const roundId = await getNextRoundId();
    let crashPoint = await crashGameInstance.getCurrentCrashPoint();
    const gameHash = crypto.randomBytes(16).toString('hex');

    // Process next round bets for bet-based crash point management
    const betBasedSettings = await crashGameInstance.getBetBasedSettings();

    // Check if we should apply bet-based crash point management for this game
    if (betBasedSettings.enabled && nextRoundBetsBuffer.length > 0) {
      console.log(`Checking bet-based crash point management. ${nextRoundBetsBuffer.length} next round bets available.`);

      // Extract bets data for calculation
      const betsForCalculation = nextRoundBetsBuffer.map(bet => ({
        amount: bet.amount,
        walletId: bet.walletId
      }));

      // Calculate bet-based crash point
      const betBasedCrashPoint = crashGameInstance.calculateBetBasedCrashPoint(betsForCalculation);

      // If a valid bet-based crash point was calculated, override the current one
      if (betBasedCrashPoint > 0) {
        console.log(`Applying bet-based crash point: ${betBasedCrashPoint} (original: ${crashPoint})`);
        crashPoint = betBasedCrashPoint;
        await crashGameInstance.setCurrentCrashPoint(betBasedCrashPoint);
      } else {
        console.log(`No bet-based crash point applied, using original: ${crashPoint}`);
      }
    }

    console.log("Creating new game in database...");
    const newGame = await prisma.game.create({
      data: {
        id: uuidv4(),
        roundId: roundId,
        gameHash: gameHash,
        crashPoint: crashPoint,
        salt: salt,
        clientSeed: clientSeed,
        serverSeed: gameHash,
        houseEdge: await crashGameInstance.getHouseEdge(),
        startTime: new Date(Date.now() + 5000),
      }
    });
    console.log(`New game created in database with ID: ${newGame.id}, Round ID: ${roundId}`);

    console.log(`Processing ${nextRoundBetsBuffer.length} next round bets from buffer...`);
    for (const bet of nextRoundBetsBuffer) {
      try {
        const user = Array.from(users.values()).find(u => u.walletId === bet.walletId);
        if (user && !isUserInFunMode(user)) {
          const newBet = await prisma.bet.create({
            data: {
              userId: user.id,
              walletId: user.walletId,
              amount: bet.amount,
              gameId: newGame.id,
              isSecondBet: bet.isSecondBet
            }
          });
          console.log(`Next round bet saved to database for wallet ${bet.walletId}: ${bet.amount}, Bet ID: ${newBet.id}, Is Second Bet: ${bet.isSecondBet}`);
        } else {
          console.log(`Skipped saving bet to database for fun mode user ${bet.walletId}: ${bet.amount}, Is Second Bet: ${bet.isSecondBet}`);
        }
      } catch (error) {
        console.error('Error saving next round bet to database:', error);
      }
    }

    // Get the next crash point for the future game
    const [nextCrashPoint] = await prisma.futureCrashPoint.findMany({
      where: { isUsed: false },
      orderBy: { roundId: 'asc' },
      take: 1
    });

    console.log("Creating new GameSession...");
    currentGame = new GameSession(
      newGame.id,
      gameHash,
      crashPoint,
      salt,
      clientSeed,
      nextCrashPoint?.roundId-1 || roundId -1
    );

    if (!currentGame) {
      throw new Error('Failed to create new game session');
    }

    if (betSimulator) {
      betSimulator.simulateBetsForNewGame(currentGame);
    }

    // Add buffered bets to the new game
    for (const bet of nextRoundBetsBuffer) {
      if (bet.isSecondBet) {
        currentGame.placeSecondBet(bet.walletId, bet.amount);
      } else {
        currentGame.placeBet(bet.walletId, bet.amount);
      }
    }
    console.log(`Added ${nextRoundBetsBuffer.length} buffered bets to new game session`);

    // Clear the buffer after processing
    nextRoundBetsBuffer = [];

    console.log(`New game starting. Hash: ${currentGame.getCurrentGameHash()}, Crash Point: ${crashPoint}`);

    // Reveal the server seed from the previous game
    io.emit('revealServerSeed', {
      gameHash: lastGameHash,
      serverSeed: gameHash,
      houseEdge: await crashGameInstance.getHouseEdge()
    });

    // Update the last game hash for the next round
    lastGameHash = currentGame.getCurrentGameHash();

    // Start countdown to game begin
    let countdown = 5000;
    const countdownInterval = setInterval(() => {
      if (countdown <= 0) {
        clearInterval(countdownInterval);
        runGame(io);
      } else if (currentGame) {
        io.emit('gameState', {
          ...currentGame.getGameState(),
          state: 'WAITING',
          countdown: countdown,
          roundId: currentGame,
          gameId: currentGame.id
        });
        countdown -= 1000;
      } else {
        clearInterval(countdownInterval);
        console.error('Game session was unexpectedly null during countdown');
      }
    }, 1000);

  } catch (error) {
    console.error('Error starting new game:', error);

    // Cleanup any partial game state
    currentGame = null;
    nextRoundBetsBuffer = [];

    // Attempt to recover by starting a new game after a delay
    setTimeout(() => {
      console.log('Attempting to recover from failed game start...');
      startNewGame(io);
    }, 1000);
  }
}



function emitOnlineUsersCount(io: Server) {
  const totalOnline = onlineUsers.size;
  const loggedInUsers = Array.from(onlineUsers.values()).filter(user => user.isLoggedIn).length;
  const funModeUsers = totalOnline - loggedInUsers;

  io.emit('onlineUsersCount', { total: totalOnline, loggedIn: loggedInUsers, funMode: funModeUsers });
}

export function getCurrentGame(): GameSession | null {
  return currentGame;
}

export function getCrashGameInstance(): CrashGame | null {
  return crashGameInstance;
}

export function getUsers(): Map<string, User> {
  return users;
}

async function handleMpesaDeposit(data: any) {
  const { Body } = data;
  if (Body.stkCallback.ResultCode === 0) {
    // Extract data from callback
    const amount = Body.stkCallback.CallbackMetadata.Item.find((item: any) => item.Name === 'Amount').Value;
    const phoneNumber = Body.stkCallback.CallbackMetadata.Item.find((item: any)=> item.Name === 'PhoneNumber').Value;
    const mpesaReceiptNumber = Body.stkCallback.CallbackMetadata.Item.find((item: any) => item.Name === 'MpesaReceiptNumber').Value;
    const transactionDate = Body.stkCallback.CallbackMetadata.Item.find((item: any) => item.Name === 'TransactionDate').Value;

    const user = Array.from(users.values()).find(u => u.phoneNumber === phoneNumber.toString());

    if (user) {
      try {
        await prisma.$transaction(async (prismaClient) => {
          // Update user balance and create deposit record
          user.wallet += amount;
          await updateUserBalance(user.walletId, user.wallet);

          const deposit = await prismaClient.deposit.create({
            data: {
              userId: user.id,
              walletId: user.walletId,
              amount: amount,
              phoneNumber: phoneNumber.toString(),
              businessShortCode: process.env.MPESA_BUSINESS_SHORTCODE || '',
              mpesaReceiptNumber: mpesaReceiptNumber,
              transactionDate: new Date(transactionDate),
              status: 'COMPLETED',
              merchantRequestID: '',
              checkoutRequestID: '',
              resultCode: Body.stkCallback.ResultCode.toString(),
              resultDesc: Body.stkCallback.ResultDesc || ''
            }
          });
        });

        // Process affiliate earnings using the service
        await processAffiliateEarnings(user.id, amount);

        // Process deposit cashback bonus
        const depositBonusAmount = await processDepositCashbackBonus(user.id, amount);
        const finalBalance = user.wallet; // Balance already updated in transaction

        // Notify user of success and bonus
        io.to(user.walletId).emit('depositSuccess', {
          amount,
          mpesaReceiptNumber,
          newBalance: finalBalance // Send updated balance including bonus
        });

        if (depositBonusAmount > 0) {
           // Fetch the user again to get the balance *after* the bonus was added by the service
           const userAfterBonus = await prisma.user.findUnique({ where: { id: user.id } });
           const bonusFinalBalance = userAfterBonus?.balance || finalBalance;

          io.to(user.walletId).emit('bonusReceived', {
            type: BonusType.DEPOSIT_CASHBACK,
            amount: depositBonusAmount,
            message: `You received a ${depositBonusAmount.toFixed(2)} KES deposit cashback bonus!`
          });
          // Update the in-memory user object's balance again to reflect the bonus
          user.wallet = bonusFinalBalance;
          user.balance = bonusFinalBalance;
           // Re-emit wallet balance after bonus
           io.to(user.walletId).emit('walletBalance', {
             balance: user.wallet,
             isRealMoney: user.isLoggedIn,
             clientSeed: user.clientSeed
           });
        }

      } catch (error) {
        console.error('Error processing deposit:', error);
        // Consider notifying user of error or implementing retry logic
        io.to(user.walletId).emit('depositError', {
          message: 'Error processing your deposit. Please contact support.'
        });
      }
    }
  }
}

// Move this outside of setupSocketServer
async function handleAffiliateWithdrawalSuccess(callbackData: any) {
  const { withdrawalRequestId } = callbackData;

  try {
    await processSuccessfulAffiliateWithdrawal(withdrawalRequestId);

    // Find the user and notify them
    const user = await prisma.user.findFirst({
      where: {
        withdrawalRequests: {
          some: { id: withdrawalRequestId }
        }
      }
    });

    if (user) {
      const socket = Array.from(io.sockets.sockets.values()).find(
        (s) => (s as any).user?.id === user.id
      );

      if (socket) {
        socket.emit('affiliateWithdrawalComplete', {
          message: 'Your affiliate withdrawal has been processed successfully'
        });
        socket.emit('getAffiliateStats');
      }
    }
  } catch (error) {
    console.error('Error processing affiliate withdrawal success:', error);
  }
}
