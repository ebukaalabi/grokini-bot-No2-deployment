/**
 * GrokiniHotBot - Solana Trading Bot for Telegram
 * A clean, production-ready Telegram bot for trading Solana tokens
 */

import TelegramBot from 'node-telegram-bot-api';
import { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import crypto from 'crypto';
import mongoose from 'mongoose';

// ============================================================================
// CONFIGURATION
// ============================================================================

const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    webhookUrl: process.env.WEBHOOK_URL || '',
  },
  mongodb: {
    uri: process.env.MONGODB_URI || '',
  },
  solana: {
    rpcUrls: [
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      'https://solana-mainnet.g.alchemy.com/v2/demo',
      'https://rpc.ankr.com/solana',
    ],
    wsUrl: process.env.SOLANA_WS_URL || 'wss://api.mainnet-beta.solana.com',
  },
  jupiter: {
    apiUrl: 'https://quote-api.jup.ag/v6',
    priceApiUrl: 'https://price.jup.ag/v6',
  },
  encryption: {
    key: process.env.ENCRYPTION_KEY || '',
    algorithm: 'aes-256-gcm' as const,
  },
  bot: {
    name: 'GrokiniHotBot',
    commissionWallet: process.env.COMMISSION_WALLET || '',
    commissionRate: 0.01,
    maxWallets: 5,
    defaultSlippage: 1,
    adminIds: (process.env.ADMIN_IDS || '').split(',').filter(Boolean),
  },
};

// ============================================================================
// DATABASE SCHEMAS
// ============================================================================

const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true, index: true },
  username: String,
  firstName: String,
  lastName: String,
  referredBy: String,
  referralCode: { type: String, unique: true },
  referralCount: { type: Number, default: 0 },
  referralEarnings: { type: Number, default: 0 },
  settings: {
    slippage: { type: Number, default: 1 },
    priorityFee: { type: Number, default: 0.000005 },
    autoApprove: { type: Boolean, default: false },
    notifications: { type: Boolean, default: true },
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  isBanned: { type: Boolean, default: false },
});

const walletSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true },
  name: { type: String, default: 'Main Wallet' },
  publicKey: { type: String, required: true },
  encryptedPrivateKey: { type: String, required: true },
  iv: { type: String, required: true },
  authTag: { type: String, required: true },
  isActive: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const transactionSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true },
  walletAddress: String,
  type: { type: String, enum: ['buy', 'sell', 'transfer'] },
  tokenAddress: String,
  tokenSymbol: String,
  amountIn: Number,
  amountOut: Number,
  priceUsd: Number,
  signature: String,
  status: { type: String, enum: ['pending', 'confirmed', 'failed'] },
  createdAt: { type: Date, default: Date.now },
});

const limitOrderSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true },
  walletAddress: String,
  type: { type: String, enum: ['buy', 'sell'] },
  tokenAddress: String,
  tokenSymbol: String,
  triggerPrice: Number,
  amount: Number,
  slippage: Number,
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  executedAt: Date,
});

const dcaOrderSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true },
  walletAddress: String,
  tokenAddress: String,
  tokenSymbol: String,
  amountPerOrder: Number,
  interval: Number,
  totalOrders: Number,
  executedOrders: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  nextExecutionAt: Date,
  createdAt: { type: Date, default: Date.now },
});
