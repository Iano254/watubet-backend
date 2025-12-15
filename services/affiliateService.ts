import { PrismaClient } from '@prisma/client';
import { Server } from 'socket.io';

const prisma = new PrismaClient({
  log: ['error', 'warn']
});

/**
 * Process multi-level referrals after first level referral
 */
async function processMultiLevelReferrals(
  referrerId: string,
  originalUserId: string,
  depositAmount: number
): Promise<void> {
  try {
    // Get the level 1 referrer
    const level1Referrer = await prisma.user.findUnique({
      where: { id: referrerId },
      select: { id: true, referredBy: true }
    });

    if (!level1Referrer?.referredBy) return;

    // Find level 2 referrer
    const level2Referrer = await prisma.user.findUnique({
      where: { referralCode: level1Referrer.referredBy },
      select: { id: true, referredBy: true }
    });

    if (level2Referrer) {
      // Create level 2 affiliate earning
      await prisma.$transaction(async (tx) => {
        await tx.affiliateEarning.create({
          data: {
            userId: level2Referrer.id,
            referralId: originalUserId,
            depositAmount,
            commissionRate: 0.05,
            level: 2,
            amount: depositAmount * 0.05,
            isPaid: false
          }
        });

        await tx.referralEarning.create({
          data: {
            userId: level2Referrer.id,
            referralId: originalUserId,
            level: 2,
            amount: depositAmount * 0.05,
            baseAmount: depositAmount,
            status: 'PENDING'
          }
        });
      });

      // Process level 3 if exists
      if (level2Referrer.referredBy) {
        const level3Referrer = await prisma.user.findUnique({
          where: { referralCode: level2Referrer.referredBy },
          select: { id: true }
        });

        if (level3Referrer) {
          await prisma.$transaction(async (tx) => {
            await tx.affiliateEarning.create({
              data: {
                userId: level3Referrer.id,
                referralId: originalUserId,
                depositAmount,
                commissionRate: 0.01,
                level: 3,
                amount: depositAmount * 0.01,
                isPaid: false
              }
            });

            await tx.referralEarning.create({
              data: {
                userId: level3Referrer.id,
                referralId: originalUserId,
                level: 3,
                amount: depositAmount * 0.01,
                baseAmount: depositAmount,
                status: 'PENDING'
              }
            });
          });
        }
      }
    }
  } catch (error) {
    console.error('Error processing multi-level referrals:', error);
    throw error;
  }
}

/**
 * Process affiliate earnings when a user makes a deposit
 */
export async function processAffiliateEarnings(userId: string, depositAmount: number): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, referredBy: true }
    });

    if (!user?.referredBy) {
      console.log(`User ${userId} has no referrer, skipping affiliate earnings`);
      return;
    }

    const referrer = await prisma.user.findUnique({
      where: { referralCode: user.referredBy },
      select: { id: true, walletId: true, referredBy: true }
    });

    if (!referrer) {
      console.log(`Referrer with code ${user.referredBy} not found`);
      return;
    }

    // Process first level earnings
    await prisma.$transaction(async (tx) => {
      // First level (25%)
      await tx.affiliateEarning.create({
        data: {
          userId: referrer.id,
          referralId: userId,
          depositAmount,
          commissionRate: 0.25,
          level: 1,
          amount: depositAmount * 0.25,
          isPaid: false
        }
      });

      await tx.referralEarning.create({
        data: {
          userId: referrer.id,
          referralId: userId,
          level: 1,
          amount: depositAmount * 0.25,
          baseAmount: depositAmount,
          status: 'PENDING'
        }
      });
    });

    // Process higher level referrals
    await processMultiLevelReferrals(referrer.id, userId, depositAmount);

  } catch (error) {
    console.error('Error processing affiliate earnings:', error);
    throw error;
  }
}

async function getAffiliateBalanceAtTime(userId: string, beforeTime: Date): Promise<number> {
  const earnings = await prisma.affiliateEarning.aggregate({
    where: {
      userId,
      createdAt: {
        lte: beforeTime
      },
      isPaid: false,
      status: {
        in: ['PENDING', 'PENDING_WITHDRAWAL']
      }
    },
    _sum: {
      amount: true
    }
  });

  return earnings._sum?.amount ?? 0;
}

export async function handleAffiliateWithdrawal(
  userId: string,
  amount: number,
  walletAddress: string
): Promise<any> {
  try {
    // Get current stats to check balance
    const stats = await calculateAffiliateStats(userId);
    
    // FIX: Use the totalBonus or availableBalance from stats directly
    // instead of summing up just the pending amounts
    const availableBalance = stats.availableBalance;

    console.log('Withdrawal request balance check:', {
      userId,
      availableBalance,
      requestedAmount: amount,
      breakdown: {
        firstLevel: stats.firstLevel.pendingAmount,
        secondLevel: stats.secondLevel.pendingAmount,
        thirdLevel: stats.thirdLevel.pendingAmount,
        startingBalance: stats.totalBonus - (
          stats.firstLevel.pendingAmount + 
          stats.secondLevel.pendingAmount + 
          stats.thirdLevel.pendingAmount
        )
      }
    });

    if (amount < 10) {
      throw new Error('Minimum withdrawal amount is 10 KES');
    }

    if (amount > availableBalance) {
      throw new Error(`Insufficient affiliate balance. Available: ${availableBalance} KES, Requested: ${amount} KES`);
    }

    return await prisma.$transaction(async (tx) => {
      // Create withdrawal request
      const withdrawalRequest = await tx.withdrawalRequest.create({
        data: {
          userId,
          amount,
          status: 'PENDING',
          type: 'AFFILIATE',
          phoneNumber: walletAddress,
          walletId: (await prisma.user.findUnique({ where: { id: userId } }))?.walletId || '',
        }
      });

      // Create affiliate withdrawal record with balance tracking
      await tx.affiliateWithdrawal.create({
        data: {
          userId,
          amount,
          walletAddress,
          status: 'PENDING',
          withdrawalId: withdrawalRequest.id,
          balanceBeforeWithdrawal: availableBalance,
          balanceAfterWithdrawal: availableBalance - amount
        }
      });

      // Mark earnings as pending withdrawal - process level by level
      let remainingAmount = amount;
      const levels = [1, 2, 3];
      
      // FIX: Handle the case where the user has a starting balance from previous withdrawals
      // This might require creating a "virtual" earnings record for the starting balance
      const pendingAmount = stats.firstLevel.pendingAmount + stats.secondLevel.pendingAmount + stats.thirdLevel.pendingAmount;
      const startingBalance = stats.availableBalance - pendingAmount;
      
      // If the starting balance can cover some or all of the withdrawal amount
      if (startingBalance > 0) {
        const startingBalanceUsed = Math.min(startingBalance, remainingAmount);
        remainingAmount -= startingBalanceUsed;
        
        // We don't need to update any earnings records for the starting balance
        // as it's already accounted for in the balanceAfterWithdrawal of the latest withdrawal
      }
      
      for (const level of levels) {
        if (remainingAmount <= 0) break;

        const levelEarnings = await tx.affiliateEarning.findMany({
          where: {
            userId,
            level,
            isPaid: false,
            status: 'PENDING'
          },
          orderBy: {
            createdAt: 'asc'
          }
        });

        for (const earning of levelEarnings) {
          if (remainingAmount <= 0) break;

          const amountToTake = Math.min(earning.amount, remainingAmount);
          await tx.affiliateEarning.update({
            where: { id: earning.id },
            data: {
              withdrawalId: withdrawalRequest.id,
              status: 'PENDING_WITHDRAWAL'
            }
          });

          remainingAmount -= amountToTake;
        }
      }

      return {
        id: withdrawalRequest.id,
        amount,
        status: 'PENDING',
        balanceBeforeWithdrawal: availableBalance,
        balanceAfterWithdrawal: availableBalance - amount
      };
    });
  } catch (error) {
    console.error('Withdrawal request error:', error);
    throw error;
  }
}

export async function processSuccessfulAffiliateWithdrawal(withdrawalId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Get the withdrawal request with affiliate withdrawal details
    const withdrawalRequest = await tx.withdrawalRequest.findUnique({
      where: { id: withdrawalId },
      include: {
        affiliateWithdrawal: true
      }
    });

    if (!withdrawalRequest || !withdrawalRequest.affiliateWithdrawal) {
      throw new Error('Withdrawal request not found');
    }

    // Update withdrawal request status
    await tx.withdrawalRequest.update({
      where: { id: withdrawalId },
      data: { status: 'COMPLETED' }
    });

    // Update affiliate withdrawal status
    await tx.affiliateWithdrawal.update({
      where: { withdrawalId },
      data: { status: 'COMPLETED' }
    });

    // Update affiliate earnings status to mark them as paid
    await tx.affiliateEarning.updateMany({
      where: {
        userId: withdrawalRequest.affiliateWithdrawal.userId,
        status: 'PENDING',
        isPaid: false
      },
      data: {
        isPaid: true,
        status: 'PAID'
      }
    });
  });
}

export async function handleAffiliateWithdrawalSuccess(
  callbackData: any,
  io: Server
): Promise<void> {
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

export async function handleAffiliateWithdrawalCallback(
  callbackData: any,
  io: Server
): Promise<void> {
  const { CheckoutRequestID, ResultCode } = callbackData.Body.stkCallback;

  try {
    // Find the withdrawal request first
    const withdrawalRequest = await prisma.withdrawalRequest.findUnique({
      where: {
        checkoutRequestID: CheckoutRequestID
      },
      include: {
        affiliateWithdrawal: true,
        user: true
      }
    });

    if (!withdrawalRequest || !withdrawalRequest.affiliateWithdrawal) {
      throw new Error('Withdrawal not found');
    }

    if (ResultCode === 0) {
      // Process successful withdrawal
      await processSuccessfulAffiliateWithdrawal(withdrawalRequest.id);

      // Find socket connection for user
      const socket = Array.from(io.sockets.sockets.values()).find(
        (s) => (s as any).user?.id === withdrawalRequest.userId
      );

      if (socket) {
        socket.emit('affiliateWithdrawalComplete', {
          message: 'Your affiliate withdrawal has been processed successfully'
        });
        socket.emit('getAffiliateStats');
      }
    } else {
      // Handle failed withdrawal
      await prisma.$transaction(async (tx) => {
        // Update withdrawal status
        await tx.affiliateWithdrawal.update({
          where: { withdrawalId: withdrawalRequest.id },
          data: { status: 'FAILED' }
        });

        // Reset affiliate earnings status
        await tx.affiliateEarning.updateMany({
          where: { 
            withdrawalId: withdrawalRequest.id,
            status: 'PENDING_WITHDRAWAL'
          },
          data: { 
            isPaid: false,
            status: 'PENDING'
          }
        });
      });

      // Notify user of failure
      const socket = Array.from(io.sockets.sockets.values()).find(
        (s) => (s as any).user?.id === withdrawalRequest.userId
      );

      if (socket) {
        socket.emit('affiliateWithdrawalFailed', {
          message: 'Your withdrawal request failed. The funds have been returned to your available balance.'
        });
        socket.emit('getAffiliateStats');
      }
    }
  } catch (error) {
    console.error('Error processing affiliate withdrawal callback:', error);
  }
}

/**
 * Calculate current affiliate balance and pending withdrawals
 */
/**
 * Calculate affiliate stats including earnings and referrals
 */
export async function calculateAffiliateStats(userId: string) {
  try {
    // 1. Get the latest COMPLETED withdrawal to get starting balance
    const latestCompletedWithdrawal = await prisma.affiliateWithdrawal.findFirst({
      where: {
        userId,
        status: 'COMPLETED'
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    console.log('Latest completed withdrawal:', latestCompletedWithdrawal);

    // 2. Get all pending earnings (including NEW referral earnings)
    const pendingEarnings = await prisma.affiliateEarning.aggregate({
      where: {
        userId,
        isPaid: false,
        status: {
          in: ['PENDING', 'NEW'] // Added 'NEW' status to include new referral earnings
        }
      },
      _sum: {
        amount: true
      }
    });

    // 3. Get pending withdrawal earnings (marked for withdrawal but not yet paid)
    const pendingWithdrawalEarnings = await prisma.affiliateEarning.aggregate({
      where: {
        userId,
        isPaid: false,
        status: 'PENDING_WITHDRAWAL'
      },
      _sum: {
        amount: true
      }
    });

    // 4. Calculate total pending amount (both regular pending and pending withdrawal)
    const pendingAmount = (pendingEarnings._sum?.amount || 0);
    const pendingWithdrawalAmount = (pendingWithdrawalEarnings._sum?.amount || 0);
    
    // 5. Use the balanceAfterWithdrawal from the latest withdrawal as the starting point
    const startingBalance = latestCompletedWithdrawal?.balanceAfterWithdrawal || 0;
    
    // 6. Calculate available balance: starting balance + all pending earnings
    // This includes both new earnings and those marked for withdrawal
    const totalAvailableAmount = startingBalance + pendingAmount + pendingWithdrawalAmount;
    
    // 7. But the actual available balance excludes pending withdrawal amounts
    const availableBalance = startingBalance + pendingAmount;

    console.log('Affiliate stats calculation:', {
      userId,
      startingBalance,
      pendingAmount,
      pendingWithdrawalAmount,
      totalAvailableAmount,
      availableBalance,
      lastWithdrawalId: latestCompletedWithdrawal?.id
    });

    // 8. Get the breakdown of earnings by level (also include NEW status)
    const firstLevelPending = await prisma.affiliateEarning.aggregate({
      where: {
        userId,
        level: 1,
        isPaid: false,
        status: {
          in: ['PENDING', 'NEW']
        }
      },
      _sum: {
        amount: true
      }
    });

    const secondLevelPending = await prisma.affiliateEarning.aggregate({
      where: {
        userId,
        level: 2,
        isPaid: false,
        status: {
          in: ['PENDING', 'NEW']
        }
      },
      _sum: {
        amount: true
      }
    });

    const thirdLevelPending = await prisma.affiliateEarning.aggregate({
      where: {
        userId,
        level: 3,
        isPaid: false,
        status: {
          in: ['PENDING', 'NEW']
        }
      },
      _sum: {
        amount: true
      }
    });

    // Get referral counts
    const firstLevelReferrals = await prisma.user.count({
      where: {
        referredBy: userId
      }
    });

    const referredUserIds = await prisma.user.findMany({
      where: {
        referredBy: userId
      },
      select: {
        id: true
      }
    });

    const secondLevelReferrals = await prisma.user.count({
      where: {
        referredBy: {
          in: referredUserIds.map(u => u.id)
        }
      }
    });

    // For third level referrals count (this was missing)
    const secondLevelUserIds = await prisma.user.findMany({
      where: {
        referredBy: {
          in: referredUserIds.map(u => u.id)
        }
      },
      select: {
        id: true
      }
    });

    const thirdLevelReferrals = await prisma.user.count({
      where: {
        referredBy: {
          in: secondLevelUserIds.map(u => u.id)
        }
      }
    });

    // Calculate completed amounts from previous withdrawals
    const completedWithdrawals = await prisma.affiliateWithdrawal.aggregate({
      where: {
        userId,
        status: 'COMPLETED'
      },
      _sum: {
        amount: true
      }
    });

    const totalCompletedAmount = completedWithdrawals._sum?.amount || 0;

    // Return stats object with the complete breakdown
    return {
      firstLevel: {
        referrals: firstLevelReferrals,
        pendingAmount: firstLevelPending._sum?.amount || 0,
        approvedAmount: 0 // We don't have level breakdown for approved amounts
      },
      secondLevel: {
        referrals: secondLevelReferrals,
        pendingAmount: secondLevelPending._sum?.amount || 0, 
        approvedAmount: 0
      },
      thirdLevel: {
        referrals: thirdLevelReferrals, // Now we calculate third level referrals count
        pendingAmount: thirdLevelPending._sum?.amount || 0,
        approvedAmount: 0
      },
      totalBonus: totalAvailableAmount,
      amountPaid: totalCompletedAmount,
      availableBalance
    };
  } catch (error) {
    console.error('Error calculating affiliate stats:', error);
    throw error;
  }
}