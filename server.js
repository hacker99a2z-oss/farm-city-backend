require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Telegram Bot Setup
const bot = new TelegramBot(process.env.BOT_TOKEN);

// Webhook Setup
const WEBHOOK_URL = `https://farm-city-backend-1.onrender.com/bot${process.env.BOT_TOKEN}`;

// Set Webhook
bot.setWebHook(WEBHOOK_URL)
  .then(() => console.log('Webhook set successfully'))
  .catch(err => console.error('Webhook error:', err));

// Webhook Endpoint
app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// /start Command Handler
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMessage = `
🌾 Welcome to Farm City!

Grow together and shine with our farming community.

👇 Join our community below:
  `;

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: '📢 Join Channel', url: 'https://t.me/earners_100b' }
      ],
      [
        { text: '👥 Join Group', url: 'https://t.me/real_eaners_supported' }
      ],
      [
        { text: '🎮 Open App', web_app: { url: 'https://farm-city-frontend.vercel.app/home.html' } }
      ]
    ]
  };

  bot.sendMessage(chatId, welcomeMessage, {
    reply_markup: inlineKeyboard
  });
});

// Bot Error Handling
bot.on('error', (error) => {
  console.error('Bot error:', error);
});

// Database connection
const MONGODB_URI = process.env.MONGODB_URI || process.env.DATABASE_URL;

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => {
    console.log('MongoDB connected successfully');
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
  });

// Define Schemas
const userSchema = new mongoose.Schema({
  telegram_id: { type: Number, required: true, unique: true },
  username: String,
  first_name: String,
  last_name: String,
  photo_url: String,
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

const balanceSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  withdraw_balance: { type: Number, default: 0.00 },
  game_balance: { type: Number, default: 0.00 },
  updated_at: { type: Date, default: Date.now }
});

const referralSchema = new mongoose.Schema({
  referrer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  referred_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, sparse: true },
  referral_code: { type: String, required: true, unique: true },
  earnings: { type: Number, default: 0.00 },
  created_at: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, required: true },
  amount: { type: Number, required: true },
  description: String,
  status: { type: String, default: 'pending' },
  created_at: { type: Date, default: Date.now }
});

const withdrawalSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  payment_method: { type: String, required: true },
  payment_details: String,
  status: { type: String, default: 'pending' },
  created_at: { type: Date, default: Date.now },
  processed_at: Date
});

// Create Models
const User = mongoose.model('User', userSchema);
const Balance = mongoose.model('Balance', balanceSchema);
const Referral = mongoose.model('Referral', referralSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// Drop old userId index if it exists
User.collection.indexes().then(indexes => {
  if (indexes.userId_1) {
    console.log('Dropping old userId_1 index...');
    User.collection.dropIndex('userId_1').catch(err => {
      console.log('Error dropping userId_1 index:', err.message);
    });
  }
}).catch(err => {
  console.log('Error checking indexes:', err.message);
});

// Routes
app.get('/', (req, res) => {
  res.json({ message: 'Farm City API is running' });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Telegram WebApp auth endpoint
app.post('/api/auth/telegram', async (req, res) => {
  try {
    const { initData } = req.body;

    console.log('Auth request received, initData length:', initData?.length);

    // Validate Telegram initData (simplified version)
    const urlParams = new URLSearchParams(initData);
    const userStr = urlParams.get('user');

    if (!userStr) {
      console.error('No user data in initData');
      return res.status(400).json({ error: 'Invalid init data: no user' });
    }

    const user = JSON.parse(userStr);
    const telegramId = user.id;

    if (!telegramId) {
      console.error('No telegram_id in user data');
      return res.status(400).json({ error: 'Invalid user data: no telegram_id' });
    }

    console.log('Processing user:', telegramId, user.first_name);

    // Check if user exists
    let existingUser = await User.findOne({ telegram_id: telegramId });

    let userId;

    if (!existingUser) {
      console.log('Creating new user:', telegramId);
      try {
        // Create new user
        const newUser = await User.create({
          telegram_id: telegramId,
          username: user.username || null,
          first_name: user.first_name || 'User',
          last_name: user.last_name || null,
          photo_url: user.photo_url || null
        });
        userId = newUser._id;

        // Create balance for new user
        await Balance.create({
          user_id: userId,
          withdraw_balance: 0.00,
          game_balance: 0.00
        });

        // Generate referral code
        const referralCode = 'FC' + Math.random().toString(36).substring(2, 8).toUpperCase();
        await Referral.create({
          referrer_id: userId,
          referral_code: referralCode
        });
      } catch (createError) {
        console.error('Error creating user:', createError.message);
        // Check if user was created by another request
        existingUser = await User.findOne({ telegram_id: telegramId });
        if (existingUser) {
          console.log('User already exists (race condition):', telegramId);
          userId = existingUser._id;
        } else {
          throw createError;
        }
      }
    } else {
      console.log('User exists:', telegramId);
      userId = existingUser._id;
    }

    // Get user balance
    const balance = await Balance.findOne({ user_id: userId });

    if (!balance) {
      console.error('No balance found for user:', userId);
      // Create balance if missing
      await Balance.create({
        user_id: userId,
        withdraw_balance: 0.00,
        game_balance: 0.00
      });
    }

    res.json({
      success: true,
      user: {
        id: userId,
        telegram_id: telegramId,
        username: user.username || null,
        first_name: user.first_name || 'User',
        last_name: user.last_name || null,
        photo_url: user.photo_url || null
      },
      balance: balance || { withdraw_balance: 0.00, game_balance: 0.00 }
    });
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Authentication failed: ' + error.message });
  }
});

// Get user balance
app.get('/api/balance/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const balance = await Balance.findOne({ user_id: userId });

    if (!balance) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(balance);
  } catch (error) {
    console.error('Balance error:', error);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// Withdraw request
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, amount, paymentMethod, paymentDetails } = req.body;

    // Check user balance
    const balance = await Balance.findOne({ user_id: userId });

    if (!balance) {
      return res.status(404).json({ error: 'User not found' });
    }

    const currentBalance = parseFloat(balance.withdraw_balance);
    const withdrawAmount = parseFloat(amount);

    if (withdrawAmount > currentBalance) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Create withdrawal request
    await Withdrawal.create({
      user_id: userId,
      amount: withdrawAmount,
      payment_method: paymentMethod,
      payment_details: paymentDetails
    });

    // Deduct from balance
    await Balance.findOneAndUpdate(
      { user_id: userId },
      { $inc: { withdraw_balance: -withdrawAmount } }
    );

    res.json({ success: true, message: 'Withdrawal request submitted' });
  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

// Get referral info
app.get('/api/referral/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const referral = await Referral.findOne({ referrer_id: userId });

    if (!referral) {
      return res.status(404).json({ error: 'Referral not found' });
    }

    const totalReferrals = await Referral.countDocuments({ referrer_id: userId });
    const totalEarnings = await Referral.aggregate([
      { $match: { referrer_id: new mongoose.Types.ObjectId(userId) } },
      { $group: { _id: null, total: { $sum: '$earnings' } } }
    ]);

    res.json({
      referral_code: referral.referral_code,
      total_referrals: totalReferrals,
      total_earnings: totalEarnings[0]?.total || 0
    });
  } catch (error) {
    console.error('Referral error:', error);
    res.status(500).json({ error: 'Failed to fetch referral info' });
  }
});

// Sell product
app.post('/api/sell', async (req, res) => {
  try {
    const { userId, productId, amount } = req.body;

    // Add to game balance
    await Balance.findOneAndUpdate(
      { user_id: userId },
      { $inc: { game_balance: amount } }
    );

    // Record transaction
    await Transaction.create({
      user_id: userId,
      type: 'sell',
      amount: amount,
      description: `Sold product ${productId}`
    });

    res.json({ success: true, message: 'Product sold successfully' });
  } catch (error) {
    console.error('Sell error:', error);
    res.status(500).json({ error: 'Sell failed' });
  }
});

// Get withdrawal history
app.get('/api/withdrawals/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const withdrawals = await Withdrawal.find({ user_id: userId })
      .sort({ created_at: -1 });

    res.json(withdrawals);
  } catch (error) {
    console.error('Withdrawals error:', error);
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
