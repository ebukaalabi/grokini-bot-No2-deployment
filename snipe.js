/**
 * Grokini Trading Bot v3.0.0
 * Ultimate Solana Telegram Trading Bot
 * Features: Jupiter Swaps, Price Alerts, Wallet Management, Multi-User Support
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

// ============================================
// CONFIGURATION
// ============================================
const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    adminIds: process.env.ADMIN_IDS?.split(',').map(id => parseInt(id)) || [],
  },
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    wsUrl: process.env.SOLANA_WS_URL || 'wss://api.mainnet-beta.solana.com',
  },
  jupiter: {
    slippageBps: parseInt(process.env.SLIPPAGE_BPS) || 100,
    priorityFee: parseInt(process.env.PRIORITY_FEE) || 10000,
  },
  alerts: {
    checkInterval: parseInt(process.env.ALERT_INTERVAL) || 30000,
  }
};

// ============================================
// CONSTANTS
// ============================================
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ============================================
// STATE MANAGEMENT
// ============================================
class BotState {
  constructor() {
    this.users = new Map();
    this.priceAlerts = new Map();
    this.tokenCache = new Map();
    this.alertCounter = 0;
  }

  getUser(chatId) {
    if (!this.users.has(chatId)) {
      this.users.set(chatId, {
        chatId,
        wallets: [],
        activeWallet: null,
        settings: {
          slippageBps: config.jupiter.slippageBps,
          autoBuy: false,
          notifications: true,
        },
        createdAt: Date.now(),
      });
    }
    return this.users.get(chatId);
  }

  addAlert(chatId, tokenMint, targetPrice, direction) {
    const alertId = ++this.alertCounter;
    this.priceAlerts.set(alertId, {
      id: alertId,
      chatId,
      tokenMint,
      targetPrice,
      direction,
      createdAt: Date.now(),
      triggered: false,
    });
    return alertId;
  }

  removeAlert(alertId) {
    return this.priceAlerts.delete(alertId);
  }

  getUserAlerts(chatId) {
    return Array.from(this.priceAlerts.values()).filter(a => a.chatId === chatId);
  }
}

const state = new BotState();

// ============================================
// SOLANA CONNECTION
// ============================================
const connection = new Connection(config.solana.rpcUrl, {
  commitment: 'confirmed',
  wsEndpoint: config.solana.wsUrl,
});

// ============================================
// UTILITY FUNCTIONS
// ============================================
function shortenAddress(address, chars = 4) {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

function formatNumber(num, decimals = 4) {
  if (num === 0) return '0';
  if (num < 0.0001) return num.toExponential(2);
  return num.toLocaleString('en-US', { maximumFractionDigits: decimals });
}

function formatSOL(lamports) {
  return formatNumber(lamports / LAMPORTS_PER_SOL);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// PRICE FETCHING
// ============================================
async function getTokenPrice(mintAddress) {
  try {
    const response = await fetch(
      `https://price.jup.ag/v6/price?ids=${mintAddress}`
    );
    const data = await response.json();
    return data.data?.[mintAddress]?.price || null;
  } catch (error) {
    console.error('Error fetching price:', error.message);
    return null;
  }
}

async function getTokenInfo(mintAddress) {
  if (state.tokenCache.has(mintAddress)) {
    return state.tokenCache.get(mintAddress);
  }

  try {
    const response = await fetch(
      `https://token.jup.ag/strict?address=${mintAddress}`
    );
    const tokens = await response.json();
    const token = tokens.find(t => t.address === mintAddress);
    
    if (token) {
      state.tokenCache.set(mintAddress, token);
      return token;
    }
    
    return {
      address: mintAddress,
      symbol: shortenAddress(mintAddress),
      name: 'Unknown Token',
      decimals: 9,
    };
  } catch (error) {
    console.error('Error fetching token info:', error.message);
    return null;
  }
}

// ============================================
// WALLET FUNCTIONS
// ============================================
async function getWalletBalance(publicKey) {
  try {
    const balance = await connection.getBalance(new PublicKey(publicKey));
    return balance;
  } catch (error) {
    console.error('Error fetching balance:', error.message);
    return 0;
  }
}

async function getTokenAccounts(publicKey) {
  try {
    const { value: accounts } = await connection.getParsedTokenAccountsByOwner(
      new PublicKey(publicKey),
      { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
    );

    return accounts
      .map(account => ({
        mint: account.account.data.parsed.info.mint,
        balance: account.account.data.parsed.info.tokenAmount.uiAmount,
        decimals: account.account.data.parsed.info.tokenAmount.decimals,
      }))
      .filter(t => t.balance > 0);
  } catch (error) {
    console.error('Error fetching token accounts:', error.message);
    return [];
  }
}

function generateWallet() {
  const keypair = Keypair.generate();
  return {
    publicKey: keypair.publicKey.toBase58(),
    privateKey: bs58.encode(keypair.secretKey),
    createdAt: Date.now(),
  };
}

function importWallet(privateKey) {
  try {
    const decoded = bs58.decode(privateKey);
    const keypair = Keypair.fromSecretKey(decoded);
    return {
      publicKey: keypair.publicKey.toBase58(),
      privateKey: privateKey,
      createdAt: Date.now(),
    };
  } catch (error) {
    return null;
  }
}

// ============================================
// JUPITER SWAP FUNCTIONS
// ============================================
async function getSwapQuote(inputMint, outputMint, amount, slippageBps) {
  try {
    const response = await fetch(
      `https://quote-api.jup.ag/v6/quote?` +
      `inputMint=${inputMint}&` +
      `outputMint=${outputMint}&` +
      `amount=${amount}&` +
      `slippageBps=${slippageBps}`
    );
    
    if (!response.ok) {
      throw new Error(`Quote API error: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error getting swap quote:', error.message);
    return null;
  }
}

async function executeSwap(wallet, quoteResponse) {
  try {
    const keypair = Keypair.fromSecretKey(bs58.decode(wallet.privateKey));
    
    const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: wallet.publicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: config.jupiter.priorityFee,
      }),
    });

    if (!swapResponse.ok) {
      throw new Error(`Swap API error: ${swapResponse.status}`);
    }

    const { swapTransaction } = await swapResponse.json();
    
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const { VersionedTransaction } = require('@solana/web3.js');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    
    transaction.sign([keypair]);
    
    const txid = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    const confirmation = await connection.confirmTransaction(txid, 'confirmed');
    
    if (confirmation.value.err) {
      throw new Error('Transaction failed');
    }

    return {
      success: true,
      txid,
      explorerUrl: `https://solscan.io/tx/${txid}`,
    };
  } catch (error) {
    console.error('Swap execution error:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

// ============================================
// TELEGRAM BOT SETUP
// ============================================
const bot = new TelegramBot(config.telegram.token, { polling: true });

// Keyboard layouts
const mainMenuKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '💳 Wallets', callback_data: 'wallet' },
        { text: '⚡️ Trade', callback_data: 'trade' },
      ],
      [
        { text: '📊 Dashboard', callback_data: 'portfolio' },
        { text: '🔍 Token Info', callback_data: 'price_check' },
      ],
      [
        { text: '📈 DCA Manager', callback_data: 'dca_manager' },
        { text: '🎯 Limit Orders', callback_data: 'limit_orders' },
      ],
      [
        { text: '👥 Copy Trading', callback_data: 'copy_trading' },
        { text: '🔔 Price Alerts', callback_data: 'alerts' },
      ],
      [
        { text: '⚙️ Settings', callback_data: 'settings' },
        { text: '🎁 Referrals', callback_data: 'referrals' },
      ],
      [
        { text: '🔄 Refresh', callback_data: 'refresh_main' },
      ],
    ],
  },
};

const walletMenuKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '➕ Create Wallet', callback_data: 'wallet_create' },
        { text: '📥 Import Wallet', callback_data: 'wallet_import' },
      ],
      [
        { text: '💰 Check Balance', callback_data: 'wallet_balance' },
        { text: '📋 My Wallets', callback_data: 'wallet_list' },
      ],
      [
        { text: '🔙 Back', callback_data: 'main_menu' },
      ],
    ],
  },
};

const alertsMenuKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '➕ Create Alert', callback_data: 'alert_create' },
        { text: '📋 My Alerts', callback_data: 'alert_list' },
      ],
      [
        { text: '🔙 Back', callback_data: 'main_menu' },
      ],
    ],
  },
};

// ============================================
// HELPER: Build Main Menu Message
// ============================================
async function buildMainMenuMessage(chatId) {
  const user = state.getUser(chatId);
  
  let walletName = 'None';
  let walletAddress = 'No wallet connected';
  let balanceSOL = '0.0000';
  let balanceUSD = '0.00';
  
  if (user.activeWallet) {
    const walletIndex = user.wallets.findIndex(w => w.publicKey === user.activeWallet.publicKey);
    walletName = `Wallet_${walletIndex + 1}`;
    walletAddress = user.activeWallet.publicKey;
    
    const balance = await getWalletBalance(user.activeWallet.publicKey);
    const solAmount = balance / LAMPORTS_PER_SOL;
    balanceSOL = solAmount.toFixed(4);
    
    const solPrice = await getTokenPrice(WSOL_MINT);
    if (solPrice) {
      balanceUSD = (solAmount * solPrice).toFixed(2);
    }
  }
  
  return `🌟 *Welcome to Grokini Trading Bot!*

Your all-in-one Solana trading hub!

Manage your wallets, trade tokens, and automate strategies.

💳 *Wallets* - Manage your funds
⚡️ *Trade* - Buy/sell tokens
📊 *Dashboard* - Monitor portfolio
🔍 *Token Info* - Detailed insights
📈 *DCA Manager* - Automate investments
🎯 *Limit Orders* - Set target prices
👥 *Copy Trading* - Follow top traders
🔔 *Price Alerts* - Real-time notifications
⚙️ *Settings* - Customize trading
🎁 *Referrals* - Invite friends, earn rewards

━━━━━━━━━━━━━━━━━━━━━━

💳 *Active Wallet:* ${walletName}

📍 *Address:*
\`${walletAddress}\`

💰 *Balance:* ${balanceSOL} SOL ($${balanceUSD})

━━━━━━━━━━━━━━━━━━━━━━

🔗 *Paste a token address to begin trading.*`;
}

// ============================================
// BOT COMMAND HANDLERS
// ============================================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  state.getUser(chatId);
  
  const loadingMsg = await bot.sendMessage(chatId, '⏳ Loading your dashboard...');
  
  const welcomeMessage = await buildMainMenuMessage(chatId);
  
  await bot.deleteMessage(chatId, loadingMsg.message_id);
  
  await bot.sendMessage(chatId, welcomeMessage, {
    parse_mode: 'Markdown',
    ...mainMenuKeyboard,
  });
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  
  const helpMessage = `
📖 *Grokini Bot Commands*

*General:*
/start - Main menu
/help - Show this help
/wallet - Wallet management
/balance - Check wallet balance
/portfolio - View token holdings

*Trading:*
/buy <token> <amount> - Buy tokens
/sell <token> <amount> - Sell tokens
/price <token> - Check token price

*Alerts:*
/alert <token> <price> <above/below>
/alerts - View your alerts
/removealert <id> - Remove an alert

*Settings:*
/slippage <bps> - Set slippage (e.g., 100 = 1%)
/settings - View current settings

*Examples:*
\`/buy So11...112 0.1\` - Buy 0.1 SOL worth
\`/price EPjF...Dt1v\` - Check USDC price
\`/alert BONK 0.00001 above\` - Alert when above price
  `;

  await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/wallet/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, '💰 *Wallet Management*', {
    parse_mode: 'Markdown',
    ...walletMenuKeyboard,
  });
});

bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  const user = state.getUser(chatId);
  
  if (!user.activeWallet) {
    await bot.sendMessage(chatId, '❌ No active wallet. Create or import one first.', walletMenuKeyboard);
    return;
  }

  await bot.sendMessage(chatId, '⏳ Fetching balance...');
  
  const balance = await getWalletBalance(user.activeWallet.publicKey);
  
  await bot.sendMessage(chatId, `
💰 *Wallet Balance*

Address: \`${shortenAddress(user.activeWallet.publicKey, 6)}\`
Balance: *${formatSOL(balance)} SOL*
  `, { parse_mode: 'Markdown' });
});

bot.onText(/\/portfolio/, async (msg) => {
  const chatId = msg.chat.id;
  const user = state.getUser(chatId);
  
  if (!user.activeWallet) {
    await bot.sendMessage(chatId, '❌ No active wallet. Create or import one first.');
    return;
  }

  await bot.sendMessage(chatId, '⏳ Fetching portfolio...');
  
  const [solBalance, tokenAccounts] = await Promise.all([
    getWalletBalance(user.activeWallet.publicKey),
    getTokenAccounts(user.activeWallet.publicKey),
  ]);

  let portfolioMsg = `
📊 *Portfolio*

*SOL Balance:* ${formatSOL(solBalance)} SOL

*Token Holdings:*
`;

  if (tokenAccounts.length === 0) {
    portfolioMsg += '\nNo token holdings found.';
  } else {
    for (const token of tokenAccounts.slice(0, 10)) {
      const tokenInfo = await getTokenInfo(token.mint);
      const price = await getTokenPrice(token.mint);
      const value = price ? (token.balance * price).toFixed(2) : 'N/A';
      
      portfolioMsg += `\n• *${tokenInfo?.symbol || shortenAddress(token.mint)}*`;
      portfolioMsg += `\n  Balance: ${formatNumber(token.balance)}`;
      portfolioMsg += `\n  Value: $${value}\n`;
    }
  }

  await bot.sendMessage(chatId, portfolioMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/price (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const tokenInput = match[1].trim();
  
  await bot.sendMessage(chatId, '⏳ Fetching price...');
  
  const tokenInfo = await getTokenInfo(tokenInput);
  const price = await getTokenPrice(tokenInput);
  
  if (!price) {
    await bot.sendMessage(chatId, '❌ Could not fetch price. Check the token address.');
    return;
  }

  await bot.sendMessage(chatId, `
📈 *Price Check*

Token: *${tokenInfo?.name || 'Unknown'}* (${tokenInfo?.symbol || 'N/A'})
Address: \`${shortenAddress(tokenInput, 6)}\`
Price: *$${formatNumber(price, 8)}*
  `, { parse_mode: 'Markdown' });
});

bot.onText(/\/buy (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = state.getUser(chatId);
  
  if (!user.activeWallet) {
    await bot.sendMessage(chatId, '❌ No active wallet. Create or import one first.');
    return;
  }

  const tokenMint = match[1].trim();
  const amountSOL = parseFloat(match[2]);
  
  if (isNaN(amountSOL) || amountSOL <= 0) {
    await bot.sendMessage(chatId, '❌ Invalid amount. Usage: /buy <token_address> <sol_amount>');
    return;
  }

  await bot.sendMessage(chatId, '⏳ Getting quote...');
  
  const amountLamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);
  const quote = await getSwapQuote(WSOL_MINT, tokenMint, amountLamports, user.settings.slippageBps);
  
  if (!quote || quote.error) {
    await bot.sendMessage(chatId, `❌ Could not get quote: ${quote?.error || 'Unknown error'}`);
    return;
  }

  const tokenInfo = await getTokenInfo(tokenMint);
  const outAmount = quote.outAmount / Math.pow(10, tokenInfo?.decimals || 9);
  
  const confirmMsg = `
🔄 *Swap Confirmation*

*Selling:* ${amountSOL} SOL
*Buying:* ~${formatNumber(outAmount)} ${tokenInfo?.symbol || 'tokens'}
*Slippage:* ${user.settings.slippageBps / 100}%
*Price Impact:* ${quote.priceImpactPct || 'N/A'}%

Reply with /confirm_buy to execute
  `;

  user.pendingSwap = { quote, type: 'buy', tokenMint };
  
  await bot.sendMessage(chatId, confirmMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/confirm_buy/, async (msg) => {
  const chatId = msg.chat.id;
  const user = state.getUser(chatId);
  
  if (!user.pendingSwap || user.pendingSwap.type !== 'buy') {
    await bot.sendMessage(chatId, '❌ No pending buy order. Use /buy first.');
    return;
  }

  await bot.sendMessage(chatId, '⏳ Executing swap...');
  
  const result = await executeSwap(user.activeWallet, user.pendingSwap.quote);
  user.pendingSwap = null;
  
  if (result.success) {
    await bot.sendMessage(chatId, `
✅ *Swap Successful!*

Transaction: [View on Solscan](${result.explorerUrl})
    `, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } else {
    await bot.sendMessage(chatId, `❌ Swap failed: ${result.error}`);
  }
});

bot.onText(/\/sell (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = state.getUser(chatId);
  
  if (!user.activeWallet) {
    await bot.sendMessage(chatId, '❌ No active wallet. Create or import one first.');
    return;
  }

  const tokenMint = match[1].trim();
  const amountTokens = parseFloat(match[2]);
  
  if (isNaN(amountTokens) || amountTokens <= 0) {
    await bot.sendMessage(chatId, '❌ Invalid amount. Usage: /sell <token_address> <token_amount>');
    return;
  }

  const tokenInfo = await getTokenInfo(tokenMint);
  const decimals = tokenInfo?.decimals || 9;
  
  await bot.sendMessage(chatId, '⏳ Getting quote...');
  
  const amountRaw = Math.floor(amountTokens * Math.pow(10, decimals));
  const quote = await getSwapQuote(tokenMint, WSOL_MINT, amountRaw, user.settings.slippageBps);
  
  if (!quote || quote.error) {
    await bot.sendMessage(chatId, `❌ Could not get quote: ${quote?.error || 'Unknown error'}`);
    return;
  }

  const outAmountSOL = quote.outAmount / LAMPORTS_PER_SOL;
  
  const confirmMsg = `
🔄 *Swap Confirmation*

*Selling:* ${formatNumber(amountTokens)} ${tokenInfo?.symbol || 'tokens'}
*Receiving:* ~${formatNumber(outAmountSOL)} SOL
*Slippage:* ${user.settings.slippageBps / 100}%
*Price Impact:* ${quote.priceImpactPct || 'N/A'}%

Reply with /confirm_sell to execute
  `;

  user.pendingSwap = { quote, type: 'sell', tokenMint };
  
  await bot.sendMessage(chatId, confirmMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/confirm_sell/, async (msg) => {
  const chatId = msg.chat.id;
  const user = state.getUser(chatId);
  
  if (!user.pendingSwap || user.pendingSwap.type !== 'sell') {
    await bot.sendMessage(chatId, '❌ No pending sell order. Use /sell first.');
    return;
  }

  await bot.sendMessage(chatId, '⏳ Executing swap...');
  
  const result = await executeSwap(user.activeWallet, user.pendingSwap.quote);
  user.pendingSwap = null;
  
  if (result.success) {
    await bot.sendMessage(chatId, `
✅ *Swap Successful!*

Transaction: [View on Solscan](${result.explorerUrl})
    `, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } else {
    await bot.sendMessage(chatId, `❌ Swap failed: ${result.error}`);
  }
});

bot.onText(/\/alert (.+) (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const tokenMint = match[1].trim();
  const targetPrice = parseFloat(match[2]);
  const direction = match[3].toLowerCase();
  
  if (isNaN(targetPrice) || targetPrice <= 0) {
    await bot.sendMessage(chatId, '❌ Invalid price.');
    return;
  }
  
  if (!['above', 'below'].includes(direction)) {
    await bot.sendMessage(chatId, '❌ Direction must be "above" or "below".');
    return;
  }

  const alertId = state.addAlert(chatId, tokenMint, targetPrice, direction);
  const tokenInfo = await getTokenInfo(tokenMint);
  
  await bot.sendMessage(chatId, `
🔔 *Alert Created*

ID: #${alertId}
Token: ${tokenInfo?.symbol || shortenAddress(tokenMint)}
Trigger: Price goes *${direction}* $${formatNumber(targetPrice, 8)}
  `, { parse_mode: 'Markdown' });
});

bot.onText(/\/alerts/, async (msg) => {
  const chatId = msg.chat.id;
  const alerts = state.getUserAlerts(chatId);
  
  if (alerts.length === 0) {
    await bot.sendMessage(chatId, '📭 No active alerts.', alertsMenuKeyboard);
    return;
  }

  let alertsMsg = '🔔 *Your Alerts*\n\n';
  
  for (const alert of alerts) {
    const tokenInfo = await getTokenInfo(alert.tokenMint);
    alertsMsg += `*#${alert.id}* - ${tokenInfo?.symbol || shortenAddress(alert.tokenMint)}\n`;
    alertsMsg += `  ${alert.direction === 'above' ? '📈' : '📉'} ${alert.direction} $${formatNumber(alert.targetPrice, 8)}\n\n`;
  }
  
  alertsMsg += '\nUse /removealert <id> to remove an alert.';
  
  await bot.sendMessage(chatId, alertsMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/removealert (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const alertId = parseInt(match[1]);
  
  const alert = state.priceAlerts.get(alertId);
  
  if (!alert || alert.chatId !== chatId) {
    await bot.sendMessage(chatId, '❌ Alert not found.');
    return;
  }
  
  state.removeAlert(alertId);
  await bot.sendMessage(chatId, `✅ Alert #${alertId} removed.`);
});

bot.onText(/\/slippage (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = state.getUser(chatId);
  const slippageBps = parseInt(match[1]);
  
  if (isNaN(slippageBps) || slippageBps < 1 || slippageBps > 5000) {
    await bot.sendMessage(chatId, '❌ Slippage must be between 1-5000 bps (0.01% - 50%)');
    return;
  }
  
  user.settings.slippageBps = slippageBps;
  await bot.sendMessage(chatId, `✅ Slippage set to ${slippageBps / 100}%`);
});

bot.onText(/\/settings/, async (msg) => {
  const chatId = msg.chat.id;
  const user = state.getUser(chatId);
  
  await bot.sendMessage(chatId, `
⚙️ *Current Settings*

Slippage: ${user.settings.slippageBps / 100}%
Notifications: ${user.settings.notifications ? 'Enabled' : 'Disabled'}
Active Wallet: ${user.activeWallet ? shortenAddress(user.activeWallet.publicKey) : 'None'}

*Commands:*
/slippage <bps> - Change slippage
  `, { parse_mode: 'Markdown' });
});

// ============================================
// CALLBACK QUERY HANDLERS
// ============================================
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  const user = state.getUser(chatId);

  await bot.answerCallbackQuery(query.id);

  switch (data) {
    case 'main_menu':
    case 'refresh_main': {
      const menuMessage = await buildMainMenuMessage(chatId);
      await bot.editMessageText(menuMessage, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        ...mainMenuKeyboard,
      });
      break;
    }
    
    case 'trade':
      await bot.editMessageText(`
⚡️ *Trade Tokens*

Select your trading action:

🔄 *Buy* - Purchase tokens with SOL
💸 *Sell* - Sell tokens for SOL
      `, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔄 Buy', callback_data: 'buy' },
              { text: '💸 Sell', callback_data: 'sell' },
            ],
            [{ text: '🔙 Back to Menu', callback_data: 'main_menu' }],
          ],
        },
      });
      break;
    
    case 'dca_manager':
      await bot.editMessageText(`
📈 *DCA Manager*

Dollar Cost Averaging allows you to automatically invest a fixed amount at regular intervals.

🚧 *Coming Soon!*

This feature is under development.
      `, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to Menu', callback_data: 'main_menu' }],
          ],
        },
      });
      break;
    
    case 'limit_orders':
      await bot.editMessageText(`
🎯 *Limit Orders*

Set buy or sell orders at your target prices.

🚧 *Coming Soon!*

This feature is under development.
      `, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to Menu', callback_data: 'main_menu' }],
          ],
        },
      });
      break;
    
    case 'copy_trading':
      await bot.editMessageText(`
👥 *Copy Trading*

Follow successful traders and automatically mirror their trades.

🚧 *Coming Soon!*

This feature is under development.
      `, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to Menu', callback_data: 'main_menu' }],
          ],
        },
      });
      break;
    
    case 'referrals':
      await bot.editMessageText(`
🎁 *Referral Program*

Invite friends and earn rewards!

🚧 *Coming Soon!*

This feature is under development.
      `, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to Menu', callback_data: 'main_menu' }],
          ],
        },
      });
      break;

    case 'wallet':
      await bot.editMessageText('💰 *Wallet Management*\n\nManage your Solana wallets:', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        ...walletMenuKeyboard,
      });
      break;

    case 'wallet_create':
      const newWallet = generateWallet();
      user.wallets.push(newWallet);
      user.activeWallet = newWallet;
      
      await bot.editMessageText(`
✅ *New Wallet Created!*

Address: \`${newWallet.publicKey}\`

⚠️ *SAVE YOUR PRIVATE KEY:*
\`${newWallet.privateKey}\`

_Store this securely. It won't be shown again._
      `, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
      });
      
      await sleep(500);
      await bot.sendMessage(chatId, '💰 Wallet Menu', walletMenuKeyboard);
      break;

    case 'wallet_import':
      user.awaitingInput = 'wallet_import';
      await bot.editMessageText(
        '📥 *Import Wallet*\n\nSend your private key (base58 encoded):\n\n⚠️ _Make sure to use this bot in a private chat!_',
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
        }
      );
      break;

    case 'wallet_balance':
      if (!user.activeWallet) {
        await bot.sendMessage(chatId, '❌ No active wallet. Create or import one first.');
        break;
      }
      
      const balance = await getWalletBalance(user.activeWallet.publicKey);
      await bot.editMessageText(`
💰 *Wallet Balance*

Address: \`${shortenAddress(user.activeWallet.publicKey, 6)}\`
Balance: *${formatSOL(balance)} SOL*
      `, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        ...walletMenuKeyboard,
      });
      break;

    case 'wallet_list':
      if (user.wallets.length === 0) {
        await bot.sendMessage(chatId, '📭 No wallets. Create or import one.', walletMenuKeyboard);
        break;
      }
      
      let walletsMsg = '📋 *Your Wallets*\n\n';
      for (let i = 0; i < user.wallets.length; i++) {
        const w = user.wallets[i];
        const isActive = user.activeWallet?.publicKey === w.publicKey;
        const bal = await getWalletBalance(w.publicKey);
        walletsMsg += `${isActive ? '✅' : '◻️'} *${i + 1}.* \`${shortenAddress(w.publicKey)}\`\n`;
        walletsMsg += `   Balance: ${formatSOL(bal)} SOL\n\n`;
      }
      
      await bot.editMessageText(walletsMsg, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        ...walletMenuKeyboard,
      });
      break;

    case 'portfolio':
      bot.emit('text', { ...query.message, text: '/portfolio' });
      break;

    case 'buy':
      await bot.editMessageText(
        '🔄 *Buy Tokens*\n\nUse command:\n`/buy <token_address> <sol_amount>`\n\nExample:\n`/buy EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 0.1`',
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Back', callback_data: 'trade' }]],
          },
        }
      );
      break;

    case 'sell':
      await bot.editMessageText(
        '💸 *Sell Tokens*\n\nUse command:\n`/sell <token_address> <token_amount>`\n\nExample:\n`/sell EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 100`',
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Back', callback_data: 'trade' }]],
          },
        }
      );
      break;

    case 'alerts':
      await bot.editMessageText('🔔 *Price Alerts*\n\nMonitor token prices:', {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        ...alertsMenuKeyboard,
      });
      break;

    case 'alert_create':
      await bot.editMessageText(
        '🔔 *Create Alert*\n\nUse command:\n`/alert <token_address> <price> <above/below>`\n\nExample:\n`/alert BONK 0.00001 above`',
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Back', callback_data: 'alerts' }]],
          },
        }
      );
      break;

    case 'alert_list':
      bot.emit('text', { ...query.message, text: '/alerts' });
      break;

    case 'price_check':
      user.awaitingInput = 'price_check';
      await bot.editMessageText(
        '🔍 *Token Info*\n\nSend a token address to get detailed insights:\n\nOr use: `/price <token_address>`',
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Back', callback_data: 'main_menu' }]],
          },
        }
      );
      break;

    case 'settings':
      bot.emit('text', { ...query.message, text: '/settings' });
      break;
  }
});

// ============================================
// MESSAGE HANDLER (for awaited inputs)
// ============================================
bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return;
  
  const chatId = msg.chat.id;
  const user = state.getUser(chatId);
  
  if (!user.awaitingInput) return;

  switch (user.awaitingInput) {
    case 'wallet_import':
      const imported = importWallet(msg.text.trim());
      if (imported) {
        user.wallets.push(imported);
        user.activeWallet = imported;
        user.awaitingInput = null;
        
        try {
          await bot.deleteMessage(chatId, msg.message_id);
        } catch (e) {}
        
        await bot.sendMessage(chatId, `
✅ *Wallet Imported!*

Address: \`${imported.publicKey}\`
        `, { parse_mode: 'Markdown', ...walletMenuKeyboard });
      } else {
        await bot.sendMessage(chatId, '❌ Invalid private key. Try again or use /wallet');
      }
      break;

    case 'price_check':
      user.awaitingInput = null;
      const tokenAddress = msg.text.trim();
      
      await bot.sendMessage(chatId, '⏳ Fetching price...');
      
      const tokenInfo = await getTokenInfo(tokenAddress);
      const price = await getTokenPrice(tokenAddress);
      
      if (price) {
        await bot.sendMessage(chatId, `
📈 *${tokenInfo?.name || 'Unknown Token'}*

Symbol: ${tokenInfo?.symbol || 'N/A'}
Price: *$${formatNumber(price, 8)}*
        `, { parse_mode: 'Markdown', ...mainMenuKeyboard });
      } else {
        await bot.sendMessage(chatId, '❌ Could not fetch price.', mainMenuKeyboard);
      }
      break;
  }
});

// ============================================
// PRICE ALERT CHECKER
// ============================================
async function checkPriceAlerts() {
  for (const [alertId, alert] of state.priceAlerts) {
    if (alert.triggered) continue;
    
    const price = await getTokenPrice(alert.tokenMint);
    if (!price) continue;
    
    const triggered = 
      (alert.direction === 'above' && price >= alert.targetPrice) ||
      (alert.direction === 'below' && price <= alert.targetPrice);
    
    if (triggered) {
      alert.triggered = true;
      const tokenInfo = await getTokenInfo(alert.tokenMint);
      
      await bot.sendMessage(alert.chatId, `
🚨 *PRICE ALERT TRIGGERED!*

Token: ${tokenInfo?.symbol || shortenAddress(alert.tokenMint)}
Current Price: $${formatNumber(price, 8)}
Alert: Price went ${alert.direction} $${formatNumber(alert.targetPrice, 8)}
      `, { parse_mode: 'Markdown' });
      
      state.removeAlert(alertId);
    }
  }
}

setInterval(checkPriceAlerts, config.alerts.checkInterval);

// ============================================
// ERROR HANDLING
// ============================================
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

// ============================================
// STARTUP
// ============================================
console.log(`
╔════════════════════════════════════════╗
║     Grokini Trading Bot v3.0.0         ║
║     Solana Telegram Trading Bot        ║
╠════════════════════════════════════════╣
║  Features:                             ║
║  • Jupiter DEX Swaps                   ║
║  • Multi-Wallet Management             ║
║  • Price Alerts                        ║
║  • Portfolio Tracking                  ║
╚════════════════════════════════════════╝
`);

console.log('Bot is running...');
console.log(`RPC: ${config.solana.rpcUrl}`);
console.log(`Alert Check Interval: ${config.alerts.checkInterval}ms`);