import express from 'express';
import { PrismaClient } from '@prisma/client';
import { Server as SocketIOServer } from 'socket.io';
import { getCurrentGame, updateUserBalance, getUsers, getOnlineUsersStats, getCrashGameInstance } from './socketServer.js';
import { CrashGame } from './crashGame.js';
import axios from 'axios';
import moment from 'moment';
import fs from 'fs';
import { initiateSTKPush, b2cPaymentRequest, querySTKPush, accountBalanceQuery, transactionStatusQuery } from './src/utils/mpesaUtils.js';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  BonusType,
  getBonusSettings,
  updateBonusSettings,
  getUserBonusHistory
} from './services/bonusService.js'; // Added bonus service imports



dotenv.config();

const router = express.Router();
const prisma = new PrismaClient();

let io: SocketIOServer;

export const initializeSocketIO = (socketIoServer: SocketIOServer) => {
  io = socketIoServer;
};

interface User {
  id: string;
  walletId: string;
  wallet: number;
  isLoggedIn: boolean;
  phoneNumber?: string;
  clientSeed: string;
  balance: number;
  nickname?: string;
}

// M-Pesa API URLs
const MPESA_OAUTH_URL = 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
const MPESA_STK_PUSH_URL = 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest';
const MPESA_STK_QUERY_URL = 'https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query';
const MPESA_B2C_URL = 'https://api.safaricom.co.ke/mpesa/b2c/v3/paymentrequest';
const MPESA_TRANSACTION_STATUS_URL = 'https://api.safaricom.co.ke/mpesa/transactionstatus/v1/query';
const MPESA_ACCOUNT_BALANCE_URL = 'https://api.safaricom.co.ke/mpesa/accountbalance/v1/query';
const MPESA_REVERSAL_URL = 'https://api.safaricom.co.ke/mpesa/reversal/v1/request';
const MPESA_C2B_REGISTER_URL = 'https://api.safaricom.co.ke/mpesa/c2b/v1/registerurl';

// ACCESS TOKEN FUNCTION
async function getAccessToken() {
  const consumer_key = process.env.MPESA_CONSUMER_KEY;
  const consumer_secret = process.env.MPESA_CONSUMER_SECRET;
  const auth = Buffer.from(`${consumer_key}:${consumer_secret}`).toString('base64');

  try {
    const response = await axios.get(MPESA_OAUTH_URL, {
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });
    return response.data.access_token;
  } catch (error) {
    console.error('Error getting access token:', error);
    throw error;
  }
}

// Game-related routes

router.get('/current-game', (req, res) => {
  const currentGame = getCurrentGame();
  if (!currentGame) {
    res.status(404).json({ error: 'No game in progress' });
    return;
  }
  res.json({
    gameHash: currentGame.getCurrentGameHash(),
    crashPoint: currentGame.getCurrentCrashPoint(),
    isInProgress: currentGame.isGameInProgress(),
    currentMultiplier: currentGame.getCurrentMultiplier()
  });
});

router.post('/place-bet', async (req, res) => {
  const currentGame = getCurrentGame();
  if (!currentGame) {
    res.status(400).json({ error: 'No game available' });
    return;
  }

  const { walletId, amount } = req.body;
  if (!walletId || !amount) {
    res.status(400).json({ error: 'WalletId and amount are required' });
    return;
  }

  try {
    const user = await prisma.user.findUnique({ where: { walletId } });
    if (!user || user.balance < amount) {
      res.status(400).json({ error: 'Insufficient balance' });
      return;
    }

    const betPlaced = currentGame.placeBet(walletId, amount);
    if (!betPlaced) {
      res.status(400).json({ error: 'Failed to place bet' });
      return;
    }

    await updateUserBalance(walletId, user.balance - amount);

    res.json({ 
      message: 'Bet placed successfully', 
      forNextRound: currentGame.isGameInProgress()
    });

    io.to(walletId).emit('betPlaced', { amount, forNextRound: currentGame.isGameInProgress() });
  } catch (error) {
    console.error('Failed to place bet:', error);
    res.status(500).json({ error: 'Failed to place bet' });
  }
});

router.post('/cancel-bet', async (req, res) => {
  const currentGame = getCurrentGame();
  if (!currentGame) {
    res.status(400).json({ error: 'No game available' });
    return;
  }

  const { walletId } = req.body;
  if (!walletId) {
    res.status(400).json({ error: 'WalletId is required' });
    return;
  }

  try {
    const refundedAmount = currentGame.cancelBet(walletId);
    if (refundedAmount === null) {
      res.status(400).json({ error: 'Failed to cancel bet' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { walletId } });
    if (!user) {
      res.status(400).json({ error: 'User not found' });
      return;
    }

    await updateUserBalance(walletId, user.balance + refundedAmount);

    res.json({ 
      message: 'Bet cancelled successfully', 
      refundedAmount,
      newBalance: user.balance + refundedAmount
    });

    io.to(walletId).emit('betCancelled', { refundedAmount, newBalance: user.balance + refundedAmount });
  } catch (error) {
    console.error('Failed to cancel bet:', error);
    res.status(500).json({ error: 'Failed to cancel bet' });
  }
});

router.get('/online-users', (req, res) => {
  try {
    const onlineStats = getOnlineUsersStats();
    res.json(onlineStats);
  } catch (error) {
    console.error('Failed to fetch online users stats:', error);
    res.status(500).json({ error: 'Failed to fetch online users stats' });
  }
});

router.post('/cashout', async (req, res) => {
  const currentGame = getCurrentGame();
  if (!currentGame || !currentGame.isGameInProgress()) {
    res.status(400).json({ error: 'No game in progress' });
    return;
  }

  const { walletId } = req.body;
  if (!walletId) {
    res.status(400).json({ error: 'WalletId is required' });
    return;
  }

  try {
    const winnings = currentGame.cashout(walletId);
    if (winnings === null) {
      res.status(400).json({ error: 'Cashout failed' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { walletId } });
    if (!user) {
      res.status(400).json({ error: 'User not found' });
      return;
    }

    await updateUserBalance(walletId, user.balance + winnings);

    res.json({ message: 'Cashout successful', winnings });
    io.to(walletId).emit('cashoutSuccess', { winnings, newBalance: user.balance + winnings });
  } catch (error) {
    console.error('Failed to process cashout:', error);
    res.status(500).json({ error: 'Failed to process cashout' });
  }
});

router.get('/game-history', async (req, res) => {
  try {
    const start = req.query.start ? parseInt(req.query.start as string, 10) : 0;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;

    if (isNaN(start) || isNaN(limit)) {
      return res.status(400).json({ error: 'Invalid start or limit parameter' });
    }

    const games = await prisma.game.findMany({
      skip: start,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { bets: true }
    });

    const total = await prisma.game.count();

    const formattedGames = games.map(game => ({
      id: game.id,
      gameHash: game.gameHash,
      crashPoint: game.crashPoint,
      houseEdge: game.houseEdge,
      salt: game.salt,
      clientSeed: game.clientSeed,
      serverSeed: game.serverSeed,
      startTime: game.startTime,
      endTime: game.endTime,
      createdAt: game.createdAt,
      updatedAt: game.updatedAt,
      totalBets: game.bets.reduce((sum, bet) => sum + bet.amount, 0),
      totalPayout: game.bets.reduce((sum, bet) => sum + (bet.cashoutAt ? bet.amount * bet.cashoutAt : 0), 0),
      players: new Set(game.bets.map(bet => bet.walletId)).size
    }));

    res.json({
      data: formattedGames,
      total: total
    });
  } catch (error) {
    console.error('Error fetching game history:', error);
    res.status(500).json({ error: 'Failed to fetch game history' });
  }
});

router.get('/verify/:gameHash', async (req, res) => {
  try {
    const { gameHash } = req.params;
    const game = await prisma.game.findUnique({ where: { gameHash } });
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    const crashGameInstance = getCrashGameInstance();
    if (!crashGameInstance) {
      return res.status(500).json({ error: 'CrashGame instance not available' });
    }

    const calculatedCrashPoint = await CrashGame.verifyGame(
      game.gameHash,
      game.clientSeed, 
      game.salt, 
      game.houseEdge
    );

    res.json({
      gameHash: game.gameHash,
      storedCrashPoint: game.crashPoint,
      calculatedCrashPoint,
      houseEdge: game.houseEdge,
      isValid: Math.abs(game.crashPoint - calculatedCrashPoint) < 0.00001
    });
  } catch (error) {
    console.error('Failed to verify game:', error);
    res.status(500).json({ error: 'Failed to verify game' });
  }
});

router.get('/user-stats/:walletId', async (req, res) => {
  try {
    const { walletId } = req.params;
    const user = await prisma.user.findUnique({
      where: { walletId },
      include: {
        bets: {
          include: { game: true },
          orderBy: { createdAt: 'desc' },
          take: 10
        }
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const stats = {
      totalBets: user.bets.length,
      totalWagered: user.bets.reduce((sum, bet) => sum + bet.amount, 0),
      totalProfit: user.bets.reduce((sum, bet) => {
        if (bet.cashoutAt) {
          return sum + (bet.amount * bet.cashoutAt - bet.amount);
        }
        return sum - bet.amount;
      }, 0),
      recentBets: user.bets.map(bet => ({
        amount: bet.amount,
        crashPoint: bet.game.crashPoint,
        cashoutAt: bet.cashoutAt,
        profit: bet.cashoutAt ? (bet.amount * bet.cashoutAt - bet.amount) : -bet.amount
      }))
    };

    res.json(stats);
  } catch (error) {
    console.error('Failed to fetch user stats:', error);
    res.status(500).json({ error: 'Failed to fetch user stats' });
  }
});

router.get('/leaderboard', async (req, res) => {
  try {
    const users = getUsers();
    const leaderboard = Array.from(users.values())
      .sort((a, b) => b.wallet - a.wallet)
      .slice(0, 10)
      .map(user => ({
        id: user.walletId,
        balance: user.wallet,
        isLoggedIn: user.isLoggedIn
      }));

    res.json(leaderboard);
  } catch (error) {
    console.error('Failed to fetch leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

router.post('/change-client-seed', async (req, res) => {
  const { walletId, newClientSeed } = req.body;

  if (!walletId || !newClientSeed) {
    return res.status(400).json({ error: 'WalletId and newClientSeed are required' });
  }

  try {
    await prisma.user.update({
      where: { walletId },
      data: { clientSeed: newClientSeed }
    });

    res.json({ message: 'Client seed updated successfully' });
    io.to(walletId).emit('clientSeedChanged', { newClientSeed });
  } catch (error) {
    console.error('Failed to update client seed:', error);
    res.status(500).json({ error: 'Failed to update client seed' });
  }
});

// M-Pesa related routes

router.get("/access_token", async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    res.json({ message: "Access token generated successfully", accessToken });
  } catch (error) {
    console.error('Failed to get access token:', error);
    res.status(500).json({ error: 'Failed to get access token' });
  }
});

router.post('/initiate-deposit', async (req, res) => {
  const { amount, phoneNumber, walletId } = req.body;

  if (!amount || !phoneNumber || !walletId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  console.log(`Initiating deposit - Amount: ${amount}, Phone: ${phoneNumber}, WalletID: ${walletId}`);

  try {
    const user = await prisma.user.findUnique({ where: { walletId } });
    if (!user) {
      console.log('User not found');
      return res.status(404).json({ error: 'User not found' });
    }

    console.log(`User found:`, user);

    const stkPushResponse = await initiateSTKPush(phoneNumber, amount, walletId);
    console.log('STK push response:', stkPushResponse);

    if (stkPushResponse.ResponseCode === "0") {
      try {
        const deposit = await prisma.deposit.create({
          data: {
            user: { 
              connect: { 
                walletId: walletId
              } 
            },
            walletId: walletId,
            amount: Number(amount),
            phoneNumber: phoneNumber.toString(),
            businessShortCode: process.env.MPESA_BUSINESS_SHORTCODE || '',
            merchantRequestID: stkPushResponse.MerchantRequestID,
            checkoutRequestID: stkPushResponse.CheckoutRequestID,
            status: 'PENDING',
          },
        });

        console.log(`Deposit record created:`, deposit);

        res.json({ 
          message: 'STK push initiated successfully', 
          checkoutRequestID: stkPushResponse.CheckoutRequestID,
        });

        io.to(walletId).emit('depositInitiated', { 
          amount,
          message: 'STK push initiated successfully'
        });
      } catch (dbError) {
        console.error('Failed to create deposit record:', dbError);
        res.status(500).json({ error: 'Failed to create deposit record' });
      }
    } else {
      console.log('STK push failed:', stkPushResponse);
      res.status(400).json({ error: 'Failed to initiate STK push' });
    }
  } catch (error) {
    console.error('Error initiating deposit:', error);
    res.status(500).json({ error: 'Failed to initiate deposit' });
  }
});

router.post('/initiate-withdrawal', async (req, res) => {
  const { amount, phoneNumber, walletId } = req.body;

  if (!amount || !phoneNumber || !walletId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { walletId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.balance < parseFloat(amount)) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const b2cResult = await b2cPaymentRequest(phoneNumber, parseFloat(amount), 'Withdrawal');

    if (b2cResult.ResponseCode === '0') {
      const withdrawal = await prisma.withdrawal.create({
        data: {
          user: { 
            connect: { 
              walletId: walletId
            } 
          },
          walletId: walletId, // Add this line
          amount: amount,
          status: 'PENDING',
          transactionId: '',
        }
      });

      await prisma.user.update({
        where: { walletId },
        data: { balance: user.balance - parseFloat(amount) },
      });

      res.json({ 
        message: 'Withdrawal initiated successfully', 
        withdrawalId: withdrawal.id,
      });

      io.to(walletId).emit('withdrawalInitiated', { 
        amount,
        message: 'Withdrawal initiated successfully'
      });
    } else {
      res.status(400).json({ error: 'Failed to initiate withdrawal' });
    }
  } catch (error) {
    console.error('Error initiating withdrawal:', error);
    res.status(500).json({ error: 'Failed to initiate withdrawal' });
  }
});

// STK PUSH CALLBACK ROUTE
router.post("/stk-callback", async (req, res) => {
  console.log("STK PUSH CALLBACK received:", JSON.stringify(req.body, null, 2));
  const { Body } = req.body;
  
  if (Body.stkCallback.ResultCode === 0) {
    const callbackMetadata = Body.stkCallback.CallbackMetadata;
    const amount = callbackMetadata.Item.find((item: { Name: string, Value: number | string }) => item.Name === 'Amount').Value as number;
    const mpesaReceiptNumber = callbackMetadata.Item.find((item: { Name: string, Value: number | string }) => item.Name === 'MpesaReceiptNumber').Value as string;
    const transactionDate = callbackMetadata.Item.find((item: { Name: string, Value: number | string }) => item.Name === 'TransactionDate').Value as string;
    const phoneNumber = callbackMetadata.Item.find((item: { Name: string, Value: number | string }) => item.Name === 'PhoneNumber').Value as string;

    try {
      // Find the user by phone number
      const user = await prisma.user.findUnique({ where: { phoneNumber: phoneNumber.toString() } });

      if (user) {
        // Update user's balance
        const updatedUser = await prisma.user.update({
          where: { id: user.id },
          data: { balance: { increment: amount } }
        });

        // Create a deposit record
        const deposit = await prisma.deposit.create({
          data: {
            userId: user.id,
            walletId: user.walletId,
            amount: amount,
            phoneNumber: phoneNumber.toString(),
            businessShortCode: process.env.MPESA_SHORTCODE || '',
            mpesaReceiptNumber: mpesaReceiptNumber,
            transactionDate: new Date(transactionDate),
            status: 'COMPLETED'
          }
        });

        console.log(`Deposit successful for user ${user.walletId}:`, {
          amount,
          mpesaReceiptNumber,
          newBalance: updatedUser.balance
        });

        // Emit a socket event to update the client
        io.to(user.walletId).emit('depositSuccess', {
          amount,
          mpesaReceiptNumber,
          newBalance: updatedUser.balance
        });
      } else {
        console.error(`User not found for phone number: ${phoneNumber}`);
      }
    } catch (error) {
      console.error('Error processing STK callback:', error);
    }
  } else {
    console.log(`STK push failed: ${Body.stkCallback.ResultDesc}`);
  }

  res.json({ ResultCode: 0, ResultDesc: "Success" });
});


router.get("/check-stk-status/:CheckoutRequestID", async (req, res) => {
  const { CheckoutRequestID } = req.params;
  try {
    const result = await querySTKPush(CheckoutRequestID);
    console.log("STK status check result:", result);

    if (result.ResultCode === "0") {
      // Process the successful transaction here
      const deposit = await prisma.deposit.findFirst({
        where: { checkoutRequestID: CheckoutRequestID },
        include: { user: true },
      });

      if (deposit) {
        await prisma.deposit.update({
          where: { id: deposit.id },
          data: {
            status: 'COMPLETED',
            mpesaReceiptNumber: result.MpesaReceiptNumber,
            transactionDate: new Date(result.TransactionDate),
          },
        });

        await prisma.user.update({
          where: { walletId: deposit.walletId },
          data: {
            balance: { increment: deposit.amount },
          },
        });

        const updatedUser = await prisma.user.findUnique({ where: { walletId: deposit.walletId } });

        io.to(deposit.walletId).emit('depositSuccess', {
          amount: deposit.amount,
          mpesaReceiptNumber: result.MpesaReceiptNumber,
          newBalance: updatedUser?.balance,
        });

        console.log("Deposit processed successfully:", {
          amount: deposit.amount,
          mpesaReceiptNumber: result.MpesaReceiptNumber,
          walletId: deposit.walletId,
          newBalance: updatedUser?.balance,
        });
      }
    }

    res.json(result);
  } catch (error) {
    console.error("Error checking STK status:", error);
    res.status(500).json({ error: "Failed to check STK status" });
  }
});

// REGISTER URL FOR C2B
router.get("/register-c2b-urls", async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    const response = await axios.post(
      MPESA_C2B_REGISTER_URL,
      {
        ShortCode: process.env.MPESA_BUSINESS_SHORTCODE,
        ResponseType: "Completed",
        ConfirmationURL: `${process.env.BASE_URL}/api/mpesa/c2b-confirmation`,
        ValidationURL: `${process.env.BASE_URL}/api/mpesa/c2b-validation`,
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
    res.status(200).json(response.data);
  } catch (error) {
    console.error('Error registering C2B URLs:', error);
    res.status(500).json({ error: 'Failed to register C2B URLs' });
  }
});

router.post("/c2b-confirmation", (req, res) => {
  console.log("C2B Confirmation:", req.body);
  // Process the confirmation
  res.json({ ResultCode: 0, ResultDesc: "Success" });
});

router.post("/c2b-validation", (req, res) => {
  console.log("C2B Validation:", req.body);
  // Validate the transaction
  res.json({ ResultCode: 0, ResultDesc: "Success" });
});

// Transaction status query
router.post("/transaction-status", async (req, res) => {
  const { transactionId } = req.body;
  
  if (!transactionId) {
    return res.status(400).json({ error: 'Transaction ID is required' });
  }

  try {
    const result = await transactionStatusQuery(transactionId);
    res.json(result);
  } catch (error) {
    console.error('Error querying transaction status:', error);
    res.status(500).json({ error: 'Failed to query transaction status' });
  }
});

// Account balance query
router.get("/account-balance", async (req, res) => {
  try {
    const result = await accountBalanceQuery();
    res.json(result);
  } catch (error) {
    console.error('Error querying account balance:', error);
    res.status(500).json({ error: 'Failed to query account balance' });
  }
});

// Withdrawal status query
router.get("/withdrawal-status/:transactionId", async (req, res) => {
  const { transactionId } = req.params;
  const { walletId } = req.query;

  if (!transactionId || !walletId) {
    return res.status(400).json({ error: 'Transaction ID and Wallet ID are required' });
  }

  try {
    const withdrawal = await prisma.withdrawal.findFirst({
      where: {
        transactionId: transactionId,
        walletId: walletId as string,
      },
    });

    if (!withdrawal) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    res.json({ status: withdrawal.status });
  } catch (error) {
    console.error('Error querying withdrawal status:', error);
    res.status(500).json({ error: 'Failed to query withdrawal status' });
  }
});

router.post('/api/admin/make-it-rain', async (req, res) => {
  try {
    const { amount, recipients, adminId } = req.body;

    // Get all online logged-in users from the users Map
    const allUsers = getUsers();
    const onlineUsers = Array.from(allUsers.values())
      .filter(u => u.isLoggedIn)
      .slice(0, recipients);

    if (onlineUsers.length < 2) {
      return res.status(400).json({
        success: false,
        message: 'Not enough online users to make it rain'
      });
    }

    const transactions = [];
    const amountPerUser = Math.floor(amount);

    // Distribute to selected users
    for (const recipient of onlineUsers) {
      recipient.wallet += amountPerUser;
      await updateUserBalance(recipient.walletId, recipient.wallet);

      // Notify the recipient through socket
      io.to(recipient.walletId).emit('receivedRain', {
        amount: amountPerUser,
        from: 'ADMIN'
      });

      transactions.push({
        userId: recipient.walletId,
        amount: amountPerUser
      });
    }

    // Broadcast the event
    io.emit('makeItRainEvent', {
      from: 'ADMIN',
      amount: amount * recipients,
      recipients: onlineUsers.length
    });

    // Send success response
    return res.json({
      success: true,
      message: 'Successfully made it rain',
      transactions
    });

  } catch (error) {
    console.error('Error processing admin make it rain:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to make it rain'
    });
  }
});

// Add routes for bet-based crash point management
router.get('/bet-based-crash-settings', async (req, res) => {
  try {
    const crashGameInstance = getCrashGameInstance();
    if (!crashGameInstance) {
      return res.status(500).json({ error: 'Crash game instance not available' });
    }

    const settings = await crashGameInstance.getBetBasedSettings();
    res.json(settings);
  } catch (error) {
    console.error('Failed to get bet based crash settings:', error);
    res.status(500).json({ error: 'Failed to get bet based crash settings' });
  }
});

router.post('/bet-based-crash-settings', async (req, res) => {
  try {
    const {
      enabled,
      houseEdgePercentage,
      minCrashPoint,
      highCrashPointFrequency,
      skipCrashPointManagement,
      betBasedOffsetAmount
    } = req.body;

    const crashGameInstance = getCrashGameInstance();
    if (!crashGameInstance) {
      return res.status(500).json({ error: 'Crash game instance not available' });
    }

    if (enabled !== undefined) {
      await crashGameInstance.setBetBasedCrashPointEnabled(enabled);
    }

    if (houseEdgePercentage !== undefined) {
      if (houseEdgePercentage < 1 || houseEdgePercentage > 60) {
        return res.status(400).json({ error: 'House edge percentage must be between 1 and 60' });
      }
      await crashGameInstance.setBetBasedHouseEdgePercentage(houseEdgePercentage);
    }

    if (minCrashPoint !== undefined) {
      if (minCrashPoint < 1) {
        return res.status(400).json({ error: 'Minimum crash point must be at least 1' });
      }
      await crashGameInstance.setMinCrashPoint(minCrashPoint);
    }

    if (highCrashPointFrequency !== undefined) {
      if (highCrashPointFrequency < 0 || highCrashPointFrequency > 100) {
        return res.status(400).json({ error: 'High crash point frequency must be between 0 and 100' });
      }
      await crashGameInstance.setHighCrashPointFrequency(highCrashPointFrequency);
    }

    if (skipCrashPointManagement !== undefined) {
      if (skipCrashPointManagement < 0 || skipCrashPointManagement > 100) {
        return res.status(400).json({ error: 'Skip crash point management must be between 0 and 100' });
      }
      await crashGameInstance.setSkipCrashPointManagement(skipCrashPointManagement);
    }

    if (betBasedOffsetAmount !== undefined) {
      if (betBasedOffsetAmount < 0) {
        return res.status(400).json({ error: 'Bet based offset amount cannot be negative' });
      }
      await crashGameInstance.setBetBasedOffsetAmount(betBasedOffsetAmount);
    }

    const updatedSettings = await crashGameInstance.getBetBasedSettings();
    res.json({
      message: 'Bet based crash settings updated successfully',
      settings: updatedSettings
    });
  } catch (error) {
    console.error('Failed to update bet based crash settings:', error);
    res.status(500).json({ error: 'Failed to update bet based crash settings' });
  }
});

export default router;
